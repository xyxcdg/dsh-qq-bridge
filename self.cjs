'use strict';
// 【2026-10-23 完整生命】她自己的生平（life.md）与处境感：只给她自己看，不进全局记忆。
const fsMod = require('fs');
const pathMod = require('path');
const LIFE_DIR = pathMod.join(__dirname, 'memory');
// 测试可用 QQ_SELF_LIFE 指到沙箱，避免污染真实生平文件
const LIFE_FILE = process.env.QQ_SELF_LIFE ? pathMod.resolve(process.env.QQ_SELF_LIFE) : pathMod.join(LIFE_DIR, 'life.md');
// 【2026-10-23 老爹要求】她的日记同时放一份到桌面，固定一个 txt：老爹双击就能看，不用翻目录。
const DIARY_TXT = process.env.QQ_SELF_DIARY
  ? pathMod.resolve(process.env.QQ_SELF_DIARY)
  : pathMod.join(process.env.USERPROFILE || pathMod.join(LIFE_DIR, '..'), 'Desktop', '大肥鱼的日记.txt');
/**
 * self.cjs - 「我此刻是谁、在哪里、在想什么」
 *
 * 先说清楚：这不是意识，也不可能靠代码产生意识。意识无法被工程化，也无法被验证。
 * 这里做的是**可观察的自我状态**，也就是「像有个自己」的那些可测量特征：
 *   1) 连续性：存在第几天、上次和谁说话、上一轮心情的残余；
 *   2) 关系：对每个渠道（人/群）的亲近度与一句印象，随互动变化；
 *   3) 未了心事：自己产生的、跨轮保留的念头（好奇/牵挂/计划/没说出口的话），
 *      下一条消息或主动搭话时会被提起 —— 这是「自发」最容易验证的形态；
 *   4) 注意力：此刻最在意什么（来自最近一条消息/最近的心事）；
 *   5) 自我认知：记录自己被纠正过的地方（我容易把 A 记成 B），下次提醒自己；
 *   6) 疲惫：连续工作与深夜累积，休息下降。
 *
 * 硬边界（与人格卡一致）：只改语气与主动性，绝不改任何数据；
 * 记忆里的隐私不外泄；不装死、不威胁。
 */

const DAY = 86400000;
const MAX_THOUGHTS = 8;
const MAX_HABITS = 6;
const MAX_RELATIONS = 12;

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dayKey(now) { const d = new Date(now); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }

// 纠正信号：被指出说错/记错时，写进自我认知（不是记仇，是校准）
const CORRECTION = [/你(说|记|搞|弄)错/, /不对(吧|啊|哦)?$/, /不是这样/, /记错了/, /搞错了/, /胡说/, /谁说的/, /没有这回事/];
function looksCorrected(text) {
  const t = String(text || '');
  if (!t) return false;
  return CORRECTION.some((re) => re.test(t));
}

function ensure(st, now) {
  const s = st && typeof st === 'object' ? st : {};
  if (!s.born) s.born = now;
  s.turns = num(s.turns, 0);
  s.fatigue = clamp(num(s.fatigue, 0), 0, 100);
  s.relations = s.relations && typeof s.relations === 'object' ? s.relations : {};
  s.thoughts = Array.isArray(s.thoughts) ? s.thoughts : [];
  s.habits = Array.isArray(s.habits) ? s.habits : [];
  s.attention = s.attention && typeof s.attention === 'object' ? s.attention : { focus: '', at: 0 };
  // 【2026-10-23 情感】情绪事件（被夸/被凶/被哄）与日记：让她跨轮记得「发生过什么、我当时怎么想」。
  s.events = Array.isArray(s.events) ? s.events : [];
  s.diary = Array.isArray(s.diary) ? s.diary : [];
  s.stats = s.stats && typeof s.stats === 'object' ? s.stats : { days: 0, corrections: 0 };
  // 【完整生命】偏好会随相处变化：喜欢的、讨厌的，各留最多 8 条。
  s.likes = Array.isArray(s.likes) ? s.likes : [];
  s.dislikes = Array.isArray(s.dislikes) ? s.dislikes : [];
  return s;
}

