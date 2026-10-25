#!/usr/bin/env node
// codex-oauth-proxy — local OpenAI Responses API proxy that reuses the
// ChatGPT OAuth login stored by Codex CLI at ~/.codex/auth.json.
//
// - Refreshes the access token via auth.openai.com when it is near expiry
//   (single-flight, atomic write-back, merges with concurrent Codex CLI writes).
// - Injects the headers the ChatGPT Codex backend requires.
// - Normalizes request bodies (store=false, stream=true, instructions default,
//   strips parameters the backend rejects).
// - Reports subscription quota and banked rate-limit reset credits at /quota,
//   and redeems one reset credit via POST /quota/consume-reset.
//
// Zero dependencies. Requires Node >= 18.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { writePrivateAtomic } from './private-file.mjs';
import { SERVICE, VERSION, statePath, shutdownPath, registerProxy, removeProxyState, shutdownAuthorized } from './proxy-control.mjs';

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

// Subscription quota comes from the same backend the ChatGPT app uses. The
// banked reset-credit route may be absent for some plans, so it is fetched
// best-effort and never blocks the quota response.
const UPSTREAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const UPSTREAM_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';
const QUOTA_CACHE_TTL_MS = 60 * 1000;
let quotaCache = { at: 0, payload: null };
let quotaRefresh = null;

function normalizeWindow(window) {
  if (!window || typeof window.used_percent !== 'number') return null;
  const used = Math.min(100, Math.max(0, Math.round(window.used_percent)));
  const out = {
    used_percent: used,
    remaining_percent: 100 - used,
    limit_window_seconds: typeof window.limit_window_seconds === 'number' ? window.limit_window_seconds : null,
    reset_at: typeof window.reset_at === 'number' ? new Date(window.reset_at * 1000).toISOString() : null,
  };
  out.resets_in_s = typeof window.reset_after_seconds === 'number'
    ? Math.max(0, Math.round(window.reset_after_seconds))
    : (out.reset_at ? Math.max(0, Math.round((Date.parse(out.reset_at) - Date.now()) / 1000)) : null);
  return out;
}

async function fetchUpstreamJson(url, auth, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...upstreamHeaders(auth), accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  // Upstream error bodies can contain account details; report status only.
  if (!res.ok) throw new Error('upstream quota endpoint: HTTP ' + res.status);
  try { return await res.json(); }
  catch { throw new Error('upstream quota endpoint returned invalid JSON'); }
}

async function refreshQuota() {
  const auth = await getAuth(false);
  const usage = await fetchUpstreamJson(UPSTREAM_USAGE_URL, auth);
  const rateLimit = usage.rate_limit ?? {};
  const payload = {
    ok: true,
    fetched_at: new Date().toISOString(),
    plan_type: typeof usage.plan_type === 'string' ? usage.plan_type : null,
    allowed: typeof rateLimit.allowed === 'boolean' ? rateLimit.allowed : null,
    limit_reached: typeof rateLimit.limit_reached === 'boolean' ? rateLimit.limit_reached : null,
    primary_window: normalizeWindow(rateLimit.primary_window),
    secondary_window: normalizeWindow(rateLimit.secondary_window),
    reset_credits: {
      available_count: typeof usage.rate_limit_reset_credits?.available_count === 'number'
        ? usage.rate_limit_reset_credits.available_count : null,
      credits: [],
    },
  };
  try {
    const data = await fetchUpstreamJson(UPSTREAM_RESET_CREDITS_URL, auth);
    const list = Array.isArray(data) ? data : (Array.isArray(data.credits) ? data.credits : []);
    payload.reset_credits.credits = list
      .filter((c) => c && typeof c.id === 'string')
      .map((c) => ({
        id: c.id,
        status: typeof c.status === 'string' ? c.status : null,
        granted_at: typeof c.granted_at === 'string' ? c.granted_at : null,
        expires_at: typeof c.expires_at === 'string' ? c.expires_at : null,
      }));
    if (payload.reset_credits.available_count === null) {
      payload.reset_credits.available_count =
        payload.reset_credits.credits.filter((c) => c.status === 'available').length;
    }
  } catch (e) {
    log('reset credits fetch failed: ' + e.message);
    payload.reset_credits.error = e.message;
  }
  quotaCache = { at: Date.now(), payload };
  return payload;
}

