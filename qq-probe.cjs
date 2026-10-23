'use strict';
// qq-probe.cjs — 探测 OneBot 账号是否真的在线（端口活着不等于能对话）。
// 用法: node qq-probe.cjs   输出一行 JSON: {ok, online, good, userId, nickname, error}
const WebSocket = require('ws');
const TOKEN = process.env.QQ_BRIDGE_TOKEN || 'dsh-qq-bridge-2026';
const URL = process.env.QQ_ONEBOT_WS || 'ws://127.0.0.1:3001';
const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(0); };
const ws = new WebSocket(URL, { headers: { Authorization: 'Bearer ' + TOKEN } });
const timer = setTimeout(() => { try { ws.close(); } catch (_) {} out({ ok: false, error: 'timeout' }); }, 7000);
const call = (action, params) => new Promise((res, rej) => {
  const echo = 'p-' + Math.random().toString(36).slice(2, 8);
  const h = (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; } if (m.echo === echo) { ws.off('message', h); res(m); } };
  ws.on('message', h);
  ws.send(JSON.stringify({ action: action, params: params || {}, echo: echo }));
  setTimeout(() => rej(new Error('timeout ' + action)), 5000);
});
ws.on('open', async () => {
  try {
    const info = await call('get_login_info');
    let status = {};
    try { const st = await call('get_status'); status = st.data || {}; } catch (_) {}
    clearTimeout(timer);
    const d = info.data || {};
    out({ ok: true, online: status.online !== false, good: status.good !== false,
          userId: String(d.user_id || ''), nickname: d.nickname || '', status: status });
  } catch (e) { clearTimeout(timer); out({ ok: false, error: e.message }); }
});
ws.on('error', (e) => { clearTimeout(timer); out({ ok: false, error: 'ws: ' + e.message }); });
