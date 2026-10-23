'use strict';
// test-self.cjs — 自我状态引擎的边界与行为断言（不碰网络）
const S = require('./self.cjs');
const DAY = 86400000;
let bad = 0;
function ok(name, cond, extra) { if (cond) console.log('[OK] ' + name); else { console.log('[FAIL] ' + name + (extra ? ' :: ' + extra : '')); bad++; } }

// 1) 空状态不炸，且能报出第 1 天
const now = Date.UTC(2026, 9, 22, 14, 0, 0);
let st = {};
S.tick(st, now, {});
const b1 = S.selfBlock(st, 'private:1', now);
ok('空状态不崩且说第 1 天', b1.includes('第 1 天'), b1.slice(0, 80));

// 2) 三天后 → 第 4 天
st = { born: now - 3 * DAY };
S.tick(st, now, {});
ok('连续性：第 4 天', S.selfBlock(st, 'private:1', now).includes('第 4 天'));

// 3) 关系：常来亲近度上升；被纠正后下降并写自我认知
st = {};
for (let i = 0; i < 5; i++) S.observe(st, { chKey: 'private:1', name: '老爹', text: '干得不错', now: now + i * 60000 });
const up = st.relations['private:1'].closeness;
ok('常来亲近度上升', up > 30, 'closeness=' + up);
S.observe(st, { chKey: 'private:1', name: '老爹', text: '你记错了，是 23 号', now: now + 600000 });
ok('被纠正后亲近度下降', st.relations['private:1'].closeness < up, 'closeness=' + st.relations['private:1'].closeness);
ok('纠正写入自我认知', st.habits.length === 1 && st.habits[0].text.includes('记错了'), JSON.stringify(st.habits));
ok('自我认知进提示词', S.selfBlock(st, 'private:1', now + 600000).includes('别重犯'));

// 4) 心事：牵挂 + 注入 + 说过之后不再出现
st = { relations: { 'private:2': { closeness: 60, lastAt: now - 50 * 3600000, impression: '' } } };
S.tick(st, now, {});
const th = S.think(st, now, { rand: () => 0 });
ok('久未出现会产生心事', !!th && th.kind === 'worry', JSON.stringify(th));
ok('心事进提示词', S.selfBlock(st, 'private:2', now).includes('已经'));
S.markSpoken(st, now);
ok('说过之后不再挂起', S.pendingThought(st, now) === null);

// 5) 深夜会想到催睡；白天不会
// 用「宿主本地时间」构造 23:30 / 12:00：写成 Date.UTC 只在 UTC+8 成立，CI（UTC）会判成白天。
const night = new Date(2026, 9, 22, 23, 30, 0).getTime();
const day = new Date(2026, 9, 22, 12, 0, 0).getTime();
const stn = { attention: { focus: '', at: 0 } };
const planN = S.think(stn, night, { rand: () => 0.99 });
const stD = { attention: { focus: '', at: 0 } };
const planD = S.think(stD, day, { rand: () => 0.99 });
ok('深夜产生催睡念头', !!planN && planN.kind === 'plan', JSON.stringify(planN));
ok('白天不产生催睡念头', !planD, JSON.stringify(planD));

// 6) 疲惫：长时间不休息会下降，连续对话会上升
st = { fatigue: 60, lastTick: now - 3 * 3600000 };
S.tick(st, now, {});
ok('休息后疲惫下降', st.fatigue < 60, 'fatigue=' + st.fatigue);
st = { fatigue: 10 };
S.observe(st, { chKey: 'private:9', text: '在吗', now: now });
ok('说话会增加疲惫', st.fatigue > 10, 'fatigue=' + st.fatigue);

// 7) 数据边界：提示词必须写明「不是事实来源」
st = {};
ok('提示词声明不改数据', S.selfBlock(st, 'private:1', now).includes('不是事实来源'));

console.log(bad ? ('失败 ' + bad + ' 条') : '全部通过');
process.exit(bad ? 1 : 0);
