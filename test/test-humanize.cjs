'use strict';
// 「像人一样回」的回归测试：钉住切条行为 + 配置里的机器话。
// 用法: node test/test-humanize.cjs
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { planBubbles, isStructured } = require('../humanize.cjs');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'bridge.config.example.json'), 'utf8'));
const SPLIT = CFG.chatStyle.bubbleSplit;
const flat = (s) => String(s).replace(/\s+/g, '');
let pass = 0;
function t(name, fn) { try { fn(); console.log('  [OK] ' + name); pass++; } catch (e) { console.log('  [FAIL] ' + name + ' :: ' + e.message); process.exitCode = 1; } }

t('短句只发一条', () => {
  const b = planBubbles('好哦，马上弄。', SPLIT);
  assert.deepStrictEqual(b, ['好哦，马上弄。']);
});

t('三句话拆成三条且不改内容', () => {
  const src = '文件我看了。里面有三条。要我现在改吗？';
  const b = planBubbles(src, SPLIT);
  assert.strictEqual(b.length, 3, 'got ' + JSON.stringify(b));
  assert.strictEqual(flat(b.join('')), flat(src));
});

t('名单/编号列表不拆', () => {
  const src = '名单如下：\n1. 张三 A2621\n2. 李四 A2622\n3. 王五 A2631\n共 3 人。';
  assert.ok(isStructured(src));
  const b = planBubbles(src, SPLIT);
  assert.strictEqual(b.length, 1, 'got ' + JSON.stringify(b));
});

t('句数超过上限时收成不超过 maxBubbles 条', () => {
  const src = Array.from({ length: 12 }, (_, i) => '这是第' + (i + 1) + '句。').join('');
  const b = planBubbles(src, SPLIT);
  assert.ok(b.length <= SPLIT.maxBubbles, 'got ' + b.length);
  assert.strictEqual(flat(b.join('')), flat(src));
});

t('超长文本按 hardLimit 切且不丢字', () => {
  const src = '很长的句子。'.repeat(800);
  const b = planBubbles(src, SPLIT);
  assert.ok(b.every((x) => x.length <= SPLIT.hardLimit), 'some bubble too long');
  assert.strictEqual(flat(b.join('')), flat(src));
});

t('空文本给出占位而不是空消息', () => {
  assert.deepStrictEqual(planBubbles('', SPLIT), ['（无输出）']);
  assert.deepStrictEqual(planBubbles(null, SPLIT), ['（无输出）']);
});

t('延迟开口/进度的话术里不许出现机器话', () => {
  const banned = ['会话', '进程', '接口', 'token', '桥接', '任务已入队', '正在处理', '收到'];
  const all = [].concat(CFG.chatStyle.ackPhrases || [], CFG.chatStyle.progressPhrases || []);
  for (const s of all) for (const w of banned) assert.ok(s.indexOf(w) < 0, '「' + s + '」含机器话: ' + w);
});

t('配置里确实关掉了「必发 ACK」', () => {
  assert.ok(CFG.chatStyle.enabled === true);
  assert.ok(CFG.chatStyle.ackDelayMs >= 3000, 'ack 太早说话就跟每次都收到一样了');
});

t('人格必须保留（提示词第一段 + 风格开关）', () => {
  assert.strictEqual(CFG.replyStyle.enabled, true, 'replyStyle 被关掉了');
  assert.ok(/猫娘/.test(CFG.replyStyle.promptPrefix), 'replyStyle 里没有猫娘设定');
  assert.ok(/人格/.test(CFG.chatStyle.promptBlock) && /本喵/.test(CFG.chatStyle.promptBlock), 'promptBlock 没有把人格写在前面');
  assert.ok(CFG.chatStyle.promptBlock.indexOf('人格') < CFG.chatStyle.promptBlock.indexOf('说话方式'), '人格段必须排在说话方式之前');
});

t('桥接自己说的话也要有猫味', () => {
  const all = [].concat(CFG.chatStyle.ackPhrases || [], CFG.chatStyle.progressPhrases || []);
  for (const s of all) assert.ok(/喵|本喵/.test(s), '「' + s + '」没有猫娘口癖');
});

console.log('\n' + (process.exitCode ? 'FAILED' : 'PASS') + ' - ' + pass + ' checks');
