// Instance-specific shutdown. Never send an OS signal to a guessed/reused PID.
import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writePrivateAtomic } from './private-file.mjs';

export const SERVICE = 'kimi-codex-oauth';
export const VERSION = JSON.parse(fs.readFileSync(new URL('../kimi.plugin.json', import.meta.url), 'utf8')).version;
export const statePath = (logPath, port) => logPath + '.' + port + '.state.json';
export const shutdownPath = '/_kimi-codex-oauth/shutdown';

export function registerProxy(file, port, permissionsFrom) {
  const state = {
    service: SERVICE, version: VERSION, pid: process.pid, port,
    instanceId: randomBytes(16).toString('hex'),
    shutdownToken: randomBytes(32).toString('hex'),
  };
  writePrivateAtomic(file, JSON.stringify(state), { permissionsFrom });
  return state;
}

export function removeProxyState(file, instanceId) {
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).instanceId === instanceId) fs.unlinkSync(file);
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

export function shutdownAuthorized(header, state) {
  if (!state || typeof header !== 'string') return false;
  const actual = Buffer.from(header);
  const expected = Buffer.from('Bearer ' + state.shutdownToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function stopProxy(logPath, port, { request = fetch } = {}) {
  const file = statePath(logPath, port);
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw new Error('cannot read proxy instance state');
    try {
      await request('http://127.0.0.1:' + port + '/healthz', { signal: AbortSignal.timeout(1500), redirect: 'error' });
    } catch (networkError) {
      if (networkError.cause?.code === 'ECONNREFUSED') return 'not running';
      throw new Error('cannot verify proxy listener; no process stopped');
    }
    throw new Error('listener has no instance state (possibly v0.1.0); verify and stop the old process manually');
  }
  if (state.service !== SERVICE || state.port !== port || typeof state.instanceId !== 'string' ||
      typeof state.shutdownToken !== 'string') throw new Error('invalid proxy instance state; no process stopped');
  const base = 'http://127.0.0.1:' + port;
  let health;
  try {
    const res = await request(base + '/healthz', { signal: AbortSignal.timeout(1500), redirect: 'error' });
    health = await res.json();
  } catch (networkError) {
    if (networkError.cause?.code === 'ECONNREFUSED') {
      removeProxyState(file, state.instanceId);
      return 'not running';
    }
    throw new Error('cannot verify proxy instance; no process stopped');
  }
  if (health.service !== SERVICE || health.instance_id !== state.instanceId || health.pid !== state.pid) {
    throw new Error('proxy instance does not match the listener; no process stopped');
  }
  const result = await request(base + shutdownPath, {
    method: 'POST', headers: { authorization: 'Bearer ' + state.shutdownToken },
    signal: AbortSignal.timeout(3000), redirect: 'error',
  });
  if (!result.ok) throw new Error('proxy refused shutdown');
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(file)) return 'stopped';
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('shutdown requested but completion was not confirmed');
}
