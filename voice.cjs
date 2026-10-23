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
  // 【2026-10-19 实测】把 mp3 直接丢给 NapCat，它会把语音转成 AMR-NB（8kHz 电话音）——这就是
  // "还是有机械音"的来源。自己转成 silk（24kHz）再发，NapCat 原样上传，音质明显干净。
  // 【2026-10-19 二次实测】silk 和 mp3 到了主人那边都“无法播放”，只有 AMR 能播。
  // 所以默认改成 amr（ffmpeg libopencore_amrnb 12.2k）；想换回 silk 就把 format 设成 'silk'。
  const fmt = cfg.format || 'amr';
  if (fmt === 'amr') {
    const amr = await toAmr(out, cfg);
    if (amr.file) return { file: amr.file, engine: 'edge-amr', cached: amr.cached };
    if (cfg.debug) console.log('[voice] amr 转换失败，退回 mp3: ' + amr.error);
  } else if (fmt !== 'mp3') {
    const silk = await toSilk(out, cfg);
    if (silk.file) return { file: silk.file, engine: 'edge-silk', cached: silk.cached };
    if (cfg.debug) console.log('[voice] silk 转换失败，退回 mp3: ' + silk.error);
  }
  return { file: out, engine: 'edge' };
}

async function toAmr(mp3, cfg) {
  const pv = Number(cfg.amrPitch) || 1;
  const base = mp3.replace(/\.(mp3|wav)$/i, '');
  const tag = pv === 1 ? '' : '-' + String(pv).replace(/\./g, '_');
  const target = base + tag + '.amr';
  if (fs.existsSync(target) && fs.statSync(target).size > 500) return { file: target, cached: true };
  const ff = cfg.ffmpegExe || 'C:\\Tools\\ffmpeg\\bin\\ffmpeg.exe';
  let input = mp3;
  let tmp = null;
  if (pv !== 1) {
    // 先规整到 24k，再 asetrate：否则 ffmpeg 按源采样率重解释，音高会被减半（曾把女声变成大叔）。
    tmp = base + '.24k.wav';
    const r0 = await run(ff, ['-y', '-v', 'error', '-i', mp3, '-ar', '24000', '-ac', '1', tmp], cfg.amrTimeoutMs || 20000);
    if (r0.code !== 0 || !fs.existsSync(tmp)) return { file: null, error: 'norm:' + (r0.err || 'exit ' + r0.code) };
    input = tmp;
  }
  const args = ['-y', '-v', 'error', '-i', input, '-ar', '8000', '-ac', '1', '-c:a', 'libopencore_amrnb', '-b:a', '12.2k'];
  if (pv !== 1) { let fx = 'asetrate=' + Math.round(24000 * pv) + ',aresample=24000,atempo=' + (1 / pv).toFixed(4); if (cfg.amrFx) fx += ',' + cfg.amrFx; args.push('-af', fx); }
  args.push(target);
  const r = await run(ff, args, cfg.amrTimeoutMs || 20000);
  if (tmp) { try { fs.unlinkSync(tmp); } catch (e) {} }
  if (r.code !== 0 || !fs.existsSync(target)) {
    return { file: null, error: (r.err || r.out || 'exit ' + r.code).trim().slice(0, 300) };
  }
  return { file: target };
}

