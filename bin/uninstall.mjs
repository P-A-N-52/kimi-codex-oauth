#!/usr/bin/env node
// Reversible configuration cleanup; never delete Codex credentials or user
// model settings. The plugin itself must also be removed in Kimi Code.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { cleanManagedConfig, writeConfig } from './config-file.mjs';
import { stopProxy } from './proxy-control.mjs';

const PORT = Number(process.env.CODEX_OAUTH_PORT || 8317);
const LOG_PATH = process.env.CODEX_OAUTH_LOG || path.join(os.homedir(), '.codex', 'oauth-proxy.log');
const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
const CONFIG_PATH = path.join(KIMI_HOME, 'config.toml');
const args = process.argv.slice(2);

try {
  if (args.some((arg) => arg !== '--dry-run')) throw new Error('usage: node bin/uninstall.mjs [--dry-run]');
  const previous = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH, 'utf8') : '';
  const plan = cleanManagedConfig(previous);
  console.log('Managed sections to remove: ' + (plan.removed.join(', ') || '(none)'));
  if (plan.retained.length) {
    console.log('Retained because still referenced (including personal overrides): ' + plan.retained.join(', '));
  }
  if (args.includes('--dry-run')) {
    console.log('Preview only; no files changed and no process stopped.');
  } else {
    console.log('Proxy: ' + await stopProxy(LOG_PATH, PORT));
    const backup = writeConfig(CONFIG_PATH, previous, plan.content);
    if (backup) console.log('Original configuration saved to ' + backup);
    console.log('Cleanup complete. Run /plugins remove kimi-codex-oauth and /reload before starting another session.');
  }
} catch (e) {
  console.error('kimi-codex-oauth uninstall: ' + e.message);
  process.exitCode = 1;
}
