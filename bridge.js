/**
 * DSH QQ 桥（codex-qq-bridge 重建版）
 *
 * 架构：
 *   QQ客户端(自带) --NapCat(OneBot11)--> ws://127.0.0.1:3001 --> 本服务
 *   本服务按白名单收消息，用固定的一个 DSH 会话跑任务，把回复发回 QQ。
 *
 * 关键设计（对应用户要求）：
 *   1) 全程同一个 DSH 会话：用 `dsh --profile headless --session-id <固定 id>`
 *      复用持久化会话，追问不再新开对话。会话 id 存在 state.json，首次自动创建。
 *   2) 隐藏运行：本进程由 wscript 隐藏启动；调用 dsh 时带 CREATE_NO_WINDOW，
 *      绝不产生可见控制台窗口。
 *   3) 开机自启 + 看门狗：由计划任务 DSH-QQ-Bridge / DSH-QQ-Watchdog 负责，
 *      本文件只关心业务。
 *
 * 日志：bridge.log（JSON Lines + 人类可读混合，滚动到 5MB）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
// 【2026-10-19】说话方式：切成「一句一句」还是「一条汇总」，逻辑抽出去单独测。
const { planBubbles, pickRandom } = require('./humanize.cjs');
// 【2026-10-19】主动搭话的门：安静够久、今天没超次数、不是深夜、不忙 —— 才轮到模型决定说什么。
const { proactiveGate, acceptProactive } = require('./proactive.cjs');
// 【2026-10-19】语音：本地合成（edge-tts 神经语音，失败退 Windows SAPI），发 [CQ:record]。
const { synthVoice } = require('./voice.cjs');

const BASE = __dirname;

// ---------------------------------------------------------------- 配置
// 配置文件默认与本文件同目录的 bridge.config.json；也可用环境变量 QQ_BOT_CONFIG 指定。
// 首次使用请把 bridge.config.example.json 复制成 bridge.config.json 再改。
const CFG_PATH = process.env.QQ_BOT_CONFIG || path.join(BASE, 'bridge.config.json');
let CFG;
try {
  CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
} catch (e) {
  console.error('读不到配置文件：' + CFG_PATH + '\n' + (e && e.message || e));
  console.error('先把 bridge.config.example.json 复制一份改名为 bridge.config.json，再按需修改。');
  process.exit(1);
}

// ---------------------------------------------------------------- 默认值 / 环境变量
// 所有跟「某台机器」有关的路径都能留空：留空时按环境变量与用户目录推断，
// 这样同一份配置换台电脑也能跑（只有 DSH 的 CLI 入口 dshBin 必须显式给）。
const HOME = process.env.USERPROFILE || process.env.HOME || '';
CFG.dshHome = CFG.dshHome || process.env.DSH_HOME || path.join(HOME, '.dsh');
CFG.dshCwd = CFG.dshCwd || process.env.QQ_BOT_CWD || process.cwd();
CFG.dshProfile = CFG.dshProfile || 'headless';
CFG.nodeExe = CFG.nodeExe || process.env.QQ_BOT_NODE || process.execPath;
CFG.dshBin = CFG.dshBin || process.env.QQ_BOT_DSH_BIN || '';
if (!CFG.dshBin) {
  console.error('配置缺 dshBin：请填 DSH 的 CLI 入口（.../@deepseek-ai/dsh/lib/bin.js），或设置环境变量 QQ_BOT_DSH_BIN。');
  process.exit(1);
}
CFG.allowedGroups = (CFG.allowedGroups || []).map(String);
CFG.allowedPrivateUsers = (CFG.allowedPrivateUsers || []).map(String);
CFG.activityGroups = (CFG.activityGroups || []).map(String);
CFG.openTriggerGroups = (CFG.openTriggerGroups || []).map(String);
CFG.triggerWord = CFG.triggerWord || '喵喵';
if (!CFG.selfQQ || !CFG.masterQQ) {
  console.error('配置缺 selfQQ（机器人自己的 QQ 号）或 masterQQ（主人 QQ 号）。');
  process.exit(1);
}

// 【2026-10-09 实测修复】机器人的会话存在一个**独立根**里，由
//   <DSH_HOME>\profiles\headless\cordis.patch.yml 的 `root: ...\sessions-qqbot` 指定
//   （桌面端只扫 <home>\sessions，所以它看不到机器人的会话 —— 这是有意的）。
// 为什么要盯目录：实测 headless CLI **不会把新会话 id 打到 stdout/stderr**，
//   原来靠正则抓 id 的绑定对「新渠道第一次跑」**从来没成功过**（日志里那句
//   「本次是新会话，但输出里没抓到 session id」就是它），后果是同一个群每来一条命令
//   就新建一个会话、上下文断掉。现在改为：一出现新会话目录就绑。
const SESS_ROOT = CFG.sessionStoreRoot || path.join(CFG.dshHome || path.join(process.env.USERPROFILE || '', '.dsh'), 'sessions-qqbot');
function listSessionDirs() {
  const out = [];
  try {
    for (const ws of fs.readdirSync(SESS_ROOT)) {
      const wsPath = path.join(SESS_ROOT, ws);
      let wst; try { wst = fs.statSync(wsPath); } catch (_) { continue; }
      if (!wst.isDirectory()) continue;
      for (const s of fs.readdirSync(wsPath)) {
        if (!/^session-[0-9a-f-]{36}$/i.test(s)) continue;
        let sst; try { sst = fs.statSync(path.join(wsPath, s)); } catch (_) { continue; }
        if (!sst.isDirectory()) continue;
        out.push({ id: s, birthMs: sst.birthtimeMs || sst.ctimeMs || 0, ws });
      }
    }
  } catch (_) { /* 读不到就当没有 */ }
  return out;
}
const LOG = path.join(BASE, 'bridge.log');
const STATE = path.join(BASE, 'state.json');
const STARTUP_STAMP = path.join(BASE, 'startup-notice.stamp.json');

// ---------------------------------------------------------------- 日志
const MAX_LOG = 5 * 1024 * 1024;
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > MAX_LOG) {
      fs.renameSync(LOG, LOG + '.1');
    }
    fs.appendFileSync(LOG, line + '\n');
  } catch (_) { /* 日志失败不影响业务 */ }
}
const info = (m) => log('INFO', m);
const warn = (m) => log('WARN', m);
const error = (m) => log('ERROR', m);

// ---------------------------------------------------------------- 状态
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (_) { return { sessionId: null, tasks: 0 }; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }
  catch (e) { warn('状态写入失败: ' + e.message); }
}
let state = loadState();

// ------------------------------------------------ 会话锁（用户硬要求）
// 「QQ 上的全部对话锁在同一个 DSH 会话里」= sessionLock.enabled。
// 开启时：
//   ① 若 state.json 还没有 sessionId，就用配置里指定的那个（而不是等到第一次
//      任务才惰性固化）；
//   ② 永久禁止自动新建会话（哪怕任务失败、哪怕会话不存在）。
// 这样"锁在一个会话"就是配置驱动、可审计的，而不是靠惰性逻辑碰巧成立。
// 【用户要求 2026-10-08（澄清版）】一个渠道一个会话：文艺部群与主人私聊
// 必须是**两个不同的 DSH 会话**。理由：文艺部群里部员看得到机器人的回复，
// 而私聊里是主人自己的事（名单文件、电脑操作、路径）；共用一个会话会让两边
// 上下文互相串（群里能问出私聊里说过的事），那既是隐私问题，也不符合
// 「会话 = 一条对话」的语义。键 = 'group:<群号>' / 'private:<QQ号>'。
state.sessions = state.sessions || {};
const MASTER_KEY = 'private:' + String(CFG.masterQQ || '');
if (CFG.masterQQ && !state.sessions[MASTER_KEY] && state.sessionId) {
  state.sessions[MASTER_KEY] = state.sessionId; saveState(state);
  info(`已把既有会话归到主人私聊渠道 ${MASTER_KEY}: ${state.sessionId}`);
}

