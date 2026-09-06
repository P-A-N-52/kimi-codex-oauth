#!/usr/bin/env node
// Start the proxy once, and restart identifiable older instances on upgrade.
// Every failure exits zero so a missing login or runtime cannot block a session.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SERVICE, VERSION, stopProxy } from './proxy-control.mjs';

const PORT = Number(process.env.CODEX_OAUTH_PORT || 8317);
const LOG_PATH = process.env.CODEX_OAUTH_LOG || path.join(os.homedir(), '.codex', 'oauth-proxy.log');
const PROXY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-oauth-proxy.mjs');

async function probe() {
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/healthz', {
      signal: AbortSignal.timeout(1500), redirect: 'error',
    });
    try { return await res.json(); } catch { return { service: 'unknown' }; }
  } catch (e) {
    if (e.cause?.code === 'ECONNREFUSED') return null;
    throw new Error('cannot verify the existing proxy listener');
  }
}

try {
  const current = await probe();
  if (current) {
    if (current.service !== SERVICE) throw new Error('port already in use; stop a verified v0.1.0 proxy manually before upgrading');
    if (current.version === VERSION) process.exit(0);
    await stopProxy(LOG_PATH, PORT);
  }
  const out = fs.openSync(LOG_PATH, 'a', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [PROXY], {
      detached: true, stdio: ['ignore', out, out], windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
  } finally { fs.closeSync(out); }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    let health;
    // Registering the private instance file can briefly block the Windows
    // child while its ACL helper runs. Allow the full startup deadline.
    try { health = await probe(); } catch { continue; }
    if (health?.service === SERVICE && health.version === VERSION && health.pid === child.pid) {
      console.log('codex-oauth-proxy started on port ' + PORT);
      process.exit(0);
    }
  }
  throw new Error('proxy did not start within 8s; check the local proxy log');
} catch (e) {
  console.error('kimi-codex-oauth: ' + e.message);
}
process.exit(0);
