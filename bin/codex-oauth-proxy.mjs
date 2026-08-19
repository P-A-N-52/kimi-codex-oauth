#!/usr/bin/env node
// codex-oauth-proxy — local OpenAI Responses API proxy that reuses the
// ChatGPT OAuth login stored by Codex CLI at ~/.codex/auth.json.
//
// - Refreshes the access token via auth.openai.com when it is near expiry
//   (single-flight, atomic write-back, merges with concurrent Codex CLI writes).
// - Injects the headers the ChatGPT Codex backend requires.
// - Normalizes request bodies (store=false, stream=true, instructions default,
//   strips parameters the backend rejects).
//
// Zero dependencies. Requires Node >= 18.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';

const PORT = Number(process.env.CODEX_OAUTH_PORT || 8317);
const HOST = '127.0.0.1';
const AUTH_PATH = process.env.CODEX_AUTH_PATH || path.join(os.homedir(), '.codex', 'auth.json');
const LOG_PATH = process.env.CODEX_OAUTH_LOG || path.join(os.homedir(), '.codex', 'oauth-proxy.log');

const UPSTREAM_RESPONSES = 'https://chatgpt.com/backend-api/codex/responses';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_LEEWAY_S = 300;
const DEFAULT_INSTRUCTIONS = 'You are a helpful coding assistant.';

// Parameters the ChatGPT Codex backend rejects or that are incompatible with
// store=false. Everything else is passed through untouched.
const BODY_STRIP = new Set([
  'temperature', 'top_p', 'presence_penalty', 'frequency_penalty',
  'logit_bias', 'logprobs', 'top_logprobs', 'n', 'user', 'seed',
  'metadata', 'response_format', 'previous_response_id', 'background',
  'max_tool_calls', 'service_tier', 'max_output_tokens',
]);

// Static fallback used only when the upstream model list cannot be fetched.
// Real metadata (context_window, modalities, efforts…) comes from the
// upstream /codex/models response.
const FALLBACK_MODELS = [
  'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5',
  'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'codex-auto-review',
].map((slug) => ({ slug }));
const UPSTREAM_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0';
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
let modelsCache = { at: 0, models: FALLBACK_MODELS, live: false };

async function getModels() {
  if (Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) return modelsCache;
  try {
    const auth = await getAuth(false);
    const res = await fetch(UPSTREAM_MODELS_URL, {
      headers: upstreamHeaders(auth),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const data = await res.json();
      const models = (data.models ?? []).filter((m) => m && m.slug);
      if (models.length > 0) {
        modelsCache = { at: Date.now(), models, live: true };
        return modelsCache;
      }
    }
    log(`models fetch: HTTP ${res.status}, using fallback`);
  } catch (e) {
    log(`models fetch failed: ${e.message}, using fallback`);
  }
  modelsCache = { at: Date.now(), models: FALLBACK_MODELS, live: false };
  return modelsCache;
}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_PATH, line); } catch { /* ignore */ }
}

function readAuth() {
  return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
}