const LOCK = CFG.sessionLock || {};
const SESSION_LOCKED = LOCK.enabled === true;
if (SESSION_LOCKED) {
  if (!state.sessions[MASTER_KEY] && LOCK.sessionId) {
    state.sessions[MASTER_KEY] = LOCK.sessionId; saveState(state);
    info(`会话锁启用：主人私聊渠道固定为 ${LOCK.sessionId}`);
  } else if (state.sessions[MASTER_KEY] && LOCK.sessionId && state.sessions[MASTER_KEY] !== LOCK.sessionId) {
    // 状态与配置不一致时以配置为准（配置是人工意图，state 是运行时产物）
    warn(`会话锁：state(${state.sessions[MASTER_KEY]}) 与配置(${LOCK.sessionId}) 不一致，以配置为准`);
    state.sessions[MASTER_KEY] = LOCK.sessionId; saveState(state);
  }
}
// 【用户要求 2026-10-08】把某个渠道**钉死**在指定会话上：配置是人工意图，优先于 state。
// 用途：文艺部群锁一个专属会话（部员看到的是同一条持续对话线，不会每次换新的）。
const PINNED = LOCK.pinned || {};
for (const [k, v] of Object.entries(PINNED)) {
  if (!v) continue;
  if (state.sessions[k] !== v) {
    info(`会话钉死：渠道 ${k} -> ${v}（原 ${state.sessions[k] || '无'}）`);
    state.sessions[k] = v; state.sessionId = v; saveState(state);
  } else {
    info(`会话钉死：渠道 ${k} 已是 ${v}`);
  }
}

// 渠道 → 会话 id。新渠道没有 id 时允许新建（每个渠道第一次用它自己的会话），
// 但**已绑定 id 的渠道绝不允许静默换会话**（那等于把该渠道的上下文悄悄丢掉）。
function channelSession(chKey) { return (state.sessions && state.sessions[chKey]) || null; }
function bindChannelSession(chKey, sid) {
  state.sessions[chKey] = sid; state.sessionId = sid; saveState(state);
  info(`渠道 ${chKey} 的会话 = ${sid}`);
}

// ------------------------------------------------ 单实例锁（正确性前提）
// 为什么必须有：多个 bridge.js 实例会①同一条 QQ 消息被处理多次（重复调 DSH）
// ②各自维护 sessionId 与 tasks、互相覆盖 heartbeat.json（心跳 pid 与真身不符）。
// 判据用「心跳文件的新鲜度 + 那个 pid 是否真的活着」——**不读对方命令行**，
// 因为提权进程读别人 CommandLine 会拿到空串（本机实测踩过这个坑）。
// 自检：真的走一遍「切条 + 挑表情」这两个函数（不连 NapCat、不跑 DSH），
// 用假 send 把结果打印出来，免得只靠单测证明不了集成没问题。
if (process.argv.indexOf('--selftest') >= 0) {
  const sent = [];
  const fakeSend = async (t) => { sent.push(String(t)); };
  const sample = '文件我看了。里面有三条。要我现在改吗？';
  (async () => {
    await sendSticker(fakeSend, 'selftest');
    for (const b of planBubbles(sample, CFG.chatStyle && CFG.chatStyle.bubbleSplit)) await fakeSend(b);
    console.log(JSON.stringify({ sticker: sent[0] || null, bubbles: sent.slice(1) }, null, 1));
    process.exit(0);
  })();
}

// 运维小工具：只数一下表情池，不连 NapCat（node bridge.js --check-stickers）。
if (process.argv.indexOf('--check-stickers') >= 0) {
  const { dir, files } = stickerPool();
  console.log('表情包目录: ' + dir);
  console.log('候选: ' + files.length + ' 张');
  files.slice(0, 8).forEach((p) => console.log('  ' + path.basename(p)));
  process.exit(files.length ? 0 : 1);
}

// --selftest 需要等异步的「假发送」跑完；单实例守卫会用 process.exit 抢在它前面，所以自检时跳过守卫。
if (process.argv.indexOf('--selftest') < 0) (function singleInstanceGuard() {
  const HB = path.join(BASE, 'heartbeat.json');
  try {
    if (fs.existsSync(HB)) {
      const hb = JSON.parse(fs.readFileSync(HB, 'utf8'));
      const ageMs = Date.now() - (hb.ts || 0);
      let alive = false;
      // [2026-10-12 fix] EPERM = 进程活着但当前权限探测不到，绝不能当成"已死"；
      // 只有 ESRCH 才是真的不存在。以前两者都当死，跨权限的第二实例被放行 -> 同一消息被处理两遍。
      try { process.kill(hb.pid, 0); alive = true; }
      catch (e) { alive = !!(e && e.code === 'EPERM'); }
      if (alive && hb.pid !== process.pid && ageMs < 90000) {
        const msg = `已有桥接实例在跑（pid=${hb.pid}，心跳 ${Math.round(ageMs / 1000)}s 前）——本实例退出，避免重复处理消息。`;
        log('WARN', msg);
        // 写一条可审计痕迹（别静默退出）
        try { fs.appendFileSync(path.join(BASE, 'bridge-dup.log'), `${new Date().toISOString()}  ${msg}\r\n`); } catch (_) {}
        process.exit(0);
      }
    }
  } catch (_) { /* 心跳坏了不该拦住启动 */ }
  try { fs.writeFileSync(HB, JSON.stringify({ pid: process.pid, ts: Date.now(), connected: false, sessionId: state.sessionId, tasks: state.tasks })); } catch (_) {}
})();

if (SESSION_LOCKED) {
  info(`【会话锁】已启用：已绑定的渠道永不换会话（现有 ${Object.keys(state.sessions).length} 个渠道绑定）`);
}

// ---------------------------------------------------------------- OneBot 客户端
let ws = null;
// 本地回环连接的退避必须短：NapCat 只把事件推给「当前已连接」的客户端，
// 连不上的那段时间里用户发的消息会被**直接丢弃且不重放**。
// 实测教训（2026-10-03 开机）：桥接 12:49:16 启动，NapCat 12:49:41 才起 3001，
// 而退避已经是 12s→24s，结果 12:49:44 用户发的「触发词+你好」掉在缝里，一条回复都没有。
// 3s→6s→12s→24s→30s 这种退避是给公网服务用的，这里打的是 127.0.0.1，没有任何理由。
let reconnectDelay = 1000;
const RECONNECT_MAX = 3000;
let connected = false;
let everConnected = false;   // 只用于「上线通知」发一次