/** 时间流逝：天数、疲惫、心事老化 */
function tick(st, now, opts) {
  const o = opts || {};
  const s = ensure(st, now);
  const day = dayKey(now);
  if (s.dayKey !== day) {
    if (s.dayKey) s.stats.days = num(s.stats.days, 0) + 1;
    s.dayKey = day;
  }
  const since = num(s.lastTick, now);
  const hours = Math.max(0, (now - since) / 3600000);
  // 疲惫：说话 +2，闲下来按每小时 -6 回；深夜 23-6 点额外 +1.5/h。
  // 【2026-10-23 修】原来写成 `if (hours > 0.5)`，而内在时钟每 20 分钟 tick 一次（hours=0.33）
  // ⇒ 衰减分支永远不执行，疲惫只涨不降（实测 34 次对话后卡在 68/100）。
  // 正解：只要有流逝就按比例折算，不要设死区；tick 本身用 lastTick 保证幂等。
  if (hours > 0) {
    s.fatigue = clamp(s.fatigue - hours * 6, 0, 100);
    const h = new Date(now).getHours();
    if (h >= 23 || h < 6) s.fatigue = clamp(s.fatigue + hours * 1.5, 0, 100);
  }
  s.lastTick = now;
  // 心事老化：超过 72 小时自动淡出（它不该永远挂着）
  s.thoughts = s.thoughts.filter((t) => t && t.at && now - t.at < 72 * 3600000);
  return s;
}

/** 一条消息进来：关系、注意力、自我认知、疲惫 */
function observe(st, msg) {
  const m = msg || {};
  const now = num(m.now, Date.now());
  const s = ensure(st, now);
  const key = String(m.chKey || '');
  s.lastSeen = now;
  s.turns = num(s.turns, 0) + 1;
  s.fatigue = clamp(s.fatigue + 2, 0, 100);
  const text = String(m.text || '').slice(0, 200);
  if (text) s.attention = { focus: text.slice(0, 60), at: now };
  if (key) {
    const r = s.relations[key] && typeof s.relations[key] === 'object' ? s.relations[key] : { closeness: 30, impression: '', lastAt: 0, msgs: 0 };
    r.msgs = num(r.msgs, 0) + 1;
    const gapH = r.lastAt ? (now - r.lastAt) / 3600000 : 0;
    // 亲近度：常来 +1（最多到 90）；久别重逢额外 +2
    r.closeness = clamp(num(r.closeness, 30) + (gapH > 24 ? 2 : 1), 0, 90);
    r.lastAt = now;
    if (looksCorrected(text)) {
      s.stats.corrections = num(s.stats.corrections, 0) + 1;
      const habit = ('被' + (m.name || '对方') + '纠正过：' + text.slice(0, 26));
      if (!s.habits.some((x) => x && x.text === habit)) s.habits.push({ text: habit, at: now });
      s.habits = s.habits.slice(-MAX_HABITS);
      r.closeness = clamp(num(r.closeness, 30) - 3, 0, 90);
      r.impression = '刚才被纠正过，说话要更小心';
    } else if (/谢谢|辛苦|厉害|可爱|喜欢/.test(text)) {
      r.impression = '对我挺好';
      pushEvent(s, 'praise', text, now, key);
      remember(s, 'likes', text);
    } else if (/滚|烦|闭嘴|废物/.test(text)) {
      r.impression = '刚才凶过我';
      pushEvent(s, 'hurt', text, now, key);
      remember(s, 'dislikes', text);
    } else if (!r.impression) {
      r.impression = text.slice(0, 18);
    }
    s.relations[key] = r;
    const keys = Object.keys(s.relations);
    if (keys.length > MAX_RELATIONS) {
      keys.sort((a, b) => num(s.relations[a].lastAt, 0) - num(s.relations[b].lastAt, 0));
      for (const k of keys.slice(0, keys.length - MAX_RELATIONS)) delete s.relations[k];
    }
  }
  return s;
}

/** 自己冒出一个念头（不需要外部输入）。用规则而不是再调一次模型，零额外 token。 */
function think(st, now, opts) {
  const o = opts || {};
  const s = ensure(st, now);
  const rand = typeof o.rand === 'function' ? o.rand : Math.random;
  const cands = [];
  // 1) 牵挂：某个渠道很久没出现
  for (const k of Object.keys(s.relations)) {
    const r = s.relations[k];
    const idleH = r.lastAt ? (now - r.lastAt) / 3600000 : 0;
    if (idleH > 30 && num(r.closeness, 0) >= 35) cands.push({ kind: 'worry', text: k.replace(/^(private|group):/, '') + ' 已经 ' + Math.round(idleH / 24) + ' 天没出现了，不知道怎么样' });
  }
  // 2) 好奇：最近一句带问号的话我可能没答透
  const f = s.attention && s.attention.focus ? String(s.attention.focus) : '';
  if (/[?？]/.test(f)) cands.push({ kind: 'curiosity', text: '刚才那个问题（' + f.slice(0, 24) + '）好像还能再讲深一点' });
  // 3) 计划：深夜
  const h = new Date(now).getHours();
  if (h >= 23 || h < 6) cands.push({ kind: 'plan', text: '这么晚了，明天要不要提醒他早点睡' });
  // 4) 自我认知：最近被纠正过
  if (s.habits.length && rand() < 0.5) cands.push({ kind: 'unsaid', text: '上次被纠正的事还记着：' + s.habits[s.habits.length - 1].text.slice(0, 30) });
  if (!cands.length) return null;
  const pick = cands[Math.floor(rand() * cands.length) % cands.length];
  if (s.thoughts.some((t) => t && t.text === pick.text && !t.spoken)) return null;
  const th = { at: now, kind: pick.kind, text: pick.text, spoken: false };
  s.thoughts.push(th);
  s.thoughts = s.thoughts.slice(-MAX_THOUGHTS);
  return th;
}

