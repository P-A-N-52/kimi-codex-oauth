#!/usr/bin/env node
// Stop only the listener authenticated by this proxy's private instance state.
import path from 'node:path';
import os from 'node:os';
import { stopProxy } from './proxy-control.mjs';

const PORT = Number(process.env.CODEX_OAUTH_PORT || 8317);
const LOG_PATH = process.env.CODEX_OAUTH_LOG || path.join(os.homedir(), '.codex', 'oauth-proxy.log');
try {
  console.log('kimi-codex-oauth proxy: ' + await stopProxy(LOG_PATH, PORT));
} catch (e) {
  console.error('kimi-codex-oauth: ' + e.message);
  process.exitCode = 1;
}
