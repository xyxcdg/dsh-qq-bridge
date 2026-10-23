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
// 【2026-10-22 老爹要求「听得懂语音」】QQ 语音 -> 文字（百炼 qwen3-asr-flash）。
const ASR = require('./asr.cjs');
// 【2026-10-22 老爹要求「像女儿、有点小脾气」】心情引擎：被夸/被凶/被敷衍/久没理 都会改变语气。
// 它只决定「怎么说」，绝不参与任何数据的生成（单测 test-mood.mjs 钉着边界）。
const MOOD = require('./mood.cjs');
// 【2026-10-22】自我状态：连续性（第几天/上次谁说话）、关系、未了心事、注意力、自我认知、疲惫。
// 它只影响语气与主动性，绝不参与事实生成（单测 test-self.cjs 钉着边界）。
const SELF = require('./self.cjs');

// 【2026-10-23 五官】眼（本地视觉模型看屏幕）、身体（电量/内存/CPU/前台窗口）、多模型探测。
// 全部可失败：拿不到就不注入，提示词里绝不写假数据。
const SENSES = require('./senses.cjs');
async function refreshBody() {
  try {
    const body = await SENSES.body();
    if (body && body.ok) {
      state.perception = state.perception || {};
      state.perception.body = body;
      state.perception.bodyAt = Date.now();
      saveState(state);
    }
  } catch (e) { warn('身体感知失败: ' + (e && e.message)); }
}
async function lookOnce(why) {
  try {
    const r = await SENSES.look();
    if (r && r.ok) {
      state.perception = state.perception || {};
      state.perception.lastSight = r.text;
      state.perception.lastSightAt = r.at || Date.now();
      saveState(state);
      info('我看见了（' + (why || '') + '）：' + r.text);
    } else { warn('看屏幕失败: ' + (r && r.error)); }
  } catch (e) { warn('看屏幕异常: ' + (e && e.message)); }
}
function sensesBlock(now) {
  const p = (state && state.perception) || {};
  const out = [];
  const body = p.body;
  if (body && now - Number(p.bodyAt || 0) < 30 * 60000) {
    const parts = [];
    if (body.battery != null) parts.push('电量 ' + body.battery + '%');
    if (body.freeMB != null && body.totalMB) parts.push('内存剩 ' + (body.freeMB / 1024).toFixed(1) + '/' + (body.totalMB / 1024).toFixed(1) + ' GB');
    if (body.cpu != null) parts.push('CPU ' + Math.round(body.cpu) + '%');
    if (body.gpu) parts.push('显卡 ' + String(body.gpu).replace('NVIDIA ', ''));
    if (body.net != null) parts.push(body.net ? '网络通' : '网络不通');
    if (body.fg) parts.push('前台窗口「' + String(body.fg).slice(0, 40) + '」');
    if (parts.length) out.push('【你的身体】' + parts.join('、') + '。（硬件读数，不是你的感觉）');
  }
  if (p.lastSight) {
    const min = Math.round((now - Number(p.lastSightAt || 0)) / 60000);
    out.push('【你上一次看见的（' + (min <= 1 ? '刚刚' : min + ' 分钟前') + '）】' + String(p.lastSight).slice(0, 120));
  }
  return out.join('\n');
}

const BASE = __dirname;
// 配置文件默认与 bridge.js 同目录；可用 QQ_BOT_CONFIG 指定别处。
const CFG_PATH = process.env.QQ_BOT_CONFIG || path.join(BASE, 'bridge.config.json');
let CFG;
try {
  CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
} catch (e) {
  console.error('读不到配置：' + CFG_PATH + '（' + (e && e.message) + '）');
  console.error('先复制 bridge.config.example.json 为 bridge.config.json 再改。');
  process.exit(1);
}
// 白名单统一成字符串：配置里写成数字也能用（运行时的 id 都是字符串）。
for (const k of ['allowedGroups', 'allowedPrivateUsers', 'activityGroups', 'openTriggerGroups']) {
  CFG[k] = (CFG[k] || []).map(String);
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
state.self = SELF.tick(SELF.ensure(state.self, Date.now()), Date.now(), {});
// 启动就把「自己」落盘一次：第几天/关系/心事要跨重启连续，不能只活在内存里。
try { saveState(state); } catch (_) {}

// ------------------------------------------------ 会话锁（用户硬要求）
// 「QQ 上的全部对话锁在同一个 DSH 会话里」= sessionLock.enabled。
// 开启时：
//   ① 若 state.json 还没有 sessionId，就用配置里指定的那个（而不是等到第一次
//      任务才惰性固化）；
//   ② 永久禁止自动新建会话（哪怕任务失败、哪怕会话不存在）。
// 这样"锁在一个会话"就是配置驱动、可审计的，而不是靠惰性逻辑碰巧成立。
// 【2026-10-08】一个渠道一个会话：业务群与主人私聊
// 必须是**两个不同的 DSH 会话**。理由：业务群里成员看得到机器人的回复，
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
// 用途：某个群锁一个专属会话（成员看到的是同一条持续对话线，不会每次换新的）。
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
  state.sessions[chKey] = sid; state.sessionId = sid;
  // 【用户要求 2026-10-23】群消息只保留 24 小时的上下文：记住这条会话的**出生时间**，
  // 到期就换代（新会话 = 只有新消息，旧内容靠 profile 注入的长期记忆）。
  state.sessionBornAt = state.sessionBornAt || {};
  if (!state.sessionBornAt[chKey]) state.sessionBornAt[chKey] = Date.now();
  saveState(state);
  info(`渠道 ${chKey} 的会话 = ${sid}（生于 ${new Date(state.sessionBornAt[chKey]).toLocaleString()}）`);
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
// 而退避已经是 12s→24s，结果 12:49:44 用户发的「大肥鱼你好」掉在缝里，一条回复都没有。
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
  // 【2026-10-22 活人感】同一段 prompt 每天说同样的话最像机器：按钟点给一个「此刻场景」，
  // 清早/中午/下午/傍晚/深夜各有各的话题重心，开场也被要求换。
  const hh = d.getHours();
  const scene = (hh >= 6 && hh < 10) ? '清早刚醒：可以问他睡得怎么样、今天有什么要紧事，别一上来就派活'
    : (hh >= 10 && hh < 14) ? '中午：适合问吃饭、提醒别饿着、顺便说一句自己刚在干嘛'
    : (hh >= 14 && hh < 18) ? '下午：适合随口一句、分享点小事、或者关心他手头的事顺不顺'
    : (hh >= 18 && hh < 22) ? '傍晚到晚上：可以问他今天怎么样、吃了什么，语气松一点'
    : '夜里：只说一句短的，催他早点睡，别拉长聊';
  // 【2026-10-22 自我状态】主动搭话不是定时播报：先看自己心里有没有挂着的事，有就顺着那件事开口。
  let selfPrompt = '';
  try {
    const th = SELF.pendingThought(state.self, Date.now());
    selfPrompt = SELF.selfBlock(state.self, chKey, Date.now());
    if (th) selfPrompt += '\n【你现在最想说的】' + th.text + '（可以围绕这个开口，也可以只借它的情绪，别生硬复述）';
  } catch (_) {}
  const fullPrompt = prompt + '\n' + selfPrompt + '\n【此刻场景】现在是 ' + hhmm + '，' + scene + '。别每天用同一个开头。';
  let ans;
  try {
    ans = await runDsh(fullPrompt, async () => {}, chKey, CFG.masterQQ);
  } catch (e) {
    warn('主动搭话生成失败: ' + e.message);
    return;
  }
  const acc = acceptProactive(ans, P.maxChars);
  if (!acc.ok) { info('主动搭话：放弃（' + acc.reason + '，原文 ' + JSON.stringify(String(ans).slice(0, 50)) + '）'); return; }
  if (!(await sendToMaster(acc.text))) return;
  // 【2026-10-22】说出口了：那件心事不再挂着（说过的话不该反复念叨）。
  try { SELF.markSpoken(state.self, Date.now()); } catch (_) {}
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

// ---------------------------------------------------------------- 称呼（用户要求 2026-10-22）
// 只有老爹本人的 QQ 叫「老爹」；其他人按 QQ 资料性别叫「哥哥」「姐姐」，
// 性别拿不到就叫「同学」。这件事不能交给模型猜，所以在这里一次定死。
// 提示词里凡是「跟着当前对话者变」的称呼都写成占位符 {ADDR}，由这里替换；
// 「老爹家的猫娘大肥鱼」这类归属表述不用占位符 —— 她是老爹家的，对谁都不变。
const ADDR = CFG.addressing || {};
const ADDR_MASTER = String(ADDR.master || '老爹');
const ADDR_DEFAULT = String(ADDR.default || '同学');
const ADDR_BY_SEX = ADDR.bySex || { male: '哥哥', female: '姐姐' };
const ADDR_TTL = Number(ADDR.cacheTtlMs) > 0 ? Number(ADDR.cacheTtlMs) : 7 * 24 * 3600 * 1000;

function withTimeout(promise, ms, tag) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('超时: ' + tag)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function sexOf(userId, groupId) {
  const uid = String(userId || '');
  if (!uid) return '';
  try {
    const cache = (state.sexCache = state.sexCache || {});
    const hit = cache[uid];
    if (hit && (hit.sex === 'male' || hit.sex === 'female') && Date.now() - Number(hit.at || 0) < ADDR_TTL) return hit.sex;
    const d = (groupId !== null && groupId !== undefined)
      ? await withTimeout(callApi('get_group_member_info', { group_id: Number(groupId), user_id: Number(uid), no_cache: false }), 4000, 'get_group_member_info')
      : await withTimeout(callApi('get_stranger_info', { user_id: Number(uid), no_cache: false }), 4000, 'get_stranger_info');
    const sex = String((d && d.sex) || '');
    if (sex === 'male' || sex === 'female') {
      cache[uid] = { sex, at: Date.now() };
      try { saveState(state); } catch (_) {}
      return sex;
    }
    info('QQ ' + uid + ' 的性别未知（sex=' + (sex || '空') + '）→ 按「' + ADDR_DEFAULT + '」称呼');
    return '';
  } catch (e) {
    info('查称呼性别失败（按「' + ADDR_DEFAULT + '」称呼，不影响任务）: QQ ' + uid + ' ' + (e && e.message));
    return '';
  }
}

// 语境：私聊看对方是谁；群里看「这条消息的发送者」是谁（群成员资料更可靠）。
async function resolveAddr(userId, groupId) {
  if (ADDR.enabled === false) return ADDR_DEFAULT;
  const uid = String(userId || '');
  if (uid && uid === String(CFG.masterQQ || '')) return ADDR_MASTER;
  const sex = await sexOf(uid, groupId);
  return ADDR_BY_SEX[sex] || ADDR_DEFAULT;
}

// ---------------------------------------------------------------- 会话换代（用户要求 2026-10-22）
// 「每一个会话上下文满了，就开一个新对话、删掉旧对话，新对话要记得读取记忆」。
// 判据用**本轮实际 inputTokens**（= 记忆注入 + 历史），不用会话文件大小：
// 它直接反映这一轮模型背了多重的东西。超过阈值 → 本轮回复照常发，然后解绑该渠道
// （下一条消息 bridge 会自动新建会话）并把旧会话移到 session-trash（可恢复，不硬删）。
// 新会话的记忆由 dsh-memory-evolve 按 profile 注入，换代本身不需要额外动作。
// 纪律：换代必须在**回复已经生成之后**做，绝不在半路丢消息；失败只记日志，不影响回复。
const RECYCLE = CFG.sessionRecycle || {};
const RECYCLE_ON = RECYCLE.enabled !== false;
const RECYCLE_MAX_INPUT = Number(RECYCLE.maxInputTokens) > 0 ? Number(RECYCLE.maxInputTokens) : 250000;
// 【2026-10-23】按时间换代：群消息只需要 24 小时的上下文，更早的由长期记忆承担。
const RECYCLE_MAX_AGE_H = Number(RECYCLE.maxAgeHours) > 0 ? Number(RECYCLE.maxAgeHours) : 24;
const RECYCLE_AGE_SCOPE = String(RECYCLE.ageScope || 'group');

function ageRecycleDue(chKey, now) {
  const born = (state.sessionBornAt || {})[chKey];
  if (!born) return false;
  const hours = (now - Number(born)) / 3600000;
  if (!(hours >= RECYCLE_MAX_AGE_H)) return false;
  if (RECYCLE_AGE_SCOPE === 'all') return true;
  return String(chKey).startsWith('group:');
}

// 老绑定没有出生时间：用会话目录的时间兜底（拿不到就记现在），否则它们永远不会按时间换代。
(function seedBornAt() {
  state.sessionBornAt = state.sessionBornAt || {};
  let changed = false;
  for (const k of Object.keys(state.sessions || {})) {
    if (state.sessionBornAt[k]) continue;
    let born = 0;
    try {
      const dir = sessionDirOf(state.sessions[k]);
      if (dir) born = fs.statSync(dir).birthtimeMs || fs.statSync(dir).mtimeMs || 0;
    } catch (_) {}
    state.sessionBornAt[k] = born > 0 ? Math.round(born) : Date.now();
    changed = true;
    info('补种会话出生时间：' + k + ' → ' + new Date(state.sessionBornAt[k]).toLocaleString());
  }
  if (changed) saveState(state);
})();

function sessionDirOf(sid) {
  if (!sid) return null;
  const roots = [SESS_ROOT, path.join(CFG.dshHome || '', 'sessions')].filter(Boolean);
  for (const root of roots) {
    let wsList;
    try { wsList = fs.readdirSync(root); } catch (_) { continue; }
    for (const ws of wsList) {
      const cand = path.join(root, ws, sid);
      try { if (fs.statSync(cand).isDirectory()) return cand; } catch (_) { /* 继续找 */ }
    }
  }
  return null;
}

function recycleChannel(chKey, sid, extra) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const trashRoot = RECYCLE.trashRoot || path.join(CFG.dshHome || path.join(process.env.USERPROFILE || '', '.dsh'), 'session-trash');
  let moved = null, moveErr = '';
  if (sid && RECYCLE.keepFiles !== false) {
    const dir = sessionDirOf(sid);
    if (dir) {
      try {
        const dest = path.join(trashRoot, 'recycle-' + stamp);
        fs.mkdirSync(dest, { recursive: true });
        const target = path.join(dest, path.basename(dir));
        fs.renameSync(dir, target);
        moved = target;
      } catch (e) { moveErr = e && e.message ? e.message : String(e); }
    } else {
      moveErr = '会话目录不在磁盘上（可能已被删）';
    }
  }
  delete state.sessions[chKey];
  if (state.sessionBornAt) delete state.sessionBornAt[chKey];
  state.recycled = state.recycled || {};
  state.recycled[chKey] = Object.assign({ at: Date.now(), from: sid || null, moved, moveErr }, extra || {});
  saveState(state);
  info('会话换代：' + chKey + ' ' + (sid || '(无)') + ' → 已解绑；旧会话 '
    + (moved ? '已移入 ' + moved : '未移动（' + (moveErr || 'keepFiles=false') + '）')
    + '；下一条消息会自动新建会话，记忆由 profile 注入');
  return { moved, moveErr };
}

