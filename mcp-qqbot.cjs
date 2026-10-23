'use strict';
/**
 * mcp-qqbot.cjs - 把大肥鱼控制台接进 DSH（MCP stdio server）
 *   工具：status / config_get / config_set / action / panel
 * 协议：JSON-RPC 2.0 over stdio，一行一条消息；日志只走 stderr。
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const BASE = __dirname;
const CFG_PATH = path.join(BASE, 'bridge.config.json');
const STATE_PATH = path.join(BASE, 'state.json');
const HB_PATH = path.join(BASE, 'heartbeat.json');
const NODE = process.execPath;
const DAY = 86400000;
const PANEL = 'http://127.0.0.1:8123/';

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fb; } }
function alive(pid) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function log() {
  const line = new Date().toISOString() + ' ' + Array.prototype.join.call(arguments, ' ');
  try { process.stderr.write('[mcp-qqbot] ' + line + '\n'); } catch (_) {}
  try { fs.appendFileSync(path.join(BASE, 'mcp.log'), line + '\n'); } catch (_) {}
}

function probePort(port) {
  return new Promise((res) => {
    const s = net.connect({ host: '127.0.0.1', port: port });
    const done = (v) => { try { s.destroy(); } catch (_) {} res(v); };
    s.setTimeout(500); s.on('connect', () => done(true)); s.on('timeout', () => done(false)); s.on('error', () => done(false));
  });
}

let probeCache = { at: 0, val: null };
function probeAccount(force) {
  const now = Date.now();
  if (!force && probeCache.val && now - probeCache.at < 5000) return Promise.resolve(probeCache.val);
  return new Promise((res) => {
    let out = '';
    let child;
    try { child = spawn(NODE, [path.join(BASE, 'qq-probe.cjs')], { windowsHide: true }); } catch (e) { return res({ ok: false, error: e.message }); }
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} res({ ok: false, error: 'probe timeout' }); }, 9000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('close', () => {
      clearTimeout(timer);
      let v;
      try { v = JSON.parse(out.trim().split('\n').pop()); } catch (_) { v = { ok: false, error: 'probe parse fail' }; }
      probeCache = { at: Date.now(), val: v };
      res(v);
    });
    child.on('error', (e) => { clearTimeout(timer); res({ ok: false, error: e.message }); });
  });
}

async function buildStatus() {
  const now = Date.now();
  const cfg = readJson(CFG_PATH, {});
  const st = readJson(STATE_PATH, {});
  const hb = readJson(HB_PATH, {});
  const [acct, p3001, p6099] = await Promise.all([probeAccount(false), probePort(3001), probePort(6099)]);
  const self = st.self || {};
  const moods = st.moods || {};
  let mood = 'calm', moodAt = 0;
  for (const k of Object.keys(moods)) { const m = moods[k] || {}; if (Number(m.since || 0) >= moodAt) { moodAt = Number(m.since || 0); mood = m.mood || 'calm'; } }
  const thoughts = (self.thoughts || []).filter((t) => t && !t.spoken).map((t) => t.text);
  const habits = (self.habits || []).map((h) => h && h.text).filter(Boolean);
  const rel = self.relations || {};
  const impressions = Object.keys(rel).map((k) => k + ' → ' + (rel[k].impression || '') + '（亲近 ' + Math.round(Number(rel[k].closeness || 0)) + '/90）');
  return {
    account: { online: !!(acct && acct.ok && acct.online), nickname: (acct && acct.nickname) || '', userId: (acct && acct.userId) || '', error: (acct && acct.error) || '' },
    bridge: { pid: hb.pid || null, alive: alive(hb.pid), connected: !!hb.connected, ageSec: hb.ts ? Math.round((now - Number(hb.ts)) / 1000) : null, tasks: hb.tasks || 0 },
    ports: { onebot3001: p3001, webui6099: p6099 },
    sessions: st.sessions || {},
    usage: st.usage || {},
    recycled: st.recycled || {},
    self: { day: self.born ? Math.floor((now - Number(self.born)) / DAY) + 1 : 1, turns: self.turns || 0, fatigue: Math.round(Number(self.fatigue || 0)), mood: mood,
            attention: (self.attention && self.attention.focus) || '', thoughts: thoughts, habits: habits, impressions: impressions },
    panel: PANEL,
  };
}

function configView() {
  const c = readJson(CFG_PATH, {});
  return {
    triggerWord: c.triggerWord || '',
    replyMode: c.replyMode || 'channel',
    sessionRecycleMaxInputTokens: (c.sessionRecycle && c.sessionRecycle.maxInputTokens) || 250000,
    sessionRecycleMaxAgeHours: (c.sessionRecycle && c.sessionRecycle.maxAgeHours) || 24,
    sessionRecycleAgeScope: (c.sessionRecycle && c.sessionRecycle.ageScope) || 'group',
    proactiveEnabled: !!(c.proactive && c.proactive.enabled),
    groupChimeEnabled: !!(c.groupChime && c.groupChime.enabled),
    personaMoodEnabled: !!(c.personaMood && c.personaMood.enabled),
    voiceEnabled: !!(c.voice && c.voice.enabled),
    addrMaster: (c.addressing && c.addressing.master) || '老爹',
    addrDefault: (c.addressing && c.addressing.default) || '同学',
    allowedGroups: c.allowedGroups || [],
    allowedPrivateUsers: c.allowedPrivateUsers || [],
  };
}

function configSet(a) {
  const c = readJson(CFG_PATH, null);
  if (!c) return { ok: false, message: 'bridge.config.json 读不出来，拒绝写入' };
  const changed = [];
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.copyFileSync(CFG_PATH, CFG_PATH + '.bak-mcp-' + stamp);
  if (typeof a.triggerWord === 'string' && a.triggerWord.trim()) { c.triggerWord = a.triggerWord.trim(); changed.push('triggerWord'); }
  if (a.replyMode === 'channel' || a.replyMode === 'private') { c.replyMode = a.replyMode; changed.push('replyMode'); }
  if (a.sessionRecycleMaxInputTokens != null) {
    const n = Number(a.sessionRecycleMaxInputTokens);
    if (Number.isFinite(n) && n >= 10000 && n <= 900000) { c.sessionRecycle = c.sessionRecycle || {}; c.sessionRecycle.maxInputTokens = Math.round(n); changed.push('sessionRecycle.maxInputTokens'); }
  }
  if (a.sessionRecycleMaxAgeHours != null) {
    const h = Number(a.sessionRecycleMaxAgeHours);
    if (Number.isFinite(h) && h >= 1 && h <= 720) { c.sessionRecycle = c.sessionRecycle || {}; c.sessionRecycle.maxAgeHours = Math.round(h); changed.push('sessionRecycle.maxAgeHours'); }
  }
  if (typeof a.proactiveEnabled === 'boolean') { c.proactive = c.proactive || {}; c.proactive.enabled = a.proactiveEnabled; changed.push('proactive.enabled'); }
  if (typeof a.groupChimeEnabled === 'boolean') { c.groupChime = c.groupChime || {}; c.groupChime.enabled = a.groupChimeEnabled; changed.push('groupChime.enabled'); }
  if (typeof a.personaMoodEnabled === 'boolean') { c.personaMood = c.personaMood || {}; c.personaMood.enabled = a.personaMoodEnabled; changed.push('personaMood.enabled'); }
  if (typeof a.voiceEnabled === 'boolean') { c.voice = c.voice || {}; c.voice.enabled = a.voiceEnabled; changed.push('voice.enabled'); }
  c.addressing = c.addressing || {};
  if (typeof a.addrMaster === 'string' && a.addrMaster.trim()) { c.addressing.master = a.addrMaster.trim(); changed.push('addressing.master'); }
  if (typeof a.addrDefault === 'string' && a.addrDefault.trim()) { c.addressing.default = a.addrDefault.trim(); changed.push('addressing.default'); }
  if (!changed.length) return { ok: false, message: '没有可改的字段（白名单：triggerWord/replyMode/sessionRecycleMaxInputTokens/proactiveEnabled/groupChimeEnabled/personaMoodEnabled/voiceEnabled/addrMaster/addrDefault）' };
  fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2), 'utf8');
  return { ok: true, changed: changed, backup: 'bridge.config.json.bak-mcp-' + stamp, note: '需要重启桥接才生效（可调用 action.restart_bridge）' };
}

function runAction(a) {
  const hb = readJson(HB_PATH, {});
  if (a === 'restart_bridge') {
    try { if (hb.pid && alive(hb.pid)) process.kill(hb.pid); } catch (_) {}
    return new Promise((res) => execFile('schtasks', ['/Run', '/TN', 'CodexQQBridge'], { windowsHide: true }, (err) => res({ ok: !err, message: err ? ('重启失败: ' + err.message) : '已请求重启桥接，约 5 秒后连上' })));
  }
  if (a === 'selfheal') {
    const c = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(BASE, 'qq-selfheal.ps1')], { windowsHide: true, detached: true, stdio: 'ignore' });
    c.unref();
    return Promise.resolve({ ok: true, message: '自愈已触发（结果见 selfheal.log）' });
  }
  if (a === 'notify_all') {
    const c = spawn(NODE, [path.join(BASE, 'qq-notify-all.cjs'), '--force'], { windowsHide: true, detached: true, stdio: 'ignore' });
    c.unref();
    return Promise.resolve({ ok: true, message: '已触发全渠道通知' });
  }
  return Promise.resolve({ ok: false, message: '未知 action: ' + a });
}

const TOOLS = [
  { name: 'status', description: '大肥鱼 QQ 机器人的实时状态：账号在线、桥接 pid/心跳、3001/6099 端口、各渠道会话与 token、自我状态（第几天/疲惫/心情/在意/心事/出过的岔子/对每个人的印象）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'config_get', description: '读取可改配置的当前值（触发词、回复去向、换代阈值、主动搭话/群搭话/心情/语音开关、两个称呼）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'config_set', description: '修改桥接配置（白名单字段，写前自动备份，改后需重启桥接生效）。只传要改的字段。',
    inputSchema: { type: 'object', properties: {
      triggerWord: { type: 'string', description: '触发词，如 大肥鱼' },
      replyMode: { type: 'string', enum: ['channel', 'private'], description: '结果回到发起渠道 / 全部走私聊主人' },
      sessionRecycleMaxInputTokens: { type: 'number', description: '会话换代阈值（inputTokens，10000-900000）' },
      sessionRecycleMaxAgeHours: { type: 'number', description: '群会话只保留多少小时的上下文（1-720，默认 24；到期换代，旧内容靠记忆）' },
      proactiveEnabled: { type: 'boolean' }, groupChimeEnabled: { type: 'boolean' },
      personaMoodEnabled: { type: 'boolean' }, voiceEnabled: { type: 'boolean' },
      addrMaster: { type: 'string', description: '对老爹的称呼' }, addrDefault: { type: 'string', description: '对其他人的默认称呼' },
    }, additionalProperties: false } },
  { name: 'action', description: '运维操作：restart_bridge（重启桥接）/ selfheal（跑一次账号自愈）/ notify_all（给所有群与授权用户发通知）。',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['restart_bridge', 'selfheal', 'notify_all'] } }, required: ['action'], additionalProperties: false } },
  { name: 'panel', description: '返回可视化控制台的地址（浏览器打开即可看/改）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

async function callTool(name, args) {
  const a = args || {};
  if (name === 'status') return { content: [{ type: 'text', text: JSON.stringify(await buildStatus(), null, 2) }] };
  if (name === 'config_get') return { content: [{ type: 'text', text: JSON.stringify(configView(), null, 2) }] };
  if (name === 'config_set') return { content: [{ type: 'text', text: JSON.stringify(configSet(a), null, 2) }] };
  if (name === 'action') return { content: [{ type: 'text', text: JSON.stringify(await runAction(String(a.action || '')), null, 2) }] };
  if (name === 'panel') return { content: [{ type: 'text', text: '控制台：' + PANEL + '（只监听本机回环；写操作需 X-QQBot 头，浏览器页面已带）' }] };
  return { content: [{ type: 'text', text: 'unknown tool: ' + name }], isError: true };
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (_) { continue; }
    handle(msg);
  }
});

async function handle(msg) {
  const id = msg.id;
  const method = msg.method;
  if (method === 'initialize') {
    const want = (msg.params && msg.params.protocolVersion) || '2024-11-05';
    send({ jsonrpc: '2.0', id: id, result: { protocolVersion: want, capabilities: { tools: {} }, serverInfo: { name: 'qqbot', version: '1.0.0' } } });
    log('initialized protocol=' + want + ' client=' + ((msg.params && msg.params.clientInfo && msg.params.clientInfo.name) || '?'));
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') { send({ jsonrpc: '2.0', id: id, result: {} }); return; }
  if (method === 'tools/list') { send({ jsonrpc: '2.0', id: id, result: { tools: TOOLS } }); return; }
  if (method === 'tools/call') {
    const p = msg.params || {};
    try {
      log('call ' + p.name);
      const out = await callTool(String(p.name || ''), p.arguments || {});
      send({ jsonrpc: '2.0', id: id, result: out });
    } catch (e) {
      send({ jsonrpc: '2.0', id: id, result: { content: [{ type: 'text', text: 'tool failed: ' + e.message }], isError: true } });
    }
    return;
  }
  if (method === 'resources/list') { send({ jsonrpc: '2.0', id: id, result: { resources: [] } }); return; }
  if (method === 'prompts/list') { send({ jsonrpc: '2.0', id: id, result: { prompts: [] } }); return; }
  if (id != null) send({ jsonrpc: '2.0', id: id, error: { code: -32601, message: 'method not found: ' + method } });
}

log('mcp-qqbot started, base=' + BASE);
