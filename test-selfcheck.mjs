const CFG = { selfQQ: '10001', triggerWord: '大肥鱼' };
// 复刻修复后的判断
function selfCheck(evt){
  const senderId = String(evt.user_id || '');
  if (senderId && CFG.selfQQ && senderId === String(CFG.selfQQ)) return 'DROP(自己发的)';
  return 'PASS';
}
const cases = [
  [{ self_id: '10001', user_id: '10002', message: '大肥鱼你好' }, 'PASS'],
  [{ self_id: '10001', user_id: '2846696173', message: '大肥鱼测试' }, 'PASS'],
  [{ self_id: '10001', user_id: '10001', message: '机器人自己发的' }, 'DROP(自己发的)'],
];
let bad = 0;
for (const [evt, want] of cases) {
  const got = selfCheck(evt);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? '✅' : '❌'} self_id=${evt.self_id} user_id=${evt.user_id} → ${got}`);
}
console.log(bad === 0 ? '  全部通过：用户的消息不再被误判成「自己的消息」' : `  ${bad} 项失败`);
