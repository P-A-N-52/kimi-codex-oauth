import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const repo = fileURLToPath(new URL('..', import.meta.url));
export function fixture(t) {
  const root = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(root, 'kimi-oauth-test-'));
  t.after(() => {
    if (path.dirname(path.resolve(dir)) !== root) throw new Error('unexpected fixture directory');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

export function httpJson(port, route = '/healthz', { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('test request timed out')));
    req.end(body);
  });
}

export function runNode(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repo, env: { ...process.env, ...env }, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    const timeout = setTimeout(() => child.kill(), 20000);
    child.on('close', (code) => { clearTimeout(timeout); resolve({ code, stdout, stderr }); });
  });
}

export function fakeAuth(expired = false) {
  const exp = Math.floor(Date.now() / 1000) + (expired ? -60 : 3600);
  return { auth_mode: 'chatgpt', tokens: {
    access_token: 'synthetic.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.not-real',
    refresh_token: 'synthetic-refresh-never-send', account_id: 'synthetic-account',
  } };
}