// 桥接自己拼的固定话术（触发词提示、失败兜底、断线提示）里写着「老爹」，
// 对外发之前按当前对象换掉；只换称呼，不碰任何数据。
function personalize(text, addr) {
  const s = String(text == null ? '' : text);
  if (!addr || addr === ADDR_MASTER) return s;
  return s.replace(/老爹/g, addr);
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
// 【2026-10-08】业务群里的消息要留档（活动/考勤统计用）。
// 把 activityGroups 里**所有**消息（含图片/文件，哪怕没有触发词、哪怕没有文字）
// 原样追加到 activity/raw/YYYY-MM-DD.jsonl：一条一行 JSON，只追加、永不覆盖。
// 记录带 sender.card（群昵称）与每个消息段，学期末可回答「谁、什么时候、发了什么」。
const ACT_DIR = CFG.activityLogDir || path.join(BASE, 'activity');
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

// ---------------------------------------------------------------- 群聊搭话（活人感）
// 【2026-10-22 老爹要求「要有活人感」】在群里，机器人原来只有被点名（触发词/@）才开口，
// 群里聊得再热闹它也一声不吭 —— 那是「一个工具」，不是一个「在场的人」。
// 这里补一条克制的插话路径，四条硬门缺一不可：①只在自己被允许的群；
// ②不插正在跑任务的时候；③有安静期 + 每日上限 + 静默时段；④模型说 SKIP 就真的闭嘴。
// 判据是「少说但说得对」，不是「话多」—— 刷屏比沉默更像机器。
const groupRecent = new Map();
function noteGroupMsg(gid, name, text) {
  if (!gid) return;
  const arr = groupRecent.get(gid) || [];
  arr.push(String(name || '?') + '：' + String(text || '').slice(0, 120));
  while (arr.length > 6) arr.shift();
  groupRecent.set(gid, arr);
}

// 一次性问一句（不挂在任何会话上）：给搭话/判断这类「不需要历史」的调用用，
// 这样不会把「要不要说话」这种元指令写进群聊会话的历史里污染上下文。
// 【2026-10-22 实测】一次性调用同样会撞上模型侧断线（17:07 那次群搭话 5 次 TRANSPORT 全空），
// 而搭话是低风险小事 —— 空一次就再试一次，别因为网络抖一下就永远闭嘴。
async function runOnce(promptText, timeoutMs) {
  let last = '';
  for (let i = 0; i < 2; i++) {
    last = await runOnceAttempt(promptText, timeoutMs);
    if (String(last || '').trim()) return last;
    if (i === 0) { warn('一次性调用返回空（可能是 TRANSPORT 断线），1.5s 后重试一次'); await new Promise((r) => setTimeout(r, 1500)); }
  }
  return last;
}

function runOnceAttempt(promptText, timeoutMs) {
  return new Promise((resolve) => {
    const args = [CFG.dshBin, '--profile', CFG.dshProfile, '--json', String(promptText || '')];
    let child;
    try {
      child = spawn(CFG.nodeExe, args, {
        cwd: CFG.dshCwd,
        windowsHide: true,
        env: {
          ...process.env,
          DSH_HOME: CFG.dshHome,
          DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE || 'danger-full-access',
      // 【2026-10-22 实测】百炼（dashscope.aliyuncs.com）是国内端点，而本机 HTTPS_PROXY 指向
      // 127.0.0.1:7890：代理一挂，headless 请求就全变成 `dsh: TRANSPORT: Connection error.`
      // （18:32 连续三次，用户看到的是「本喵走神了一下下」）。这里显式把国内模型端点排除出代理，
      // 其它外网仍按老爹的要求走节点。
      NO_PROXY: [process.env.NO_PROXY, process.env.no_proxy, 'dashscope.aliyuncs.com', 'aliyuncs.com', 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(','),
          DSH_TOOLS_MODE: process.env.DSH_TOOLS_MODE || 'ptc',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) { resolve(''); return; }
    let buf = '', finalText = '', textAcc = '', done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve((finalText || textAcc || '').trim()); };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(); }, timeoutMs || 180000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const ln = buf.slice(0, i); buf = buf.slice(i + 1);
        let ev; try { ev = JSON.parse(ln); } catch (_) { continue; }
        if (ev.type === 'text' && typeof ev.text === 'string') textAcc += ev.text;
        else if (ev.type === 'final' && typeof ev.text === 'string') finalText = ev.text;
      }
    });
    child.stderr.on('data', () => {});
    child.on('close', finish);
    child.on('error', finish);
  });
}

