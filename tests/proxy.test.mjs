import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fixture, fakeAuth, httpJson, runNode } from './helpers.mjs';
import { stopProxy, statePath, SERVICE, shutdownPath } from '../bin/proxy-control.mjs';

const realFetch = globalThis.fetch;
let sequence = 0;
async function start(t, expired = false) {
  const dir = fixture(t);
  const file = path.join(dir, 'auth.json');
  const log = path.join(dir, 'proxy.log');
  fs.writeFileSync(file, JSON.stringify(fakeAuth(expired)), { mode: 0o600 });
  const previous = { CODEX_AUTH_PATH: process.env.CODEX_AUTH_PATH, CODEX_OAUTH_LOG: process.env.CODEX_OAUTH_LOG };
  process.env.CODEX_AUTH_PATH = file;
  process.env.CODEX_OAUTH_LOG = log;
  let module;
  try { module = await import('../bin/codex-oauth-proxy.mjs?fixture=' + sequence++); }
  finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  const server = module.createProxyServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { globalThis.fetch = realFetch; server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  return { dir, file, log, server, port, env: {
    CODEX_AUTH_PATH: file, CODEX_OAUTH_LOG: log, CODEX_OAUTH_PORT: String(port),
    KIMI_CODE_HOME: dir, KIMI_TEST_VALIDATOR: 'accept',
  } };
}
const requestBody = JSON.stringify({ model: 'fixture-model', input: 'offline fixture' });
const post = (port) => httpJson(port, '/v1/responses', {
  method: 'POST', body: requestBody, headers: { 'content-type': 'application/json' },
});
const completed = () => new Response('data: {"type":"response.completed"}\n\n', {
  status: 200, headers: { 'content-type': 'text/event-stream' },
});

test('successful refresh is single-flight and atomically updates synthetic credentials', async (t) => {
  const instance = await start(t, true);
  let refreshes = 0;
  let responses = 0;
  const fresh = fakeAuth().tokens.access_token;
  globalThis.fetch = async (url, options) => {
    if (url === 'https://auth.openai.com/oauth/token') {
      refreshes++;
      assert.equal(JSON.parse(options.body).refresh_token, 'synthetic-refresh-never-send');
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json({ access_token: fresh, refresh_token: 'synthetic-next-refresh' });
    }
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(options.headers.authorization, 'Bearer ' + fresh);
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.stream, true);
    responses++;
    return completed();
  };
  const results = await Promise.all([post(instance.port), post(instance.port)]);
  assert.ok(results.every((result) => result.status === 200 && result.text.includes('response.completed')));
  assert.equal(refreshes, 1);
  assert.equal(responses, 2);
  assert.equal(JSON.parse(fs.readFileSync(instance.file)).tokens.refresh_token, 'synthetic-next-refresh');
  const log = fs.readFileSync(instance.log, 'utf8');
  assert.ok(!log.includes('synthetic-next-refresh') && !log.includes(fresh));
  if (process.platform !== 'win32') assert.equal(fs.statSync(instance.file).mode & 0o777, 0o600);
});

test('refresh errors preserve auth bytes and exclude upstream error bodies from logs', async (t) => {
  const instance = await start(t, true);
  const original = fs.readFileSync(instance.file, 'utf8');
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    return new Response('synthetic-refresh-never-send', { status: 400 });
  };
  const result = await post(instance.port);
  assert.equal(result.status, 502);
  assert.match(result.text, /HTTP 400/);
  assert.equal(fs.readFileSync(instance.file, 'utf8'), original);
  assert.ok(!result.text.includes('synthetic-refresh-never-send'));
  assert.ok(!fs.readFileSync(instance.log, 'utf8').includes('synthetic-refresh-never-send'));
});

