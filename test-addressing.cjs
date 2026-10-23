'use strict';
/**
 * 称呼规则回归测试（2026-10-22 老爹要求：只有老爹叫「老爹」，其他人叫「同学」或「哥哥/姐姐」）
 *
 * 做法：把 bridge.js 复制到隔离沙箱（tmp/addressing-test），配一个假 OneBot（ws 3999）
 * 和一个假 DSH（只把收到的提示词原样存盘），注入四条消息，然后**直接断言 bridge 真正
 * 发给模型的提示词**里称呼是什么 —— 不看代码意图，只看线上会发什么。
 *
 * 跑法：node test-addressing.cjs
 * 判据：四条全 OK 且 exit 0。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const SRC = __dirname;
const CFG_PATH = process.env.QQ_BOT_CONFIG || (fs.existsSync(path.join(SRC, 'bridge.config.json')) ? path.join(SRC, 'bridge.config.json') : path.join(SRC, 'bridge.config.example.json'));
const DIR = path.join(SRC, 'tmp', 'addressing-test');
const PORT = 3999;

const CASES = [
  { label: 'master-private', user_id: 10002, group_id: null, want: '老爹' },
  { label: 'female-private', user_id: 20001, group_id: null, want: '姐姐' },
  { label: 'male-group', user_id: 20002, group_id: 100000001, want: '哥哥' },
  { label: 'unknown-sex-group', user_id: 20003, group_id: 100000001, want: '同学' },
];
const SEX_STRANGER = { '20001': 'female', '10002': 'male' };
const SEX_GROUP = { '10001': 'male', '10002': 'unknown', '20002': 'male', '20003': 'unknown' };

function setup() {
  fs.mkdirSync(path.join(DIR, 'sessions'), { recursive: true });
  // 依赖随 bridge.js 的 require 增长（self.cjs / asr.cjs 都是后加的）：按存在性拷，少一个就整条测试静默失败。
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
  cfg.sessionRecycle = Object.assign({}, cfg.sessionRecycle, { enabled: false });
  cfg.proactive = Object.assign({}, cfg.proactive, { enabled: false });
  cfg.voice = Object.assign({}, cfg.voice, { enabled: false, eggChance: 0, originalChance: 0 });
  cfg.endSticker = Object.assign({}, cfg.endSticker, { enabled: false });
  cfg.groupChime = Object.assign({}, cfg.groupChime, { enabled: false });
  cfg.chatStyle = Object.assign({}, cfg.chatStyle, { ackDelayMs: 600000, progressDelayMs: 600000 });
  cfg.privateTriggerForOthers = false;
  // 群里那两条用例不是主人发的：把测试群放进 openTriggerGroups，才走到称呼解析。
  cfg.openTriggerGroups = [100000001];
  // 白名单要覆盖用例里所有人（否则非主人私聊会被准入拦掉，看起来像「没跑」）。
  cfg.allowedPrivateUsers = ['10002', '20001'];
  cfg.allowedGroups = ['100000001'];
  fs.writeFileSync(path.join(DIR, 'bridge.config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  try { fs.unlinkSync(path.join(DIR, 'state.json')); } catch (_) {}
  for (const f of fs.readdirSync(DIR)) if (/^prompt-(\d+)\.(txt|json)$/.test(f) || f === 'prompt-count.txt') { try { fs.unlinkSync(path.join(DIR, f)); } catch (_) {} }
}

function run() {
  return new Promise((resolve) => {
    let sent = 0;
    const server = new WebSocket.Server({ port: PORT });
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
        const p = m.params || {};
        let data = {};
        if (m.action === 'send_msg') { sent += 1; data = { message_id: 'x' }; }
        else if (m.action === 'get_stranger_info') data = { user_id: p.user_id, sex: SEX_STRANGER[String(p.user_id)] || 'unknown', nickname: 'n' };
        else if (m.action === 'get_group_member_info') data = { user_id: p.user_id, sex: SEX_GROUP[String(p.user_id)] || 'unknown', nickname: 'n', card: 'c' };
        else if (m.action === 'get_group_member_list') data = [];
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: m.echo }));
      });
      let i = 0;
      const next = () => {
        if (i >= CASES.length) return;
        const c = CASES[i++];
        const evt = {
          post_type: 'message', message_type: c.group_id ? 'group' : 'private',
          self_id: 10001, user_id: c.user_id, message_id: 'test-' + Date.now() + '-' + i,
          raw_message: '大肥鱼 测试称呼', message: [{ type: 'text', data: { text: '大肥鱼 测试称呼' } }],
          sender: { user_id: c.user_id, nickname: 'tester' },
        };
        if (c.group_id) evt.group_id = c.group_id;
        ws.send(JSON.stringify(evt));
        setTimeout(next, 6000);
      };
      setTimeout(next, 1500);
    });
    const bridge = spawn(process.execPath, [path.join(DIR, 'bridge.js')], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    bridge.stdout.on('data', (d) => { log += d.toString(); });
    bridge.stderr.on('data', (d) => { log += d.toString(); });
    setTimeout(() => {
      try { bridge.kill('SIGKILL'); } catch (_) {}
      try { server.close(); } catch (_) {}
      resolve({ log, sent });
    }, 12000 + CASES.length * 6500);
  });
}

function assertAll() {
  let bad = 0;
  CASES.forEach((c, idx) => {
    const f = path.join(DIR, 'prompt-' + (idx + 1) + '.txt');
    if (!fs.existsSync(f)) { console.log('[FAIL] ' + c.label + ' 没捕获到提示词（任务没跑）'); bad++; return; }
    const t = fs.readFileSync(f, 'utf8');
    const checks = {
      ['称呼对方「' + c.want + '」']: t.includes('称呼对方「' + c.want + '」'),
      ['要' + c.want + '道歉']: t.includes('要' + c.want + '道歉'),
      '归属句保留（老爹家的猫娘）': t.includes('老爹家的猫娘'),
      '旧称呼「主人」未残留': !/(称呼对方「主人」|要主人道歉|主人这次的任务)/.test(t),
      '占位符未泄漏 {ADDR}': !t.includes('{ADDR}'),
    };
    const fails = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
    if (fails.length) { console.log('[FAIL] ' + c.label + ' 期望「' + c.want + '」：' + fails.join('；')); bad++; }
    else console.log('[OK] ' + c.label + ' -> ' + c.want);
  });
  return bad;
}

(async () => {
  setup();
  await run();
  const bad = assertAll();
  console.log(bad ? ('失败 ' + bad + ' 条') : '全部通过');
  process.exit(bad ? 1 : 0);
})();
