'use strict';
// 插队（preempt）回归：慢任务跑到 1s 时来新消息，应当先答新消息，被插队的慢任务排到队尾重跑。
// 2026-10-23：stub 改为独立文件 tmp/stub-dsh-preempt.cjs，且只按【本次任务】段判慢/快（整段 includes 会被自我状态里的上一条消息污染）。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const SRC = __dirname;
const CFG_PATH = process.env.QQ_BOT_CONFIG || (fs.existsSync(path.join(SRC, 'bridge.config.json')) ? path.join(SRC, 'bridge.config.json') : path.join(SRC, 'bridge.config.example.json'));
const DIR = path.join(SRC, 'tmp', 'preempt-test');
const PORT = 4023;

function setup() {
  fs.mkdirSync(path.join(DIR, 'sessions'), { recursive: true });
  const DEPS = ['bridge.js', 'humanize.cjs', 'proactive.cjs', 'mood.cjs', 'voice.cjs', 'self.cjs', 'asr.cjs', 'senses.cjs', 'see.ps1', 'persona.md'];
  for (const f of DEPS) {
    if (!fs.existsSync(path.join(SRC, f))) continue;
    fs.copyFileSync(path.join(SRC, f), path.join(DIR, f));
  }
  fs.copyFileSync(path.join(SRC, 'fixtures', 'stub-dsh-preempt.cjs'), path.join(DIR, 'stub-dsh.cjs'));
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  cfg.onebotWs = 'ws://127.0.0.1:' + PORT;
  cfg.notifyOnStartup = false;
  cfg.sessionLock = { enabled: false };
  cfg.dshBin = path.join(DIR, 'stub-dsh.cjs');
  cfg.nodeExe = process.execPath;
  cfg.dshCwd = DIR;
  cfg.dshHome = DIR;
  cfg.sessionStoreRoot = path.join(DIR, 'sessions');
  cfg.turnRetryCount = 0;
  cfg.preemptAfterMs = 1000;
  cfg.maxPreempt = 2;
  cfg.privateTriggerForOthers = false;
  cfg.proactive = Object.assign({}, cfg.proactive, { enabled: false });
  cfg.voice = Object.assign({}, cfg.voice, { enabled: false, eggChance: 0, originalChance: 0 });
  cfg.endSticker = Object.assign({}, cfg.endSticker, { enabled: false });
  cfg.groupChime = Object.assign({}, cfg.groupChime, { enabled: false });
  cfg.chatStyle = Object.assign({}, cfg.chatStyle, { ackDelayMs: 600000, progressDelayMs: 600000 });
  cfg.sessionRecycle = { enabled: true, maxInputTokens: 1e9, maxAgeHours: 24, ageScope: 'group', notify: true };
  fs.writeFileSync(path.join(DIR, 'bridge.config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  for (const f of ['state.json', 'bridge.log']) { try { fs.unlinkSync(path.join(DIR, f)); } catch (_) {} }
}

function run() {
  return new Promise((resolve) => {
    const got = [];
    const server = new WebSocket.Server({ port: PORT });
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
        const p = m.params || {};
        let data = {};
        if (m.action === 'send_msg') {
          const t = Array.isArray(p.message) ? p.message.map((x) => (x && x.data && x.data.text) || '').join('') : String(p.message || '');
          if (/快答|慢答/.test(t)) got.push(t.includes('快答') ? 'FAST' : 'SLOW');
          data = { message_id: 'x' };
        } else if (m.action === 'get_stranger_info') data = { user_id: p.user_id, sex: 'male', nickname: 'n' };
        else if (m.action === 'get_group_member_list') data = [];
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: m.echo }));
      });
      const send = (text, id) => ws.send(JSON.stringify({
        post_type: 'message', message_type: 'private', self_id: 10001,
        user_id: 10002, message_id: 'pre-' + id, raw_message: text,
        message: [{ type: 'text', data: { text } }],
        sender: { user_id: 10002, nickname: 'tester' },
      }));
      setTimeout(() => send('慢任务：数到二十', 1), 1500);
      setTimeout(() => send('快问题：现在几点了', 2), 3500);
    });
    const bridge = spawn(process.execPath, [path.join(DIR, 'bridge.js')], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    bridge.stdout.on('data', (d) => { log += d.toString(); });
    bridge.stderr.on('data', (d) => { log += d.toString(); });
    setTimeout(() => {
      try { bridge.kill('SIGKILL'); } catch (_) {}
      try { server.close(); } catch (_) {}
      resolve({ log, got });
    }, 24000);
  });
}

(async () => {
  setup();
  const { log, got } = await run();
  const checks = {
    '收到了两条回复': got.length >= 2,
    '新消息先被回答（FAST 在 SLOW 前）': got.indexOf('FAST') >= 0 && got.indexOf('FAST') < got.indexOf('SLOW'),
    '被插队的慢任务最终也答了': got.includes('SLOW'),
    '日志里有插队留痕': /插队/.test(log),
  };
  let bad = 0;
  for (const [k, v] of Object.entries(checks)) { console.log((v ? '[OK] ' : '[FAIL] ') + k); if (!v) bad++; }
  console.log('顺序: ' + got.join(' -> '));
  if (bad) console.log('--- log tail ---\n' + log.slice(-1200));
  process.exit(bad ? 1 : 0);
})();