test('malformed refresh JSON and login cache never leak their contents', async (t) => {
  const instance = await start(t, true);
  const original = fs.readFileSync(instance.file, 'utf8');
  const secret = 'synthetic-secret-marker-never-log';
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    return new Response('invalid-json ' + secret, { status: 200 });
  };
  const refresh = await post(instance.port);
  assert.equal(refresh.status, 502);
  assert.match(refresh.text, /invalid JSON/);
  assert.equal(fs.readFileSync(instance.file, 'utf8'), original);
  fs.writeFileSync(instance.file, 'invalid-json ' + secret);
  const cache = await post(instance.port);
  assert.equal(cache.status, 502);
  assert.match(cache.text, /invalid JSON/);
  assert.ok(!refresh.text.includes(secret) && !cache.text.includes(secret));
  fs.writeFileSync(instance.file, JSON.stringify(fakeAuth()));
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/models?client_version=1.0.0');
    return new Response('invalid-json ' + secret, { status: 200 });
  };
  const models = await httpJson(instance.port, '/v1/models');
  assert.equal(JSON.parse(models.text).live, false);
  assert.ok(!models.text.includes(secret));
  assert.ok(!fs.readFileSync(instance.log, 'utf8').includes(secret));
});

test('upstream 401 forces one refresh and retries the response once', async (t) => {
  const instance = await start(t);
  let refreshes = 0;
  let responses = 0;
  globalThis.fetch = async (url) => {
    if (url === 'https://auth.openai.com/oauth/token') {
      refreshes++;
      return Response.json({ access_token: fakeAuth().tokens.access_token, refresh_token: 'synthetic-retry-refresh' });
    }
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    return ++responses === 1 ? new Response('', { status: 401 }) : completed();
  };
  assert.equal((await post(instance.port)).status, 200);
  assert.equal(refreshes, 1);
  assert.equal(responses, 2);
});

test('logout or switching login during refresh is not overwritten', async (t) => {
  const instance = await start(t, true);
  const switched = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-api-key' });
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://auth.openai.com/oauth/token');
    fs.writeFileSync(instance.file, switched);
    return Response.json({ access_token: fakeAuth().tokens.access_token });
  };
  const result = await post(instance.port);
  assert.equal(result.status, 502);
  assert.match(result.text, /login changed/);
  assert.equal(fs.readFileSync(instance.file, 'utf8'), switched);
});

test('health and shutdown do not disclose secrets; only instance-authenticated stop succeeds', async (t) => {
  const instance = await start(t);
  globalThis.fetch = async () => { throw new Error('unexpected upstream request'); };
  const health = await httpJson(instance.port);
  assert.equal(JSON.parse(health.text).service, SERVICE);
  assert.ok(!health.text.includes('synthetic-refresh-never-send'));
  assert.ok(!health.text.includes('shutdownToken'));
  assert.equal((await httpJson(instance.port, shutdownPath, { method: 'POST' })).status, 403);
  assert.equal(await stopProxy(instance.log, instance.port, { request: realFetch }), 'stopped');
  assert.equal(fs.existsSync(statePath(instance.log, instance.port)), false);
  await assert.rejects(httpJson(instance.port), { code: 'ECONNREFUSED' });
});

test('mismatched listener identity is never sent a shutdown request', async (t) => {
  const dir = fixture(t);
  const log = path.join(dir, 'proxy.log');
  const file = statePath(log, 12345);
  fs.writeFileSync(file, JSON.stringify({
    service: SERVICE, port: 12345, pid: 123, instanceId: 'original-instance', shutdownToken: 'synthetic-control',
  }));
  let calls = 0;
  await assert.rejects(stopProxy(log, 12345, { request: async (_url, options) => {
    calls++;
    assert.equal(options.method, undefined);
    return Response.json({ service: SERVICE, pid: 456, instance_id: 'different-instance' });
  } }), /does not match/);
  assert.equal(calls, 1);
  assert.ok(fs.existsSync(file));
});

