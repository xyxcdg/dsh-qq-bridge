// 触发词解析的回归测试：与 bridge.js handleEvent 里的实现逐字一致。
// 用法: node test/test-trigger.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'bridge.config.example.json'), 'utf8'));
const trigger = CFG.triggerWord || '喵喵';

// ↓↓↓ 与 bridge.js handleEvent 中的实现逐字一致 ↓↓↓
function parse(text) {
  const raw = String(text).trim();
  let isCmd = false;
  let rest = raw;
  {
    const lt = trigger.toLowerCase();
    const li = raw.toLowerCase();
    if (lt && li.startsWith(lt)) {
      isCmd = true;
      rest = raw.slice(trigger.length);
    } else if (lt) {
      const idx = li.indexOf(lt);
      if (idx >= 0) {
        isCmd = true;
        rest = raw.slice(0, idx) + ' ' + raw.slice(idx + trigger.length);
      }
    }
    rest = rest.replace(/^[\s，,。.!！?？:：、~～\-]+/, '').trim();
  }
  const task = (isCmd ? rest.trim() : raw) || '（无内容）';
  return { isCmd, task };
}
// ↑↑↑ 逐字一致结束 ↑↑↑

const cases = [
  // [输入, 期望 isCmd, 期望 task]
  [trigger + '自己修复', true, '自己修复'],   // 中文没有词边界：触发词后面直接跟字也算命令
  [trigger + ' 你好', true, '你好'],
  [trigger, true, '（无内容）'],
  [trigger + '，帮我看看', true, '帮我看看'],
  ['在吗' + trigger, true, '在吗'],           // 触发词在中间
  ['你好', false, '你好'],
  ['  ' + trigger + '  测试  ', true, '测试'],
];

let bad = 0;
for (const [input, wantCmd, wantTask] of cases) {
  const got = parse(input);
  const ok = got.isCmd === wantCmd && got.task === wantTask;
  if (!ok) bad++;
  console.log(`${ok ? '✅' : '❌'} ${JSON.stringify(input).padEnd(24)} → isCmd=${got.isCmd} task=${JSON.stringify(got.task)}` + (ok ? '' : `   期望 isCmd=${wantCmd} task=${JSON.stringify(wantTask)}`));
}
console.log(bad === 0 ? `\n全部 ${cases.length} 项通过` : `\n${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
