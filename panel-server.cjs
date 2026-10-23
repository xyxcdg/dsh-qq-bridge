'use strict';
/**
 * panel-server.cjs - 大肥鱼控制台（本地小插件，不依赖 DSH 重启）
 *   GET  /               可视化面板（panel.html）
 *   GET  /api/status     账号/桥接/自我状态/日志 汇总
 *   GET  /api/config     可改配置的当前值
 *   POST /api/config     白名单修改（写前备份，改后需重启桥接）
 *   POST /api/action     restart-bridge | run-selfheal | notify-all
 * 只监听 127.0.0.1；写操作要求 X-QQBot: 1（挡掉别的网页顺手 POST）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const BASE = __dirname;
const CFG_PATH = path.join(BASE, 'bridge.config.json');
const STATE_PATH = path.join(BASE, 'state.json');
const HB_PATH = path.join(BASE, 'heartbeat.json');
const PORT = Number(process.env.QQBOT_PANEL_PORT) || 8123;
const NODE = process.execPath;

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } }
function tail(p, n) { try { const a = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean); return a.slice(-n); } catch (_) { return []; } }
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }

function probePort(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port: port });
    const done = (v) => { try { s.destroy(); } catch (_) {} res(v); };
    s.setTimeout(600);
    s.on('connect', () => done(true));
    s.on('timeout', () => done(false));
    s.on('error', () => done(false));
  });
}

function probeAccount() {
  return new Promise((res) => {
    let out = '';
    let child;
    try { child = spawn(NODE, [path.join(BASE, 'qq-probe.cjs')], { windowsHide: true }); } catch (e) { res({ ok: false, error: e.message }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} res({ ok: false, error: 'probe timeout' }); }, 9000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', () => { clearTimeout(timer); try { res(JSON.parse(out.trim().split('\n').pop())); } catch (_) { res({ ok: false, error: 'probe parse fail' }); } });
    child.on('error', (e) => { clearTimeout(timer); res({ ok: false, error: e.message }); });
  });
}

const DAY = 86400000;
async function buildStatus() {
  const now = Date.now();
  const cfg = readJson(CFG_PATH, {});
  const st = readJson(STATE_PATH, {});
  const hb = readJson(HB_PATH, {});
  const [acct, p3001, p6099] = await Promise.all([probeAccount(), probePort(3001), probePort(6099)]);
  const self = st.self || {};
  const moods = st.moods || {};
  let mood = 'calm', moodAt = 0;
  for (const k of Object.keys(moods)) { const m = moods[k] || {}; if (Number(m.since || 0) >= moodAt) { moodAt = Number(m.since || 0); mood = m.mood || 'calm'; } }
  const pending = (self.thoughts || []).filter((t) => t && !t.spoken).map((t) => t.text);
  const habits = (self.habits || []).map((h) => h && h.text).filter(Boolean);
  return {
    ok: true,
    now: now,
    account: { online: !!(acct && acct.ok && acct.online), userId: (acct && acct.userId) || '', nickname: (acct && acct.nickname) || '', error: (acct && acct.error) || '' },
    bridge: {
      pid: hb.pid || null,
      connected: !!hb.connected,
      ageSec: hb.ts ? Math.round((now - Number(hb.ts)) / 1000) : null,
      tasks: hb.tasks || 0,
      sessions: st.sessions || {},
      usage: st.usage || {},
      recycled: st.recycled || {},
      sessionLocked: !!(cfg.sessionLock && cfg.sessionLock.enabled),
    },
    ports: { onebot: p3001, webui: p6099 },
    napcatPid: (function () { try { const a = tail(path.join(BASE, 'heartbeat.json'), 1); return null; } catch (_) { return null; } })(),
    self: {
      day: self.born ? Math.floor((now - Number(self.born)) / DAY) + 1 : 1,
      turns: self.turns || 0,
      fatigue: Math.round(Number(self.fatigue || 0)),
      mood: mood,
      attention: (self.attention && self.attention.focus) || '',
      thoughts: pending,
      habits: habits,
      relations: self.relations || {},
    },
    logs: {
      bridge: tail(path.join(BASE, 'bridge.log'), 40),
      selfheal: tail(path.join(BASE, 'selfheal.log'), 20),
      // NapCat 控制台日志路径因机器而异：用 QQ_BOT_NAPCAT_LOG 指定，没设就不显示。
      napcat: process.env.QQ_BOT_NAPCAT_LOG ? tail(process.env.QQ_BOT_NAPCAT_LOG, 20) : [],
    },
  };
}

function readConfigView() {
  const c = readJson(CFG_PATH, {});
  return {
    triggerWord: c.triggerWord || '',
    replyMode: c.replyMode || 'channel',
    maxInputTokens: (c.sessionRecycle && c.sessionRecycle.maxInputTokens) || 250000,
    maxAgeHours: (c.sessionRecycle && c.sessionRecycle.maxAgeHours) || 24,
    proactiveEnabled: !!(c.proactive && c.proactive.enabled),
    groupChimeEnabled: !!(c.groupChime && c.groupChime.enabled),
    personaMoodEnabled: !!(c.personaMood && c.personaMood.enabled),
    voiceEnabled: !!(c.voice && c.voice.enabled),
    addrMaster: (c.addressing && c.addressing.master) || '老爹',
    addrDefault: (c.addressing && c.addressing.default) || '同学',
  };
}

function saveConfigView(body) {
  const c = readJson(CFG_PATH, null);
  if (!c) throw new Error('bridge.config.json 读不出来，拒绝写入');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(CFG_PATH, CFG_PATH + '.bak-panel-' + stamp);
  if (typeof body.triggerWord === 'string' && body.triggerWord.trim()) c.triggerWord = body.triggerWord.trim();
  if (body.replyMode === 'channel' || body.replyMode === 'private') c.replyMode = body.replyMode;
  c.sessionRecycle = c.sessionRecycle || {};
  const mah = Number(body.maxAgeHours);
  if (Number.isFinite(mah) && mah >= 1 && mah <= 720) c.sessionRecycle.maxAgeHours = Math.round(mah);
  const mit = Number(body.maxInputTokens);
  if (Number.isFinite(mit) && mit >= 10000 && mit <= 900000) c.sessionRecycle.maxInputTokens = Math.round(mit);
  c.proactive = c.proactive || {}; c.proactive.enabled = !!body.proactiveEnabled;
  c.groupChime = c.groupChime || {}; c.groupChime.enabled = !!body.groupChimeEnabled;
  c.personaMood = c.personaMood || {}; c.personaMood.enabled = !!body.personaMoodEnabled;
  c.voice = c.voice || {}; c.voice.enabled = !!body.voiceEnabled;
  c.addressing = c.addressing || {};
  if (typeof body.addrMaster === 'string' && body.addrMaster.trim()) c.addressing.master = body.addrMaster.trim();
  if (typeof body.addrDefault === 'string' && body.addrDefault.trim()) c.addressing.default = body.addrDefault.trim();
  fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2), 'utf8');
  return { ok: true, message: '已保存（备份 ' + path.basename(CFG_PATH + '.bak-panel-' + stamp) + '）。点「重启桥接」后生效。' };
}

function runAction(action) {
  const hb = readJson(HB_PATH, {});
  if (action === 'restart-bridge') {
    return new Promise((res) => {
      try { if (hb.pid && alive(hb.pid)) process.kill(hb.pid); } catch (_) {}
      execFile('schtasks', ['/Run', '/TN', 'CodexQQBridge'], { windowsHide: true }, (err) => {
        res({ ok: !err, message: err ? ('重启失败: ' + err.message) : '桥接已重启（约 5 秒后连上）' });
      });
    });
  }
  if (action === 'run-selfheal') {
    return new Promise((res) => {
      const c = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(BASE, 'qq-selfheal.ps1')], { windowsHide: true, detached: true, stdio: 'ignore' });
      c.unref();
      res({ ok: true, message: '自愈已触发（看自愈日志）' });
    });
  }
  if (action === 'notify-all') {
    return new Promise((res) => {
      const c = spawn(NODE, [path.join(BASE, 'qq-notify-all.cjs'), '--force'], { windowsHide: true, detached: true, stdio: 'ignore' });
      c.unref();
      res({ ok: true, message: '已触发全渠道通知' });
    });
  }
  return Promise.resolve({ ok: false, message: '未知操作: ' + action });
}

function send(res, code, type, body) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const write = req.headers['x-qqbot'] === '1';
  if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
    try { send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(BASE, 'panel.html'))); }
    catch (e) { send(res, 500, 'text/plain; charset=utf-8', 'panel.html 读不出来: ' + e.message); }
    return;
  }
  if (req.method === 'GET' && url === '/api/status') {
    buildStatus().then((s) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(s)))
      .catch((e) => send(res, 500, 'application/json', JSON.stringify({ ok: false, error: e.message })));
    return;
  }
  if (req.method === 'GET' && url === '/api/config') {
    send(res, 200, 'application/json; charset=utf-8', JSON.stringify(readConfigView()));
    return;
  }
  if (req.method === 'POST' && (url === '/api/config' || url === '/api/action')) {
    if (!write) { send(res, 403, 'application/json', JSON.stringify({ ok: false, message: '缺少 X-QQBot 头（防跨站写入）' })); return; }
    let raw = '';
    req.on('data', (d) => { raw += d.toString(); if (raw.length > 200000) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch (_) { send(res, 400, 'application/json', JSON.stringify({ ok: false, message: 'bad json' })); return; }
      try {
        if (url === '/api/config') send(res, 200, 'application/json; charset=utf-8', JSON.stringify(saveConfigView(body)));
        else runAction(String(body.action || '')).then((r) => send(res, 200, 'application/json; charset=utf-8', JSON.stringify(r)));
      } catch (e) { send(res, 500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, message: e.message })); }
    });
    return;
  }
  send(res, 404, 'text/plain; charset=utf-8', 'not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const line = '[' + new Date().toISOString() + '] panel listening http://127.0.0.1:' + PORT + '/';
  console.log(line);
  try { fs.appendFileSync(path.join(BASE, 'panel.log'), line + '\n'); } catch (_) {}
});
