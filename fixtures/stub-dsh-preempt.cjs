'use strict';
// preempt 专用假 DSH：只按【本次任务】那一段判慢/快 —— 提示词前半段是人格、记忆、自我状态，
// 里面会出现上一条消息的摘录，用整段 includes 判定会被污染（2026-10-23 实测）。
const prompt = String(process.argv[process.argv.length - 1] || '');
const m = prompt.match(/【本次任务】([\s\S]*)$/);
const body = m ? m[1] : prompt;
const slow = body.includes('慢任务');
process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-44444444-4444-4444-4444-444444444444', cwd: __dirname }) + '\n');
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'final', text: slow ? '慢答' : '快答' }) + '\n');
  process.exit(0);
}, slow ? 8000 : 200);
