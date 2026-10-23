'use strict';
// 假 DSH：把收到的提示词存成 prompt-<n>.txt（称呼测试断言的就是它），并输出 bridge 认的三行事件。
const fs = require('fs');
const path = require('path');
const prompt = String(process.argv[process.argv.length - 1] || '');
const cntFile = path.join(__dirname, 'prompt-count.txt');
let n = 0;
try { n = parseInt(fs.readFileSync(cntFile, 'utf8'), 10) || 0; } catch (_) {}
n += 1;
fs.writeFileSync(cntFile, String(n));
fs.writeFileSync(path.join(__dirname, 'prompt-' + n + '.txt'), prompt, 'utf8');
process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-33333333-3333-3333-3333-333333333333', cwd: __dirname }) + '\n');
process.stdout.write(JSON.stringify({ type: 'status', phase: 'step_end', turn: 1, usage: { inputTokens: 1000, totalTokens: 1000 } }) + '\n');
process.stdout.write(JSON.stringify({ type: 'final', text: '收到喵' }) + '\n');
process.exit(0);