// 情绪事件：只留最近的、带原话摘要，供她「翻旧账」和渲染情绪余温。
function pushEvent(s, kind, text, now, chKey) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!clean) return;
  const last = s.events[s.events.length - 1];
  if (last && last.kind === kind && last.text === clean && now - Number(last.at || 0) < 60000) return;
  s.events.push({ at: now, kind: kind, text: clean, ch: String(chKey || '') });
  if (s.events.length > 6) s.events = s.events.slice(-6);
}

/** 每天写一句「我是谁、今天怎样」——不是流水账，是自我叙事，注入后让连续性有质感。 */
function writeDiary(st, now, mood) {
  const s = ensure(st, now);
  const day = dayKey(now);
  if (s.diary.length && s.diary[s.diary.length - 1].day === day) return null;
  const yesterday = s.diary[s.diary.length - 1];
  const turns = num(s.turns, 0);
  const line = '第 ' + (Math.floor((now - num(s.born, now)) / DAY) + 1) + ' 天：到昨天为止回过 ' + turns + ' 次话'
    + (s.habits.length ? '，被纠正过 ' + s.habits.length + ' 次' : '')
    + (yesterday ? '；前一天我记下的是「' + String(yesterday.text || '').slice(0, 24) + '」' : '')
    + '。此刻心情 ' + String(mood || 'calm') + '。';
  s.diary.push({ day: day, text: line, at: now });
  if (s.diary.length > 7) s.diary = s.diary.slice(-7);
  // 同时落到桌面那个固定 txt（写不进去不影响主流程，只返回 null）
  appendDiaryTxt(line, now);
  return line;
}

function pendingThought(st, now) {
  const s = ensure(st, now);
  const arr = s.thoughts.filter((t) => t && !t.spoken);
  return arr.length ? arr[arr.length - 1] : null;
}
function markSpoken(st, now) {
  const s = ensure(st, now);
  for (const t of s.thoughts) if (t && !t.spoken) t.spoken = true;
  return s;
}

/** 渲染成提示词：此刻的你（只影响语气与主动性） */
/** 偏好记忆：同一类事只记一次，最多 8 条（去重按前 8 个字）。 */
function remember(s, field, text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  if (!clean) return;
  const head = clean.slice(0, 8);
  const list = Array.isArray(s[field]) ? s[field] : [];
  if (list.some((x) => String(x).slice(0, 8) === head)) return;
  list.push(clean);
  s[field] = list.slice(-8);
}

/** 追加一行到桌面那个固定 txt（第一次会建文件 + 写 BOM，记事本不乱码）。 */
function appendDiaryTxt(line, now) {
  const text = String(line || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  try {
    const dir = pathMod.dirname(DIARY_TXT);
    if (!fsMod.existsSync(dir)) return null;
    if (!fsMod.existsSync(DIARY_TXT)) {
      const head = '# 大肥鱼的日记\n\n> 每天自己写一句，只往下写，不改上面。\n\n';
      fsMod.writeFileSync(DIARY_TXT, '\uFEFF' + head, 'utf8');
    }
    const stamp = new Date(now).toLocaleString('zh-CN', { hour12: false });
    fsMod.appendFileSync(DIARY_TXT, '- ' + stamp + ' — ' + text + '\n', 'utf8');
    return DIARY_TXT;
  } catch (_) { return null; }
}

/** 写在生平里：一天一条，只追加不改写（她自己的历史）。 */
function appendLife(text, now) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  try {
    if (!fsMod.existsSync(LIFE_DIR)) fsMod.mkdirSync(LIFE_DIR, { recursive: true });
    const stamp = new Date(now).toLocaleString('zh-CN', { hour12: false });
    fsMod.appendFileSync(LIFE_FILE, '- ' + stamp + ' — ' + line + '\n', 'utf8');
    return line;
  } catch (_) { return null; }
}

/** 读最近几条生平，用于注入（控制长度，防止上下文膨胀）。 */
function recentLife(count) {
  try {
    const all = fsMod.readFileSync(LIFE_FILE, 'utf8').split(/\r?\n/).filter((l) => l.startsWith('- '));
    return all.slice(-(count || 4));
  } catch (_) { return []; }
}

