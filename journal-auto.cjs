'use strict';
// 自动日志：把当天记录摘成摘要。去重后再报，避免同一类告警刷屏。
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const LOG = path.join(ROOT, 'bridge.log');
const OUT_DIR = path.join(ROOT, 'journal');
const localDay = (d) => new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);

const raw = fs.readFileSync(LOG, 'utf8').split(/\r?\n/);
const today = localDay(new Date());
const stat = { task: 0, sent: 0, warn: 0, error: 0, preempt: 0, voice: 0 };
const kinds = new Map(); // 归并同类行：key -> {n, sample}
const bump = (k, sample) => {
  const cur = kinds.get(k) || { n: 0, sample };
  cur.n++; kinds.set(k, cur);
};
for (const line of raw) {
  const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\]\s+\[(\w+)\]\s+(.*)$/);
  if (!m) continue;
  if (localDay(new Date(m[1])) !== today) continue;
  const lvl = m[2], msg = m[3];
  if (/任务入队/.test(msg)) stat.task++;
  if (/已发送 ->/.test(msg)) stat.sent++;
  if (/插队/.test(msg)) { stat.preempt++; bump('插队', msg.slice(0, 50)); }
  if (/语音转文字/.test(msg)) { stat.voice++; bump('语音转写', msg.slice(0, 50)); }
  if (lvl === 'ERROR') { stat.error++; bump('ERROR ' + msg.slice(0, 50), msg.slice(0, 80)); }
  else if (lvl === 'WARN') {
    stat.warn++;
    const key = msg.replace(/\d+/g, '#').slice(0, 50);
    bump('WARN ' + key, msg.slice(0, 80));
  }
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const out = path.join(OUT_DIR, 'auto-' + today + '.md');
const top = [...kinds.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 12);
const lines = [
  '# 自动摘要 · ' + today,
  '',
  '机器自己从当天记录里摘的，不是人写的；细节看 bridge.log。',
  '任务 ' + stat.task + ' 条 / 发出 ' + stat.sent + ' 条 / 插队 ' + stat.preempt + ' 次 / 语音转写 ' + stat.voice + ' 次',
  '告警 ' + stat.warn + ' 条 / 错误 ' + stat.error + ' 条（下面按同类归并）',
  '',
  '## 出现最多的几类',
  ...(top.length ? top.map(([k, v]) => '- ×' + v.n + '  ' + v.sample) : ['- （今天没有特别的）']),
];
fs.writeFileSync(out, lines.join('\n'), 'utf8');
console.log('written ' + out);