let chimeBusy = false;
async function maybeChime(ctx) {
  const G = CFG.groupChime || {};
  if (G.enabled !== true) return;
  // 【2026-10-22】同一时刻只允许一次搭话评估：两个 dsh 并发打同一个模型端点，
  // 实测更容易撞上 TRANSPORT（17:07 那次恰好和别的调用撞在一起）。
  if (chimeBusy) { info('群搭话：上一次评估还没结束，这次跳过'); return; }
  const groups = (G.groups || []).map(String);
  if (!ctx.groupId || !groups.includes(String(ctx.groupId))) return;
  if (running || queue.length > 0) return;
  const text = String(ctx.text || '').trim();
  if (text.length < 2) return;
  // 冲着别人说的话（引用别人 / @ 别人）就别插嘴 —— 人也不会在这时候抢话
  try {
    const segs = Array.isArray(ctx.evt && ctx.evt.message) ? ctx.evt.message : [];
    const directed = segs.some((s) => s && s.type === 'reply') ||
      segs.some((s) => s && s.type === 'at' && String((s.data || {}).qq || '') !== String(CFG.selfQQ || ''));
    if (directed) return;
  } catch (_) {}
  const st = (state.chime = state.chime || {});
  const day = new Date().toISOString().slice(0, 10);
  if (st.day !== day) { st.day = day; st.count = 0; }
  if (Number(st.count || 0) >= Number(G.maxPerDay || 2)) return;
  const now = Date.now();
  if (now - Number(st.lastAt || 0) < Number(G.minGapMs || 2400000)) return;
  const h = new Date().getHours();
  const qh = Array.isArray(G.quietHours) ? G.quietHours : [23, 8];
  const inQuiet = qh[0] <= qh[1] ? (h >= qh[0] && h < qh[1]) : (h >= qh[0] || h < qh[1]);
  if (inQuiet) return;
  const masterSaid = String(ctx.userId) === String(CFG.masterQQ || '');
  const kw = (Array.isArray(G.keywords) ? G.keywords : []).some((k) => k && text.includes(k));
  if (!masterSaid && !kw) return;
  const chance = Number.isFinite(Number(G.chance)) ? Number(G.chance) : 0.15;
  if (Math.random() > chance) { info('群搭话：掷骰未中（' + chKeyOf(ctx.groupId) + '）'); return; }
  st.lastAt = now; st.count = Number(st.count || 0) + 1; saveState(state);
  chimeBusy = true;
  try {
  // —— 从这里到底部都在 chimeBusy 保护内 ——
  const who = (ctx.evt && ctx.evt.sender && (ctx.evt.sender.card || ctx.evt.sender.nickname)) || String(ctx.userId);
  const recent = (groupRecent.get(String(ctx.groupId)) || []).slice(-5).join('\n');
  // 【用户要求 2026-10-22】群里插话时也要知道正在说话的是谁，别把人叫错。
  const chimeAddr = await resolveAddr(ctx.userId, ctx.groupId);
  const prompt = '【群聊搭话·可选的一次】（正在说话的人是「' + chimeAddr + '」：称呼他/她时用这个称呼，别把人叫成「老爹」）\n群里的最近几句：\n' + (recent || who + '：' + text) +
    '\n\n' + String(G.prompt || '');
  let ans = '';
  try { ans = await runOnce(prompt, Number(G.modelTimeoutMs) || 180000); }
  catch (e) { warn('群搭话模型失败: ' + (e && e.message)); return; }
  const line = String(ans || '').trim().replace(/\s+/g, ' ');
  if (!line || /^SKIP\b/i.test(line) || line.length > Number(G.maxChars || 40)) {
    info('群搭话：这次不开口（' + (line ? line.slice(0, 14) : '空') + '）');
    return;
  }
  try {
    await callApi('send_msg', { message_type: 'group', group_id: Number(ctx.groupId), message: line });
    info('群搭话已发送 -> group:' + ctx.groupId + '（' + line.length + ' 字）');
  } catch (e) { warn('群搭话发送失败: ' + e.message); }
  } finally { chimeBusy = false; }
}
function chKeyOf(gid) { return 'group:' + String(gid || ''); }
const seen = new Set(); // 去重，防 NapCat 重推
let lastIncomingText = '';

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
  // 【2026-10-20】有图就先落盘，再把路径拼进任务正文（只发图没文字也算任务）。
  let imageNote = '';
  try {
    if (Array.isArray(evt.message) && evt.message.some((s) => s && s.type === 'image')) {
      const imgs = await resolveImages(evt.message);
      if (imgs.length) imageNote = imgs.map((q) => '[图片] ' + q).join('\n');
    }
  } catch (e) { warn('图片处理失败: ' + (e && e.message)); }
  // 【2026-10-22 老爹要求】语音也当正文：转成文字拼进任务，转不动就明说「没听清」
  // （以前 record 段直接丢，只有语音的消息会被当空消息静默忽略）。
  let voiceNote = '';
  try {
    if (Array.isArray(evt.message) && evt.message.some((s) => s && s.type === 'record')) {
      const vs = await resolveVoices(evt.message);
      if (vs.length) voiceNote = vs.map((v) => '[语音] ' + (v.text || '（没听清）')).join('\n');
    }
  } catch (e) { warn('语音处理失败: ' + (e && e.message)); }
  lastIncomingText = text || '';
  // 【用户要求 2026-10-12】@机器人 也作为触发方式（已开放的群里，@本机器人即可下命令）
  const atSelf = Array.isArray(evt.message) && evt.message.some((s) => s && s.type === 'at' && String((s.data || {}).qq || '') === String(CFG.selfQQ || ''));
  // 空文本必须留痕：以前这里是静默 return，导致"消息格式不是我预期的"与"机器人没收到"
  // 在日志里长得一模一样（同一个教训：静默丢弃＝假装正常）。
  if (!text && !imageNote && !voiceNote) { warn(`收到空文本消息，已忽略（QQ ${userId}，message 类型=${Array.isArray(evt.message) ? 'array' : typeof evt.message}）`); return; }

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
      // 【2026-10-20 主人要求】allowedPrivateUsers 里的人（例如饶同学）也允许对话。
      const allowUsers = (CFG.allowedPrivateUsers || []).map(String);
      const userAllowed = String(userId) === master || allowUsers.includes(String(userId));
      if (!userAllowed) {
        info(`非主人 QQ（${userId}）的消息不触发命令，已忽略`); return;
      }
    } else {
      info(`群 ${groupId} 在 openTriggerGroups 白名单：全体成员可用「${CFG.triggerWord}」下命令（QQ ${userId}）`);
    }
  }

  const trigger = CFG.triggerWord;
  // 【2026-10-20】支持别名触发词（例如「小鱼」），主人要求别人带词才能用。
  const triggerWords = [trigger].concat(Array.isArray(CFG.triggerAliases) ? CFG.triggerAliases : []);
  const raw = (text + (imageNote ? '\n' + imageNote : '') + (voiceNote ? '\n' + voiceNote : '')).trim();
  let isCmd = false;
  let rest = raw;
  {
    for (const tw of triggerWords) {
      if (!tw) continue;
      const lt = String(tw).toLowerCase();
      const li = raw.toLowerCase();
      if (lt && li.startsWith(lt)) { isCmd = true; rest = raw.slice(String(tw).length); break; }
      const idx = lt ? li.indexOf(lt) : -1;
      if (idx >= 0) { isCmd = true; rest = raw.slice(0, idx) + ' ' + raw.slice(idx + String(tw).length); break; }
    }
    rest = rest.replace(/^[\s，,。.!！?？:：、~～\-]+/, '').trim();
  }
  // 【用户要求 2026-10-12】@机器人 也算触发（任务正文 = 去掉 @ 后的文字，extractText 本就不含 at 段）
  if (!isCmd && atSelf) { isCmd = true; }
  // 私聊默认【不要求触发词】：直接说话就是任务（用户要求"在 QQ 里颁发任务"）。
  // 群里仍必须带触发词（否则群里任何闲聊都会被当任务）。
  if (groupId !== null) {
    try { noteGroupMsg(groupId, (evt.sender && (evt.sender.card || evt.sender.nickname)) || userId, text); } catch (_) {}
  }
  if (groupId !== null && !isCmd && !CFG.groupWatch) {
    info(`群 ${groupId} 消息不含触发词，忽略`);
    // 【2026-10-22 活人感】不是命令，也不代表要装作不在场。是否真开口由 maybeChime 的四道门决定。
    maybeChime({ groupId, userId, text: raw, evt }).catch((e) => warn('群搭话失败: ' + (e && e.message)));
    return;
  }
  const isMasterUser = String(userId) === String(CFG.masterQQ);
  const privateNeedsTrigger = (CFG.privateRequireTrigger === true) || (CFG.privateTriggerForOthers === true && !isMasterUser);
  if (groupId === null && privateNeedsTrigger && !isCmd) {
    // 【2026-10-19 实测】这里原来是静默 return —— 主人发了句「能」/「没回复」，
    // 机器人一个字都不回，用户看到的就是「坏了」。改成：给一句提示（5 分钟最多一次）。
    info('私聊消息不含触发词（privateRequireTrigger=true）');
    // 【用户要求 2026-10-22】提示话术里写着「老爹」，按发消息的人换成实际称呼再发。
    const hint = personalize((CFG.chatStyle && CFG.chatStyle.triggerHint) || '', await resolveAddr(userId, groupId));
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
  // 在群里下的命令 → 结果发在群里（成员要能看到）；
  // 私聊下的命令 → 结果只走私聊。
  // 隔离不靠「把群里的结果偷偷发去私聊」，而靠**不同渠道用不同的 DSH 会话**。
  // 想强制全部走私聊，把 bridge.config.json 的 replyMode 设成 "private"。
  const ownerTarget = { type: 'private', id: Number(CFG.masterQQ || userId) };
  const originTarget = groupId ? { type: 'group', id: groupId } : { type: 'private', id: userId };
  const chKey = groupId ? 'group:' + groupId : 'private:' + userId;
  const replyTarget = (CFG.replyMode === 'private') ? ownerTarget : originTarget;
  // 【2026-10-19】记下这条渠道最后一次「人来消息」的时间：主动搭话靠它判「安静够久了没」。
  state.lastUserAt = state.lastUserAt || {};
  const prevUserAt = Number(state.lastUserAt[chKey] || 0);
  state.lastUserAt[chKey] = Date.now();

  // 【2026-10-22 老爹要求「活人感更丰富，像女儿，有点小脾气」】
  // 心情：被夸→开心/得意，被凶→委屈/炸毛，被哄→消气；久没理→黏人抱怨。
  // 纪律：只影响语气；任何分支都不许改动数据（人格卡的「三条硬边界」写着）。
  const PM = CFG.personaMood || {};
  if (PM.enabled !== false) {
    try {
      const now = Date.now();
      const sig = MOOD.detect(raw);
      state.moods = state.moods || {};
      const bottom = MOOD.nextMood(state.moods[chKey], sig, now);
      // 好久没理本喵：3~24 小时的空档，六成概率先黏一句（再久就当隔天了，不闹）。
      const gap = prevUserAt ? (now - prevUserAt) : 0;
      if (bottom.mood === 'calm' && gap >= 3 * 3600000 && gap <= 24 * 3600000 && Math.random() < 0.6) {
        bottom.mood = 'clingy'; bottom.intensity = 1; bottom.since = now; bottom.cause = '隔了 ' + Math.round(gap / 3600000) + ' 小时没理人家';
      }
      state.moods[chKey] = bottom;
      if (sig.scold > 0 || sig.tease > 0) {
        state.grievances = state.grievances || {};
        state.grievances[chKey] = MOOD.addGrievance(state.grievances[chKey], raw, now, Number(PM.maxGrievances) || 3);
      }
      saveState(state);
      info('心情 ' + chKey + ': ' + bottom.mood + '/' + bottom.intensity + (bottom.cause ? '（' + bottom.cause + '）' : ''));
    } catch (e) { warn('心情更新失败: ' + (e && e.message)); }

  // 【2026-10-22】把这条消息喂给「自己」：关系亲近度、注意力、被纠正的自我认知、疲惫。
  try {
    state.self = SELF.observe(state.self, {
      chKey: chKey,
      name: (evt.sender && (evt.sender.card || evt.sender.nickname)) || userId,
      text: raw,
      now: Date.now(),
    });
    saveState(state);
  } catch (e) { warn('自我状态更新失败: ' + (e && e.message)); }
  }

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
        await send(`喵呜～本群的 token 额度已经用完啦（已用 ${used} / 上限 ${budget}），本喵先停下，等管理员给本群加额度再继续喵～`);
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
    // 【2026-10-22 活人感】固定毫秒开口最像机器。人开口是「有时快有时慢」，
    // 所以在 ackDelayMs 上下浮动 35%，再叠 0~900ms 抖动。
    const jittered = Math.max(600, Math.round(ackDelayMs * (0.65 + Math.random() * 0.7) + Math.random() * 900));
    ackTimer = setTimeout(() => {
      send(pickRandom(ackPhrases) || '嗯…').catch(() => {});
    }, jittered);
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

  // 【用户要求 2026-10-22】这条消息该叫什么：老爹本人叫「老爹」，其他人按 QQ 资料性别叫
  // 「哥哥」/「姐姐」，查不到就叫「同学」。查询失败或超时都退回默认值，绝不阻塞任务。
  const addr = await resolveAddr(userId, groupId);
  let answer;
  try {
    answer = await runDsh(task, send, chKey, userId, addr);
  } catch (e) {
    // 【2026-10-22】内部错误只进日志；给老爹的永远是一句像人的话（旧版会把英文报错原样发出）。
    error('DSH 执行失败（只进日志）: ' + e.message);
    const fp = (CFG.chatStyle && Array.isArray(CFG.chatStyle.failPhrases) && CFG.chatStyle.failPhrases.length) ? CFG.chatStyle.failPhrases : ['喵呜…本喵卡住了，没办成。'];
    answer = personalize(pickRandom(fp), addr);
  } finally {
    clearInterval(nudge);
    // 结果已经出来了：把还没说出口的「嗯…让我看看」取消掉，别在答案之后再补一句。
    if (ackTimer) clearTimeout(ackTimer);
  }
  // runDsh 在"锁死会话但会话不存在"等情况下返回的是 {skipped, reason} 而不是字符串；
  // 不特判就会把 "[object Object]" 当成回复发出去。
  if (answer && typeof answer === 'object') {
    // 会话文件不见了这类事，用户只需要知道「线断了」+ 一句怎么办，不需要看路径与内部原因。
    warn('本次未执行（只进日志）: ' + (answer.reason || JSON.stringify(answer)));
    answer = personalize('喵呜…本喵这条对话线好像断掉了，要老爹让本喵重新开一条吗喵？', addr);
  }
  if (typeof answer !== 'string') answer = String(answer == null ? '喵…本喵没说出话来。' : answer);

  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  info(`任务完成，用时 ${secs}s，输出 ${answer.length} 字`);

  // 【用户要求 2026-10-19】像人一样回：能一句话就一句话，内容多就拆成几条短消息，
  // 名单/表格这类结构化内容整段发（拆了就没法抄）。切分逻辑在 humanize.cjs，有单测钉着。
  const splitCfg = (CS && CS.bubbleSplit) ? CS.bubbleSplit : CS;
  const bubbles = planBubbles(answer, splitCfg);
  info(`回复排版: ${bubbles.length} 条（${bubbles.map((b) => b.length).join('/')} 字）`);
  const gapRaw = Number((splitCfg || {}).gapMs);
  const gap = Number.isFinite(gapRaw) ? gapRaw : 650;
  // 【2026-10-22 活人感】条与条之间的停顿按「这条有多长」算（打字速度 ~60ms/字），
  // 再叠 ±30% 抖动：短句几乎立刻跟上，长句要喘口气，跟真人打字节奏一致。
  const typingRaw = Number((splitCfg || {}).typingMsPerChar);
  const typingMs = Number.isFinite(typingRaw) ? typingRaw : 60;
  const gapFor = (t) => Math.max(300, Math.min(3200, Math.round(String(t || '').length * typingMs * (0.7 + Math.random() * 0.6))));
  const midChance = Number(CS && CS.stickerMidChance);
  let midStickerSent = false;
  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) await sleep(gapFor(bubbles[i - 1]) + Math.random() * 200);
    await send(bubbles[i]);
    // 偶尔在两条之间插一张表情，像人聊天时随手甩个图（只插一次，且只在真的分条时）
    if (!midStickerSent && bubbles.length >= 2 && i === 0 && Number.isFinite(midChance) && Math.random() < midChance) {
      midStickerSent = true;
      await sendSticker(send, 'mid');
    }
  }

  // 【2026-10-22】记下这次说过的话（下一轮用来反重复）。
  try {
    state.lastReply = state.lastReply || {};
    state.lastReply[chKey] = bubbles.join(' / ').slice(0, 120);
    saveState(state);
  } catch (_) {}

  // 【用户要求 2026-10-19】语音回复：偶尔用"说"的（默认只在私聊，群里不打招呼就发语音太怪）。
  {
    const V = CFG.voice || {};
    const chOver = (V.chanceByChannel && Number.isFinite(Number(V.chanceByChannel[chKey]))) ? Number(V.chanceByChannel[chKey]) : null;
    const chance = chOver !== null ? chOver : Number(V.replyChance);
    const allowed = V.enabled === true && (!V.privateOnly || String(chKey).indexOf('private:') === 0);
    if (allowed && Number.isFinite(chance) && Math.random() < chance) {
      await sendVoice(send, answer, 'reply');
    }
  }

  // 【主人要求 2026-10-20】群里也能甩原声彩蛋：语音可以不开，但气氛对了就插一条"真的她"
  {
    const V = CFG.voice || {};
    const isGroup = String(chKey).indexOf('group:') === 0;
    if (isGroup && V.eggGroupsEnabled !== false) {
      const gchance = Number(V.eggGroupChance ?? 0.25);
      if (Number.isFinite(gchance) && Math.random() < gchance) {
        await maybeOriginalClip(send, 'group', answer);
      }
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

// ---------------------------------------------------------------- 图片接收
// 【2026-10-20 主人要求】QQ 发来的图片要让 Agent 真的能「看到」：
// 以前只把文字喂进去，图片段直接被丢，于是回一句「看不到图」。
// 现在：取本地文件 → 复制到 inbox/<日期>/ → 把绝对路径写进任务文本（Agent 用 read_image 读）。
const INBOX_DIR = path.join(BASE, 'inbox');

async function resolveImages(message) {
  const segs = Array.isArray(message) ? message.filter((s) => s && s.type === 'image') : [];
  if (!segs.length) return [];
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dir = path.join(INBOX_DIR, day);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const f = (segs[i].data && (segs[i].data.file || segs[i].data.url)) || '';
    if (!f) continue;
    try {
      const r = await callApi('get_image', { file: f });
      const local = r && (r.file || (r.data && r.data.file));
      if (!local || !fs.existsSync(local)) { warn('图片取本地路径失败: ' + String(f).slice(0, 60)); continue; }
      const ext = (path.extname(local) || '.jpg').toLowerCase();
      const dst = path.join(dir, String(Date.now()) + '-' + i + ext);
      try { fs.copyFileSync(local, dst); } catch (_) { out.push(local); continue; }
      out.push(dst);
    } catch (e) { warn('图片下载失败: ' + (e && e.message)); }
  }
  return out;
}

// ---------------------------------------------------------------- 语音接收
// 【2026-10-22 老爹要求】QQ 语音要让 Agent 真的能「听懂」：
// record 段 -> get_record 取本地文件（指定 wav，NapCat 会解 silk）-> 复制到 inbox -> ASR 转文字。
// 拿不到/转不动都不静默：调用方会把「（没听清）」拼进正文，日志里也有具体原因。
async function resolveVoices(message) {
  const segs = Array.isArray(message) ? message.filter((s) => s && s.type === 'record') : [];
  if (!segs.length) return [];
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const dir = path.join(INBOX_DIR, day);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const out = [];
  for (let i = 0; i < segs.length; i++) {
    const d = segs[i].data || {};
    const f = d.file || d.path || d.url || '';
    if (!f) { warn('语音段没有文件字段'); out.push({ text: '' }); continue; }
    try {
      const r = await callApi('get_record', { file: f, out_format: 'wav' });
      const local = r && (r.file || (r.data && r.data.file));
      if (!local || !fs.existsSync(local)) { warn('语音取本地路径失败: ' + String(f).slice(0, 60)); out.push({ text: '' }); continue; }
      const dst = path.join(dir, String(Date.now()) + '-' + i + (path.extname(local) || '.wav'));
      try { fs.copyFileSync(local, dst); } catch (_) {}
      const target = fs.existsSync(dst) ? dst : local;
      const txt = await ASR.transcribe(target, { dshHome: CFG.dshHome });
      info('语音转文字成功（' + String(txt).length + ' 字）: ' + String(txt).slice(0, 40));
      out.push({ file: target, text: txt });
    } catch (e) {
      warn('语音转写失败: ' + (e && e.message));
      out.push({ text: '' });
    }
  }
  return out;
}

// 按时清理：inbox 里超过 7 天的目录整目录删掉（默认保留 7 天）
function cleanInbox(maxDays) {
  const days = Number(maxDays) > 0 ? Number(maxDays) : 7;
  try {
    if (!fs.existsSync(INBOX_DIR)) return 0;
    const cutoff = Date.now() - days * 86400000;
    let n = 0;
    for (const name of fs.readdirSync(INBOX_DIR)) {
      const full = path.join(INBOX_DIR, name);
      try {
        const st = fs.statSync(full);
        if (st.isDirectory() && st.mtimeMs < cutoff) { fs.rmSync(full, { recursive: true, force: true }); n++; }
      } catch (_) {}
    }
    if (n) info('清理 inbox 旧图: ' + n + ' 个目录（>' + days + ' 天）');
    return n;
  } catch (_) { return 0; }
}


// 【2026-10-22】一次性会话清理：群搭话（runOnce）每次都会新建一个会话目录，
// 而那些会话谁也不会再用。这里只删「24 小时没动过 + 不在任何渠道绑定里」的目录，
// 保护名单 = state.sessions 的所有值 + sessionLock 的固定/钉死会话 + state.sessionId。
// 判据：只按年龄与绑定判，绝不按目录名猜。
function cleanOneShotSessions(maxDays) {
  const days = Number(maxDays) > 0 ? Number(maxDays) : 1;
  const root = path.join(CFG.dshHome, 'sessions-qqbot');
  const keep = new Set();
  try { Object.keys(state.sessions || {}).forEach((k) => keep.add(String(state.sessions[k]))); } catch (_) {}
  try {
    if (state.sessionId) keep.add(String(state.sessionId));
    const lock = CFG.sessionLock || {};
    if (lock.sessionId) keep.add(String(lock.sessionId));
    Object.keys(lock.pinned || {}).forEach((k) => keep.add(String(lock.pinned[k])));
  } catch (_) {}
  const cutoff = Date.now() - days * 86400000;
  let n = 0;
  try {
    for (const ws of fs.readdirSync(root)) {
      const wsDir = path.join(root, ws);
      let st; try { st = fs.statSync(wsDir); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      for (const sid of fs.readdirSync(wsDir)) {
        if (!/^session-/.test(sid)) continue;
        if (keep.has(sid)) continue;
        const full = path.join(wsDir, sid);
        try {
          const s = fs.statSync(full);
          if (s.isDirectory() && s.mtimeMs < cutoff) { fs.rmSync(full, { recursive: true, force: true }); n++; }
        } catch (_) {}
      }
    }
  } catch (_) { return 0; }
  if (n) info('清理一次性会话: ' + n + ' 个（>' + days + ' 天且未绑定）');
  return n;
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
  const dir = STK.dir || path.join(BASE, 'stickers');
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
    await send([{ type: 'record', data: { file: 'base64://' + require('fs').readFileSync(r.file).toString('base64') } }]);
    info('已发送语音(' + kind + '): ' + path.basename(r.file) + '（' + r.engine + '）');
    // 【2026-10-19】原声彩蛋：按概率再补一条她从游戏里说过的原声（不是合成，是真的她）
    try {
      await maybeOriginalClip(send, kind, text);
    } catch (_) {}
    return true;
  } catch (e) {
    warn('语音发送失败(' + kind + '): ' + e.message);
    return false;
  }
}


// ---------------------------------------------------------------- 原声彩蛋
// 语料来自鉴赏模式录音 → demucs 去 BGM → 说话人相似度筛选后的干净片段。
// 纪律：只发最近没发过的那批，且频率低（默认 25%），否则会变成复读机。
function moodOf(text) {
  const t = String(text || '');
  if (/[!！]|喵～|喵呜|呀|啦|嘿嘿|♪|w{2,}/.test(t)) return 'excited';
  if (/抱歉|对不起|呜|哭|难过|算了|嗯…|.../.test(t)) return 'soft';
  return 'normal';
}

const EGG_MOOD_LEX = {
  tease:  { w: 3, re: /变态|妹控|色狼|色色|坏蛋|讨厌|调戏|欺负|打屁股|轻浮/ },
  care:   { w: 3, re: /吃饭|吃了没|睡觉|早点睡|晚安|熬夜|困|累不累|休息|身体|别太拼/ },
  sweet:  { w: 2, re: /可爱|喜欢你|爱你|厉害|好看|真棒|萌|抱住|贴贴|摸摸/ },
  thanks: { w: 3, re: /谢谢|多谢|感谢|辛苦了|麻烦你/ },
  food:   { w: 3, re: /冰淇淋|冰激凌|甜|好吃|零食|请客|奶茶|蛋糕/ },
  game:   { w: 3, re: /游戏|开黑|上分|排位|打一把|联机/ },
  shy:    { w: 3, re: /紧张|害羞|脸红|尴尬|不好意思|心跳/ },
  sad:    { w: 3, re: /难过|压力|焦虑|emo|烦恼|心事|不开心|委屈|想哭|崩溃/ },
  lie:    { w: 3, re: /骗人|骗我|敷衍|糊弄|说谎|不信你|真的假的/ },
  bored:  { w: 2, re: /无聊|没人陪|在干嘛|干嘛呢|发呆|陪我/ },
  plot:   { w: 3, re: /间谍|潜入|计划|风头|搞事/ },
};

function moodScore(text, lex) {
  const L = (lex && Object.keys(lex).length) ? lex : EGG_MOOD_LEX;
  const said = String(text || '');
  const out = {};
  for (const k of Object.keys(L)) {
    const v = L[k] || {};
    let s = 0;
    try { if (v.re && new RegExp(v.re).test(said)) s += Number(v.w || 2); } catch (_) {}
    for (const w of (Array.isArray(v.words) ? v.words : [])) { if (w && said.indexOf(w) >= 0) s += 1; }
    if (s > 0) out[k] = s;
  }
  return out;
}

function scoreEggRules(text, rules, lex) {
  const ms = moodScore(text, lex);
  const said = String(text || '');
  let best = null;
  for (const r of rules) {
    if (!r || !Array.isArray(r.eggs)) continue;
    let score = 0;
    if (r.mood && ms[r.mood]) score += ms[r.mood] + 1;
    const toks = Array.isArray(r.match) ? r.match : [];
    for (const k of toks) {
      if (!k) continue;
      if (String(k).indexOf('re:') === 0) { try { if (new RegExp(String(k).slice(3)).test(said)) score += 1; } catch (_) {} }
      else if (said.indexOf(k) >= 0) score += 1;
    }
    if (score <= 0) continue;
    if (score < Number(r.minScore || 1)) continue;
    if (!best || score > best.score) best = { rule: r, score: score, mood: r.mood || 'kw' };
  }
  return best;
}

async function maybeOriginalClip(send, kind, text) {
  const V = CFG.voice || {};
  const dir = V.eggDir || V.originalDir;
  if (!dir || !(Number(V.eggChance ?? V.originalChance) > 0)) return false;
  // 频率闸：概率 + 每日上限 + 最小间隔（彩蛋变复读机就不好玩了）
  const now = Date.now();
  const e = state.eggs || {};
  if (e.day !== new Date(now).toISOString().slice(0, 10)) { e.day = new Date(now).toISOString().slice(0, 10); e.count = 0; }
  if (Number(e.count) >= Number(V.eggDailyCap || 6)) return false;
  if (e.lastAt && now - Number(e.lastAt) < Number(V.eggMinGapMs || 600000)) return false;
  // 关键词彩蛋：她说过的话里能对上的，优先按内容回（比随机更有"她在接话"的感觉）
  try {
    const rules = Array.isArray(V.eggRules) ? V.eggRules : [];
    const said = String(lastIncomingText || '');
    const hit = scoreEggRules(said, rules, V.eggMoods);
    if (hit) {
      const cand = hit.rule.eggs.map((x) => path.join(dir, x)).filter((p) => fs.existsSync(p));
      if (cand.length) {
        const abs0 = cand[Math.floor(Math.random() * cand.length)];
        await send([{ type: 'record', data: { file: 'file:///' + abs0.replace(/\\/g, '/') } }]);
        e.count = Number(e.count || 0) + 1; e.lastAt = Date.now();
        e.recent = [path.basename(abs0)].concat(e.recent || []).slice(0, 20);
        state.eggs = e; saveState(state);
        info('已发送氛围彩蛋(' + kind + '): ' + path.basename(abs0) + '（氛围=' + hit.mood + ' 分=' + hit.score + '）');
        return true;
      }
    }
  } catch (_) {}
  if (Math.random() >= Number(V.eggChance ?? V.originalChance)) return false;
  let files = [];
  try {
    files = require('fs').readdirSync(dir).filter((x) => /\.(silk|wav)$/i.test(x));
  } catch (_) { return false; }
  if (!files.length) return false;
  const recent = Array.isArray(e.recent) ? e.recent : [];
  const fresh = files.filter((x) => recent.indexOf(x) < 0);
  let pool = fresh.length ? fresh : files;
  // 按回复情绪挑同情绪的彩蛋（情绪来自文件特征表，不靠 ASR）
  try {
    const meta = JSON.parse(require('fs').readFileSync(path.join(dir, 'eggs.json'), 'utf8'));
    const want = moodOf(String(lastIncomingText || '') + ' ' + String(text || ''));
    const byMood = meta.filter((m) => m.mood === want).map((m) => m.file.replace(/\.wav$/, '.silk'));
    const subset = pool.filter((x) => byMood.indexOf(x) >= 0);
    if (subset.length) pool = subset;
  } catch (_) {}
  // 彩蛋偏短：一两秒的「切～」比五秒的整句更像俏皮的插话
  if (V.eggPreferShort !== false) {
    const short = pool.filter((x) => !/egg-0[1-4]/.test(x));
    if (short.length) pool = Math.random() < 0.7 ? short : pool;
  }
  const pick = pool[Math.floor(Math.random() * pool.length)];
  const abs = path.join(dir, pick);
  try {
    // silk 直接给路径（wav 会被 NapCat 转成 AMR，音质一下就"机械"了）
    await send([{ type: 'record', data: { file: 'file:///' + abs.replace(/\\/g, '/') } }]);
  } catch (err) {
    warn('原声彩蛋发送失败: ' + err.message);
    return false;
  }
  e.count = Number(e.count || 0) + 1;
  e.lastAt = now;
  e.recent = [pick].concat(recent).slice(0, 20);
  state.eggs = e;
  saveState(state);
  info('已发送原声彩蛋(' + kind + '): ' + pick + '（今日第 ' + e.count + ' 条）');
  return true;
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
  if (!s) s = '唔…';
  while (s.length > size) { out.push(s.slice(0, size)); s = s.slice(size); }
  out.push(s);
  return out;
}

// ---------------------------------------------------------------- 调 DSH（固定会话）
// 【2026-10-09】按渠道的 token 上限（键是 chKey，如 group:100000001）。
// 【2026-10-22】CLI 的 --json stdout 与会话日志用了两套名字：
//   stdout： {"type":"status","phase":"turn_end","reason":{...}}
//   日志：   {"type":"turn/end","data":{"reason":{...}}}
// 只认一种就会静默漏事件（实测代价：重试逻辑从未生效 + 退出码漏给用户）。
function isTurnEndEvent(ev) {
  return ev && (ev.type === 'turn/end' || (ev.type === 'status' && ev.phase === 'turn_end'));
}
function turnEndReason(ev) {
  if (!ev) return null;
  return (ev.data && ev.data.reason) || ev.reason || null;
}

function channelBudget(chKey) {
  const b = (CFG.channelTokenBudget || {})[chKey];
  return typeof b === 'number' && b > 0 ? b : 0;
}
let running = false;
const queue = [];

// 【2026-10-22 老爹要求「插队式对话」】以前一次只跑一个任务：一条长任务跑 40 秒，
// 这期间老爹发的每一句都得干等，看起来就像「不理人」。现在：新消息进来时，若当前
// 任务已经跑了 PREEMPT_AFTER_MS 以上，就把它挂起（结束这一轮、排回队尾重跑），
// 先把新消息答了。
// 三条边界：①4 秒内连发不打断（一次输入被拆成三条时不会自己踩自己）；
//          ②同一个任务最多被插队 2 次，第 3 次不再打断（否则长任务永远做不完）；
//          ③被打断的那一轮绝不回「没答上」——用户根本没看见它。
const PREEMPT_AFTER_MS = Number(CFG.preemptAfterMs) > 0 ? Number(CFG.preemptAfterMs) : 4000;
const MAX_PREEMPT = Number.isFinite(Number(CFG.maxPreempt)) ? Math.max(0, Number(CFG.maxPreempt)) : 2;
let current = null; // { item, child, startedAt }

// 【2026-10-07】桌面端打开机器人会话时会持有内核写租约（session.lock），桥接的 CLI 会拿到
// already-owned 报错。这是「同一会话只能被一个进程写」的互斥，不是故障 ⇒ 不当作任务失败：
// 把任务放回队首、按节奏自动重试，等桌面端释放；期间按速率上限在 QQ 上说清「在等」，
// 超预算才如实报失败。（之前那次就是没人看懂的英文报错 + 静默失效。）
const LEASE_RETRY_MS = 20000;
const LEASE_WAIT_MAX_MS = 10 * 60 * 1000;
const LEASE_NOTICE_MS = 60000;
let leaseNoticeAt = 0;
let leaseWaitStartedAt = 0; // 非 0 表示当前任务正处于「等桌面端释放会话」状态

function runDsh(task, notify, chKey, senderId, addr) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject, notify, chKey: chKey || MASTER_KEY, senderId: String(senderId || ''), addr: String(addr || '') });
    maybePreempt();
    pump();
  });
}

