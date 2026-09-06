import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { validateConfig, writeConfig, cleanManagedConfig, MARKER } from '../bin/config-file.mjs';
import { fixture, runNode } from './helpers.mjs';

const missing = () => ({ error: Object.assign(new Error('missing'), { code: 'ENOENT' }) });
const managed = (slug) => '[models."chatgpt/' + slug + '"]\n' + MARKER + '\nprovider = "chatgpt-oauth"\nmodel = "' + slug + '"\n';
const provider = '[providers.chatgpt-oauth]\n' + MARKER + '\ntype = "openai_responses"\n';

test('missing validators refuse even malformed TOML', () => {
  assert.match(validateConfig('[invalid', { run: missing, platform: 'linux' }), /no configuration validator/);
});
test('timeouts do not fall through to success', () => {
  const run = () => ({ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }), status: null });
  assert.match(validateConfig('a = 1', { run }), /could not complete/);
});
test('doctor rejection does not get overridden by a weaker parser', () => {
  let calls = 0;
  const result = validateConfig('a = 1', { run: () => { calls++; return { status: 1 }; } });
  assert.match(result, /doctor rejected/);
  assert.equal(calls, 1);
});
test('Python syntax fallback works when Kimi is unavailable', () => {
  const run = (bin) => bin === 'python3' ? { status: 0 } : missing();
  assert.equal(validateConfig('a = 1', { run, platform: 'linux' }), null);
  assert.match(validateConfig('[invalid', {
    run: (bin) => bin === 'python3' ? { status: 1 } : missing(), platform: 'linux',
  }), /TOML validator rejected/);
});
test('Python without tomllib is not a successful validation', () => {
  const run = (bin) => bin.startsWith('python') ? { status: 77 } : missing();
  assert.match(validateConfig('a = 1', { run, platform: 'linux' }), /no configuration validator/);
});
test('Windows cmd shim is invoked through cmd, not shell-built user content', () => {
  const calls = [];
  assert.equal(validateConfig('a = 1', { platform: 'win32', run: (bin, args) => {
    calls.push([bin, args]);
    return bin === 'cmd.exe' ? { status: 0 } : missing();
  } }), null);
  assert.deepEqual(calls[1], ['cmd.exe', ['/d', '/s', '/c', 'kimi.cmd doctor']]);
});
test('config rejection leaves original bytes and creates no backup', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, 'original = 1\r\n');
  assert.throws(() => writeConfig(file, 'original = 1\r\n', '[broken', { validate: () => 'invalid' }), /invalid/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original = 1\r\n');
  assert.deepEqual(fs.readdirSync(dir), ['config.toml']);
});
test('writes retain an exact backup; no-op does not write again', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'config.toml');
  fs.writeFileSync(file, 'a = 1\r\n');
  const backup = writeConfig(file, 'a = 1\r\n', 'a = 2\r\n', { validate: () => null });
  assert.equal(fs.readFileSync(backup, 'utf8'), 'a = 1\r\n');
  assert.equal(fs.readFileSync(file, 'utf8'), 'a = 2\r\n');
  const before = fs.statSync(file).mtimeMs;
  assert.equal(writeConfig(file, 'a = 2\r\n', 'a = 2\r\n'), null);
  assert.equal(fs.statSync(file).mtimeMs, before);
});
test('concurrent user edits prevent overwrite', (t) => {
  const file = path.join(fixture(t), 'config.toml');
  fs.writeFileSync(file, 'a = 2');
  assert.throws(() => writeConfig(file, 'a = 1', 'a = 3', { validate: () => null }), /changed while preparing/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'a = 2');
});
test('cleanup removes only unreferenced managed aliases and provider', () => {
  const user = '[models."chatgpt/personal"]\nprovider = "other"\n';
  const result = cleanManagedConfig('default_model = "other/model"\n' + provider + managed('old') + user);
  assert.equal(result.content, 'default_model = "other/model"\n' + user);
  assert.deepEqual(result.removed, ['chatgpt/old', 'providers.chatgpt-oauth']);
});
test('defaults, secondary pools and personal overrides preserve managed models', () => {
  const original = 'default_model = "chatgpt/default"\n[secondary_model]\n"chatgpt/secondary" = 1\n' +
    provider + managed('default') + managed('secondary') + managed('override') +
    '[models."chatgpt/override".overrides]\nfoo = 1\n' + managed('removable');
  const result = cleanManagedConfig(original);
  assert.deepEqual(result.retained, ['chatgpt/default', 'chatgpt/secondary', 'chatgpt/override']);
  assert.deepEqual(result.removed, ['chatgpt/removable']);
  assert.ok(result.content.includes('[providers.chatgpt-oauth]'));
  assert.ok(result.content.includes('[models."chatgpt/override".overrides]\nfoo = 1\n'));
});
test('user-owned models referencing our provider keep that provider', () => {
  const user = '[models.custom]\n"provider" = \'chatgpt-oauth\'\n';
  assert.equal(cleanManagedConfig(provider + user).content, provider + user);
});
test('fake headers and ownership markers inside multiline TOML survive byte-for-byte', () => {
  for (const quotes of ['"""', "'''"]) {
    const content = 'prompt = ' + quotes + '\n' + managed('fake') + quotes + '\n' +
      '[models."chatgpt/user"]\nprompt = ' + quotes + '\n' + MARKER + '\n' + quotes + '\n';
    assert.equal(cleanManagedConfig(content).content, content);
  }
});
test('CRLF and trailing header comments are preserved outside removed sections', () => {
  const input = ('[user] # comment [brackets]\nvalue = 1\n' + provider + managed('old')).replace(/\n/g, '\r\n');
  assert.equal(cleanManagedConfig(input).content, '[user] # comment [brackets]\r\nvalue = 1\r\n');
});
test('sync CLI adds, preserves user overrides, is idempotent, and refuses missing validators', async (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'config.toml');
  const initial = 'default_model = "other/test"\r\ncustom_prompt = \'\'\'\r\n' +
    '[models."chatgpt/fixture-model"]\r\n' + MARKER + '\r\n\'\'\'\r\n';
  fs.writeFileSync(file, initial);
  let responseData = { live: true, auth_mode: 'chatgpt', data: [{
    slug: 'fixture-model', context_window: 123456, input_modalities: ['text', 'image'],
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
  }] };
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(responseData));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const env = { KIMI_CODE_HOME: dir, CODEX_OAUTH_PORT: String(server.address().port), KIMI_TEST_VALIDATOR: 'missing' };
  const args = ['--require', './tests/offline-preload.cjs', './bin/sync-models.mjs'];
  const refused = await runNode(args, env);
  assert.equal(refused.code, 0);
  assert.match(refused.stderr, /no configuration validator/);
  assert.equal(fs.readFileSync(file, 'utf8'), initial);
  env.KIMI_TEST_VALIDATOR = 'accept';
  const added = await runNode(args, env);
  assert.equal(added.code, 0);
  assert.match(added.stdout, /config.toml updated/);
  const first = fs.readFileSync(file, 'utf8');
  assert.match(first, /max_context_size = 123456/);
  assert.match(first, /default_effort = "high"/);
  assert.ok(first.includes('\r\n'));
  const modified = first.replace('default_effort = "high"', 'default_effort = "low"')
    .replace('[models."chatgpt/fixture-model"]\r\n# managed', '[models."chatgpt/fixture-model"] # user comment\r\n# managed') +
    '\r\ncustom_text = \'\'\'\r\nmodel = "keep this text"\r\n\'\'\'\r\n' +
    '\r\n[models."chatgpt/fixture-model".overrides]\r\ncustom = true\r\n';
  fs.writeFileSync(file, modified);
  const again = await runNode(args, env);
  assert.equal(again.code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), modified);
  responseData = { live: false, auth_mode: 'chatgpt', data: [] };
  assert.equal((await runNode(args, env)).code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), modified);
  responseData = { live: true, auth_mode: 'chatgpt', data: [{ slug: 'replacement-model' }] };
  assert.equal((await runNode(args, env)).code, 0);
  const retired = fs.readFileSync(file, 'utf8');
  assert.ok(retired.includes('[models."chatgpt/fixture-model"]'));
  assert.ok(retired.includes('[models."chatgpt/replacement-model"]'));
  responseData = { live: false, auth_mode: 'apikey', data: [] };
  assert.equal((await runNode(args, env)).code, 0);
  const apiKey = fs.readFileSync(file, 'utf8');
  assert.ok(apiKey.includes('[models."chatgpt/fixture-model"]'));
  assert.ok(apiKey.includes('[models."chatgpt/fixture-model".overrides]'));
  assert.ok(!apiKey.includes('[models."chatgpt/replacement-model"]'));
  assert.ok(apiKey.includes('[providers.chatgpt-oauth]'));
  const userProvider = provider + '[models.custom]\n"provider" = \'chatgpt-oauth\'\n';
  fs.writeFileSync(file, userProvider);
  assert.equal((await runNode(args, env)).code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), userProvider);
  const singleQuoteDefault = "default_model = 'chatgpt/old'\n" + provider + managed('old');
  fs.writeFileSync(file, singleQuoteDefault);
  const kept = await runNode(args, env);
  assert.equal(kept.code, 0);
  assert.match(kept.stderr, /kept stale aliases/);
  assert.equal(fs.readFileSync(file, 'utf8'), singleQuoteDefault);
});
