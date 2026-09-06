import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomInt } from 'node:crypto';
import { fixture, fakeAuth, httpJson, runNode } from './helpers.mjs';
import { SERVICE, VERSION, stopProxy, statePath } from '../bin/proxy-control.mjs';

const cli = (name) => ['--require', './tests/offline-preload.cjs', './bin/' + name + '.mjs'];
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

async function reserveCliPort() {
  // Other parallel fixtures bind port 0. Keep this short reservation outside
  // the OS ephemeral range so they cannot reuse it before the child starts.
  for (let attempt = 0; attempt < 10; attempt++) {
    const server = http.createServer();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(randomInt(12000, 20000), '127.0.0.1', resolve);
      });
      const port = server.address().port;
      await close(server);
      return port;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('no free port for CLI fixture');
}

test('ensure CLI starts one detached instance; repeated setup and verified stop work', async (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'auth.json');
  const log = path.join(dir, 'proxy.log');
  fs.writeFileSync(file, JSON.stringify(fakeAuth()), { mode: 0o600 });
  const port = await reserveCliPort();
  const env = { CODEX_AUTH_PATH: file, CODEX_OAUTH_LOG: log, CODEX_OAUTH_PORT: String(port) };
  try {
    const started = await runNode(cli('ensure-proxy'), env);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, /started on port/, started.stderr);
    const first = JSON.parse((await httpJson(port)).text);
    assert.equal(first.service, SERVICE);
    assert.equal(first.version, VERSION);
    assert.equal((await runNode(cli('ensure-proxy'), env)).code, 0);
    const again = JSON.parse((await httpJson(port)).text);
    assert.equal(again.instance_id, first.instance_id);
    const stopped = await runNode(cli('stop-proxy'), env);
    assert.equal(stopped.code, 0, stopped.stderr);
    await assert.rejects(httpJson(port), { code: 'ECONNREFUSED' });
  } finally {
    if (fs.existsSync(statePath(log, port))) await stopProxy(log, port);
  }
});

test('ensure CLI leaves unrelated listeners running and startup failures do not block hooks', async (t) => {
  const dir = fixture(t);
  const log = path.join(dir, 'missing-directory', 'proxy.log');
  const server = http.createServer((_req, res) => res.end('{"service":"unrelated"}'));
  await listen(server);
  const port = server.address().port;
  const env = { CODEX_OAUTH_LOG: log, CODEX_OAUTH_PORT: String(port) };
  try {
    const occupied = await runNode(cli('ensure-proxy'), env);
    assert.equal(occupied.code, 0);
    assert.match(occupied.stderr, /port already in use/);
    assert.equal(JSON.parse((await httpJson(port)).text).service, 'unrelated');
  } finally { await close(server); }
  const failed = await runNode(cli('ensure-proxy'), env);
  assert.equal(failed.code, 0);
  assert.match(failed.stderr, /ENOENT/);
  assert.equal(fs.existsSync(log), false);
});
