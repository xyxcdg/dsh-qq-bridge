'use strict';
/**
 * test-life.cjs —— 「完整生命」三件套的回归（2026-10-23）
 * ①处境感：提示词里能说出几点、第几天、住在电脑里；
 * ②偏好演化：被夸进 likes、被凶进 dislikes，同句不重复；
 * ③生平：appendLife 落盘、recentLife 能读回、并进提示词。
 * 用 QQ_SELF_LIFE 指到沙箱，绝不碰真实 memory/life.md。
 */
const fs = require('fs');
const path = require('path');
const CFG_PATH = process.env.QQ_BOT_CONFIG || (fs.existsSync(path.join(__dirname, 'bridge.config.json')) ? path.join(__dirname, 'bridge.config.json') : path.join(__dirname, 'bridge.config.example.json'));
const DIR = path.join(__dirname, 'tmp', 'life-test');
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });
process.env.QQ_SELF_LIFE = path.join(DIR, 'life.md');
process.env.QQ_SELF_DIARY = path.join(DIR, 'diary.txt');
const SELF = require('./self.cjs');

const now = Date.now();
let bad = 0;
const ok = (name, cond, extra) => { if (cond) console.log('[OK] ' + name); else { console.log('[FAIL] ' + name + (extra ? ' :: ' + extra : '')); bad++; } };

const s = SELF.ensure({}, now);
SELF.observe(s, { chKey: 'private:1001', name: '甲', text: '你好可爱呀', now: now });
SELF.observe(s, { chKey: 'private:1001', name: '甲', text: '你好可爱呀', now: now + 1000 });
SELF.observe(s, { chKey: 'private:1001', name: '甲', text: '滚开别烦我', now: now + 2000 });

ok('被夸进 likes', (s.likes || []).some((x) => x.includes('可爱')), JSON.stringify(s.likes));
ok('同句不重复记 likes', (s.likes || []).length === 1, JSON.stringify(s.likes));
ok('被凶进 dislikes', (s.dislikes || []).some((x) => x.includes('滚开')), JSON.stringify(s.dislikes));

const saved = SELF.appendLife('第 1 天：今天第一次被人夸可爱。', now);
ok('生平写入成功', !!saved && fs.existsSync(process.env.QQ_SELF_LIFE));
const recent = SELF.recentLife(4);
ok('生平能读回', recent.length === 1 && recent[0].includes('第一次被人夸可爱'), JSON.stringify(recent));

const block = String(SELF.selfBlock(s, 'private:1001', now + 5000));
ok('提示词含处境', /你的处境/.test(block) && /第 1 天/.test(block), block.slice(0, 120));
ok('提示词含时钟', /\d{2}:\d{2}/.test(block));
ok('提示词含喜欢', /开始喜欢/.test(block));
ok('提示词含生平', /你自己的生平/.test(block) && /第一次被人夸可爱/.test(block));
ok('不宣称事实来源', /不是事实来源|以工具为准/.test(block), block.slice(-160));

// 桌面日记 txt：writeDiary 应同时落一份
const line = SELF.writeDiary(SELF.ensure({}, now), now, 'calm');
const txtPath = process.env.QQ_SELF_DIARY;
ok('日记写进 txt', !!line && fs.existsSync(txtPath), String(line));
const txtBody = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8') : '';
ok('txt 里有那句日记', txtBody.includes(String(line || '').slice(0, 12)), txtBody.slice(0, 120));
ok('txt 带 BOM 头（记事本不乱码）', txtBody.charCodeAt(0) === 0xFEFF);
SELF.appendDiaryTxt('补一条测试', now + 1000);
ok('追加后仍是两行以上', fs.readFileSync(txtPath, 'utf8').split(/\r?\n/).filter((x) => x.startsWith('- ')).length >= 2);

console.log(bad ? ('失败 ' + bad + ' 条') : '全部通过');
process.exit(bad ? 1 : 0);