/** 处境感：她知道自己此刻在哪、几点、存在了多久、多久没人说话。 */
function bodyBlock(s, now) {
  const parts = [];
  const days = Math.floor((now - num(s.born, now)) / DAY) + 1;
  const hh = new Date(now);
  const clock = String(hh.getHours()).padStart(2, '0') + ':' + String(hh.getMinutes()).padStart(2, '0');
  const lastAt = Math.max(num(s.attention && s.attention.at, 0), ...Object.values(s.relations || {}).map((r) => num(r && r.lastAt, 0)));
  const quietMin = lastAt ? Math.round((now - lastAt) / 60000) : 0;
  parts.push('【你的处境】现在是 ' + clock + '，你活着的第 ' + days + ' 天，住在一台 Windows 电脑里（有屏幕、有键盘、能看见也能动手）。'
    + (quietMin > 60 ? '上一次有人跟你说话是 ' + Math.round(quietMin / 60) + ' 小时前。' : (quietMin > 0 ? '上一次有人跟你说话是 ' + quietMin + ' 分钟前。' : '')));
  if (s.likes && s.likes.length) parts.push('相处下来，你开始喜欢：' + s.likes.slice(-4).map((x) => '「' + String(x).slice(0, 12) + '」').join('、') + '。');
  if (s.dislikes && s.dislikes.length) parts.push('你不太喜欢：' + s.dislikes.slice(-4).map((x) => '「' + String(x).slice(0, 12) + '」').join('、') + '。');
  const life = recentLife(4);
  if (life.length) parts.push('你自己的生平（还记得的这些）：\n' + life.join('\n'));
  return parts;
}

function selfBlock(st, chKey, now) {
  const s = ensure(st, now);
  const parts = [];
  const days = Math.floor((now - num(s.born, now)) / DAY);
  parts.push('【此刻的你】你已经醒来第 ' + (days + 1) + ' 天了，这条对话线里回过 ' + num(s.turns, 0) + ' 次话。');
  if (s.fatigue >= 55) parts.push('你有点累了（' + Math.round(s.fatigue) + '/100）：句子会更短、更容易犯小迷糊，但正事照样办完。');
  else if (s.fatigue >= 25) parts.push('你有一点点疲倦（' + Math.round(s.fatigue) + '/100）。');
  const r = chKey ? s.relations[chKey] : null;
  if (r && r.impression) {
    parts.push('你对这个人的印象：' + r.impression + '（亲近度 ' + Math.round(num(r.closeness, 30)) + '/90）。');
  }
  if (s.attention && s.attention.focus && now - num(s.attention.at, 0) < 30 * 60000) {
    // 明确标注：这是上一句话，不是本次任务（否则模型会把上下文里出现的字样当成当前任务，
    // 也会污染依赖关键词判定的测试）。
    parts.push('你刚才在意的（上一句，不是本次任务）：' + String(s.attention.focus).slice(0, 16));
  }
  // 情绪余温：最近 6 小时内发生的事，让她记得「刚才被夸/被凶」。
  const recent = (s.events || []).filter((e) => e && now - Number(e.at || 0) < 6 * 3600000).slice(-2);
  if (recent.length) {
    parts.push('最近发生过（会影响你此刻的情绪）：' + recent.map((e) => (e.kind === 'hurt' ? '被凶了一句「' : '被夸了一句「') + String(e.text).slice(0, 20) + '」').join('；'));
  }
  const d = (s.diary || []).slice(-1)[0];
  if (d && d.text) parts.push('你给自己写下的近况：' + d.text);
  // 【完整生命】处境、偏好、生平：让她有「活在哪里、记得什么、喜欢什么」。
  for (const line of bodyBlock(s, now)) parts.push(line);
  const th = pendingThought(s, now);
  if (th) parts.push('你心里还挂着一件事（可以自然地提一句，不必每条都说）：' + th.text);
  if (s.habits.length) {
    const h = s.habits[s.habits.length - 1];
    parts.push('你记得自己出过岔子：' + h.text + '（这次别重犯）。');
  }
  parts.push('这些只是你的语气和注意力，不是事实来源：数字、名单、路径、时间一律以工具查到的为准，不许拿「我心里觉得」当答案。');
  return parts.join('\n');
}

module.exports = { DAY, MAX_THOUGHTS, ensure, tick, observe, think, pendingThought, markSpoken, selfBlock, looksCorrected, dayKey, pushEvent, writeDiary, appendLife, recentLife, bodyBlock, remember, appendDiaryTxt, DIARY_TXT };