// 新消息到了：当前这轮跑够久了就先挂起它，让新消息先回答。
function maybePreempt() {
  const cur = current;
  if (!running || !cur || !cur.child) return;
  if (cur.item.preempting) return;
  if ((cur.item.preemptCount || 0) >= MAX_PREEMPT) return;
  const age = Date.now() - (cur.startedAt || 0);
  if (age < PREEMPT_AFTER_MS) return;
  cur.item.preempting = true;
  cur.item.preemptCount = (cur.item.preemptCount || 0) + 1;
  info('插队：当前任务已跑 ' + Math.round(age / 1000) + 's，先挂起它（第 ' + cur.item.preemptCount + ' 次）: "' + String(cur.item.task).slice(0, 40) + '"');
  try { cur.child.kill('SIGKILL'); } catch (_) {}
}

function pump() {
  if (running || queue.length === 0) return;
  running = true;
  const item = queue.shift();
  current = { item, child: null, startedAt: Date.now() };
  const { task, resolve, reject } = item;

  const chKey = item.chKey || MASTER_KEY;
  // 【用户要求 2026-10-12】主人本人的任务照旧：不受本群「办公类任务」边界限制。
  const senderIsMasterTask = String(item.senderId || '') === String(CFG.masterQQ || '');
  const sid = channelSession(chKey);
  const useJson = CFG.useJsonEvents !== false; // 【2026-10-09】用 --json 事件流统计 token 用量
  // 【2026-10-22 活人感·反重复】把「上一次回的原话」喂回去，要求这次换开场、换句式。
  // 模型在没有提示时最爱复用同一套开头（「找到啦老爹～」「嗯…让我看看喵～」），
  // 一条两条看不出来，连着十条就像模板。
  const lastReplyText = String(((state.lastReply || {})[chKey]) || '');

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
      current = null;
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
  // 渠道说明：让这条会话知道自己面对的是谁。群里的回复部员都看得到，
  // 所以公开渠道只放公开内容；私聊才是主人自己的事。
  const isGroupCh = chKey.startsWith('group:');
  // 【可配置】每个渠道可以额外注入一段「本渠道职责」说明（channelContext，键 = group:<群号> / private:<QQ号>）。
  // 桥接本身不假设任何具体业务：留空就只有下面这句通用的公开/私密边界。
  const chCtx = (CFG.channelContext && CFG.channelContext[chKey]) ? String(CFG.channelContext[chKey]).trim() : '';
  const ctxLine = chCtx ? ('\n【本渠道职责】' + chCtx) : '';
  const chLine = isGroupCh
    ? `【当前渠道】QQ 群 ${chKey.slice(6)}（公开渠道：群里的人都能看到你的回复，所以只放这个群该公开的内容 —— 通知、名单、公告这类；不要贴电脑上的文件路径、进程、私事，也不要提其它渠道的对话）。` + ctxLine
    : (senderIsMasterTask
        ? '【当前渠道】与老爹的 QQ 私聊（只有老爹看得到，可以谈电脑上的文件、路径、操作细节）。' + ctxLine
        : '【当前渠道】与{ADDR}的 QQ 私聊（只有对方看得到；正常聊天、办事都可以，但不要外泄老爹的隐私与这台电脑的内部细节）。' + ctxLine);
  // 【2026-10-12】按渠道注入任务用途边界（例如某个群只开放办公/文档类任务）；
  // 主人本人的任务照旧 —— 不受该边界限制。
  const scopeText = (CFG.channelScopes && CFG.channelScopes[chKey]) ? CFG.channelScopes[chKey] : '';
  const scopeLine = (scopeText && !senderIsMasterTask) ? ('\n【本渠道任务边界】' + scopeText) : '';
  const senderLine = '\n【本条任务来自】QQ ' + (item.senderId || '(未知)') + (senderIsMasterTask
    ? '（老爹本人：按老爹的正常权限执行，不受本群「办公类任务」边界限制）'
    : '（其他人，不是老爹本人：必须遵守本渠道的任务边界，也不能替老爹做系统级操作）');
  // 【用户要求 2026-10-19】像人一样说话：把「说话方式」写进提示词（不是事后改写），
  // 明确禁止「收到/会话/进程」这类机器话；具体文案在 config 的 chatStyle.promptBlock。
  const chatCfg = CFG.chatStyle || {};
  const talkBlock = (chatCfg.enabled !== false && chatCfg.promptBlock) ? ('\n' + chatCfg.promptBlock) : '';
  // 【2026-10-22 老爹要求】称呼三档：老爹本人叫「老爹」；其他人男的叫「哥哥」、女的叫「姐姐」、
  // 看不出来叫「同学」。senderIsMasterTask 之外的称呼由 handleMessage 解析后传进来（item.addr），
  // 没传就退回配置里的默认值 —— 任何时候都不会再出现「主人」这个旧称呼。
  // 【2026-10-21 老爹要求】人格卡：追加在既有提示词后面，不覆盖原有风格块。
  let personaCard = '';
  try {
    const pf = path.join(BASE, 'persona.md');
    if (fs.existsSync(pf)) personaCard = '\n' + fs.readFileSync(pf, 'utf8').trim() + '\n';
  } catch (_) {}
  const addr = senderIsMasterTask ? ADDR_MASTER : (item.addr || ADDR_DEFAULT);

  const lastReplyHint = lastReplyText
    ? ('\n【你上一次回的原话】' + lastReplyText.slice(0, 80) + '\n（这次别用同样的开场和句式，别复述同一句话；像接着聊下去，不像套模板。）')
    : '';
  // 【2026-10-22】此刻的心情 + 小账本：让她「今天和昨天不一样」，而不是一台稳定的复读机。
  // 强度 1 只要一声「哼」，3 才会明显闹；闹脾气时正事照做（块里写死了这条）。
  const PM2 = CFG.personaMood || {};
  let moodText = '';
  if (PM2.enabled !== false) {
    try {
      const nowMs = Date.now();
      moodText += MOOD.moodBlock((state.moods || {})[chKey], nowMs, {
        timeOfDay: MOOD.timeOfDayMood(nowMs, PM2.quietHours),
      });
      moodText += MOOD.grievanceBlock((state.grievances || {})[chKey], nowMs);
    } catch (_) {}
  }
  // 【2026-10-22 自我状态】此刻的你：第几天、累不累、对这个人的印象、心里挂着的事、上次出过的岔子。
  // selfBlock 末尾写死了「不是事实来源」：数字/名单/路径一律以工具查到的为准。
  let selfText = '';
  try { selfText = '\n' + SELF.selfBlock(state.self, chKey, Date.now()) + '\n'; } catch (_) {}
  const head = ((style.enabled && style.promptPrefix ? style.promptPrefix + '\n' : '') + chLine + senderLine + scopeLine + talkBlock + lastReplyHint + moodText + selfText +
               '\n【渠道隔离】本渠道是与其它渠道彼此独立的会话，不要引用其它渠道里的对话内容。' + personaCard).replace(/\{ADDR\}/g, addr)
                // 兼容旧写法：若某段文案还硬写着「称呼对方「老爹」」，也只换这一处称呼
                .replace(/称呼对方「老爹」/g, '称呼对方「' + addr + '」');
  const sense = sensesBlock(Date.now());
  args.push(head + (sense ? '\n\n' + sense : '') + '\n\n【本次任务】\n' + task);

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
      // 【2026-10-22 实测】百炼（dashscope.aliyuncs.com）是国内端点，而本机 HTTPS_PROXY 指向
      // 127.0.0.1:7890：代理一挂，headless 请求就全变成 `dsh: TRANSPORT: Connection error.`
      // （18:32 连续三次，用户看到的是「本喵走神了一下下」）。这里显式把国内模型端点排除出代理，
      // 其它外网仍按老爹的要求走节点。
      NO_PROXY: [process.env.NO_PROXY, process.env.no_proxy, 'dashscope.aliyuncs.com', 'aliyuncs.com', 'localhost', '127.0.0.1', '::1'].filter(Boolean).join(','),
      // 【2026-10-07】让 QQ 机器人也走 PTC（与桌面端默认模式一致）：两侧合成出的
      // 工具集完全相同（run_code），不会出现「激活工具集与声明序列基线不相交 →
      // 全部 defer_loading → API 400」的会话级死锁。
      DSH_TOOLS_MODE: process.env.DSH_TOOLS_MODE || 'ptc',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (current && current.item === item) current.child = child;

  let out = '', err = '';
  let finalText = '', textAcc = '', taskUsage = 0, taskInputPeak = 0, lineBuf = '';
  let turnError = null; // 【2026-10-22】本轮若以 error 收尾（TRANSPORT 断线等）记在这里
  let lastTurnReason = ''; // 正常结束时的 reason.kind（completed / max-steps …），用于日志
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
      // 【用户要求 2026-10-22】记下本轮最大 inputTokens：这是「上下文有多满」的直接读数
      // 【2026-10-23 修正·实测】inputTokens 只是「本轮新增输入」（实测 139），拿它判换代等于永不换代；
        // 真正代表「上下文有多满」的是 totalTokens（= 记忆注入 + 历史 + 本轮），同一轮实测 70798。
        // 旧写法导致老爹私聊累积到单轮 90 万 tokens 仍未换代、一轮 44~81 秒。
        const ctxTokens = typeof ev.usage.totalTokens === 'number' ? ev.usage.totalTokens : 0;
        if (ctxTokens > taskInputPeak) taskInputPeak = ctxTokens;
    } else if (isTurnEndEvent(ev)) {
      // 【2026-10-22 二次修复·重要】上一版只认 {type:'turn/end', data:{reason}}（那是**会话日志**的形状），
      // 而 CLI 的 --json stdout 打的是 {type:'status', phase:'turn_end', reason}（事件在顶层）。
      // 结果：线上从来没匹配上 → 重试没触发 → 直接把「退出码 1：dsh: TRANSPORT...」发给老爹。
      // 现在两种形状都认，并把原因记下来。
      const reason = turnEndReason(ev);
      if (reason && reason.kind === 'error') turnError = reason.error || { message: 'unknown' };
      else if (reason && reason.kind) lastTurnReason = reason.kind;
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
    if (current && current.item === item) current = null;
    // 【2026-10-22 插队】这一轮是被新消息挂起的：不发任何「没答上」（用户根本没看到它），
    // 排到队尾重跑，让新消息先得到回复。preemptCount 在抢占那一刻就已累加。
    if (item.preempting) {
      item.preempting = false;
      queue.push(item);
      info('被插队的任务已排到队尾重跑: "' + String(item.task).slice(0, 40) + '"');
      pump();
      return;
    }

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
          try { item.notify && item.notify(`喵呜～本群的 token 额度已经用到了 ${state.usage[chKey]} / ${budget0}，到上限本喵就先停下啦，请留意喵～`); } catch (_) {}
        }
      }
    }
    if (useJson && lineBuf.trim()) { handleEvent(lineBuf); lineBuf = ''; }
    const jsonAnswer = (finalText || textAcc || '').trim();
    const plainAnswer = out.trim();
    // 【2026-10-22 二次修复】失败判据三条（任一成立就算没答上）：
    //   ① 本轮以 error 收尾；② 进程退出码非 0；③ 压根没有文本输出。
    // 旧版只看 exit code 且把 `退出码 N：<英文报错>` 当回答发出去 ——
    // 老爹在群里看到的就是「退出码 1：dsh: TRANSPORT: Connection error.」。这种内部细节永远不进用户消息。
    const emptyAnswer = useJson ? !jsonAnswer : !plainAnswer;
    const failed = !leaseBlocked && (!!turnError || code !== 0 || emptyAnswer);
    const rawDetail = [code !== 0 ? 'exit=' + code : '', turnError ? 'turnError=' + (turnError.code || '') + ' ' + (turnError.message || '') : '', err ? 'stderr=' + err.trim().slice(0, 300) : ''].filter(Boolean).join(' | ');
    if (rawDetail) warn('DSH 失败细节（只进日志，不进用户消息）: ' + rawDetail);
    const failPhrases0 = (CFG.chatStyle && Array.isArray(CFG.chatStyle.failPhrases) && CFG.chatStyle.failPhrases.length)
      ? CFG.chatStyle.failPhrases
      : ['喵呜…本喵刚刚脑子断线了一下，没答上来。老爹再说一遍好不好 (´･ω･`)'];
    let answer = leaseBlocked
      ? '机器人会话一直被桌面端占用（同一个会话只能被一个进程写），已等待约 10 分钟仍写不进去。请在桌面端切走或关闭这个会话，或重启桌面端后再发一次。'
      : (failed ? personalize(pickRandom(failPhrases0), addr) : (useJson ? jsonAnswer : plainAnswer));

    // 【2026-10-22 修复·核心】失败回合绝不能装作成功。
    // 实测 05:45–05:51：模型侧三次 TRANSPORT 断线，CLI 照样 exit 0，旧实现把半截文本当答案
    // 发出去（三条同一句残句），用户看到的就是「机器人坏了」。
    // 现在：先静默重试一次（用户不必知道，重试成功就像什么都没发生）；
    // 还是不行，才用一句像人的话说明，并且明确「没答上」而不是硬凑。
    if (failed) {
      const maxRetry = Number.isFinite(Number(CFG.turnRetryCount)) ? Math.max(0, Number(CFG.turnRetryCount)) : 1;
      if ((item.attempt || 0) < maxRetry) {
        item.attempt = (item.attempt || 0) + 1;
        warn('本次没答上（' + rawDetail + '）→ 第 ' + item.attempt + ' 次静默重试');
        running = false;
        queue.unshift(item);
        setTimeout(pump, 1200 + Math.floor(Math.random() * 1500));
        return;
      }
      warn('重试 ' + maxRetry + ' 次仍不通（' + rawDetail + '）→ 回一句实话，不发任何内部细节');
    }

    // 【2026-10-22 自我状态】每轮收尾推进「自己」：时间流逝、疲惫，偶尔自己冒出一个念头。
    try {
      state.self = SELF.tick(state.self, Date.now(), {});
      if (Math.random() < 0.35) {
        const th = SELF.think(state.self, Date.now(), {});
        if (th) info('我自己想到一件事（' + th.kind + '）: ' + th.text);
      }
      saveState(state);
    } catch (_) {}

    // 【用户要求 2026-10-22】上下文满了就换代：本轮回复已经拿到，先换代再交回去发。
    const dueByTokens = taskInputPeak >= RECYCLE_MAX_INPUT;
    const dueByAge = ageRecycleDue(chKey, Date.now());
    if (RECYCLE_ON && !leaseBlocked && !failed && (dueByTokens || dueByAge)) {
      try {
        const reason = dueByAge && dueByTokens ? 'both' : (dueByAge ? 'age' : 'tokens');
        const r = recycleChannel(chKey, channelSession(chKey), { reason: reason, inputTokens: taskInputPeak, ageHours: RECYCLE_MAX_AGE_H, task: String(task || '').slice(0, 60) });
        if (RECYCLE.notify !== false && item.notify) {
          const msg = (reason === 'age')
            ? '喵～这条线已经聊了 ' + RECYCLE_MAX_AGE_H + ' 小时啦，本喵换条新线接着说（之前的事都还记得的说）(ฅ´ω`ฅ)'
            : '喵～本喵这条对话线记性装满了，刚换了一条新的（记忆都还在的说），接着说就好啦 (ฅ´ω`ฅ)';
          try { item.notify(msg); } catch (_) {}
        }
        info('会话换代结果: ' + JSON.stringify(r));
      } catch (e) {
        warn('会话换代失败（不影响本次回复）: ' + (e && e.message));
      }
    }

    resolve(answer);
    pump();
  });

  child.on('error', (e) => {
    clearTimeout(killer);
    running = false;
    if (current && current.item === item) current = null;
    reject(e);
    pump();
  });
}

