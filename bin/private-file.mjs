// Atomic replacement without temporarily exposing credentials or widening the
// original file's permissions. A symlink keeps pointing at its original target.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

function protectWindowsFile(file, source) {
  const command = [
    '$ErrorActionPreference = "Stop"',
    'if ($env:KIMI_PRIVATE_SOURCE) { $acl = [System.IO.File]::GetAccessControl($env:KIMI_PRIVATE_SOURCE) }',
    'else {',
    '  $acl = [System.Security.AccessControl.FileSecurity]::new()',
    '  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User',
    '  $acl.SetOwner($sid)',
    '  $acl.SetAccessRuleProtection($true, $false)',
    '  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, "FullControl", "Allow")',
    '  $acl.AddAccessRule($rule)',
    '}',
    '[System.IO.File]::SetAccessControl($env:KIMI_PRIVATE_TARGET, $acl)',
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    env: { ...process.env, KIMI_PRIVATE_TARGET: file, KIMI_PRIVATE_SOURCE: source ?? '' },
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('cannot preserve private file permissions');
}

export function writePrivateAtomic(file, content, { permissionsFrom, beforeRename } = {}) {
  const target = fs.existsSync(file) ? fs.realpathSync(file) : path.resolve(file);
  const source = permissionsFrom ?? (fs.existsSync(target) ? target : undefined);
  const stat = source ? fs.statSync(source) : null;
  if (stat && !stat.isFile()) throw new Error('private file source must be a regular file');
  const mode = stat ? stat.mode & 0o600 : 0o600;
  const tmp = target + '.tmp-' + process.pid + '-' + randomBytes(8).toString('hex');
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', mode);
    // Apply the original DACL before writing even one byte of sensitive data.
    if (process.platform === 'win32') protectWindowsFile(tmp, source);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    beforeRename?.();
    fs.renameSync(tmp, target);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
