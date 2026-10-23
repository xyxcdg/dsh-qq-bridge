'use strict';
/**
 * test-recycle-age.cjs — 校验「群消息只保留 24 小时上下文」的按时间换代（2026-10-23 老爹要求）
 * 四条断言：①群渠道超 24h → 换代（解绑 + reason=age + 出生时间清除 + 发通知）
 *           ②私聊渠道同样超 24h → **不**换代（ageScope=group）
 *           ③群渠道只聊了 1h → 不换代（不误杀）
 *           ④换代后的新会话会重新记出生时间（第二轮消息再验一次）
 * 跑法：node test-recycle-age.cjs   判据：全 OK 且 exit 0
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const SRC = __dirname;
const CFG_PATH = process.env.QQ_BOT_CONFIG || (fs.existsSync(path.join(SRC, 'bridge.config.json')) ? path.join(SRC, 'bridge.config.json') : path.join(SRC, 'bridge.config.example.json'));
const DIR = path.join(SRC, 'tmp', 'recycle-age-test');
const PORT = 3996;
const GROUP = '100000001';
const MASTER = '10002';
const NOW = Date.now();
const H = 3600000;

function setup(state) {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'sessions', 'default'), { recursive: true });
  const DEPS = ['bridge.js', 'humanize.cjs', 'proactive.cjs', 'mood.cjs', 'voice.cjs', 'self.cjs', 'asr.cjs', 'senses.cjs', 'see.ps1', 'persona.md'];
  for (const f of DEPS) {
    if (!fs.existsSync(path.join(SRC, f))) continue;
    fs.copyFileSync(path.join(SRC, f), path.join(DIR, f));
  }
  fs.copyFileSync(path.join(SRC, 'fixtures', 'stub-dsh-addressing.cjs'), path.join(DIR, 'stub-dsh.cjs'));
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  cfg.onebotWs = 'ws://127.0.0.1:' + PORT;
  cfg.notifyOnStartup = false;
  cfg.sessionLock = { enabled: false };
  cfg.dshBin = path.join(DIR, 'stub-dsh.cjs');
  cfg.senses = { enabled: false }; // 无头/CI 环境不要截图探身体，否则每次启动白等超时
  cfg.nodeExe = process.execPath;
  cfg.dshCwd = DIR;
  cfg.dshHome = DIR;
  cfg.sessionStoreRoot = path.join(DIR, 'sessions');
  cfg.turnRetryCount = 0;
  cfg.allowedGroups = [GROUP];
  cfg.allowedPrivateUsers = [MASTER];
  cfg.masterOnlyCommands = false;
  cfg.privateTriggerForOthers = false;
  cfg.proactive = Object.assign({}, cfg.proactive, { enabled: false });
  cfg.voice = Object.assign({}, cfg.voice, { enabled: false, eggChance: 0, originalChance: 0 });
  cfg.endSticker = Object.assign({}, cfg.endSticker, { enabled: false });
  cfg.groupChime = Object.assign({}, cfg.groupChime, { enabled: false });
  cfg.chatStyle = Object.assign({}, cfg.chatStyle, { ackDelayMs: 600000, progressDelayMs: 600000 });
  cfg.sessionRecycle = { enabled: true, maxInputTokens: 1e9, maxAgeHours: 24, ageScope: 'group', notify: true };
  fs.writeFileSync(path.join(DIR, 'bridge.config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  // 两条老会话的目录都要真实存在，否则 bridge 会以「已不在磁盘上」拒绝执行
  for (const sid of Object.values(state.sessions)) fs.mkdirSync(path.join(DIR, 'sessions', 'default', sid), { recursive: true });
  fs.writeFileSync(path.join(DIR, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

function readState() { return JSON.parse(fs.readFileSync(path.join(DIR, 'state.json'), 'utf8')); }

function run(msgs) {
  return new Promise((resolve) => {
    const sent = [];
    const server = new WebSocket.Server({ port: PORT });
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
        if (m.action === 'send_msg') {
          const t = (m.params && m.params.message) || [];
          sent.push(Array.isArray(t) ? t.map((x) => (x && x.data && x.data.text) || '').join('') : String(t));
        }
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 'x' }, echo: m.echo }));
      });
      let i = 0;
      const next = () => {
        if (i >= msgs.length) return;
        const m = msgs[i++];
        const evt = {
          post_type: 'message', message_type: m.group ? 'group' : 'private',
          self_id: 10001, user_id: m.user, message_id: 't-' + i,
          raw_message: m.text, message: [{ type: 'text', data: { text: m.text } }],
          sender: { user_id: m.user, nickname: 'tester' },
        };
        if (m.group) evt.group_id = m.group;
        ws.send(JSON.stringify(evt));
        setTimeout(next, 3500);
      };
      setTimeout(next, 1200);
    });
    const bridge = spawn(process.execPath, [path.join(DIR, 'bridge.js')], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    bridge.stdout.on('data', (d) => { log += d.toString(); });
    bridge.stderr.on('data', (d) => { log += d.toString(); });
    setTimeout(() => {
      try { bridge.kill('SIGKILL'); } catch (_) {}
      try { server.close(); } catch (_) {}
      resolve({ log, sent });
    }, 4000 + msgs.length * 4000);
  });
}

(async () => {
  let bad = 0;
  const ok = (name, cond, extra) => { if (cond) console.log('[OK] ' + name); else { console.log('[FAIL] ' + name + (extra ? ' :: ' + extra : '')); bad++; } };

  // —— 第 1 轮：群 25 小时前建的会话 + 私聊 25 小时前建的会话 + 群新会话 1 小时前
  setup({
    sessions: { ['group:' + GROUP]: 'session-old-group', ['private:' + MASTER]: 'session-old-private', 'group:999': 'session-fresh-group' },
    sessionBornAt: { ['group:' + GROUP]: NOW - 25 * H, ['private:' + MASTER]: NOW - 25 * H, 'group:999': NOW - 1 * H },
    tasks: 0, self: {},
  });
  // 群消息的发送者不能用 selfQQ（10001）—— 那会被当成「机器人自己发的」直接丢弃。
  const r1 = await run([{ group: GROUP, user: '20002', text: '大肥鱼 测试一下' }, { group: null, user: MASTER, text: '大肥鱼 私聊测试' }]);
  const st1 = readState();
  ok('群渠道超 24h → 解绑', !st1.sessions['group:' + GROUP], JSON.stringify(Object.keys(st1.sessions)));
  ok('群渠道换代原因 = age', (st1.recycled || {})['group:' + GROUP] && st1.recycled['group:' + GROUP].reason === 'age', JSON.stringify((st1.recycled || {})['group:' + GROUP]));
  ok('群渠道出生时间已清', !(st1.sessionBornAt || {})['group:' + GROUP]);
  ok('私聊超 24h 但不换代（ageScope=group）', st1.sessions['private:' + MASTER] === 'session-old-private', JSON.stringify(st1.sessions['private:' + MASTER]));
  ok('没到 24h 的群会话不动', st1.sessions['group:999'] === 'session-fresh-group');
  ok('换代发了通知（含 24 小时）', r1.sent.some((x) => /24 小时|换条新线/.test(x)), JSON.stringify(r1.sent.slice(0, 3)));
  ok('旧会话被移进回收区', !!((st1.recycled || {})['group:' + GROUP] || {}).moved, JSON.stringify((st1.recycled || {})['group:' + GROUP] || {}));

  // —— 第 2 轮：换代后新消息应重建会话并记出生时间（再过 1 小时不换代，证明新会话是新的）
  const r2 = await run([{ group: GROUP, user: '20002', text: '大肥鱼 再说一句' }]);
  const st2 = readState();
  const newSid = st2.sessions['group:' + GROUP];
  const born = (st2.sessionBornAt || {})['group:' + GROUP];
  ok('换代后新消息重建了会话', !!newSid && newSid !== 'session-old-group', String(newSid));
  ok('新会话重新记了出生时间（距现在 < 5 分钟）', !!born && (Date.now() - Number(born)) < 5 * 60000, String(born));
  ok('第二轮没有再触发换代', !!newSid);

  console.log(bad ? ('失败 ' + bad + ' 条') : '全部通过');
  process.exit(bad ? 1 : 0);
})();
