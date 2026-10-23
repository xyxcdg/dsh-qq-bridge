'use strict';
/**
 * QQ 语音 -> 文字（2026-10-22 老爹要求「听得懂语音」）
 *
 * 路线：NapCat get_record 拿本地文件 -> ffmpeg 转 16k 单声道 wav
 *      -> 阿里云百炼 qwen3-asr-flash（OpenAI 兼容 chat/completions，audio 输入 base64）
 *
 * 纪律：任何一步失败都抛错，由调用方写日志并降级成「（没听清）」；
 *       绝不静默当成没收到（那会变成「机器人又聋了」）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const MODEL = 'qwen3-asr-flash';
// 可用 QQ_BOT_FFMPEG 指定 ffmpeg 绝对路径；留空则用 PATH 里的 ffmpeg。
const FFMPEG_FALLBACK = process.env.QQ_BOT_FFMPEG || '';
let cachedKey = null;

function readKey(dshHome) {
  if (cachedKey) return cachedKey;
  if (process.env.DASHSCOPE_API_KEY) { cachedKey = String(process.env.DASHSCOPE_API_KEY).trim(); return cachedKey; }
  const envPath = path.join(dshHome || path.join(process.env.USERPROFILE || '', '.dsh'), '.env');
  try {
    const m = fs.readFileSync(envPath, 'utf8').match(/^DASHSCOPE_API_KEY=(.+)$/m);
    if (m) cachedKey = m[1].trim();
  } catch (_) {}
  return cachedKey;
}

function ffmpegBin() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  if (fs.existsSync(FFMPEG_FALLBACK)) return FFMPEG_FALLBACK;
  return 'ffmpeg'; // 交给 PATH，失败会被上层记成具体错误
}

function toWav(src, dst) {
  execFileSync(ffmpegBin(), ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '16000', dst], { stdio: 'ignore', timeout: 60000 });
  if (!fs.existsSync(dst)) throw new Error('ffmpeg 没产出 wav');
  return dst;
}

async function transcribe(file, opts) {
  const o = opts || {};
  const key = readKey(o.dshHome);
  if (!key) throw new Error('没有 DASHSCOPE_API_KEY，无法转写');
  const wav = file.replace(/\.[^.\\/]+$/, '') + '.16k.wav';
  toWav(file, wav);
  const b64 = fs.readFileSync(wav).toString('base64');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 45000);
  try {
    const r = await fetch(BASE + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,' + b64 } }] }],
      }),
      signal: ac.signal,
    });
    const t = await r.text();
    if (!r.ok) throw new Error('ASR HTTP ' + r.status + ': ' + String(t).slice(0, 200));
    const j = JSON.parse(t);
    const c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    return String(c || '').trim();
  } finally {
    clearTimeout(timer);
    try { fs.unlinkSync(wav); } catch (_) {}
  }
}

module.exports = { transcribe, readKey };