async function getQuota(force = false) {
  if (!force && quotaCache.payload) {
    if (Date.now() - quotaCache.at < QUOTA_CACHE_TTL_MS) return quotaCache.payload;
    // Stale cache: answer instantly and refresh in the background, so fast
    // consumers (status line, 300ms budget) never wait on the upstream.
    if (!quotaRefresh) {
      quotaRefresh = refreshQuota()
        .catch((e) => log('quota refresh failed: ' + e.message))
        .finally(() => { quotaRefresh = null; });
    }
    return { ...quotaCache.payload, stale: true };
  }
  if (!quotaRefresh) {
    quotaRefresh = refreshQuota().finally(() => { quotaRefresh = null; });
  }
  return quotaRefresh;
}

async function consumeResetCredit(creditId) {
  let target = typeof creditId === 'string' && creditId ? creditId : null;
  if (!target) {
    // Default to the available credit that expires soonest.
    const quota = await getQuota(true);
    const available = quota.reset_credits.credits
      .filter((c) => c.status === 'available')
      .sort((a, b) => (Date.parse(a.expires_at) || Infinity) - (Date.parse(b.expires_at) || Infinity));
    if (available.length === 0) throw new Error('no available reset credits');
    target = available[0].id;
  }
  const auth = await getAuth(false);
  const data = await fetchUpstreamJson(UPSTREAM_RESET_CREDITS_URL + '/consume', auth, {
    method: 'POST',
    body: JSON.stringify({ credit_id: target, redeem_request_id: randomUUID() }),
  });
  quotaCache = { at: 0, payload: null };
  // A background refresh triggered before the consume would finish with
  // pre-consume numbers; let it settle, then fetch fresh quota.
  if (quotaRefresh) await quotaRefresh.catch(() => {});
  const quota = await getQuota(true);
  return {
    ok: true,
    code: typeof data.code === 'string' ? data.code : null,
    windows_reset: typeof data.windows_reset === 'number' ? data.windows_reset : null,
    redeemed_at: typeof data.credit?.redeemed_at === 'string' ? data.credit.redeemed_at : null,
    credit_id: target,
    quota,
  };
}

