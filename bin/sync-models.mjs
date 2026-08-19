#!/usr/bin/env node
// sync-models — keep `chatgpt/*` model aliases in Kimi Code's config.toml in
// sync with the account's real upstream model list (via the local proxy).
//
//   - Add:    new upstream slugs get an alias generated from real metadata
//             (context_window, input_modalities, supported_reasoning_levels…).
//   - Repair: entries carrying the "# managed-by: kimi-codex-oauth" marker are
//             reconciled back to upstream values if they were edited/broken.
//   - Remove: managed entries whose slug disappeared upstream (retired model)
//             or that became unusable (login switched to API key) are deleted —
//             unless still referenced by default_model / secondary_model, in
//             which case they are kept and a warning is printed.
//   - Hands off: entries without the marker are user-owned and never touched;
//             [models."chatgpt/x".overrides] tables are never touched either.
//
// Writes only when something actually changed, and only after the candidate
// config passes `kimi doctor` in a sandbox. Fail-open (always exits 0) so it
// is safe to run from a SessionStart hook.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const PORT = Number(process.env.CODEX_OAUTH_PORT || 8317);
const KIMI_HOME = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
const CONFIG_PATH = path.join(KIMI_HOME, 'config.toml');
const MARKER = '# managed-by: kimi-codex-oauth';

// Values accepted on the wire as reasoning.effort (verified against the
// backend: it rejects e.g. "ultra", which the models endpoint lists but which
// is a client-side delegation mode, not a wire effort).
const WIRE_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function wireEfforts(m) {
  return (m.supported_reasoning_levels ?? [])
    .map((e) => e && e.effort)
    .filter((e) => WIRE_EFFORTS.has(e));
}

// Only slugs that are safe inside a quoted TOML table header.
const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/i;

// Validate candidate config content before it touches the real config.toml.
// Primary: `kimi doctor` against a sandboxed KIMI_CODE_HOME (the same strict
// checks the CLI itself applies). Fallback: python3 tomllib. If neither
// validator exists, accept. Returns null when valid, an error string when not.
// On Windows the CLI binary is kimi.cmd / kimi.exe, so try several names.
const KIMI_BIN_NAMES = process.platform === 'win32' ? ['kimi.cmd', 'kimi.exe', 'kimi'] : ['kimi'];

function validateConfig(content) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-codex-oauth-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'config.toml'), content);
    for (const bin of KIMI_BIN_NAMES) {
      const doctor = spawnSync(bin, ['doctor'], {
        env: { ...process.env, KIMI_CODE_HOME: tmpDir },
        timeout: 20000,
        encoding: 'utf8',
      });
      if (doctor.error) continue; // binary not found under this name
      if (doctor.status === 0) return null;
      return `kimi doctor: ${`${doctor.stdout}\n${doctor.stderr}`.trim().slice(0, 300)}`;
    }
    const py = spawnSync(
      'python3',
      ['-c', 'import sys,tomllib;tomllib.load(open(sys.argv[1],"rb"))', path.join(tmpDir, 'config.toml')],
      { timeout: 10000, encoding: 'utf8' },
    );
    if (py.error || (py.stderr ?? '').includes('No module named')) return null;
    return py.status === 0 ? null : `TOML parse error: ${(py.stderr ?? '').trim().slice(0, 200)}`;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const PROVIDER_HEADER = '[providers.chatgpt-oauth]';
const PROVIDER_FIELDS = {
  type: '"openai_responses"',
  base_url: `"http://127.0.0.1:${PORT}/v1"`,
  api_key: '"local-proxy"',
};

function tomlStr(s) {
  return JSON.stringify(String(s));
}

