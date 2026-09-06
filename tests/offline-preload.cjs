// Child CLI tests may use loopback only. Mock validator discovery, but retain
// the real Windows ACL helper so cross-platform file permissions are exercised.
const cp = require('node:child_process');
const realSpawn = cp.spawnSync;
cp.spawnSync = (bin, args, options) => {
  if (bin === 'powershell.exe') return realSpawn(bin, args, options);
  if (process.env.KIMI_TEST_VALIDATOR === 'accept') return { status: 0, stdout: '', stderr: '' };
  return { error: Object.assign(new Error('fixture missing validator'), { code: 'ENOENT' }) };
};
require('node:module').syncBuiltinESMExports();
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('external network forbidden by test');
  return realFetch(url, options);
};