async function getModels() {
  if (Date.now() - modelsCache.at < MODELS_CACHE_TTL_MS) return modelsCache;
  try {
    const auth = await getAuth(false);
    const res = await fetch(UPSTREAM_MODELS_URL, {
      headers: upstreamHeaders(auth),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      let data;
      try { data = await res.json(); }
      catch { throw new Error('models endpoint returned invalid JSON'); }
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
  let content;
  try { content = fs.readFileSync(AUTH_PATH, 'utf8'); }
  catch { throw new Error('cannot read Codex login cache; check CODEX_AUTH_PATH and codex login'); }
  try { return JSON.parse(content); }
  catch { throw new Error('Codex login cache contains invalid JSON; run codex login'); }
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

function writeAuthAtomic(next, expected) {
  writePrivateAtomic(AUTH_PATH, JSON.stringify(next, null, 2), {
    beforeRename: () => {
      if (JSON.stringify(readAuth()) !== JSON.stringify(expected)) {
        throw new Error('Codex login changed during refresh; retry the request');
      }
    },
  });
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
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error('token refresh failed: HTTP ' + res.status + '; run "codex login" if the login expired');
  }
  let data;
  try { data = await res.json(); }
  catch { throw new Error('token refresh returned invalid JSON'); }
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new Error('token refresh returned no access_token');
  }

  // Merge against the on-disk file: Codex CLI may have refreshed concurrently.
  const current = readAuth();
  if (!current.tokens?.access_token || current.auth_mode !== usedAuth.auth_mode ||
      current.tokens.account_id !== usedAuth.tokens.account_id) {
    throw new Error('Codex login changed during refresh; retry the request');
  }
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

  if (current.tokens.refresh_token !== usedAuth.tokens.refresh_token) {
    throw new Error('Codex login changed during refresh; retry the request');
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
  writeAuthAtomic(next, current);
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

// The quota dashboard is a static, self-contained page; it only ever calls
// the same origin's /quota endpoints (enforced by its CSP meta tag).
let dashboardHtml = null;
function handleDashboard(_req, res) {
  try {
    if (dashboardHtml === null) {
      dashboardHtml = fs.readFileSync(new URL('./quota-page.html', import.meta.url), 'utf8');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(dashboardHtml);
  } catch {
    sendJson(res, 500, { error: { message: 'quota dashboard page is missing from the installation' } });
  }
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
      log('upstream error: HTTP ' + upstream.status);
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      return res.end(text);
    }
    res.writeHead(200, {
      'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
      'cache-control': 'no-cache',
    });
    const upstreamStream = Readable.fromWeb(upstream.body);
    // Upstream stream resets (HTTP/2 RST, body timeout) surface as an 'error'
    // event on this stream after forwarding starts; without a listener the
    // whole proxy process dies.
    upstreamStream.on('error', (err) => {
      log(`upstream stream error: ${err.message}`);
      res.destroy(err);
    });
    upstreamStream.pipe(res);
  } catch (e) {
    log(`proxy error: ${e.message}`);
    sendJson(res, 502, { error: { message: `codex-oauth-proxy: ${e.message}` } });
  }
}

function handleHealthz(_req, res, state) {
  const info = {
    ok: true, port: state?.port ?? PORT, auth_file: AUTH_PATH,
    service: SERVICE, version: VERSION, pid: process.pid, instance_id: state?.instanceId,
  };
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

async function handleQuota(_req, res) {
  try {
    sendJson(res, 200, await getQuota(false));
  } catch (e) {
    log('quota error: ' + e.message);
    sendJson(res, 502, { ok: false, error: { message: 'codex-oauth-proxy: ' + e.message } });
  }
}

async function handleConsumeReset(req, res) {
  let body;
  try {
    body = await readRequestJson(req);
  } catch {
    return sendJson(res, 400, { error: { message: 'invalid JSON request body' } });
  }
  try {
    sendJson(res, 200, await consumeResetCredit(body?.credit_id));
  } catch (e) {
    log('consume reset credit error: ' + e.message);
    sendJson(res, 502, { ok: false, error: { message: 'codex-oauth-proxy: ' + e.message } });
  }
}

export function createProxyServer() {
  let state;
  let instanceFile;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === 'POST' && url.pathname === shutdownPath) {
      if (!shutdownAuthorized(req.headers.authorization, state)) {
        return sendJson(res, 403, { error: 'invalid control token' });
      }
      res.on('finish', () => { server.close(); server.closeAllConnections(); });
      sendJson(res, 200, { ok: true });
      return;
    }
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
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/quota/view')) {
      return void handleDashboard(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/quota') {
      return void handleQuota(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/quota/consume-reset') {
      return void handleConsumeReset(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return void handleHealthz(req, res, state);
    }
    sendJson(res, 404, { error: { message: `not found: ${req.method} ${url.pathname}` } });
  });
  server.on('listening', () => {
    const port = server.address().port;
    instanceFile = statePath(LOG_PATH, port);
    try {
      state = registerProxy(instanceFile, port, fs.existsSync(AUTH_PATH) ? AUTH_PATH : undefined);
    } catch (e) {
      server.close();
      server.emit('error', e);
      return;
    }
    log('codex-oauth-proxy listening on http://' + HOST + ':' + port);
  });
  server.on('close', () => {
    if (state) removeProxyState(instanceFile, state.instanceId);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = createProxyServer();
  // Warm the quota cache so the status line and dashboard stay fast. Done only
  // here, not in createProxyServer: tests must never trigger a real fetch.
  server.on('listening', () => { getQuota().catch(() => {}); });
  server.on('error', (e) => { console.error('codex-oauth-proxy: ' + e.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { server.close(); server.closeAllConnections(); });
  }
  server.listen(PORT, HOST);
}