// Expected managed fields for a model, derived from upstream metadata.
// Managed fields reconciled on every sync. default_effort is intentionally
// NOT managed: it is a user preference — set once at creation (highest level)
// and never repaired afterwards.
function modelFields(m) {
  const slug = m.slug ?? m.id;
  const fields = {
    provider: '"chatgpt-oauth"',
    model: tomlStr(slug),
    max_context_size: String(Number(m.context_window) > 0 ? Number(m.context_window) : 272000),
  };
  const capabilities = ['thinking', 'tool_use'];
  if ((m.input_modalities ?? []).includes('image')) capabilities.push('image_in');
  fields.capabilities = `[ ${capabilities.map(tomlStr).join(', ')} ]`;
  fields.display_name = tomlStr((m.display_name ?? slug) + ' (ChatGPT OAuth)');
  const efforts = wireEfforts(m);
  if (efforts.length > 0) {
    fields.support_efforts = `[ ${efforts.map(tomlStr).join(', ')} ]`;
  }
  return fields;
}

function modelCreateFields(m) {
  const fields = modelFields(m);
  const efforts = wireEfforts(m);
  if (efforts.length > 0) {
    // default to the highest supported thinking level; user edits win afterwards
    fields.default_effort = tomlStr(efforts[efforts.length - 1]);
  }
  return fields;
}

function blockFromFields(header, fields) {
  const lines = ['', header, MARKER];
  for (const [k, v] of Object.entries(fields)) lines.push(`${k} = ${v}`);
  return lines.join('\n') + '\n';
}

// Reconcile managed field lines inside a block body (lines after the header).
// Returns { body, changed }.
function reconcileBody(body, fields) {
  const lines = body.split('\n');
  let changed = false;
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-z_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, key, value] = m;
    if (!(key in fields)) continue; // not ours — leave alone
    seen.add(key);
    if (value.trim() !== fields[key]) {
      lines[i] = `${key} = ${fields[key]}`;
      changed = true;
    }
  }
  // Insert managed fields that are missing entirely (e.g. deleted by accident).
  const missing = Object.entries(fields).filter(([k]) => !seen.has(k));
  if (missing.length) {
    const insertAt = lines.findIndex((l) => l.trim() === MARKER);
    const at = insertAt >= 0 ? insertAt + 1 : 0;
    lines.splice(at, 0, ...missing.map(([k, v]) => `${k} = ${v}`));
    changed = true;
  }
  return { body: lines.join('\n'), changed };
}

