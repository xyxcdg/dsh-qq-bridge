'use strict';
/**
 * senses.cjs —— 她的五官（2026-10-23）
 *   眼：截图 → 本机 ollama 视觉模型（qwen2.5vl:3b）→ 一句话描述
 *   耳：最近一条语音的转写 / 最近一条消息（由 bridge 传入）
 *   口：交给 voice.cjs（TTS），本文件只负责「说什么」的素材
 *   手：computer 工具（点、敲、开程序）——已经在她工具面里
 *   身：电量 / CPU / 内存 / GPU / 网络延迟 / 前台窗口 / 闲置秒数
 * 设计纪律：所有感官都是**可失败的**，拿不到就返回 null 并说明原因，绝不编。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DIR = __dirname;
const TMP = path.join(DIR, 'tmp');
const SIGHT_FILE = path.join(DIR, 'memory', 'sight.jsonl');
const SEE_PS = path.join(DIR, 'see.ps1');
const OLLAMA = process.env.QQ_OLLAMA || 'http://127.0.0.1:11434';
const VLM = process.env.QQ_VLM || 'qwen2.5vl:3b';

function run(file, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs || 30000, windowsHide: true }, (err, stdout) => {
      resolve(err ? { ok: false, error: String(err.message || err) } : { ok: true, out: String(stdout || '').trim() });
    });
  });
}

/** 拍一张（缩小到 960 宽） */
async function shoot() {
  const out = path.join(TMP, 'sight-' + Date.now() + '.jpg');
  const r = await run('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SEE_PS, '-Out', out, '-Width', '960'], 30000);
  if (!r.ok || !fs.existsSync(out)) return { ok: false, error: r.error || '截图没生成' };
  return { ok: true, file: out, bytes: fs.statSync(out).size };
}

/** 眼睛：看一眼屏幕，用本地视觉模型说一句话 */
async function look(opts) {
  const o = opts || {};
  const shot = await shoot();
  if (!shot.ok) return { ok: false, error: shot.error };
  const b64 = fs.readFileSync(shot.file).toString('base64');
  const prompt = o.prompt || '用一句话（不超过40字）说这张电脑屏幕上正在做什么，只描述看到的东西，不要评价。如果画面里有密码框、验证码、身份证、银行卡、聊天隐私等内容，只写「有人在登录/在处理私事」，绝不读出具体内容。';
  let text = null, err = '';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs || 120000);
    const resp = await fetch(OLLAMA + '/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: o.model || VLM, prompt, images: [b64], stream: false, options: { num_predict: 90, temperature: 0.2 } }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const json = await resp.json();
    text = String((json && json.response) || '').replace(/\s+/g, ' ').trim();
  } catch (e) { err = String(e && e.message || e); }
  try { fs.unlinkSync(shot.file); } catch (_) {}
  if (!text) return { ok: false, error: '视觉模型没给出描述: ' + (err || '空响应') };
  const rec = { at: Date.now(), text: text.slice(0, 160), bytes: shot.bytes };
  try {
    if (!fs.existsSync(path.dirname(SIGHT_FILE))) fs.mkdirSync(path.dirname(SIGHT_FILE), { recursive: true });
    fs.appendFileSync(SIGHT_FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch (_) {}
  return { ok: true, text: rec.text, at: rec.at };
}

/** 最近 N 次看见的东西 */
function recentSight(n) {
  try {
    const lines = fs.readFileSync(SIGHT_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-(n || 3)).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

/** 身体：能拿到的硬件/系统状态，拿不到的如实说 */
async function body() {
  const ps = [
    '$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1',
    '$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
    '$os = Get-CimInstance Win32_OperatingSystem',
    '$freeMB = [int]($os.FreePhysicalMemory / 1024)',
    '$totalMB = [int]($os.TotalVisibleMemorySize / 1024)',
    '$gpu = (Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match "NVIDIA" } | Select-Object -First 1).Name',
    '$fg = (Get-Process | Where-Object { $_.MainWindowTitle } | Sort-Object CPU -Descending | Select-Object -First 1).MainWindowTitle',
    '$net = Test-Connection -ComputerName 223.5.5.5 -Count 1 -Quiet',
    'function IdleSec { Add-Type -Namespace W -Name I -MemberDefinition "[DllImport(\"user32.dll\")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p); public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }"; $i = New-Object W.I+LASTINPUTINFO; $i.cbSize = 8; [void][W.I]::GetLastInputInfo([ref]$i); [int](([Environment]::TickCount - $i.dwTime) / 1000) }',
    '$idle = try { IdleSec } catch { -1 }',
    'Write-Output (@{ battery = if ($b) { $b.EstimatedChargeRemaining } else { $null }; cpu = $cpu; freeMB = $freeMB; totalMB = $totalMB; gpu = $gpu; fg = $fg; net = $net; idleSec = $idle } | ConvertTo-Json -Compress)',
  ].join('; ');
  const r = await run('pwsh', ['-NoProfile', '-Command', ps], 25000);
  if (!r.ok) return { ok: false, error: r.error };
  try { return Object.assign({ ok: true }, JSON.parse(r.out)); } catch (e) { return { ok: false, error: '身体数据解析失败' }; }
}

/** 多模型联动：看看这台机器上有哪些脑子可用 */
async function models() {
  const out = { local: [], cloud: [] };
  try {
    const resp = await fetch(OLLAMA + '/api/tags');
    const json = await resp.json();
    out.local = (json.models || []).map((m) => m.name);
  } catch (_) { out.localError = 'ollama 不可达'; }
  if (process.env.DASHSCOPE_API_KEY) out.cloud.push('dashscope');
  if (process.env.DEEPSEEK_API_KEY) out.cloud.push('deepseek');
  return out;
}

module.exports = { shoot, look, recentSight, body, models, SIGHT_FILE, VLM };