test('uninstall preview is read-only; cleanup stops the instance, backs up config and retains auth', async (t) => {
  const instance = await start(t);
  globalThis.fetch = async () => { throw new Error('unexpected upstream request'); };
  const config = 'default_model = "other/test"\n[providers.chatgpt-oauth]\n# managed-by: kimi-codex-oauth\n' +
    'type = "openai_responses"\n[models."chatgpt/old"]\n# managed-by: kimi-codex-oauth\nprovider = "chatgpt-oauth"\n';
  const configFile = path.join(instance.dir, 'config.toml');
  fs.writeFileSync(configFile, config);
  const auth = fs.readFileSync(instance.file, 'utf8');
  const args = ['--require', './tests/offline-preload.cjs', './bin/uninstall.mjs'];
  const preview = await runNode([...args, '--dry-run'], instance.env);
  assert.equal(preview.code, 0, preview.stderr);
  assert.equal(fs.readFileSync(configFile, 'utf8'), config);
  assert.ok(instance.server.listening);
  const applied = await runNode(args, instance.env);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(instance.server.listening, false);
  assert.equal(fs.readFileSync(configFile, 'utf8'), 'default_model = "other/test"\n');
  assert.equal(fs.readFileSync(instance.file, 'utf8'), auth);
  const backups = fs.readdirSync(instance.dir).filter((name) => name.startsWith('config.toml.bak-'));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(instance.dir, backups[0]), 'utf8'), config);
  const repeated = await runNode(args, instance.env);
  assert.equal(repeated.code, 0, repeated.stderr);
});

const usageFixture = (used) => ({
  plan_type: 'plus',
  rate_limit: {
    allowed: used < 100,
    limit_reached: used >= 100,
    primary_window: {
      used_percent: used, limit_window_seconds: 18000,
      reset_after_seconds: 3600, reset_at: Math.floor(Date.now() / 1000) + 3600,
    },
    secondary_window: {
      used_percent: 12.4, limit_window_seconds: 604800,
      reset_after_seconds: 86400, reset_at: Math.floor(Date.now() / 1000) + 86400,
    },
  },
  rate_limit_reset_credits: { available_count: 2 },
});
const creditsFixture = () => ({
  credits: [
    {
      id: 'RateLimitResetCredit_synthetic1', status: 'available',
      granted_at: '2026-06-12T01:33:14Z', expires_at: '2026-07-12T01:33:14Z',
    },
    { id: 'RateLimitResetCredit_synthetic2', status: 'redeemed' },
  ],
});
const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

test('quota reports remaining percent and reset credits, and caches upstream calls', async (t) => {
  const instance = await start(t);
  let usageCalls = 0;
  globalThis.fetch = async (url) => {
    if (url === USAGE_URL) { usageCalls++; return Response.json(usageFixture(40)); }
    if (url === CREDITS_URL) return Response.json(creditsFixture());
    throw new Error('unexpected upstream request: ' + url);
  };
  const first = await httpJson(instance.port, '/quota');
  assert.equal(first.status, 200);
  const quota = JSON.parse(first.text);
  assert.equal(quota.ok, true);
  assert.equal(quota.plan_type, 'plus');
  assert.equal(quota.primary_window.remaining_percent, 60);
  assert.ok(quota.primary_window.resets_in_s > 3500 && quota.primary_window.resets_in_s <= 3600);
  assert.equal(quota.secondary_window.used_percent, 12);
  assert.equal(quota.reset_credits.available_count, 2);
  assert.equal(quota.reset_credits.credits.length, 2);
  assert.equal(quota.reset_credits.credits[0].expires_at, '2026-07-12T01:33:14Z');
  const second = await httpJson(instance.port, '/quota');
  assert.equal(second.status, 200);
  assert.equal(usageCalls, 1);
  assert.ok(!first.text.includes('synthetic-refresh-never-send'));
});