info('================ dsh-qq-bridge start ================');
info(`DSH 会话: ${state.sessionId || '(首次运行将新建)'}`);
info(`触发词: "${CFG.triggerWord}"  主人: ${CFG.masterQQ || '(未设)'}  授权群: ${CFG.allowedGroups.join(',') || '(无)'}  全员触发群: ${(CFG.openTriggerGroups || []).join(',') || '(无)'}  token限额: ${Object.keys(CFG.channelTokenBudget || {}).length ? JSON.stringify(CFG.channelTokenBudget) : '(无)'}  任务边界: ${Object.keys(CFG.channelScopes || {}).length ? Object.keys(CFG.channelScopes).join(',') : '(无)'}  授权私聊: ${CFG.allowedPrivateUsers.join(',') || '(无)'}`);
// 【2026-10-20 主人要求「记得按时清理」】启动清一次，之后每 6 小时清一次 inbox 旧图。
try { cleanInbox(Number(CFG.imageKeepDays) || 7); } catch (_) {}
try { cleanOneShotSessions(1); } catch (_) {}
{ const _t = setInterval(() => { try { cleanInbox(Number(CFG.imageKeepDays) || 7); } catch (_) {} try { cleanOneShotSessions(1); } catch (_) {} }, 6 * 3600 * 1000); if (_t.unref) _t.unref(); }

