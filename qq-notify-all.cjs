'use strict';
// qq-notify-all.cjs — 给「机器人能触达的每一个群、每一个授权用户」发一条通知。
// 用法: node qq-notify-all.cjs --force [--reason=selfheal]
// 节流：没有 --force 时，6 小时内只发一次（自愈成功后自动通知用）。
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const BASE = __dirname;
const CFG = JSON.parse(fs.readFileSync(path.join(BASE, 'bridge.config.json'), 'utf8'));
const STAMP = path.join(BASE, 'selfheal-notify.stamp');
const args = process.argv.slice(2);
const force = args.indexOf('--force') >= 0;
const reasonArg = args.find(function (a) { return a.indexOf('--reason=') === 0; }) || '';
const reason = reasonArg ? reasonArg.slice(9) : 'manual';
if (!force) {
  try {
    const ageMin = (Date.now() - fs.statSync(STAMP).mtimeMs) / 60000;
    if (ageMin < 360) { console.log('skip: notified ' + Math.round(ageMin) + ' min ago'); process.exit(0); }
  } catch (_) {}
}
const groups = (CFG.allowedGroups || []).map(String);
const users = (CFG.allowedPrivateUsers || []).map(String);
const TEXT_GROUP = [
  '本喵回来啦～（刚被老爹修好了喵）',
  '以后本喵会自己盯着自己：账号掉线会自己重登，对话线装满了会自己换一条新的（记忆都还在的说）。',
  '刚才那段时间不理人，是账号掉线了，对不起喵 (´･ω･`)',
].join('\n');
const TEXT_USER = [
  '本喵修好啦喵～',
  '之前一直不回你，是账号掉线了（不是不想理你）。',
  '现在本喵会自己盯着自己：掉线自己重登；对话线装满了会自己换新的，但记忆都还在。',
].join('\n');
const ws = new WebSocket('ws://127.0.0.1:3001', { headers: { Authorization: 'Bearer dsh-qq-bridge-2026' } });
const call = function (action, params) {
  return new Promise(function (res, rej) {
    const echo = 'n-' + Math.random().toString(36).slice(2, 8);
    const h = function (raw) { let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; } if (m.echo === echo) { ws.off('message', h); res(m); } };
    ws.on('message', h);
    ws.send(JSON.stringify({ action: action, params: params, echo: echo }));
    setTimeout(function () { rej(new Error('timeout ' + action)); }, 12000);
  });
};
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
ws.on('open', async function () {
  const res = [];
  for (const g of groups) {
    try {
      const r = await call('send_msg', { message_type: 'group', group_id: Number(g), message: TEXT_GROUP });
      res.push({ to: 'group:' + g, ok: r.status === 'ok' || r.retcode === 0, mid: (r.data && r.data.message_id) || '' });
    } catch (e) { res.push({ to: 'group:' + g, ok: false, err: e.message }); }
    await sleep(1200);
  }
  for (const u of users) {
    try {
      const r = await call('send_msg', { message_type: 'private', user_id: Number(u), message: TEXT_USER });
      res.push({ to: 'private:' + u, ok: r.status === 'ok' || r.retcode === 0, mid: (r.data && r.data.message_id) || '' });
    } catch (e) { res.push({ to: 'private:' + u, ok: false, err: e.message }); }
    await sleep(1200);
  }
  console.log(JSON.stringify({ reason: reason, total: res.length, ok: res.filter(function (x) { return x.ok; }).length, res: res }, null, 1));
  if (res.some(function (x) { return x.ok; })) { try { fs.writeFileSync(STAMP, new Date().toISOString()); } catch (_) {} }
  ws.close();
  process.exit(0);
});
ws.on('error', function (e) { console.log('WS ERROR ' + e.message); process.exit(1); });
