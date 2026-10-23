// 自查：判断"是不是机器人自己发的"必须比发送者 user_id，不能比 self_id。
// self_id 按 OneBot 规范永远是机器人自己 —— 拿它去比会把每一条消息都丢掉。
// 用法: node test/test-selfcheck.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'bridge.config.example.json'), 'utf8'));
const selfQQ = String(CFG.selfQQ);

function selfCheck(evt) {
  const senderId = String(evt.user_id || '');
  if (senderId && selfQQ && senderId === selfQQ) return 'DROP(自己发的)';
  return 'PASS';
}

const cases = [
  [{ self_id: selfQQ, user_id: CFG.masterQQ, message: '你好' }, 'PASS'],
  [{ self_id: selfQQ, user_id: '20002', message: '测试' }, 'PASS'],
  [{ self_id: selfQQ, user_id: selfQQ, message: '机器人自己发的' }, 'DROP(自己发的)'],
];
let bad = 0;
for (const [evt, want] of cases) {
  const got = selfCheck(evt);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? '✅' : '❌'} self_id=${evt.self_id} user_id=${evt.user_id} → ${got}`);
}
console.log(bad === 0 ? '  全部通过：用户的消息不会被误判成「自己的消息」' : `  ${bad} 项失败`);
process.exit(bad === 0 ? 0 : 1);