function connect() {
  info(`连接 OneBot: ${CFG.onebotWs}`);
  ws = new WebSocket(CFG.onebotWs, {
    headers: CFG.onebotToken ? { Authorization: `Bearer ${CFG.onebotToken}` } : {},
  });

  ws.on('open', () => {
    connected = true;
    reconnectDelay = 1000;
    info('已连接 OneBot WebSocket');
    writeHeartbeat();
    // 首次连上时主动报一声「已上线」。理由：开机后 NapCat 要 ~25 秒才起 3001，
    // 这段时间用户说话是没人应的，而「没回复」到底是坏了还是没连上，用户分不出来。
    // 发一次就等于把窗口关掉。
    if (!everConnected && CFG.notifyOnStartup !== false) {      everConnected = true;
      notifyStartup().catch((e) => warn('上线通知发送失败: ' + e.message));
    }
  });

  ws.on('message', (data) => {
    let evt;
    try { evt = JSON.parse(data.toString()); } catch (_) { return; }
    handleEvent(evt).catch((e) => error('处理事件异常: ' + e.message));
  });

  ws.on('close', () => {
    connected = false;
    warn(`OneBot 连接断开，${reconnectDelay / 1000}s 后重连`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(Math.round(reconnectDelay * 1.5), RECONNECT_MAX);
  });

  ws.on('error', (e) => {
    connected = false;
    warn('OneBot 连接出错: ' + e.message);
  });
}

// 上线通知：发给白名单里除机器人自己以外的所有私聊用户
async function notifyStartup() {
  const me = String(CFG.selfQQ || '');
  // 【用户要求 2026-10-19】上线通知节流：调试期间反复重启，主人连着收到 3 条"本喵上线啦"，
  // 这比不回消息更像机器人。默认 6 小时内只发一次（state.lastStartupNoticeAt）。
  const minGap = Number(CFG.startupNoticeMinIntervalMs) || 6 * 60 * 60 * 1000;
  // 【2026-10-19 实测】不能用 state.json 存这个时间：state 是「内存权威 + 单写者」，
  // 旧进程保存一次就会把新进程写进去的字段冲掉（实测：写完 13 秒后又被冲成 0，
  // 于是重启照样刷屏）。改用独立戳文件，谁写谁读，不跟别人抢。
  let last = 0;
  try { last = Number(JSON.parse(fs.readFileSync(STARTUP_STAMP, 'utf8')).ts || 0); } catch (_) {}
  if (Date.now() - last < minGap) {
    info((Math.round((Date.now() - last) / 60000)) + ' 分钟前刚发过上线通知，这次不刷屏了');
    return;
  }
  const targets = (CFG.allowedPrivateUsers || []).filter((u) => String(u) !== me);
  if (targets.length === 0) return;
  const text = `✅ 本喵上线啦～ 只有主人能叫本喵哦，暗号是「${CFG.triggerWord}」(=^･ω･^=)`;
  for (const u of targets) {
    try {
      await callApi('send_msg', { message_type: 'private', user_id: Number(u), message: text });
      try { fs.writeFileSync(STARTUP_STAMP, JSON.stringify({ ts: Date.now() })); } catch (_) {}
      info(`已发送上线通知 -> ${u}`);
    } catch (e) { warn(`上线通知 -> ${u} 失败: ` + e.message); }
  }
}

// ---------------------------------------------------------------- 主动搭话
// 【用户要求 2026-10-19】"有时候可以主动聊天，但是要看情况"。
// 设计：门（proactive.cjs，可机械检验）+ 模型判断（说什么/该不该说）。
// 纪律：①只在私聊找主人，永远不主动进群；②正在跑任务时不插话；
// ③每天最多 N 次、深夜静默、安静够久才考虑；④模型说 SKIP 就真的不说。
function sendToMaster(text) {
  return callApi('send_msg', { message_type: 'private', user_id: Number(CFG.masterQQ), message: String(text) })
    .then((r) => { info('已发送 -> private:' + CFG.masterQQ + '（' + String(text).length + ' 字' + (r && r.message_id ? '，id=' + r.message_id : '') + '）'); return true; })
    .catch((e) => { warn('发送失败: private:' + CFG.masterQQ + ' ' + e.message); return false; });
}

async function maybeProactive() {
  const P = CFG.proactive || {};
  const chKey = 'private:' + String(CFG.masterQQ || '');
  const gate = proactiveGate({ now: Date.now(), busy: running || queue.length > 0, cfg: CFG, state });
  if (!gate.allow) { info('主动搭话：不开口（' + gate.reason + '）'); return; }
  const d = new Date();
  const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  const mins = Math.round((gate.silenceMs || 0) / 60000);
  const prompt = String(P.prompt || '')
    .split('{time}').join(hhmm)
    .split('{minutes}').join(String(mins));
  let ans;
  try {
    ans = await runDsh(prompt, async () => {}, chKey, CFG.masterQQ);
  } catch (e) {
    warn('主动搭话生成失败: ' + e.message);
    return;
  }
  const acc = acceptProactive(ans, P.maxChars);
  if (!acc.ok) { info('主动搭话：放弃（' + acc.reason + '，原文 ' + JSON.stringify(String(ans).slice(0, 50)) + '）'); return; }
  if (!(await sendToMaster(acc.text))) return;
  state.proactive = { day: gate.day, count: (gate.count || 0) + 1, lastAt: Date.now() };
  saveState(state);
  info('主动搭话已发送（今天第 ' + state.proactive.count + ' 次，安静 ' + mins + ' 分钟）');
  const vChance = Number((CFG.voice || {}).proactiveChance);
  if ((CFG.voice || {}).enabled === true && Number.isFinite(vChance) && Math.random() < vChance) {
    await sendVoice(sendToMaster, acc.text, 'proactive');
  }
  const chance = Number(P.stickerChance);
  if (Number.isFinite(chance) && Math.random() < chance) {
    await sendSticker(sendToMaster, 'proactive');
  }
}

function startProactive() {
  const P = CFG.proactive || {};
  if (P.enabled !== true) { info('主动搭话：已关闭'); return; }
  const every = Math.max(5 * 60 * 1000, Number(P.checkIntervalMs) || 30 * 60 * 1000);
  setInterval(() => {
    maybeProactive().catch((e) => warn('主动搭话异常: ' + e.message));
  }, every);
  info('主动搭话：每 ' + Math.round(every / 60000) + ' 分钟评估一次；安静 ≥ '
    + Math.round((Number(P.minSilenceMs) || 3 * 3600 * 1000) / 3600000) + ' 小时、每天 ≤ '
    + (Number(P.maxPerDay) || 2) + ' 次、' + (Array.isArray(P.quietHours) ? P.quietHours.join('-') : '23-8') + ' 点静默');
}

function callApi(action, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('未连接')); return; }
    const echo = `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timer = setTimeout(() => reject(new Error('API 超时: ' + action)), 20000);
    const onMsg = (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.echo === echo) {
        clearTimeout(timer); ws.off('message', onMsg);
        m.status === 'ok' || m.retcode === 0 ? resolve(m.data) : reject(new Error(m.message || m.wording || 'API 失败'));
      }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

// ---------------------------------------------------------------- 心跳（给看门狗判活）
function writeHeartbeat() {
  try {
    fs.writeFileSync(path.join(BASE, 'heartbeat.json'), JSON.stringify({
      pid: process.pid, ts: Date.now(), connected, sessionId: state.sessionId, tasks: state.tasks,
    }));
  } catch (_) {}
}
setInterval(writeHeartbeat, 30000);

// ---------------------------------------------------------------- 活动留档
// 【用户要求 2026-10-08】文艺部群里出现的活动要留档，学期末用来算加分。
// 把 activityGroups 里**所有**消息（含图片/文件，哪怕没有触发词、哪怕没有文字）
// 原样追加到 activity/raw/YYYY-MM-DD.jsonl：一条一行 JSON，只追加、永不覆盖。
// 记录带 sender.card（群昵称）与每个消息段，学期末可回答「谁、什么时候、发了什么」。
// 留档目录：相对路径按本文件所在目录解析（换台电脑/换盘符都不会写错地方）。
const ACT_DIR = CFG.activityLogDir
  ? (path.isAbsolute(CFG.activityLogDir) ? CFG.activityLogDir : path.join(BASE, CFG.activityLogDir))
  : path.join(BASE, 'activity');
function recordActivity(evt, groupId, userId) {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const dir = path.join(ACT_DIR, 'raw');
  fs.mkdirSync(dir, { recursive: true });
  const segs = Array.isArray(evt.message)
    ? evt.message
    : [{ type: 'text', data: { text: String(evt.message || '') } }];
  const sender = evt.sender || {};
  const rec = {
    t: now.toISOString(),
    group: groupId,
    user: userId,
    name: sender.card || sender.nickname || '',
    role: sender.role || '',
    msgId: String(evt.message_id || ''),
    text: extractText(evt.message),
    segs: segs.map((s) => {
      const d = s.data || {};
      if (s.type === 'text') return { type: 'text', text: d.text || '' };
      if (s.type === 'image') return { type: 'image', file: d.file || '', url: d.url || '' };
      if (s.type === 'file') return { type: 'file', name: d.file || d.name || '', size: d.file_size || 0, id: d.file_id || '' };
      if (s.type === 'at') return { type: 'at', qq: String(d.qq || '') };
      if (s.type === 'reply') return { type: 'reply', id: String(d.id || '') };
      if (s.type === 'face') return { type: 'face', id: String(d.id || '') };
      if (s.type === 'forward') return { type: 'forward', id: String(d.id || '') };
      return { type: s.type };
    }),
  };
  fs.appendFileSync(path.join(dir, day + '.jsonl'), JSON.stringify(rec) + '\n');
}

// ---------------------------------------------------------------- 事件处理
// 入群/退群通知也留档 —— 这是「谁参加了这个活动」最硬的证据（比事后回忆可靠）。
function handleNotice(evt) {
  try {
    const gid = evt.group_id ? String(evt.group_id) : null;
    if (!gid || !(CFG.activityGroups || []).map(String).includes(gid)) return;
    const nt = evt.notice_type || '';
    if (nt !== 'group_increase' && nt !== 'group_decrease') return;
    const now = new Date();
    const dir = path.join(ACT_DIR, 'raw');
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
      t: now.toISOString(),
      group: gid,
      user: String(evt.user_id || ''),
      name: '',
      role: '',
      msgId: '',
      notice: nt,
      text: nt === 'group_increase' ? '加入群聊' : '退出群聊',
      segs: [{ type: 'notice', notice: nt, operator: String(evt.operator_id || '') }],
    };
    fs.appendFileSync(path.join(dir, now.toISOString().slice(0, 10) + '.jsonl'), JSON.stringify(rec) + '\n');
  } catch (e) { warn('notice 留档失败: ' + e.message); }
}

const seen = new Set(); // 去重，防 NapCat 重推
async function handleEvent(evt) {
  if (evt.post_type === 'notice') { handleNotice(evt); return; }
  if (evt.post_type !== 'message') return;

  // 【2026-10-03 修复·重要】判断「是不是机器人自己发的」必须比**发送者 user_id**，
  // 绝不能比 self_id —— self_id 按 OneBot 规范**永远是机器人自己的账号**，
  // 拿它跟配置里的 selfQQ 比会恒等于真，于是每一条消息都在任何日志之前被 return 掉，
  // 现象就是"机器人完全不理人、而且日志里一个字都没有"。
  // 这个坑是自己造的：selfQQ 原本误填成用户号（比较恒不成立＝无害空转），
  // 我"修正"成机器人号之后，反而把空转变成了全量拦截（2026-10-03 00:42 起，直到 12:58 才发现）。
  const senderId = String(evt.user_id || '');
  if (senderId && CFG.selfQQ && senderId === String(CFG.selfQQ)) return; // 发送者是自己

  const userId = senderId;
  const groupId = evt.group_id ? String(evt.group_id) : null;
  const msgId = String(evt.message_id || '');
  if (msgId && seen.has(msgId)) return;
  if (msgId) { seen.add(msgId); if (seen.size > 500) seen.clear(); }

  // 【活动留档 2026-10-08】活动群的消息在**任何过滤之前**先落盘。
  // 必须放在 extractText 的空文本 return 之前：只发图片、没有文字的活动公告
  // 恰恰是最需要留档的一类，放后面会被静默丢掉。
  if (groupId !== null && (CFG.activityGroups || []).map(String).includes(groupId)) {
    try { recordActivity(evt, groupId, userId); }
    catch (e) { warn('活动留档失败: ' + e.message); }
  }

  const text = extractText(evt.message);
  // 【用户要求 2026-10-12】@机器人 也作为触发方式（已开放的群里，@本机器人即可下命令）
  const atSelf = Array.isArray(evt.message) && evt.message.some((s) => s && s.type === 'at' && String((s.data || {}).qq || '') === String(CFG.selfQQ || ''));
  // 空文本必须留痕：以前这里是静默 return，导致"消息格式不是我预期的"与"机器人没收到"
  // 在日志里长得一模一样（同一个教训：静默丢弃＝假装正常）。
  if (!text) { warn(`收到空文本消息，已忽略（QQ ${userId}，message 类型=${Array.isArray(evt.message) ? 'array' : typeof evt.message}）`); return; }

  // 白名单
  if (groupId === null) {
    if (CFG.allowedPrivateUsers.length && !CFG.allowedPrivateUsers.includes(userId)) {
      warn(`已忽略未授权私聊（QQ ${userId}）`); return;
    }
  } else {
    if (!CFG.allowedGroups.includes(groupId)) {
      warn(`已忽略未授权群消息（群 ${groupId}）`); return;
    }
  }

  // 【用户硬要求 2026-10-08】只有主人 QQ 能触发命令。
  // 放在留档与白名单之后、触发词解析之前：别人的消息仍然会被 activityGroups 记档，
  // 但永远不会变成任务（群里闲聊/别人喊触发词都不会让机器人动起来）。
  if (CFG.masterOnlyCommands === true) {
    // 【用户要求 2026-10-09】openTriggerGroups 里的群向全体成员开放：群成员带触发词即可下命令。
    const openTriggerGroups = (CFG.openTriggerGroups || []).map(String);
    const groupOpened = groupId !== null && openTriggerGroups.includes(String(groupId));
    if (!groupOpened) {
      const master = String(CFG.masterQQ || '');
      if (!master) { warn('masterOnlyCommands=true 但没配 masterQQ，为安全起见忽略所有命令'); return; }
      if (String(userId) !== master) {
        info(`非主人 QQ（${userId}）的消息不触发命令，已忽略`); return;
      }
    } else {
      info(`群 ${groupId} 在 openTriggerGroups 白名单：全体成员可用「${CFG.triggerWord}」下命令（QQ ${userId}）`);
    }
  }

  const trigger = CFG.triggerWord;
  // 触发词匹配（2026-10-03 修）：**只要出现触发词就算命令**，不再要求它后面跟空白/标点。
  // 旧规则要求"词边界"（本意是免得「喵喵干」被误剥成「干」），但中文没有词边界，
  // 于是「喵喵自己修复」这种最自然的写法被判成"不含触发词"，整条消息被**静默丢弃**
  // （现场：NapCat 收到消息、桥接只留一行"私聊消息不含触发词，忽略"，用户看到的就是"机器人不回我"）。
  // 现在的语义：触发词是**前缀标记** —— 出现在开头就去掉前缀，出现在中间就地摘掉。
  const raw = text.trim();
  let isCmd = false;
  let rest = raw;
  {
    const lt = trigger.toLowerCase();
    const li = raw.toLowerCase();
    if (lt && li.startsWith(lt)) {
      isCmd = true;
      rest = raw.slice(trigger.length);
    } else if (lt) {
      const idx = li.indexOf(lt);
      if (idx >= 0) {
        isCmd = true;
        rest = raw.slice(0, idx) + ' ' + raw.slice(idx + trigger.length);
      }
    }
    rest = rest.replace(/^[\s，,。.!！?？:：、~～\-]+/, '').trim();
  }
  // 【用户要求 2026-10-12】@机器人 也算触发（任务正文 = 去掉 @ 后的文字，extractText 本就不含 at 段）
  if (!isCmd && atSelf) { isCmd = true; }
  // 私聊默认【不要求触发词】：直接说话就是任务（用户要求"在 QQ 里颁发任务"）。
  // 群里仍必须带触发词（否则群里任何闲聊都会被当任务）。
  if (groupId !== null && !isCmd && !CFG.groupWatch) {
    info(`群 ${groupId} 消息不含触发词，忽略`); return;
  }
  const privateNeedsTrigger = CFG.privateRequireTrigger === true;
  if (groupId === null && privateNeedsTrigger && !isCmd) {
    // 【2026-10-19 实测】这里原来是静默 return —— 主人发了句「能」/「没回复」，
    // 机器人一个字都不回，用户看到的就是「坏了」。改成：给一句提示（5 分钟最多一次）。
    info('私聊消息不含触发词（privateRequireTrigger=true）');
    const hint = (CFG.chatStyle && CFG.chatStyle.triggerHint) || '';
    if (hint) {
      const now = Date.now();
      const lastHint = Number(state.lastTriggerHintAt || 0);
      if (now - lastHint > 5 * 60 * 1000) {
        state.lastTriggerHintAt = now; saveState(state);
        callApi('send_msg', { message_type: 'private', user_id: Number(userId), message: hint })
          .then((r) => info('已发送触发词提示 -> ' + userId + (r && r.message_id ? '，id=' + r.message_id : '')))
          .catch((e) => warn('触发词提示发送失败: ' + e.message));
      } else {
        info('触发词提示 5 分钟内已发过，这次不重复');
      }
    }
    return;
  }
  // 任务正文：带触发词就去掉前缀；不带就整句当任务。
  const task = (isCmd ? rest.trim() : raw) || '（无内容）';

  // 【用户要求 2026-10-08（澄清版）】结果回到「命令是从哪条渠道来的」那里：
  // 在文艺部群里下的命令 → 结果发在文艺部群（部员要能看到）；
  // 私聊下的命令 → 结果只走私聊。
  // 隔离不靠「把群里的结果偷偷发去私聊」，而靠**不同渠道用不同的 DSH 会话**。
  // 想强制全部走私聊，把 bridge.config.json 的 replyMode 设成 "private"。
  const ownerTarget = { type: 'private', id: Number(CFG.masterQQ || userId) };
  const originTarget = groupId ? { type: 'group', id: groupId } : { type: 'private', id: userId };
  const chKey = groupId ? 'group:' + groupId : 'private:' + userId;
  const replyTarget = (CFG.replyMode === 'private') ? ownerTarget : originTarget;
  // 【2026-10-19】记下这条渠道最后一次「人来消息」的时间：主动搭话靠它判「安静够久了没」。
  state.lastUserAt = state.lastUserAt || {};
  state.lastUserAt[chKey] = Date.now();
  saveState(state);
  info(`任务入队: from=${chKey} task="${task.slice(0, 60)}"（结果 -> ${replyTarget.type}:${replyTarget.id}；渠道会话 ${channelSession(chKey) || '首次将新建'}）`);

  // 只有在「群里下命令、结果却发去私聊」时，群里才补一句固定文案的知会
  // （否则部员完全不知道发生了什么）。结果本来就在群里时，这句是多余的噪音。
  if (groupId !== null && replyTarget.type !== 'group' && CFG.groupAck) {
    callApi('send_msg', { message_type: 'group', group_id: Number(groupId), message: String(CFG.groupAck) })
      .catch((e) => warn('群内知会发送失败: ' + e.message));
  }

  state.tasks = (state.tasks || 0) + 1; saveState(state);

  const t0 = Date.now();
  // 【串台闸】结果只能回到「发起的那条渠道」：既不许把群里的结果偷偷发去私聊
  // （部员看不到、等于没回），也不许把私聊的结果发到群里（泄露主人自己的事）。
  // 放在发送函数里，是为了让「跨渠道漏话」在结构上不可能发生，
  // 而不是靠以后每个新加的代码路径自己记得。
  const send = async (text) => {
    let to = replyTarget;
    if (!to || to.type !== originTarget.type || String(to.id) !== String(originTarget.id)) {
      warn(`串台闸：目标 ${to && to.type}:${to && to.id} 与发起渠道 ${originTarget.type}:${originTarget.id} 不一致，已改回发起渠道`);
      to = originTarget;
    }
    try {
      const r = await callApi('send_msg', to.type === 'group'
        ? { message_type: 'group', group_id: Number(to.id), message: text }
        : { message_type: 'private', user_id: Number(to.id), message: text });
      // 【2026-10-19】发送结果必须留痕：OneBot 回 ok 也未必送达，
      // 至少把 message_id 记下来，事后能与 NapCat 的历史逐条对齐。
      const mid = r && (r.message_id || r.messageId || (r.data && r.data.message_id));
      info('已发送 -> ' + to.type + ':' + to.id + '（' + String(text).length + ' 字' + (mid ? '，id=' + mid : '') + '）');
    } catch (e) {
      // 【2026-10-19 实测】NapCat 发语音时经常回 retcode 1200
      // "Timeout: NTEvent ... sendMsg ... onMsgInfoListUpdate"，但消息其实已经进 QQ 了
      // （三条试听语音全部报超时，历史里 1039/1040/1041 都在）。所以这里要区分：
      // 是「没发出去」还是「发出去了但回调慢」——后者不能当失败报给用户。
      const m = String(e && e.message || '');
      if (/Timeout:\s*NTEvent/i.test(m)) info('已提交 -> ' + to.type + ':' + to.id + '（回调超时，消息通常已送达）');
      else warn('发送失败: ' + to.type + ':' + to.id + ' ' + m);
    }
  };

  // 【用户要求 2026-10-09】按渠道 token 限额：累计用量到上限后直接拒绝新任务。
  {
    const budget = channelBudget(chKey);
    // 【用户要求 2026-10-12】额度是对部员的；主人本人的使用照旧，不受本群额度拦截。
    const budgetSkipMaster = String(userId) === String(CFG.masterQQ || '');
    if (budget && !budgetSkipMaster) {
      const used = Number((state.usage || {})[chKey] || 0);
      if (used >= budget) {
        info(`渠道 ${chKey} token 额度已用完（${used}/${budget}），拒绝本次任务`);
        await send(`喵呜～本群的 token 额度已经用完啦（已用 ${used} / 上限 ${budget}），本喵先停下，等主人给本群加额度再继续喵～`);
        return;
      }
    }
  }

  // 【用户要求 2026-10-19】不要每次都先甩一句「收到…会话 xxx」。
  // 人的反应是：很快答完就根本不用说「收到了」；真等久了才开口。
  // 所以改成「延迟开口」——超过 ackDelayMs 还没结果才说一句话，且绝不提会话/进程。
  const CS = CFG.chatStyle || {};
  const ackPhrases = (Array.isArray(CS.ackPhrases) && CS.ackPhrases.length)
    ? CS.ackPhrases
    : ['嗯…让我看看喵～', '好哦，稍等本喵一下 (๑•̀ㅂ•́)و✧'];
  const ackDelayMs = Number.isFinite(Number(CS.ackDelayMs)) ? Number(CS.ackDelayMs) : 9000;
  let ackTimer = null;
  if (CS.enabled !== false && ackDelayMs >= 0) {
    ackTimer = setTimeout(() => {
      send(pickRandom(ackPhrases) || '嗯…').catch(() => {});
    }, ackDelayMs);
    if (ackTimer.unref) ackTimer.unref();
  }

  // 【长任务别装死】一条命令动辄跑几分钟（实测有过 295 秒），期间完全安静，
  // 用户看到的就是「机器人又不回我了」。但报进度也要像人：延迟 + 随机措辞。
  const progressPhrases = (Array.isArray(CS.progressPhrases) && CS.progressPhrases.length)
    ? CS.progressPhrases
    : ['还在弄喵～再等我一下下 (´･ω･`)', '这个有点慢喵…本喵还在跑 (ฅ´ω`ฅ)'];
  const progressDelayMs = Number.isFinite(Number(CS.progressDelayMs)) ? Number(CS.progressDelayMs) : 75000;
  const progressIntervalMs = Math.max(30000, Number(CS.progressIntervalMs) || 90000);
  const nudge = setInterval(() => {
    // 等桌面端释放会话时，进度由「占用提示」负责，避免两种提示互相刷屏。
    if (leaseWaitStartedAt) return;
    if (Date.now() - t0 < progressDelayMs) return;
    const s = Math.round((Date.now() - t0) / 1000);
    const raw = String(pickRandom(progressPhrases) || '还在跑喵～');
    const line = raw.indexOf('{seconds}') >= 0 ? raw.split('{seconds}').join(String(s)) : (raw + '（已 ' + s + ' 秒）');
    send(line).catch(() => {});
  }, progressIntervalMs);

  let answer;
  try {
    answer = await runDsh(task, send, chKey, userId);
  } catch (e) {
    error('DSH 执行失败: ' + e.message);
    answer = `执行失败：${e.message}`;
  } finally {
    clearInterval(nudge);
    // 结果已经出来了：把还没说出口的「嗯…让我看看」取消掉，别在答案之后再补一句。
    if (ackTimer) clearTimeout(ackTimer);
  }
  // runDsh 在"锁死会话但会话不存在"等情况下返回的是 {skipped, reason} 而不是字符串；
  // 不特判就会把 "[object Object]" 当成回复发出去。
  if (answer && typeof answer === 'object') {
    answer = '⚠️ 本次未执行：' + (answer.reason || JSON.stringify(answer));
  }
  if (typeof answer !== 'string') answer = String(answer == null ? '（无输出）' : answer);

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  info(`任务完成，用时 ${secs}s，输出 ${answer.length} 字`);

  // 【用户要求 2026-10-19】像人一样回：能一句话就一句话，内容多就拆成几条短消息，
  // 名单/表格这类结构化内容整段发（拆了就没法抄）。切分逻辑在 humanize.cjs，有单测钉着。
  const splitCfg = (CS && CS.bubbleSplit) ? CS.bubbleSplit : CS;
  const bubbles = planBubbles(answer, splitCfg);
  info(`回复排版: ${bubbles.length} 条（${bubbles.map((b) => b.length).join('/')} 字）`);
  const gapRaw = Number((splitCfg || {}).gapMs);
  const gap = Number.isFinite(gapRaw) ? gapRaw : 650;
  const midChance = Number(CS && CS.stickerMidChance);
  let midStickerSent = false;
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) await sleep(gap);
    await send(bubbles[i]);
    // 偶尔在两条之间插一张表情，像人聊天时随手甩个图（只插一次，且只在真的分条时）
    if (!midStickerSent && bubbles.length >= 2 && i === 0 && Number.isFinite(midChance) && Math.random() < midChance) {
      midStickerSent = true;
      await sendSticker(send, 'mid');
    }
  }

  // 【用户要求 2026-10-19】语音回复：偶尔用"说"的（默认只在私聊，群里不打招呼就发语音太怪）。
  {
    const V = CFG.voice || {};
    const chance = Number(V.replyChance);
    const allowed = V.enabled === true && (!V.privateOnly || String(chKey).indexOf('private:') === 0);
    if (allowed && Number.isFinite(chance) && Math.random() < chance) {
      await sendVoice(send, answer, 'reply');
    }
  }

  // 【用户要求 2026-10-19】结束语表情包：按概率发，且避开最近发过的十几张。
  // 每次都补一张、还总是同一张，是最像机器人的行为；偶尔发一张才像人。
  const STK = CFG.endSticker || {};
  const stickerChance = Number.isFinite(Number(STK.probability)) ? Number(STK.probability) : 0.6;
  if (STK.enabled !== false && Math.random() < stickerChance) {
    await sendSticker(send, 'end');
  }
}

function extractText(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  return message.filter((s) => s.type === 'text').map((s) => s.data && s.data.text || '').join('').trim();
}

// 等一会儿再发下一条：一句话一句话地说，比一次性倒出来更像人在打字。
function sleep(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
  return new Promise((r) => { const t = setTimeout(r, n); if (t.unref) t.unref(); });
}

// 表情包池：递归扫 stickers/ 下**不以下划线或点开头**的目录。
// 纪律（2026-10-17 主人要求）：_blocked / _offstyle / _collected 这些下划线目录永远不进池子，
// 池子里只放「正经」的图 —— 擦边/低俗的一张都不能发。
function stickerPool() {
  const STK = CFG.endSticker || {};
  // 相对路径按本文件所在目录解析，避免"在别的目录启动就读不到表情"。
  const dir = STK.dir ? (path.isAbsolute(STK.dir) ? STK.dir : path.join(BASE, STK.dir)) : path.join(BASE, 'stickers');
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); }
      else if (/\.(png|jpe?g|gif|webp)$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir, 1);
  return { dir, files: out };
}

// 发一张表情；避开最近发过的 12 张（同一张反复出现最像机器人）。
// 走的是调用方传进来的 send —— 所以一样受「串台闸」约束，只会发到发起渠道。
// 把一段文字说成语音发出去。返回是否真的发了。
// 纪律：只有一句话能念完的才转（maxChars），太长就只发文字 —— 5 分钟的语音没人听。
async function sendVoice(send, text, kind) {
  const V = CFG.voice || {};
  if (V.enabled !== true) return false;
  const r = await synthVoice(text, V);
  if (!r.file) { info('语音跳过(' + kind + '): ' + (r.error || 'no-file')); return false; }
  try {
    await send('[CQ:record,file=file:///' + r.file.replace(/\\/g, '/') + ']');
    info('已发送语音(' + kind + '): ' + path.basename(r.file) + '（' + r.engine + '）');
    return true;
  } catch (e) {
    warn('语音发送失败(' + kind + '): ' + e.message);
    return false;
  }
}

async function sendSticker(send, kind) {
  try {
    const { dir, files } = stickerPool();
    if (!files.length) { warn('表情包候选为空: ' + dir); return false; }
    const recent = (state.stickers && Array.isArray(state.stickers.recent)) ? state.stickers.recent : [];
    const fresh = files.filter((f) => recent.indexOf(path.basename(f)) < 0);
    const pick = pickRandom(fresh.length ? fresh : files);
    if (!pick) return false;
    const abs = pick.replace(/\\/g, '/');
    await send('[CQ:image,file=file:///' + abs + ']');
    state.stickers = { recent: [path.basename(pick)].concat(recent).slice(0, 12) };
    saveState(state);
    info('已发送表情(' + kind + '): ' + path.basename(pick) + '（候选 ' + files.length + ' 张）');
    return true;
  } catch (e) {
    warn('表情包发送失败: ' + e.message);
    return false;
  }
}

function splitMessage(text, size) {
  const out = [];
  let s = String(text || '').trim();
  if (!s) s = '（无输出）';
  while (s.length > size) { out.push(s.slice(0, size)); s = s.slice(size); }
  out.push(s);
  return out;
}

// ---------------------------------------------------------------- 调 DSH（固定会话）
// 【2026-10-09】按渠道的 token 上限（键是 chKey，如 group:100000001）。
function channelBudget(chKey) {
  const b = (CFG.channelTokenBudget || {})[chKey];
  return typeof b === 'number' && b > 0 ? b : 0;
}
let running = false;
const queue = [];

// 【2026-10-07】桌面端打开机器人会话时会持有内核写租约（session.lock），桥接的 CLI 会拿到
// already-owned 报错。这是「同一会话只能被一个进程写」的互斥，不是故障 ⇒ 不当作任务失败：
// 把任务放回队首、按节奏自动重试，等桌面端释放；期间按速率上限在 QQ 上说清「在等」，
// 超预算才如实报失败。（之前那次就是没人看懂的英文报错 + 静默失效。）
const LEASE_RETRY_MS = 20000;
const LEASE_WAIT_MAX_MS = 10 * 60 * 1000;
const LEASE_NOTICE_MS = 60000;
let leaseNoticeAt = 0;
let leaseWaitStartedAt = 0; // 非 0 表示当前任务正处于「等桌面端释放会话」状态

function runDsh(task, notify, chKey, senderId) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject, notify, chKey: chKey || MASTER_KEY, senderId: String(senderId || '') });
    pump();
  });
}

function pump() {
  if (running || queue.length === 0) return;
  running = true;
  const item = queue.shift();
  const { task, resolve, reject } = item;

  const chKey = item.chKey || MASTER_KEY;
  // 【用户要求 2026-10-12】主人本人的任务照旧：不受本群「办公类任务」边界限制。
  const senderIsMasterTask = String(item.senderId || '') === String(CFG.masterQQ || '');
  const sid = channelSession(chKey);
  const useJson = CFG.useJsonEvents !== false; // 【2026-10-09】用 --json 事件流统计 token 用量

  // 【渠道会话的保险】已绑定会话的渠道，若那个会话在磁盘上不存在（被人删了），
  // 绝不能静默换一个新会话 —— 那会把该渠道的上下文悄悄丢掉，而外观毫无变化。
  if (sid) {
    // 【2026-10-07】机器人的会话根已挪到 sessions-qqbot：桌面端只扫 <home>\sessions，
    // 因此它再也看不到、也就无法占用机器人的会话（写租约互斥从此不会发生）。
    const sessRoots = [path.join(CFG.dshHome, 'sessions-qqbot'), path.join(CFG.dshHome, 'sessions')];
    let exists = false;
    try {
      for (const root of sessRoots) {
        for (const g of fs.readdirSync(root)) {
          if (fs.existsSync(path.join(root, g, sid))) { exists = true; break; }
        }
        if (exists) break;
      }
    } catch (_) { exists = true; } // 读不到目录就不要误拦，宁可放行
    if (!exists) {
      const msg = `渠道 ${chKey} 的会话 ${sid} 已不在磁盘上（可能被删了）。` +
                  `为避免静默换会话，本次不执行。请把 state.json 的 sessions["${chKey}"] 清掉后重试（会为该渠道新建一个）。`;
      error(msg);
      running = false;
      try { resolve({ skipped: true, reason: msg }); } catch (_) {}
      return;
    }
  } else {
    // 新渠道（还没有专属会话）允许新建：这正是「一个渠道一个会话」的落点。
    info(`渠道 ${chKey} 还没有专属会话，本次为它新建一个`);
  }

  const args = [CFG.dshBin, '--profile', CFG.dshProfile];
  if (sid) args.push('--session-id', sid);
  // 【用户要求 2026-10-09】--json：拿到机器可读事件（session id / 最终文本 / 每步 usage），
  // 用来「按渠道统计 token 并限额」。解析不出 JSON 时回退成纯文本。
  if (useJson) args.push('--json');
  // 【用户要求 2026-10-08】可爱风格：在任务前面挂一段风格要求（写进提示词，
  // 而不是靠事后改写——事后改写会动到数字与名单，那是最危险的）。
  const style = CFG.replyStyle || {};
  // 渠道说明：让这条会话知道自己面对的是谁。群里的回复群成员都看得到，
  // 所以公开渠道只放公开内容；私聊才是主人自己的事。
  const isGroupCh = chKey.startsWith('group:');
  // 【可配置】每个渠道可以额外注入一段「本群职责」说明（channelContext，键 = group:<群号> / private:<QQ号>）。
  // 留空就只有下面这句通用的公开/私密边界说明 —— 桥接不假设任何具体业务。
  const chCtx = (CFG.channelContext && CFG.channelContext[chKey]) ? String(CFG.channelContext[chKey]).trim() : '';
  const chLine = isGroupCh
    ? `【当前渠道】QQ 群 ${chKey.slice(6)}（公开渠道：群成员都能看到你的回复，所以只放这个群该公开的内容 —— 通知、名单、公告这类；不要贴主人电脑上的文件路径、进程、私事，也不要提其它渠道的对话）。` +
      (chCtx ? '\n【本群职责】' + chCtx : '')
    : `【当前渠道】与主人的 QQ 私聊（只有主人看得到，可以谈电脑上的文件、路径、操作细节）。` + (chCtx ? '\n【本渠道说明】' + chCtx : '');
  // 【用户要求 2026-10-12】按渠道注入任务用途边界（文艺部群只对部员开放办公/文档类任务）；
  // 主人本人的任务照旧 —— 不受该边界限制。
  const scopeText = (CFG.channelScopes && CFG.channelScopes[chKey]) ? CFG.channelScopes[chKey] : '';
  const scopeLine = (scopeText && !senderIsMasterTask) ? ('\n【本渠道任务边界】' + scopeText) : '';
  const senderLine = '\n【本条任务来自】QQ ' + (item.senderId || '(未知)') + (senderIsMasterTask ? '（主人本人：按主人的正常权限执行，不受本群「办公类任务」边界限制）' : '（本群成员：必须遵守本群任务边界）');
  // 【用户要求 2026-10-19】像人一样说话：把「说话方式」写进提示词（不是事后改写），
  // 明确禁止「收到/会话/进程」这类机器话；具体文案在 config 的 chatStyle.promptBlock。
  const chatCfg = CFG.chatStyle || {};
  const talkBlock = (chatCfg.enabled !== false && chatCfg.promptBlock) ? ('\n' + chatCfg.promptBlock) : '';
  const head = (style.enabled && style.promptPrefix ? style.promptPrefix + '\n' : '') + chLine + senderLine + scopeLine + talkBlock +
               '\n【渠道隔离】本渠道是与其它渠道彼此独立的会话，不要引用其它渠道里的对话内容。';
  args.push(head + '\n\n【主人这次的任务】\n' + task);

  info(`调用 DSH: ch=${chKey} session=${sid || '(新建)'} args=${args.length}`);
  // 拍快照：现在已存在哪些会话目录（新出现的那个就是这次的）
  const spawnMs = Date.now();
  const sessSeen = new Set(listSessionDirs().map((d) => d.id));
  const child = spawn(CFG.nodeExe, args, {
    cwd: CFG.dshCwd,
    windowsHide: true,
    env: {
      ...process.env,
      DSH_HOME: CFG.dshHome,
      // 【2026-10-03】用户要求 QQ 机器人能真正操控电脑执行任务。
      // headless profile 的基础沙箱层是 `mode: process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`，
      // 而用户审批层是 `(DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'`。
      // 这里显式注入，**不依赖 permission-presets 插件是否加载成功**（dump-config 不加载插件代码，验不出它到底有没有生效）。
      // 位置就在这里而不是 profile 里：影响面精确限定为「QQ 桥接拉起的 DSH」，不动别的入口。
      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || 'danger-full-access',
      // 【2026-10-07】让 QQ 机器人也走 PTC（与桌面端默认模式一致）：两侧合成出的
      // 工具集完全相同（run_code），不会出现「激活工具集与声明序列基线不相交 →
      // 全部 defer_loading → API 400」的会话级死锁。
      DSH_TOOLS_MODE: process.env.DSH_TOOLS_MODE || 'ptc',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '', err = '';
  let finalText = '', textAcc = '', taskUsage = 0, lineBuf = '';
  // 【2026-10-08 实测教训】会话 id 原来只在任务**结束时**才绑定，于是
  // 「第一次在某渠道下命令 → 桥接被我重启/杀掉 → 该渠道的会话没绑上」，
  // 下次又会新建一个（对话线断了，而且看起来毫无异常）。现改为**一出现就绑**。
  const tryBind = () => {
    if (channelSession(chKey)) return;
    const mm = (out + err).match(/session[- ]([0-9a-f-]{36})/i);
    if (mm) { bindChannelSession(chKey, 'session-' + mm[1]); info(`会话绑定（按输出）: ${chKey} -> session-${mm[1]}`); return; }
    // 兜底：输出里没有 id（实测 headless CLI 就是不打印），改按「新出现的会话目录」绑定。
    // 只认出生时间晚于 spawn 的目录 —— 避免把别的渠道/历史会话绑错。
    const fresh = listSessionDirs().filter((d) => !sessSeen.has(d.id) && d.birthMs > spawnMs - 3000);
    if (fresh.length) {
      fresh.sort((a, b) => a.birthMs - b.birthMs);
      bindChannelSession(chKey, fresh[0].id);
      info(`会话绑定（按目录探测）: ${chKey} -> ${fresh[0].id}`);
    }
  };
  // 【用户要求 2026-10-09】--json 事件流：session/text/final/status(step_end.usage)
  const handleEvent = (line) => {
    const t = line.trim();
    if (!t) return;
    let ev; try { ev = JSON.parse(t); } catch (_) { return; }
    if (ev.type === 'session' && ev.sessionId) {
      if (!channelSession(chKey)) { bindChannelSession(chKey, ev.sessionId); info(`会话绑定（--json）: ${chKey} -> ${ev.sessionId}`); }
    } else if (ev.type === 'text' && typeof ev.text === 'string') {
      textAcc += ev.text;
    } else if (ev.type === 'final' && typeof ev.text === 'string') {
      finalText = ev.text;
    } else if (ev.type === 'status' && ev.phase === 'step_end' && ev.usage && typeof ev.usage.totalTokens === 'number') {
      taskUsage += ev.usage.totalTokens;
    }
  };
  // stdout 是任意分块的：先攒行再解析，否则跨块的 JSON 行会解析失败、丢掉 final/usage。
  const feedStdout = (s) => {
    out += s;
    if (!useJson) return;
    lineBuf += s;
    let idx;
    while ((idx = lineBuf.indexOf('\n')) >= 0) {
      handleEvent(lineBuf.slice(0, idx));
      lineBuf = lineBuf.slice(idx + 1);
    }
  };
  child.stdout.on('data', (d) => { feedStdout(d.toString()); tryBind(); });
  child.stderr.on('data', (d) => { err += d.toString(); tryBind(); });

  const killer = setTimeout(() => {
    warn('DSH 超时，强制结束');
    try { child.kill('SIGKILL'); } catch (_) {}
  }, CFG.taskTimeoutMs || 600000);

  child.on('close', (code) => {
    clearTimeout(killer);
    running = false;

    // 会话 id：从 stdout 或 stderr 里抓，抓到就固化下来。
    // 【会话锁】开启时**禁止**在这里固化 —— 因为能在输出里抓到 id，说明这次
    // 调用并没有带上固定会话（=已经开了新会话），固化它等于把"锁死"改成"随手开新的"。
    // 【2026-10-09】先走统一的 tryBind（输出正则 + 目录兜底），还绑不上才告警。
    tryBind();
    if (!channelSession(chKey)) {
      warn(`渠道 ${chKey} 本次是新会话，但既没在输出里抓到 id、也没探测到新会话目录 —— 下次会再新建一个，该渠道的上下文无法延续。`);
    }

    // 【2026-10-07】同一个会话只能被一个进程写：桌面端打开机器人会话时会持有内核写租约，
    // 桥接随即拿到 already-owned 报错。这里把它翻成人话，避免又出现「机器人莫名其妙不理人」。
    const leaseBlocked = /already owned by an active write handle/i.test(out + err);
    if (leaseBlocked) {
      const now = Date.now();
      item.leaseSince = item.leaseSince || now;
      leaseWaitStartedAt = leaseWaitStartedAt || now;
      const waitedMs = now - item.leaseSince;
      if (waitedMs < LEASE_WAIT_MAX_MS) {
        queue.unshift(item); // 放回队首，保持任务顺序；running 已在上方置 false
        if (now - leaseNoticeAt >= LEASE_NOTICE_MS) {
          leaseNoticeAt = now;
          const secs = Math.round(waitedMs / 1000);
          try { item.notify && item.notify('机器人会话正被桌面端占用（同一个会话只能被一个进程写）。我在等它释放，已等 ' + secs + ' 秒，会自动重试；你也可以在桌面端切走/关闭该会话。'); } catch (_) {}
        }
        info('会话被占用，' + Math.round(LEASE_RETRY_MS / 1000) + 's 后重试（已等 ' + Math.round(waitedMs / 1000) + 's）');
        setTimeout(pump, LEASE_RETRY_MS);
        return;
      }
      warn('会话被占用超过 ' + Math.round(LEASE_WAIT_MAX_MS / 60000) + ' 分钟，放弃本次任务');
    }
    leaseWaitStartedAt = 0;
    // 【用户要求 2026-10-09】把本次各 step 的 totalTokens 累加到该渠道；到上限由消息入口拒绝新任务。
    // 【用户要求 2026-10-12】额度是给部员的：主人本人的用量不计入本群额度（对主人照旧）。
    if (!leaseBlocked && useJson && taskUsage > 0) {
      if (senderIsMasterTask) {
        info(`token 用量（主人本人，不计入本群额度）: ${chKey} +${taskUsage}`);
      } else {
        state.usage = state.usage || {};
        const prev = Number(state.usage[chKey] || 0);
        state.usage[chKey] = prev + taskUsage;
        saveState(state);
        info(`token 用量: ${chKey} +${taskUsage} -> ${state.usage[chKey]}`);
        const budget0 = channelBudget(chKey);
        if (budget0 && prev < budget0 && state.usage[chKey] >= budget0) {
          try { item.notify && item.notify(`喵呜～本群的 token 额度已经用到了 ${state.usage[chKey]} / ${budget0}，到上限本喵就先停下啦，请主人留意喵～`); } catch (_) {}
        }
      }
    }
    if (useJson && lineBuf.trim()) { handleEvent(lineBuf); lineBuf = ''; }
    const jsonAnswer = (finalText || textAcc || '').trim();
    const fallback = code === 0 ? '（无输出）' : `退出码 ${code}${err ? '：' + err.trim().slice(0, 300) : ''}`;
    const answer = leaseBlocked
      ? '机器人会话一直被桌面端占用（同一个会话只能被一个进程写），已等待约 10 分钟仍写不进去。请在桌面端切走或关闭这个会话，或重启桌面端后再发一次。'
      : (useJson ? (jsonAnswer || fallback) : (out.trim() || fallback));
    if (code !== 0 && err) warn('DSH stderr: ' + err.trim().slice(0, 500));
    resolve(answer);
    pump();
  });

  child.on('error', (e) => {
    clearTimeout(killer);
    running = false;
    reject(e);
    pump();
  });
}

info('================ dsh-qq-bridge start ================');
info(`DSH 会话: ${state.sessionId || '(首次运行将新建)'}`);
info(`触发词: "${CFG.triggerWord}"  主人: ${CFG.masterQQ || '(未设)'}  授权群: ${CFG.allowedGroups.join(',') || '(无)'}  全员触发群: ${(CFG.openTriggerGroups || []).join(',') || '(无)'}  token限额: ${Object.keys(CFG.channelTokenBudget || {}).length ? JSON.stringify(CFG.channelTokenBudget) : '(无)'}  任务边界: ${Object.keys(CFG.channelScopes || {}).length ? Object.keys(CFG.channelScopes).join(',') : '(无)'}  授权私聊: ${CFG.allowedPrivateUsers.join(',') || '(无)'}`);
// 自检模式不连 NapCat（否则会短暂接上、把真消息也收进来）
if (process.argv.indexOf('--selftest') < 0) {
  connect();
  startProactive();
}

process.on('uncaughtException', (e) => error('未捕获异常: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => error('未处理的 rejection: ' + (e && e.stack || e)));