test('consume reset credit picks the soonest-expiring credit, sends idempotency key and refreshes quota', async (t) => {
  const instance = await start(t);
  let used = 100;
  let consumedBody = null;
  globalThis.fetch = async (url, options = {}) => {
    if (url === USAGE_URL) return Response.json(usageFixture(used));
    if (url === CREDITS_URL) return Response.json(creditsFixture());
    if (url === CREDITS_URL + '/consume') {
      assert.equal(options.method, 'POST');
      consumedBody = JSON.parse(options.body);
      used = 0;
      return Response.json({
        code: 'reset', windows_reset: 1,
        credit: { id: consumedBody.credit_id, status: 'redeemed', redeemed_at: '2026-06-13T13:12:31Z' },
      });
    }
    throw new Error('unexpected upstream request: ' + url);
  };
  const res = await httpJson(instance.port, '/quota/consume-reset', {
    method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const result = JSON.parse(res.text);
  assert.equal(result.ok, true);
  assert.equal(result.credit_id, 'RateLimitResetCredit_synthetic1');
  assert.equal(result.windows_reset, 1);
  assert.equal(result.redeemed_at, '2026-06-13T13:12:31Z');
  assert.match(consumedBody.redeem_request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(result.quota.primary_window.used_percent, 0);
  assert.equal(result.quota.limit_reached, false);
  assert.ok(!res.text.includes('synthetic-refresh-never-send'));
});

test('quota failures never include upstream response bodies in output or logs', async (t) => {
  const instance = await start(t);
  const secret = 'synthetic-quota-secret-never-log';
  globalThis.fetch = async () => new Response(secret, { status: 403 });
  const res = await httpJson(instance.port, '/quota');
  assert.equal(res.status, 502);
  assert.match(res.text, /HTTP 403/);
  assert.ok(!res.text.includes(secret));
  assert.ok(!fs.readFileSync(instance.log, 'utf8').includes(secret));
});

test('quota CLI renders the card and hints at ensure-proxy when the proxy is down', async (t) => {
  const instance = await start(t);
  globalThis.fetch = async (url) => {
    if (url === USAGE_URL) return Response.json(usageFixture(40));
    if (url === CREDITS_URL) return Response.json(creditsFixture());
    throw new Error('unexpected upstream request: ' + url);
  };
  const args = ['--require', './tests/offline-preload.cjs', './bin/quota.mjs'];
  const ok = await runNode(args, instance.env);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /套餐 plus/);
  assert.match(ok.stdout, /剩余 60%/);
  assert.match(ok.stdout, /5小时窗口/);
  assert.match(ok.stdout, /每周窗口/);
  assert.match(ok.stdout, /重置卡\s+2 张可用/);
  assert.ok(!ok.stdout.includes('synthetic'));
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const freePort = probe.address().port;
  probe.close();
  await once(probe, 'close');
  const down = await runNode(args, { ...instance.env, CODEX_OAUTH_PORT: String(freePort) });
  assert.equal(down.code, 1);
  assert.match(down.stderr, /ensure-proxy/);
});

test('dashboard serves a self-contained page with a locked-down CSP', async (t) => {
  const instance = await start(t);
  globalThis.fetch = async () => { throw new Error('unexpected upstream request'); };
  for (const route of ['/', '/quota/view']) {
    const res = await httpJson(instance.port, route);
    assert.equal(res.status, 200);
    assert.match(res.text, /ChatGPT 订阅额度/);
    assert.match(res.text, /Content-Security-Policy/);
    assert.ok(!res.text.includes('https://'), 'dashboard must not reference external resources');
  }
});

test('quota CLI --statusline prints one compact line and stays silent when down', async (t) => {
  const instance = await start(t);
  globalThis.fetch = async (url) => {
    if (url === USAGE_URL) return Response.json(usageFixture(40));
    if (url === CREDITS_URL) return Response.json(creditsFixture());
    throw new Error('unexpected upstream request: ' + url);
  };
  const args = ['--require', './tests/offline-preload.cjs', './bin/quota.mjs', '--statusline'];
  const ok = await runNode(args, instance.env);
  assert.equal(ok.code, 0, ok.stderr);
  const lines = ok.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /5h余60%/);
  assert.match(lines[0], /周余88%/);
  assert.match(lines[0], /重置卡×2/);
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const freePort = probe.address().port;
  probe.close();
  await once(probe, 'close');
  const down = await runNode(args, { ...instance.env, CODEX_OAUTH_PORT: String(freePort) });
  assert.equal(down.code, 1);
  assert.equal(down.stdout.trim(), '');
});