async function toSilk(mp3, cfg) {
  const silk = mp3.replace(/\.(mp3|wav)$/i, '.silk');
  // 【2026-10-19 实测】腾讯 silk 必须以 0x02 开头；早期缓存是"裸 silk"（QQ 点开会听不了），
  // 所以缓存校验不能只看存在与大小，必须验首字节，否则旧的坏文件会被一直复用。
  if (fs.existsSync(silk) && fs.statSync(silk).size > 2000) {
    try {
      const fd = fs.openSync(silk, 'r');
      const b = Buffer.alloc(1);
      fs.readSync(fd, b, 0, 1, 0);
      fs.closeSync(fd);
      if (b[0] === 0x02) return { file: silk, cached: true };
    } catch (_) {}
  }
  const r = await run(cfg.pythonExe || PY, [path.join(VOICE_DIR, 'silk.py'), '--mp3', mp3, '--out', silk], cfg.silkTimeoutMs || 20000);
  if (r.code !== 0 || !fs.existsSync(silk)) {
    return { file: null, error: (r.err || r.out || 'exit ' + r.code).trim().slice(0, 300) };
  }
  return { file: silk };
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
  const tries = engine === 'edge' ? ['edge'] : engine === 'sapi' ? ['sapi']
    : engine === 'chattts' ? ['chattts', 'edge', 'sapi']
    : engine === 'gptsovits' ? ['gptsovits', 'edge', 'sapi']
    : ['gptsovits', 'chattts', 'edge', 'sapi'];
  let lastErr = null;
  for (const e of tries) {
    const r = e === 'edge' ? await synthEdge(say, c)
      : e === 'chattts' ? await synthChattts(say, c)
      : e === 'gptsovits' ? await synthGptSovits(say, c)
      : await synthSapi(say, c);
    if (r.file) { cleanup(Number(c.keepFiles) || 40); return r; }
    lastErr = e + ': ' + (r.error || 'unknown');
    if (c.debug) console.log('[voice] ' + lastErr);
  }
  return { file: null, error: lastErr || 'no-engine' };
}


// ---------------------------------------------------------------- ChatTTS（本地角色音）
// 常驻服务 tts_server.py：模型只加载一次。桥接第一次要发语音时把它拉起来，之后复用。
// 用 http.request 而不是 fetch：本机 NODE_USE_ENV_PROXY=1，fetch 会被塞进代理；
// 循环地址显式走 http 直连最稳。
const http = require('http');
const SERVER_PORT = 8571;

function httpJson(method, path, body, timeoutMs) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request({
      host: '127.0.0.1', port: SERVER_PORT, path, method,
      headers: data ? { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length } : {},
      timeout: timeoutMs || 120000,
      agent: new http.Agent({ keepAlive: false }),
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); }
        catch (_) { resolve({ status: res.statusCode, json: null, raw: buf.slice(0, 200) }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function ensureTtsServer(cfg) {
  const h = await httpJson('GET', '/health', null, 1500);
  if (h.status === 200 && h.json && h.json.ok) return true;
  if (h.status === 200 && h.json && h.json.ok === false) {
    // 服务在但模型还没 load 完，再等等
    for (let i = 0; i < 60; i++) {
      await sleepMs(2000);
      const again = await httpJson('GET', '/health', null, 1500);
      if (again.status === 200 && again.json && again.json.ok) return true;
    }
    return false;
  }
  // 不在：拉起来（脱离当前进程树，桥接重启也不用重装）
  try {
    const { spawn } = require('child_process');
    const p = spawn(cfg.pythonExe || PY, [path.join(VOICE_DIR, 'tts_server.py')], {
      detached: true, windowsHide: true, stdio: 'ignore',
      env: Object.assign({}, process.env, {
        CHATTTS_MODELS: path.join(VOICE_DIR, 'models', 'chattts'),
        CHATTTS_PORT: String(SERVER_PORT),
        CHATTTS_SEED: String((cfg && cfg.chatttsSeed) || 42),
      }),
    });
    p.unref();
  } catch (_) { return false; }
  for (let i = 0; i < 75; i++) {
    await sleepMs(2000);
    const again = await httpJson('GET', '/health', null, 1500);
    if (again.status === 200 && again.json && again.json.ok) return true;
  }
  return false;
}

async function synthChattts(text, cfg) {
  ensureDirs();
  const seed = Number(cfg.chatttsSeed) || 42;
  const key = crypto.createHash('sha1').update(['chattts', seed, text].join('\u0000')).digest('hex').slice(0, 16);
  const out = path.join(OUT_DIR, 'chattts-' + key + '.wav');
  if (fs.existsSync(out) && fs.statSync(out).size > 4000) return { file: out, engine: 'chattts', cached: true };
  const ok = await ensureTtsServer(cfg);
  if (!ok) return { file: null, engine: 'chattts', error: 'tts-server-not-ready' };
  const r = await httpJson('POST', '/tts', { text, out, seed }, 180000);
  if (r.status !== 200 || !r.json || !r.json.ok) {
    return { file: null, engine: 'chattts', error: (r.json && r.json.error) || r.error || ('http ' + r.status) };
  }
  // 【2026-10-19】ChatTTS 也要走 amr（主人那边只有 amr 稳定能播）。
  const cfmt = cfg.format || 'sil k'.replace(' ', '');
  if (cfmt === 'amr') {
    const amr = await toAmr(out, cfg);
    if (amr.file) return { file: amr.file, engine: 'chattts-amr' };
  } else if (cfmt !== 'mp3') {
    const silk = await toSilk(out, cfg);
    if (silk.file) return { file: silk.file, engine: 'chattts-silk' };
  }
  return { file: out, engine: 'chattts' };
}


// ---------------------------------------------------------------- GPT-SoVITS（天音声线）
// 常驻 9880：官方 v2 底模 + 零样本克隆，参考音 = 鉴赏模式里她本人的原声。
// 起不来自动拉起（.venv + api_v2.py），再不行退回 edge/SAPI，绝不让"这次没声音"发生。
const GSV = {
  // GPT-SoVITS 是可选的本地音色引擎：留空即视为未安装，自动跳过（回退 edge/SAPI）。
  root: process.env.QQ_BOT_GSV_ROOT || '',
  port: 9880,
  config: 'GPT_SoVITS/configs/tts_infer_amane.yaml',
  ref: path.join(VOICE_DIR, 'galgame', 'amane-ref-01.wav'),
};

function rawRequest(opts, body, timeoutMs) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request(Object.assign({ method: 'POST' }, opts, {
      headers: Object.assign(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}, opts.headers || {}),
      timeout: timeoutMs || 120000,
      agent: new http.Agent({ keepAlive: false }),
    }), (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, buf, text: buf.slice(0, 300).toString('utf8') });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: 0, buf: Buffer.alloc(0), text: e.message }));
    if (data) req.write(data);
    req.end();
  });
}

