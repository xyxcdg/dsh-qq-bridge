import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('./mood.cjs');
const H = 3600000;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log('FAIL  ' + name + (extra ? '  ->  ' + extra : '')); } };
// 本地时间 21:00：不能写带 +08:00 的绝对时刻，否则 UTC 机器上会被判成下午。
const now = new Date(2026, 9, 22, 21, 0, 0).getTime();

// 1 信号识别
ok('detect 空文本全 0', JSON.stringify(M.detect('')) === JSON.stringify({ praise: 0, scold: 0, soothe: 0, tease: 0, order: 0 }));
ok('detect 夸两次', M.detect('真棒呀，好可爱').praise === 2);
ok('detect 骂一次', M.detect('你真笨').scold === 1);
ok('detect 哄（至少命中一次）', M.detect('对不起别生气').soothe >= 1, JSON.stringify(M.detect('对不起别生气')));
ok('detect 普通话不误伤', M.detect('今晚排练七点半').scold === 0 && M.detect('今晚排练七点半').praise === 0);

// 2 心情迁移
let m = M.nextMood({ mood: 'calm', intensity: 0, since: now - 1000 }, M.detect('好可爱'), now);
ok('被夸一次 = happy', m.mood === 'happy' && m.intensity === 1, JSON.stringify(m));
m = M.nextMood({ mood: 'happy', intensity: 1, since: now - 1000 }, M.detect('真棒，好可爱'), now);
ok('被夸两次 = proud', m.mood === 'proud', JSON.stringify(m));
m = M.nextMood({ mood: 'calm', intensity: 0, since: now - 1000 }, M.detect('你真笨'), now);
ok('被骂一次 = sulky', m.mood === 'sulky' && m.cause === '被凶了', JSON.stringify(m));
m = M.nextMood({ mood: 'calm', intensity: 0, since: now - 1000 }, M.detect('笨死了，闭嘴'), now);
ok('连骂 = grumpy', m.mood === 'grumpy', JSON.stringify(m));
m = M.nextMood({ mood: 'grumpy', intensity: 2, since: now - 60000 }, M.detect('我错了别生气'), now);
ok('被哄后降级', m.intensity < 2 && (m.mood === 'sulky' || m.mood === 'calm'), JSON.stringify(m));
m = M.nextMood({ mood: 'sulky', intensity: 1, since: now - 60000 }, M.detect('快去干活'), now);
ok('闹脾气还被使唤 = 更气或保持', m.intensity >= 1, JSON.stringify(m));

// 3 衰减（半衰期 3h）
m = M.nextMood({ mood: 'grumpy', intensity: 3, since: now - 7 * H }, { }, now);
ok('7 小时后气消完 = calm', m.mood === 'calm', JSON.stringify(m));
m = M.nextMood({ mood: 'grumpy', intensity: 3, since: now - 3 * H }, { }, now);
ok('3 小时后强度降 1', m.intensity === 2 && m.mood === 'grumpy', JSON.stringify(m));

// 4 钟点
ok('凌晨 = sleepy', M.timeOfDayMood(new Date('2026-10-22T02:00:00+08:00').getTime()) === 'sleepy');
ok('下午 = 无', M.timeOfDayMood(new Date('2026-10-22T15:00:00+08:00').getTime()) === null);

// 5 提示块
ok('calm 无块', M.moodBlock({ mood: 'calm' }, now, {}) === '');
const b1 = M.moodBlock({ mood: 'sulky', intensity: 2, cause: '被凶了' }, now, {});
ok('sulky 块含委屈且禁止改数据', b1.includes('委屈') && b1.includes('一个字符都不许改'), b1);
const b2 = M.moodBlock({ mood: 'calm' }, new Date('2026-10-22T02:00:00+08:00').getTime(), { timeOfDay: 'sleepy' });
ok('夜里叠加困', b2.includes('困'), b2);
const b3 = M.moodBlock({ mood: 'grumpy', intensity: 3 }, new Date('2026-10-22T02:00:00+08:00').getTime(), { timeOfDay: 'sleepy' });
ok('正在炸毛时不叠困', b3.includes('炸毛') && !b3.includes('打哈欠'), b3);

// 6 小账本
let g = [];
for (let i = 0; i < 5; i++) g = M.addGrievance(g, '第' + i + '句', now - i * 1000, 3);
ok('只留 3 条', g.length === 3, JSON.stringify(g));
ok('留下的是最近的', g[g.length - 1].text === '第0句', JSON.stringify(g));
g = M.addGrievance([{ at: now - 8 * 86400000, text: '太久以前' }], '新的', now, 3);
ok('7 天前自动过期', g.length === 1 && g[0].text === '新的', JSON.stringify(g));
const gb = M.grievanceBlock([{ at: now - 2 * H, text: '你真胖' }], now);
ok('账本块带时间与原文', gb.includes('2 小时前') && gb.includes('你真胖'), gb);

console.log('\nRESULT pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
