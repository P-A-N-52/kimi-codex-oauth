import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { writePrivateAtomic } from '../bin/private-file.mjs';
import { fixture } from './helpers.mjs';

test('atomic replacement cleans temporary files on failure', (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'auth.json');
  fs.writeFileSync(file, 'original');
  assert.throws(() => writePrivateAtomic(file, 'replacement', { beforeRename: () => { throw new Error('fixture abort'); } }), /fixture abort/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'original');
  assert.deepEqual(fs.readdirSync(dir), ['auth.json']);
});
test('POSIX replacement removes group/other permissions', { skip: process.platform === 'win32' }, (t) => {
  const file = path.join(fixture(t), 'auth.json');
  fs.writeFileSync(file, 'original');
  fs.chmodSync(file, 0o640);
  writePrivateAtomic(file, 'replacement');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
test('POSIX symlink continues to reference its original private target', { skip: process.platform === 'win32' }, (t) => {
  const dir = fixture(t);
  const file = path.join(dir, 'auth.json');
  const link = path.join(dir, 'link.json');
  fs.writeFileSync(file, 'original', { mode: 0o600 });
  fs.symlinkSync(file, link);
  writePrivateAtomic(link, 'replacement');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
});
test('Windows replacement preserves the original security descriptor', { skip: process.platform !== 'win32' }, (t) => {
  const file = path.join(fixture(t), 'auth.json');
  fs.writeFileSync(file, 'original');
  const acl = () => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.IO.File]::GetAccessControl($env:KIMI_TEST_ACL_FILE).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::All)'], {
      env: { ...process.env, KIMI_TEST_ACL_FILE: file }, encoding: 'utf8', windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const before = acl();
  writePrivateAtomic(file, 'replacement');
  assert.equal(acl(), before);
  assert.equal(fs.readFileSync(file, 'utf8'), 'replacement');
});