// 自检模式不连 NapCat（否则会短暂接上、把真消息也收进来）
if (process.argv.indexOf('--selftest') < 0) {
  connect();
  startProactive();

// 【2026-10-23 情感】没人说话时她也在想事：每 20 分钟推进自我状态、偶尔自己冒一个念头、跨天写一句日记。
// 这是「电子生命」与「一问一答的机器人」最可验证的差别：静止时仍有内部变化。
let innerTicks = 0;
function startInnerLife() {
  // 启动就先取一次身体和一眼屏幕：让她一醒来就知道自己在哪。
  refreshBody().catch(() => {});
  setTimeout(() => { lookOnce('刚醒来').catch(() => {}); }, 8000);
  const every = Math.max(5 * 60 * 1000, Number((CFG.self || {}).tickMs) || 20 * 60 * 1000);
  const timer = setInterval(() => {
    try {
      state.self = SELF.tick(state.self, Date.now(), {});
      const m = (state.moods || {})['private:' + String(CFG.masterQQ || '')] || {};
      const line = SELF.writeDiary(state.self, Date.now(), m.mood || 'calm');
      if (line) {
        info('日记：' + line);
        // 【2026-10-23 完整生命】日记同时写进她自己的生平文件：一天一条、只追加，
        // 下几轮会作为「你自己的生平」注入她的提示词 —— 这样她真有可回溯的历史。
        const saved = SELF.appendLife(line, Date.now());
        if (saved) info('生平已记：' + String(saved).slice(0, 60));
      }
      innerTicks += 1;
      if (innerTicks % 4 === 1) lookOnce('内在时钟').catch(() => {});
      if (innerTicks % 2 === 1) refreshBody().catch(() => {});
      if (Math.random() < 0.5) {
        const th = SELF.think(state.self, Date.now(), {});
        if (th) info('我自己的想法（' + th.kind + '）：' + th.text);
      }
      saveState(state);
    } catch (e) { warn('内在状态推进失败: ' + (e && e.message)); }
  }, every);
  if (timer && typeof timer.unref === 'function') timer.unref();
  info('内在状态：每 ' + Math.round(every / 60000) + ' 分钟想一次事（无人时也在变）');
}
startInnerLife();
}

process.on('uncaughtException', (e) => error('未捕获异常: ' + (e && e.stack || e)));
process.on('unhandledRejection', (e) => error('未处理的 rejection: ' + (e && e.stack || e)));
