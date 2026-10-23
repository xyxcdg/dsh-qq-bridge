'use strict';
/**
 * test-lists.cjs —— 白名单 / 触发词 / 称呼 的准入回归（2026-10-23 老爹反馈后补）
 * 断言：
 *  ①主人私聊不带触发词 → 直接当任务（称呼「老爹」）
 *  ②白名单里的好友私聊不带触发词 → 也直接当任务（male→哥哥 / female→姐姐）
 *  ③不在白名单的陌生人私聊 → 忽略
 *  ④主人在已授权群里带触发词 → 当任务
 *  ⑤未授权群 → 忽略
 * 判据看沙箱里 stub 收到的提示词条数与内容，而不是只看「有回复」。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const SRC = __dirname;
const CFG_PATH = process.env.QQ_BOT_CONFIG || (fs.existsSync(path.join(SRC, 'bridge.config.json')) ? path.join(SRC, 'bridge.config.json') : path.join(SRC, 'bridge.config.example.json'));
const DIR = path.join(SRC, 'tmp', 'lists-test');
const PORT = 3998;
const MASTER = '10002';
const FRIEND_M = '20002';   // 男性好友
const FRIEND_F = '20001';   // 女性好友（她）
const STRANGER = '999999999';
const GROUP_OK = '100000002';    // 小谢的小屋
const GROUP_BAD = '999999998';

function setup() {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(DIR, 'sessions', 'default'), { recursive: true });
  for (const f of ['bridge.js', 'humanize.cjs', 'proactive.cjs', 'mood.cjs', 'voice.cjs', 'self.cjs', 'asr.cjs', 'senses.cjs', 'see.ps1', 'persona.md']) {
    if (!fs.existsSync(path.join(SRC, f))) continue;
    fs.copyFileSync(path.join(SRC, f), path.join(DIR, f));
  }
  fs.copyFileSync(path.join(SRC, 'fixtures', 'stub-dsh-addressing.cjs'), path.join(DIR, 'stub-dsh.cjs'));
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
  cfg.masterOnlyCommands = true;
  cfg.privateRequireTrigger = false;
  cfg.privateTriggerForOthers = false;
  cfg.openTriggerGroups = [];
  cfg.allowedPrivateUsers = [MASTER, FRIEND_M, FRIEND_F];
  cfg.allowedGroups = [GROUP_OK];
  cfg.proactive = Object.assign({}, cfg.proactive, { enabled: false });
  cfg.voice = Object.assign({}, cfg.voice, { enabled: false, eggChance: 0, originalChance: 0 });
  cfg.endSticker = Object.assign({}, cfg.endSticker, { enabled: false });
  cfg.groupChime = Object.assign({}, cfg.groupChime, { enabled: false });
  cfg.chatStyle = Object.assign({}, cfg.chatStyle, { ackDelayMs: 600000, progressDelayMs: 600000 });
  cfg.sessionRecycle = { enabled: true, maxInputTokens: 1e9, maxAgeHours: 24, ageScope: 'group', notify: false };
  fs.writeFileSync(path.join(DIR, 'bridge.config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  for (const f of ['state.json', 'bridge.log', 'prompt-count.txt']) { try { fs.unlinkSync(path.join(DIR, f)); } catch (_) {} }
  for (const f of fs.readdirSync(DIR)) { if (/^prompt-\d+\.txt$/.test(f)) { try { fs.unlinkSync(path.join(DIR, f)); } catch (_) {} } }
}

function run() {
  return new Promise((resolve) => {
    const sent = [];
    const server = new WebSocket.Server({ port: PORT });
    server.on('connection', (ws) => {
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
        const p = m.params || {};
        let data = {};
        if (m.action === 'send_msg') {
          const t = Array.isArray(p.message) ? p.message.map((x) => (x && x.data && x.data.text) || '').join('') : String(p.message || '');
          sent.push(t);
          data = { message_id: 'x' };
        } else if (m.action === 'get_stranger_info') {
          data = { user_id: p.user_id, sex: String(p.user_id) === FRIEND_F ? 'female' : 'male', nickname: 'f' + p.user_id };
        } else if (m.action === 'get_group_member_info') {
          data = { user_id: p.user_id, sex: 'male', nickname: 'm' + p.user_id };
        } else if (m.action === 'get_group_member_list') data = [];
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: m.echo }));
      });
      const send = (m, i) => ws.send(JSON.stringify({
        post_type: 'message', message_type: m.group ? 'group' : 'private', self_id: 10001,
        user_id: m.user, message_id: 'l-' + i, raw_message: m.text,
        message: [{ type: 'text', data: { text: m.text } }],
        sender: { user_id: m.user, nickname: 'tester' },
        ...(m.group ? { group_id: m.group } : {}),
      }));
      const cases = [
        { user: MASTER, text: '你好呀老爹测试' },
        { user: FRIEND_M, text: '你好呀男好友' },
        { user: FRIEND_F, text: '你好呀她' },
        { user: STRANGER, text: '你好呀陌生人' },
        { user: MASTER, group: GROUP_OK, text: '大肥鱼 群里测试' },
        { user: MASTER, group: GROUP_BAD, text: '大肥鱼 未授权群' },
      ];
      let i = 0;
      const next = () => {
        if (i >= cases.length) return;
        send(cases[i++], i);
        setTimeout(next, 3200);
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
    }, 26000);
  });
}

(async () => {
  setup();
  const { log, sent } = await run();
  const prompts = [];
  for (const f of fs.readdirSync(DIR).sort()) {
    if (/^prompt-\d+\.txt$/.test(f)) prompts.push(fs.readFileSync(path.join(DIR, f), 'utf8'));
  }
  const has = (s) => prompts.some((p) => p.includes(s));
  const checks = {
    '主人私聊（无触发词）被处理': has('你好呀老爹测试'),
    '主人称呼 = 老爹': has('老爹'),
    '男好友私聊（无触发词）被处理': has('你好呀男好友'),
    '男好友称呼 = 哥哥': /哥哥/.test(prompts.find((p) => p.includes('你好呀男好友')) || ''),
    '女好友私聊（无触发词）被处理': has('你好呀她'),
    '女好友称呼 = 姐姐': /姐姐/.test(prompts.find((p) => p.includes('你好呀她')) || ''),
    '陌生人私聊被忽略': !has('你好呀陌生人') && /未授权私聊/.test(log),
    '主人在授权群（小谢的小屋）带触发词被处理': has('群里测试'),
    '未授权群被忽略': !has('未授权群') && /未授权群消息/.test(log),
  };
  let bad = 0;
  for (const [k, v] of Object.entries(checks)) { console.log((v ? '[OK] ' : '[FAIL] ') + k); if (!v) bad++; }
  console.log('提示词条数: ' + prompts.length + '（期望 4）');
  if (bad) {
    console.log('--- log 片段 ---');
    console.log(log.split('\n').filter((l) => /忽略|未授权|触发词|称呼|入队/.test(l)).slice(-12).join('\n'));
  }
  process.exit(bad ? 1 : 0);
})();
