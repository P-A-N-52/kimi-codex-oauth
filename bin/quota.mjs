#!/usr/bin/env node
// quota — render the ChatGPT subscription quota card from the local proxy,
// and redeem one banked rate-limit reset credit on explicit request.
//
// Usage:
//   node bin/quota.mjs [--json]
//   node bin/quota.mjs --consume-reset [credit_id] [--json]
//   node bin/quota.mjs --statusline          one compact line for tui.toml [status_line].command
//
// Talks only to the local proxy (127.0.0.1, CODEX_OAUTH_PORT); the proxy owns
// the upstream credentials. A redeemed credit cannot be undone, so the caller
// (slash command) is responsible for user confirmation. Exit 1 with a hint
// when the proxy or the upstream is unreachable; --statusline fails silently
// so the TUI falls back to its built-in footer.

const PORT = Number(process.env.CODEX_OAUTH_PORT || 8317);
const BASE = 'http://127.0.0.1:' + PORT;

async function request(pathname, options = {}) {
  const timeout = options.timeout ?? 15000;
  delete options.timeout;
  let res;
  try {
    res = await fetch(BASE + pathname, { ...options, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    if (e.cause?.code === 'ECONNREFUSED') {
      throw new Error('代理未运行:先执行 node "<插件目录>/bin/ensure-proxy.mjs" 再重试');
    }
    throw new Error('无法连接本地代理:' + e.message);
  }
  let data;
  try { data = await res.json(); }
  catch { throw new Error('代理返回了无效 JSON(HTTP ' + res.status + ')'); }
  if (!res.ok) throw new Error(data?.error?.message ?? ('HTTP ' + res.status));
  return data;
}

function windowLabel(seconds) {
  if (typeof seconds !== 'number') return '额度窗口';
  if (seconds <= 6 * 3600) return '5小时窗口';
  if (seconds <= 8 * 86400) return '每周窗口';
  return '长周期窗口';
}

function bar(used, width = 20) {
  const filled = Math.round((used / 100) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

const pad2 = (n) => String(n).padStart(2, '0');

function formatReset(resetAt, resetsInS) {
  if (!resetAt) return '重置时间未知';
  const at = new Date(resetAt);
  if (Number.isNaN(at.getTime())) return '重置时间未知';
  const time = pad2(at.getHours()) + ':' + pad2(at.getMinutes());
  const when = at.toDateString() === new Date().toDateString()
    ? time
    : (at.getMonth() + 1) + '月' + at.getDate() + '日 ' + time;
  if (typeof resetsInS !== 'number') return when + ' 重置';
  if (resetsInS < 3600) return Math.max(1, Math.round(resetsInS / 60)) + ' 分钟后重置(' + when + ')';
  if (resetsInS < 86400) {
    const minutes = Math.round((resetsInS % 3600) / 60);
    return Math.floor(resetsInS / 3600) + ' 小时' + (minutes ? minutes + ' 分' : '') + '后重置(' + when + ')';
  }
  return String(Math.round((resetsInS / 86400) * 10) / 10) + ' 天后重置(' + when + ')';
}

function render(quota) {
  const lines = [];
  lines.push(['ChatGPT 订阅额度', quota.plan_type ? '套餐 ' + quota.plan_type : null]
    .filter(Boolean).join(' · '));
  if (quota.limit_reached === true) lines.push('当前状态:限流已触发,请求会被拒绝');
  for (const w of [quota.primary_window, quota.secondary_window]) {
    if (!w) continue;
    lines.push(
      windowLabel(w.limit_window_seconds) + '  ' + bar(w.used_percent) +
      '  已用 ' + w.used_percent + '% · 剩余 ' + w.remaining_percent + '% · ' +
      formatReset(w.reset_at, w.resets_in_s),
    );
  }
  const credits = quota.reset_credits ?? {};
  if (typeof credits.available_count === 'number') {
    let line = '重置卡      ' + credits.available_count + ' 张可用';
    const nextExpiry = (credits.credits ?? [])
      .filter((c) => c.status === 'available' && c.expires_at)
      .map((c) => Date.parse(c.expires_at))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => a - b)[0];
    if (nextExpiry) {
      const d = new Date(nextExpiry);
      line += '(最近过期 ' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ')';
    }
    lines.push(line);
  } else if (credits.error) {
    lines.push('重置卡      查询失败(' + credits.error + ')');
  }
  lines.push('数据时间    ' + quota.fetched_at);
  return lines.join('\n');
}

// --- --statusline: one compact line for tui.toml [status_line].command ---

function shortLabel(seconds) {
  if (typeof seconds !== 'number') return '窗口';
  if (seconds <= 6 * 3600) return '5h';
  if (seconds <= 8 * 86400) return '周';
  return '长';
}

// The TUI pipes a JSON snapshot on stdin, but a manual run (or a test spawn)
// may leave stdin open forever — never wait longer than a brief grace period.
function readSnapshot() {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A never-closing stdin (manual runs, test spawns) would otherwise keep
      // the event loop alive after the line is printed.
      process.stdin.removeAllListeners();
      process.stdin.pause();
      if (typeof process.stdin.unref === 'function') process.stdin.unref();
      try { resolve(JSON.parse(buf)); } catch { resolve(null); }
    };
    const timer = setTimeout(done, 120);
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

function snapshotModel(snap) {
  const m = snap?.model;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object') return m.id ?? m.name ?? m.display_name ?? null;
  return null;
}

function snapshotBranch(snap) {
  const g = snap?.git ?? snap?.branch;
  if (typeof g === 'string') return g;
  if (g && typeof g === 'object' && typeof g.branch === 'string') return g.branch;
  return null;
}

function statusLine(quota, snap) {
  const windows = [quota.primary_window, quota.secondary_window].filter(Boolean);
  let line = '⚡ ' + windows.map((w) => shortLabel(w.limit_window_seconds) + '余' + w.remaining_percent + '%').join(' ');
  if (windows.length === 0) line = '⚡ 额度未知';
  if (quota.limit_reached === true) line += ' · 已限流';
  const credits = quota.reset_credits?.available_count;
  if (typeof credits === 'number' && credits > 0) line += ' · 重置卡×' + credits;
  const prefix = [snapshotModel(snap), snapshotBranch(snap) ? '⎇ ' + snapshotBranch(snap) : null]
    .filter(Boolean).join(' ');
  return prefix ? prefix + ' | ' + line : line;
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const consumeAt = args.indexOf('--consume-reset');

if (args.includes('--statusline')) {
  try {
    const [quota, snap] = await Promise.all([request('/quota', { timeout: 250 }), readSnapshot()]);
    console.log(statusLine(quota, snap));
  } catch {
    // Stay silent and fail: the TUI falls back to its built-in footer.
    process.exitCode = 1;
  }
} else try {
  if (consumeAt !== -1) {
    const next = args[consumeAt + 1];
    const creditId = next && !next.startsWith('--') ? next : undefined;
    const result = await request('/quota/consume-reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(creditId ? { credit_id: creditId } : {}),
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        '已使用 1 张重置卡(不可撤销),重置了 ' + (result.windows_reset ?? '?') + ' 个限流窗口' +
        (result.redeemed_at ? ':' + result.redeemed_at : ''),
      );
      console.log('');
      console.log(render(result.quota));
    }
  } else {
    const quota = await request('/quota');
    console.log(json ? JSON.stringify(quota, null, 2) : render(quota));
  }
} catch (e) {
  console.error('kimi-codex-oauth: ' + e.message);
  process.exitCode = 1;
}