function portOpen(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const s = net.connect({ host: '127.0.0.1', port }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.setTimeout(800, () => { s.destroy(); resolve(false); });
  });
}

const GSV_STATE = path.join(VOICE_DIR, 'gptsovits-server.json');

function readGsvState() {
  try { return JSON.parse(fs.readFileSync(GSV_STATE, 'utf8')); } catch (_) { return null; }
}
function writeGsvState(o) {
  try { fs.mkdirSync(VOICE_DIR, { recursive: true }); fs.writeFileSync(GSV_STATE, JSON.stringify(o)); } catch (_) {}
}
function portPid(port) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    const ps = '(Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess';
    execFile('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true }, (e, out) => {
      const pid = parseInt(String(out || '').trim(), 10);
      resolve(Number.isFinite(pid) ? pid : 0);
    });
  });
}
function killPid(pid) {
  return new Promise((resolve) => {
    const { execFile } = require('child_process');
    execFile('taskkill', ['/PID', String(pid), '/F', '/T'], { windowsHide: true }, () => resolve());
  });
}

// 长跑实测：同一实例累积大量请求后，单句耗时从 2.5s 退化到 20s+（显存碎片/缓存），
// 所以按「服务器已运行时长」定期轮换；轮换只发生在下一次合成前，不打断正在进行的请求。
async function ensureGsv(cfg) {
  const rotateHours = Number((cfg && cfg.rotateHours) ?? GSV.rotateHours ?? 6);
  if (await portOpen(GSV.port)) {
    const st = readGsvState();
    if (!st || !st.startedAt) {
      writeGsvState({ startedAt: Date.now(), pid: await portPid(GSV.port) });
      return true;
    }
    const ageH = (Date.now() - Number(st.startedAt)) / 3600000;
    // 只在凌晨空窗轮换：冷启动 + 首句预热约 1-2 分钟，白天触发会拖慢正在进行的回复。
    const winStart = Number((cfg && cfg.rotateWindowStart) ?? 3);
    const winEnd = Number((cfg && cfg.rotateWindowEnd) ?? 7);
    const hour = new Date().getHours();
    const inWindow = winStart <= winEnd ? (hour >= winStart && hour < winEnd) : (hour >= winStart || hour < winEnd);
    if (!inWindow) return true;
    if (!(rotateHours > 0) || ageH < rotateHours) return true;
    const owner = await portPid(GSV.port);
    const pids = [...new Set([Number(st.pid) || 0, Number(owner) || 0].filter((x) => x > 0))];
    for (const x of pids) await killPid(x);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (!(await portOpen(GSV.port))) break;
    }
  }
  try {
    const py = path.join(GSV.root, '.venv', 'Scripts', 'python.exe');
    if (!fs.existsSync(py)) return false;
    const p = spawn(py, ['-u', 'api_v2.py', '-a', '127.0.0.1', '-p', String(GSV.port), '-c', GSV.config], {
      cwd: GSV.root, detached: true, windowsHide: true, stdio: 'ignore',
    });
    p.unref();
    writeGsvState({ startedAt: Date.now(), pid: p.pid });
  } catch (_) { return false; }
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    if (await portOpen(GSV.port)) {
      if (!readGsvState()) writeGsvState({ startedAt: Date.now(), pid: await portPid(GSV.port) });
      return true;
    }
  }
  return false;
}

