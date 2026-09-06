import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
