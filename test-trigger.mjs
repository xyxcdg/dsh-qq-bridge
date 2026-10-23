// test-trigger.mjs —— 校验 bridge.js 的触发词解析（与 bridge.js handleEvent 里那段逐字一致）
// 用法: node test-trigger.mjs
const trigger = '大肥鱼';

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
  ['大肥鱼自己修复', true, '自己修复'],       // ← 本次真实失败的那条
  ['大肥鱼 你好', true, '你好'],
  ['大肥鱼', true, '（无内容）'],             // 只有触发词（表情被剥掉后剩这个）
  ['大肥鱼，帮我看看', true, '帮我看看'],
  ['大肥鱼！快', true, '快'],
  ['在吗大肥鱼', true, '在吗'],               // 触发词在中间
  ['你好', false, '你好'],                    // 不带触发词
  ['大肥鱼干', true, '干'],                   // 旧规则专门保护的 case；新语义下算命令
  ['  大肥鱼  测试  ', true, '测试'],
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
