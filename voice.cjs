'use strict';
/**
 * 把一句话说成语音文件（给 QQ 发语音用）。
 *
 * 引擎顺序（配置 voice.engine）：
 *   auto  → edge-tts（微软神经语音，最像真人，需要网络）→ 失败退 Windows SAPI（完全离线）
 *   edge  → 只用 edge-tts
 *   sapi  → 只用 Windows 自带语音（Huihui/Yaoyao，音质一般）
 *
 * 本机两条实测纪律（都写进代码了）：
 *   ① edge-tts 走 aiohttp + trust_env，而本机全局 HTTP(S)_PROXY 指向常关的 127.0.0.1:7890
 *      ⇒ 必须在 python 进程里清掉代理变量，否则必报 ClientProxyConnectionError。
 *   ② 不存在的语音名（如 zh-CN-XiaomengNeural）会报 NoAudioReceived，那不是网络问题。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BASE = __dirname;
const VOICE_DIR = path.join(BASE, 'voice');
const OUT_DIR = path.join(VOICE_DIR, 'out');
// python 解释器：优先 config 的 voice.pythonExe，其次环境变量 QQ_BOT_PYTHON，最后走 PATH 里的 python。
const PY = process.env.QQ_BOT_PYTHON || 'python';

function ensureDirs() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function run(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let p;
    try { p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { resolve({ code: -1, out: '', err: e.message }); return; }
    const t = setTimeout(() => { try { p.kill(); } catch (_) {} }, timeoutMs || 25000);
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

/** 念出来时把 CQ 码、链接、Markdown 记号剃掉（不剃的话会念出 "CQ image file..."）。 */
function speakable(text) {
  return String(text == null ? '' : text)
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*\u0060#>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanup(keep) {
  try {
    const files = fs.readdirSync(OUT_DIR)
      .map((f) => ({ f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(keep || 40)) {
      try { fs.unlinkSync(path.join(OUT_DIR, x.f)); } catch (_) {}
    }
  } catch (_) {}
}

async function synthEdge(text, cfg) {
  ensureDirs();
  const voice = cfg.edgeVoice || 'zh-CN-XiaoyiNeural';
  const rate = cfg.rate || '+8%';
  const pitch = cfg.pitch || '+0Hz';
  const key = crypto.createHash('sha1').update([voice, rate, pitch, text].join('\u0000')).digest('hex').slice(0, 16);
  const out = path.join(OUT_DIR, 'tts-' + key + '.mp3');
  if (fs.existsSync(out) && fs.statSync(out).size > 2000) return { file: out, engine: 'edge', cached: true };
  const txt = path.join(os.tmpdir(), 'dsh-tts-' + key + '.txt');
  fs.writeFileSync(txt, text, 'utf8');
  const r = await run(cfg.pythonExe || PY, [path.join(VOICE_DIR, 'tts.py'), '--text-file', txt, '--out', out, '--voice', voice, '--rate', rate, '--pitch', pitch], cfg.timeoutMs || 25000);
  try { fs.unlinkSync(txt); } catch (_) {}
  if (r.code !== 0 || !fs.existsSync(out)) {
    return { file: null, engine: 'edge', error: (r.err || r.out || 'exit ' + r.code).trim().slice(0, 300) };
  }
  return { file: out, engine: 'edge' };
}

async function synthSapi(text, cfg) {
  ensureDirs();
  const key = crypto.createHash('sha1').update(['sapi', cfg.sapiVoice || 'Microsoft Yaoyao', text].join('\u0000')).digest('hex').slice(0, 16);
  const out = path.join(OUT_DIR, 'tts-' + key + '.wav');
  if (fs.existsSync(out) && fs.statSync(out).size > 2000) return { file: out, engine: 'sapi', cached: true };
  const txt = path.join(os.tmpdir(), 'dsh-tts-' + key + '.txt');
  fs.writeFileSync(txt, text, 'utf8');
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(VOICE_DIR, 'sapi.ps1'), '-TextFile', txt, '-Out', out, '-Voice', cfg.sapiVoice || 'Microsoft Yaoyao'], 20000);
  try { fs.unlinkSync(txt); } catch (_) {}
  if (r.code !== 0 || !fs.existsSync(out)) {
    return { file: null, engine: 'sapi', error: (r.err || r.out || 'exit ' + r.code).trim().slice(0, 300) };
  }
  return { file: out, engine: 'sapi' };
}

/** 主入口：返回 { file, engine } 或 { file:null, error }。永不抛。 */
async function synthVoice(text, cfg) {
  const c = cfg || {};
  const say = speakable(text);
  if (!say) return { file: null, error: 'empty-after-clean' };
  if (say.length > (Number(c.maxChars) || 120)) return { file: null, error: 'too-long:' + say.length };
  const engine = c.engine || 'auto';
  const tries = engine === 'edge' ? ['edge'] : engine === 'sapi' ? ['sapi'] : ['edge', 'sapi'];
  let lastErr = null;
  for (const e of tries) {
    const r = e === 'edge' ? await synthEdge(say, c) : await synthSapi(say, c);
    if (r.file) { cleanup(Number(c.keepFiles) || 40); return r; }
    lastErr = e + ': ' + (r.error || 'unknown');
    if (c.debug) console.log('[voice] ' + lastErr);
  }
  return { file: null, error: lastErr || 'no-engine' };
}

module.exports = { synthVoice, speakable, VOICE_DIR };
