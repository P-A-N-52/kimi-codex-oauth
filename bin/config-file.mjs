// Shared validation and conservative cleanup of plugin-managed TOML sections.
// A missing validator is an error for a write, never an error for session start.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writePrivateAtomic } from './private-file.mjs';

export const MARKER = '# managed-by: kimi-codex-oauth';

export function validateConfig(content, { run = spawnSync, platform = process.platform } = {}) {
  const tempRoot = path.resolve(os.tmpdir());
  const tmpDir = fs.mkdtempSync(path.join(tempRoot, 'kimi-codex-oauth-'));
  const candidate = path.join(tmpDir, 'config.toml');
  const deadline = Date.now() + 8000;
  try {
    writePrivateAtomic(candidate, content);
    const invoke = (bin, args) => run(bin, args, {
      env: { ...process.env, KIMI_CODE_HOME: tmpDir },
      timeout: Math.max(1, deadline - Date.now()), encoding: 'utf8', windowsHide: true,
    });
    const kimiCommands = platform === 'win32'
      ? [['kimi.exe', ['doctor']], ['cmd.exe', ['/d', '/s', '/c', 'kimi.cmd doctor']]]
      : [['kimi', ['doctor']]];
    for (const [bin, args] of kimiCommands) {
      const doctor = invoke(bin, args);
      if (doctor.error?.code === 'ENOENT') continue;
      // cmd.exe exists even when kimi.cmd does not; 9009 means command missing.
      if (bin === 'cmd.exe' && doctor.status === 9009) continue;
      if (doctor.error || doctor.status === null) return 'configuration validator could not complete';
      if (doctor.status === 0) return null;
      return 'kimi doctor rejected the candidate configuration';
    }
    const code = [
      'import sys',
      'try: import tomllib',
      'except ImportError: sys.exit(77)',
      'with open(sys.argv[1], "rb") as f: tomllib.load(f)',
    ].join('\n');
    const pythonCommands = platform === 'win32'
      ? [['python', []], ['py', ['-3']], ['python3', []]]
      : [['python3', []], ['python', []]];
    for (const [bin, prefix] of pythonCommands) {
      const py = invoke(bin, [...prefix, '-c', code, candidate]);
      if (py.error?.code === 'ENOENT' || py.status === 77) continue;
      if (py.error || py.status === null) return 'TOML validator could not complete';
      return py.status === 0 ? null : 'TOML validator rejected the candidate configuration';
    }
    return 'no configuration validator available; install Kimi Code or Python 3.11+';
  } finally {
    // This directory was created above; never recursively remove a caller path.
    if (path.dirname(path.resolve(tmpDir)) !== tempRoot) throw new Error('unexpected validator directory');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export function writeConfig(file, previous, next, { validate = validateConfig } = {}) {
  if (next === previous) return null;
  const invalid = validate(next);
  if (invalid) throw new Error(invalid);
  const checkUnchanged = () => {
    if (fs.readFileSync(file, 'utf8') !== previous) {
      throw new Error('config.toml changed while preparing the update; retry in a new session');
    }
  };
  checkUnchanged();
  const backup = file + '.bak-kimi-codex-oauth-' + Date.now() + '-' + randomBytes(6).toString('hex');
  writePrivateAtomic(backup, previous, { permissionsFrom: file });
  writePrivateAtomic(file, next, { beforeRename: checkUnchanged });
  return backup;
}

// Track strings and arrays so apparent headers/markers inside multiline values
// are never interpreted as tables owned by the plugin.
export function tomlLines(config) {
  const result = [];
  let quote = null;
  let multiline = false;
  let depth = 0;
  let offset = 0;
  for (const line of config.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    result.push({ text: line, start: offset, topLevel: !quote && depth === 0 });
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (quote === '"' && c === '\\') { i++; continue; }
        if (multiline && line.slice(i, i + 3) === quote.repeat(3)) {
          while (line[i + 1] === quote) i++;
          quote = null; multiline = false;
        } else if (!multiline && c === quote) quote = null;
        continue;
      }
      if (c === '#') break;
      if (c === '"' || c === "'") {
        quote = c;
        multiline = line.slice(i, i + 3) === c.repeat(3);
        if (multiline) i += 2;
      } else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
    }
    offset += line.length;
  }
  return result;
}

export function sections(config) {
  const result = [{ start: 0, header: '', managed: false }];
  for (const line of tomlLines(config)) {
    if (!line.topLevel) continue;
    const header = line.text.trim().match(/^(\[(?:[^"'#\r\n]|"(?:\\.|[^"])*"|'[^']*')+\])\s*(?:#.*)?$/);
    if (header) result.push({ start: line.start, header: header[1], managed: false });
    if (line.text.trim() === MARKER) result.at(-1).managed = true;
  }
  return result.map((section, i) => ({
    ...section, end: result[i + 1]?.start ?? config.length,
    text: config.slice(section.start, result[i + 1]?.start ?? config.length),
  }));
}

export function cleanManagedConfig(config) {
  const blocks = sections(config);
  const removed = [];
  const retained = [];
  const kept = blocks.filter((block) => {
    const model = block.header.match(/^\[models\."(chatgpt\/[a-z0-9._-]+)"\]$/i);
    if (!block.managed || !model) return true;
    const alias = model[1];
    const other = config.slice(0, block.start) + config.slice(block.end);
    // Conservative: even a reference in a comment keeps an alias. Personal
    // override tables, default models and secondary pools therefore survive.
    if (other.includes('"' + alias + '"') || other.includes("'" + alias + "'")) {
      retained.push(alias);
      return true;
    }
    removed.push(alias);
    return false;
  });
  const providerReferenced = kept.some((block) =>
    block.header !== '[providers.chatgpt-oauth]' &&
    block.text.includes('chatgpt-oauth'));
  return {
    content: kept.filter((block) => {
      if (block.header !== '[providers.chatgpt-oauth]' || !block.managed || providerReferenced) return true;
      removed.push('providers.chatgpt-oauth');
      return false;
    }).map((block) => block.text).join(''),
    removed, retained,
  };
}
