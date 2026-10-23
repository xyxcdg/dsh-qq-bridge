#! /usr/bin/env node
'use strict';
/**
 * 手动发一条消息，验证 OneBot 链路（不经过 DSH）。
 *   node scripts/send-test.cjs 10002 "测试"
 *   node scripts/send-test.cjs group:100000001 "测试"
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const cfgPath = process.env.QQ_BOT_CONFIG || path.join(__dirname, '..', 'bridge.config.json');
const CFG = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const target = process.argv[2] || '';
const text = process.argv[3] || '测试消息';
if (!target) {
  console.error('用法: node scripts/send-test.cjs <QQ号 | group:群号> "消息"');
  process.exit(2);
}

const ws = new WebSocket(CFG.onebotWs, {
  headers: CFG.onebotToken ? { Authorization: 'Bearer ' + CFG.onebotToken } : {},
});
const echo = 'test-' + Date.now();

ws.on('open', () => {
  const params = target.startsWith('group:')
    ? { message_type: 'group', group_id: Number(target.slice(6)), message: text }
    : { message_type: 'private', user_id: Number(target), message: text };
  ws.send(JSON.stringify({ action: 'send_msg', params, echo }));
});

ws.on('message', (raw) => {
  let m;
  try { m = JSON.parse(raw.toString()); } catch (_) { return; }
  if (m.echo !== echo) return;
  console.log(JSON.stringify(m));
  ws.close();
  process.exit(m.status === 'ok' || m.retcode === 0 ? 0 : 1);
});

setTimeout(() => { console.error('超时：没有收到 OneBot 回包'); process.exit(1); }, 10000);
