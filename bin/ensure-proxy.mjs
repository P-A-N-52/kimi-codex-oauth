#!/usr/bin/env node
// ensure-proxy — idempotently start codex-oauth-proxy in the background.
// Safe to run repeatedly: exits immediately if the proxy is already healthy.
// Always exits 0 (fail-open) so hooks never block a session.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.CODEX_OAUTH_PORT || 8317);
const LOG_PATH = process.env.CODEX_OAUTH_LOG || path.join(os.homedir(), '.codex', 'oauth-proxy.log');
const PROXY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'codex-oauth-proxy.mjs');

async function healthy() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

if (await healthy()) process.exit(0);

const out = fs.openSync(LOG_PATH, 'a');
const child = spawn(process.execPath, [PROXY], {
  detached: true,
  stdio: ['ignore', out, out],
  windowsHide: true, // no console window flash when spawned on Windows
});
child.unref();
fs.closeSync(out);

const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 300));
  if (await healthy()) {
    console.log(`codex-oauth-proxy started on port ${PORT}`);
    process.exit(0);
  }
}
console.error(`codex-oauth-proxy did not become healthy within 8s; see ${LOG_PATH}`);
process.exit(0); // fail-open