try {
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/models`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`proxy returned HTTP ${res.status}`);
  const data = await res.json();
  const models = (data.data ?? [])
    .filter((m) => m && (m.slug || m.id))
    .filter((m) => SLUG_RE.test(m.slug ?? m.id)); // keep TOML-safe slugs only
  const authMode = data.auth_mode ?? 'missing';
  // Do nothing unless we know the auth state. A transient upstream failure
  // (live:false under chatgpt auth) must never trigger repairs or deletions.
  if (authMode !== 'chatgpt' && authMode !== 'apikey') process.exit(0);
  if (authMode === 'chatgpt' && (!data.live || models.length === 0)) {
    console.error('kimi-codex-oauth sync-models: upstream list unavailable, skipping');
    process.exit(0);
  }
  const bySlug = new Map(models.map((m) => [m.slug ?? m.id, m]));

  const config = fs.readFileSync(CONFIG_PATH, 'utf8');
  const existing = new Set(
    [...config.matchAll(/^\[models\."chatgpt\/([^"]+)"\]$/gm)].map((m) => m[1]),
  );
  // Aliases referenced as default models must never be deleted — removing
  // them would make the whole config fail Kimi's startup validation.
  const referenced = new Set();
  for (const m of config.matchAll(/default_model\s*=\s*"chatgpt\/([^"]+)"/g)) referenced.add(m[1]);
  for (const m of config.matchAll(/^\s*"chatgpt\/([^"]+)"\s*=/gm)) referenced.add(m[1]);

  let out = config;
  const added = [];
  const repaired = [];
  const removed = [];
  const keptReferenced = [];

  // 1) Reconcile managed blocks: repair drift, delete stale entries.
  //    "Stale" = slug gone from upstream (chatgpt auth) or login switched to
  //    API key (then every managed chatgpt entry is unusable).
  const headerRe = /^\[(?:models\."chatgpt\/[^"]+"|providers\.chatgpt-oauth)\]$/gm;
  const headers = [...config.matchAll(headerRe)];
  for (let i = headers.length - 1; i >= 0; i--) {
    const start = headers[i].index;
    const header = headers[i][0];
    const nextHeader = out.indexOf('\n[', start + header.length);
    const end = nextHeader === -1 ? out.length : nextHeader + 1;
    const body = out.slice(start + header.length, end);
    if (!body.includes(MARKER)) continue; // user-owned — hands off
    if (header === PROVIDER_HEADER) {
      if (authMode === 'chatgpt') {
        const { body: fixed, changed } = reconcileBody(body, PROVIDER_FIELDS);
        if (changed) {
          out = out.slice(0, start + header.length) + fixed + out.slice(end);
          repaired.push(header);
        }
      }
      continue; // provider deletion handled after the model pass
    }
    const slug = header.match(/chatgpt\/([^"]+)/)[1];
    const stale = authMode === 'apikey' || !bySlug.has(slug);
    if (stale) {
      if (referenced.has(slug)) {
        keptReferenced.push(slug); // in use as a default model — keep, but warn
        continue;
      }
      out = (out.slice(0, start) + out.slice(end)).replace(/\n{3,}/g, '\n\n');
      removed.push(slug);
      continue;
    }
    const { body: fixed, changed } = reconcileBody(body, modelFields(bySlug.get(slug)));
    if (changed) {
      out = out.slice(0, start + header.length) + fixed + out.slice(end);
      repaired.push(header);
    }
  }

  // 2) Provider block cleanup/addition.
  const anyModelLeft = /^\[models\."chatgpt\//m.test(out);
  const providerPresent = new RegExp(`^\\${PROVIDER_HEADER}$`, 'm').test(out);
  if (authMode === 'apikey' && providerPresent && !anyModelLeft) {
    // No chatgpt models remain (or only user-owned ones reference their own
    // providers) — remove the managed provider block if it is managed.
    const m = out.match(new RegExp(`^\\${PROVIDER_HEADER}$`, 'm'));
    const start = m.index;
    const nextHeader = out.indexOf('\n[', start + PROVIDER_HEADER.length);
    const end = nextHeader === -1 ? out.length : nextHeader + 1;
    if (out.slice(start, end).includes(MARKER)) {
      out = (out.slice(0, start) + out.slice(end)).replace(/\n{3,}/g, '\n\n');
      removed.push('(provider)');
    }
  }

  // 3) Add missing entries (chatgpt auth only; provider first, then models).
  if (authMode === 'chatgpt') {
    let addition = '';
    if (!new RegExp(`^\\${PROVIDER_HEADER}$`, 'm').test(out)) {
      addition += blockFromFields(PROVIDER_HEADER, PROVIDER_FIELDS);
    }
    for (const m of models) {
      const slug = m.slug ?? m.id;
      if (!existing.has(slug)) {
        addition += blockFromFields(`[models."chatgpt/${slug}"]`, modelCreateFields(m));
        added.push(slug);
      }
    }
    if (addition) out = out.trimEnd() + '\n' + addition;
  }

  if (out === config) process.exit(0);
  // Never write a config that Kimi Code itself would reject.
  const invalid = validateConfig(out);
  if (invalid) {
    console.error(`kimi-codex-oauth sync-models: refusing to write config.toml (${invalid})`);
    process.exit(0);
  }
  const tmp = CONFIG_PATH + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, CONFIG_PATH);
  const parts = [];
  if (added.length) parts.push(`added: ${added.map((s) => 'chatgpt/' + s).join(', ')}`);
  if (repaired.length) parts.push(`repaired: ${repaired.join(', ')}`);
  if (removed.length) parts.push(`removed: ${removed.map((s) => (s.startsWith('(') ? s : 'chatgpt/' + s)).join(', ')}`);
  console.log('kimi-codex-oauth: config.toml updated (' + parts.join('; ') + ')');
  if (keptReferenced.length) {
    console.error(
      `kimi-codex-oauth: kept stale aliases still referenced as default models: ` +
      keptReferenced.map((s) => 'chatgpt/' + s).join(', ') +
      ' — switch default_model / secondary_model away from them to allow cleanup',
    );
  }
} catch (e) {
  console.error(`kimi-codex-oauth sync-models: ${e.message}`);
}
process.exit(0);