function jwtExp(token) {
  try {
    const part = token.split('.')[1];
    const padded = part + '='.repeat((4 - (part.length % 4)) % 4);
    const payload = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

function writeAuthAtomic(next) {
  const tmp = AUTH_PATH + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, AUTH_PATH);
}

let refreshPromise = null;

async function refreshTokens(usedAuth) {
  log('refreshing access token via auth.openai.com');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: usedAuth.tokens.refresh_token,
    }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 500);
    throw new Error(`token refresh failed: HTTP ${res.status} ${text}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('token refresh returned no access_token');

  // Merge against the on-disk file: Codex CLI may have refreshed concurrently.
  const current = readAuth();
  if (
    current.tokens?.access_token &&
    current.tokens.access_token !== usedAuth.tokens.access_token
  ) {
    const exp = jwtExp(current.tokens.access_token);
    if (exp && exp - Date.now() / 1000 > REFRESH_LEEWAY_S) {
      log('another process refreshed concurrently; keeping its token');
      return current;
    }
  }

  const next = {
    ...current,
    tokens: {
      ...current.tokens,
      id_token: data.id_token ?? current.tokens.id_token,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? current.tokens.refresh_token,
    },
    last_refresh: new Date().toISOString(),
  };
  writeAuthAtomic(next);
  log('access token refreshed and written back');
  return next;
}

async function getAuth(forceRefresh = false) {
  const auth = readAuth();
  if (!auth.tokens?.access_token) {
    if (auth.OPENAI_API_KEY || auth.auth_mode === 'apikey') {
      throw new Error(
        'codex auth is API-key based, not ChatGPT OAuth — this plugin is unnecessary; ' +
        'configure a standard openai_responses provider with your API key instead',
      );
    }
    throw new Error(`${AUTH_PATH} has no tokens.access_token — run "codex login" first`);
  }
  if (!forceRefresh) {
    const exp = jwtExp(auth.tokens.access_token);
    if (exp && exp - Date.now() / 1000 > REFRESH_LEEWAY_S) return auth;
  }
  if (!refreshPromise) {
    refreshPromise = refreshTokens(auth).finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

function normalizeBody(body) {
  const out = { ...body };
  out.store = false;
  out.stream = true;
  if (typeof out.instructions !== 'string' || out.instructions.length === 0) {
    out.instructions = DEFAULT_INSTRUCTIONS;
  }
  for (const key of BODY_STRIP) delete out[key];
  return out;
}

function upstreamHeaders(auth) {
  return {
    'authorization': `Bearer ${auth.tokens.access_token}`,
    'content-type': 'application/json',
    'accept': 'text/event-stream',
    'chatgpt-account-id': auth.tokens.account_id ?? '',
    'OpenAI-Beta': 'responses=experimental',
    'originator': 'codex_cli_rs',
    'user-agent': 'codex_cli_rs (kimi-codex-oauth-proxy)',
  };
}

async function forwardResponses(body) {
  let auth = await getAuth(false);
  let upstream = await fetch(UPSTREAM_RESPONSES, {
    method: 'POST',
    headers: upstreamHeaders(auth),
    body: JSON.stringify(body),
  });
  if (upstream.status === 401) {
    log('upstream 401; forcing token refresh and retrying once');
    auth = await getAuth(true);
    upstream = await fetch(UPSTREAM_RESPONSES, {
      method: 'POST',
      headers: upstreamHeaders(auth),
      body: JSON.stringify(body),
    });
  }
  return upstream;
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid JSON request body')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj, null, 2);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

async function handleResponses(req, res) {
  let body;
  try {
    body = normalizeBody(await readRequestJson(req));
  } catch (e) {
    return sendJson(res, 400, { error: { message: e.message } });
  }
  log(`POST /v1/responses model=${body.model ?? '?'} input_items=${Array.isArray(body.input) ? body.input.length : '?'}`);
  try {
    const upstream = await forwardResponses(body);
    if (!upstream.ok) {
      const text = (await upstream.text()).slice(0, 2000);
      log(`upstream error: HTTP ${upstream.status} ${text.slice(0, 300)}`);
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      return res.end(text);
    }
    res.writeHead(200, {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache',
    });
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    log(`proxy error: ${e.message}`);
    sendJson(res, 502, { error: { message: `codex-oauth-proxy: ${e.message}` } });
  }
}

function handleHealthz(_req, res) {
  const info = { ok: true, port: PORT, auth_file: AUTH_PATH };
  try {
    const auth = readAuth();
    const exp = jwtExp(auth.tokens?.access_token ?? '');
    info.auth_mode = auth.auth_mode ?? (auth.tokens?.access_token ? 'chatgpt' : 'unknown');
    info.has_tokens = Boolean(auth.tokens?.access_token && auth.tokens?.refresh_token);
    info.has_account_id = Boolean(auth.tokens?.account_id);
    info.access_token_exp = exp ? new Date(exp * 1000).toISOString() : null;
    info.access_token_expires_in_s = exp ? Math.max(0, Math.round(exp - Date.now() / 1000)) : null;
    info.last_refresh = auth.last_refresh ?? null;
    if (!info.has_tokens && (auth.OPENAI_API_KEY || auth.auth_mode === 'apikey')) {
      info.hint = 'API-key login detected — this plugin is unnecessary; configure a standard openai_responses provider with your API key instead.';
    }
  } catch (e) {
    info.ok = false;
    info.error = e.message;
  }
  sendJson(res, info.ok ? 200 : 500, info);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) {
    return void handleResponses(req, res);
  }
  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
    const { models, live } = await getModels();
    let authMode = 'missing';
    try {
      const auth = readAuth();
      authMode = auth.tokens?.access_token
        ? 'chatgpt'
        : (auth.OPENAI_API_KEY || auth.auth_mode === 'apikey' ? 'apikey' : 'missing');
    } catch { /* keep 'missing' */ }
    return sendJson(res, 200, {
      object: 'list',
      live,
      auth_mode: authMode,
      data: models.map((m) => ({ ...m, id: m.slug, object: 'model', created: 0, owned_by: 'chatgpt-oauth' })),
    });
  }
  if (req.method === 'GET' && url.pathname === '/healthz') {
    return void handleHealthz(req, res);
  }
  sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
});

server.listen(PORT, HOST, () => {
  log(`codex-oauth-proxy listening on http://${HOST}:${PORT}`);
  console.log(`codex-oauth-proxy listening on http://${HOST}:${PORT} (log: ${LOG_PATH})`);
});