async function synthGptSovits(text, cfg) {
  ensureDirs();
  const c = cfg || {};
  const g = Object.assign({}, GSV, c.gptsovits || {});
  const ref = g.refAudio || GSV.ref;
  if (!fs.existsSync(ref)) return { file: null, engine: 'gptsovits', error: 'ref-audio-missing' };
  if (!(await ensureGsv(g))) return { file: null, engine: 'gptsovits', error: 'server-not-ready' };
  const body = {
    text,
    text_lang: g.textLang || 'zh',
    ref_audio_path: ref.replace(/\\/g, '/'),
    prompt_text: g.promptText || '',
    prompt_lang: g.promptLang || 'ja',
    aux_ref_audio_paths: Array.isArray(g.auxRefs) ? g.auxRefs.map((p) => p.replace(/\\/g, '/')) : [],
    text_split_method: 'cut5',
    media_type: 'wav',
    streaming_mode: false,
    temperature: Number(g.temperature ?? 0.35),
    top_p: Number(g.topP ?? 0.7),
    top_k: Number(g.topK ?? 15),
    speed_factor: Number(g.speed ?? 1.0),
  };
  const r = await rawRequest({ host: '127.0.0.1', port: Number(g.port) || GSV.port, path: '/tts' }, body, 180000);
  if (r.status !== 200 || !r.buf || r.buf.length < 1000) {
    return { file: null, engine: 'gptsovits', error: 'http-' + r.status + ':' + String(r.text || '').slice(0, 120) };
  }
  const key = crypto.createHash('sha1').update(['gsv', ref, (g.auxRefs || []).join('|'), String(g.temperature ?? ''), String(g.topP ?? ''), String(g.speed ?? ''), String(c.debuzz || g.debuzz || ''), text].join('\u0000')).digest('hex').slice(0, 16);
  const out = path.join(OUT_DIR, 'gsv-' + key + '.wav');
  fs.writeFileSync(out, r.buf);
  // 去「电音」：zero-shot 的高频嘶声/金属感主要来自 vocoder，轻量滤波能压下去
  const chain = c.debuzz || g.debuzz;
  let voicen = out;
  if (chain) {
    const filt = out.replace(/\.wav$/, '.filt.wav');
    const rr = await run(path.join('C:\\Tools\\ffmpeg\\bin', 'ffmpeg.exe'), ['-y', '-v', 'error', '-i', out, '-af', chain, '-ar', '32000', filt], 60000);
    if (rr.code === 0 && fs.existsSync(filt) && fs.statSync(filt).size > 4000) voicen = filt;
  }
  // 【2026-10-21】主人那边只有 amr 稳定能播，GPT-SoVITS 也要走 amr。
  const gfmt = c.format || g.format || 'amr';
  if (gfmt === 'amr') {
    const amr = await toAmr(voicen, c);
    if (amr.file) return { file: amr.file, engine: 'gptsovits-amr' };
  } else if (gfmt !== 'mp3') {
    const silk = await toSilk(voicen, c);
    if (silk.file) return { file: silk.file, engine: 'gptsovits-silk' };
  }
  return { file: voicen, engine: 'gptsovits' };
}

module.exports = { synthVoice, speakable, VOICE_DIR };
