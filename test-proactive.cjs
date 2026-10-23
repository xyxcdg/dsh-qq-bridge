'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { proactiveGate, acceptProactive, inQuietHours } = require('./proactive.cjs');
const CFG_PATH = process.env.QQ_BOT_CONFIG || (fs.existsSync(path.join(__dirname, 'bridge.config.json')) ? path.join(__dirname, 'bridge.config.json') : path.join(__dirname, 'bridge.config.example.json'));
// 测试测的是门控逻辑，不能依赖线上开关状态：线上 proactive.enabled 可能是 false，那会把每条断言压成 disabled。
const RAW = require(CFG_PATH);
const CFG = Object.assign({}, RAW, { proactive: Object.assign({ enabled: true, maxPerDay: 2, chance: 1, quietHours: [23, 8], minGapMs: 60 * 60 * 1000 }, RAW.proactive, { enabled: true }) }); // FORCED_ENABLED
let pass = 0;
const t = (n, fn) => { try { fn(); console.log('  [OK] ' + n); pass++; } catch (e) { console.log('  [FAIL] ' + n + ' :: ' + e.message); process.exitCode = 1; } };
const now = new Date('2026-10-19T14:00:00+08:00').getTime();
const baseState = { lastUserAt: { ['private:' + CFG.masterQQ]: now - 4 * 3600 * 1000 }, proactive: { day: '2026-10-19', count: 0 } };
const g = (over) => proactiveGate(Object.assign({ now, hour: 14, cfg: CFG, state: JSON.parse(JSON.stringify(baseState)), rand: () => 0 }, over));

t('满足条件才开口', () => assert.strictEqual(g({}).allow, true));
t('正在跑任务不插话', () => assert.strictEqual(g({ busy: true }).reason, 'busy'));
t('安静时间不够不说', () => {
  const st = JSON.parse(JSON.stringify(baseState));
  st.lastUserAt['private:' + CFG.masterQQ] = now - 10 * 60 * 1000;
  assert.strictEqual(g({ state: st }).reason, 'too-soon');
});
t('每天上限', () => {
  const st = JSON.parse(JSON.stringify(baseState));
  st.proactive.count = CFG.proactive.maxPerDay;
  assert.strictEqual(g({ state: st }).reason, 'daily-cap');
});
t('换一天计数归零', () => {
  const st = JSON.parse(JSON.stringify(baseState));
  st.proactive = { day: '2026-10-18', count: 9 };
  assert.strictEqual(g({ state: st }).allow, true);
});
t('深夜静默', () => {
  assert.strictEqual(g({ hour: 2 }).reason, 'quiet-hours');
  assert.strictEqual(g({ hour: 23 }).reason, 'quiet-hours');
  assert.strictEqual(g({ hour: 12 }).allow, true);
});
t('从没聊过不主动开口', () => {
  assert.strictEqual(g({ state: { lastUserAt: {}, proactive: {} } }).reason, 'no-history');
});
t('掷骰没中就不说', () => assert.strictEqual(g({ rand: () => 0.99 }).reason, 'dice'));
t('关掉就彻底不说', () => {
  const c = JSON.parse(JSON.stringify(CFG)); c.proactive.enabled = false;
  assert.strictEqual(g({ cfg: c }).reason, 'disabled');
});
t('SKIP / 太长 / 模板泄漏都丢掉', () => {
  assert.strictEqual(acceptProactive('SKIP').ok, false);
  assert.strictEqual(acceptProactive('skip，因为主人在忙').ok, false);
  assert.strictEqual(acceptProactive('喵'.repeat(80)).ok, false);
  assert.strictEqual(acceptProactive('【主动搭话】在吗').ok, false);
  assert.strictEqual(acceptProactive('主人还没睡喵？(=^･ω･^=)').ok, true);
});
console.log('\n' + (process.exitCode ? 'FAILED' : 'PASS') + ' - ' + pass + ' checks');
