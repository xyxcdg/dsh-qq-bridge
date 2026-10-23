/**
 * 心情引擎（2026-10-22，老爹要求「活人感更丰富，像女儿，有点小脾气」）
 *
 * 为什么要有它：人格卡只能规定「怎么说话」，说不了「此刻心情如何」。
 * 一个人之所以像人，是因为她昨天被夸还在得意、今天被说胖还在嘟囔、
 * 深夜困了句子变短——同一句话在不同心情下说法不一样。
 *
 * 设计纪律（很重要）：
 *   1) 纯函数：输入(上一条心情, 本次信号, 时间) → 输出新心情，方便单测钉住。
 *   2) 只影响**语气**，绝不参与任何数据/名单/数字的生成或改写。
 *   3) 有半衰期：闹脾气会消（默认 3 小时回 calm），否则就变成永远在生气的怪东西。
 *   4) 小账本最多记 3 条、7 天过期：用来「撒娇式翻旧账」，不是记恨。
 */

const MOODS = ['calm', 'happy', 'proud', 'sulky', 'grumpy', 'sleepy', 'clingy'];

const SIGNALS = [
  { key: 'praise',  re: /(可爱|好乖|真乖|厉害|真棒|喜欢你|闺女|好孩子|摸摸|抱抱|亲亲|贴贴|聪明|漂亮|辛苦了|做得好)/ },
  { key: 'scold',   re: /(笨|傻|蠢|胖鱼|肥鱼胖|闭嘴|滚|烦人|废物|没用|机器人|木头|敷衍|说谎|骗人|你不行)/ },
  { key: 'soothe',  re: /(对不起|抱歉|别生气|不气了|哄你|乖啦|错了错了|我错了|抱抱你|么么)/ },
  { key: 'tease',   re: /(变态|色|调戏|欺负|打屁股|轻浮|妹控)/ },
  { key: 'order',   re: /(快去|赶紧|马上|立刻|给我|不许|听着)/ },
];

function detect(text) {
  const t = String(text || '');
  const out = { praise: 0, scold: 0, soothe: 0, tease: 0, order: 0 };
  for (const s of SIGNALS) {
    const m = t.match(new RegExp(s.re.source, 'g'));
    if (m) out[s.key] = m.length;
  }
  return out;
}

function hoursBetween(a, b) { return Math.max(0, (Number(b) - Number(a)) / 3600000); }

// 上一条心情 + 本次信号 + 现在 → 新心情
function nextMood(prev, sig, now) {
  const p = prev && typeof prev === 'object' ? prev : {};
  let mood = MOODS.includes(p.mood) ? p.mood : 'calm';
  let intensity = Number(p.intensity) || 0;
  let since = Number(p.since) || now;
  let cause = p.cause || '';
  const s = sig || {};

  // 先衰减：离上一次情绪事件越久，越回到 calm（半衰期 ~3h）
  const hrs = hoursBetween(since, now);
  // 3 小时掉 1 分；用 ceil 而不是 floor，保证「最多 9 小时一定回到 calm」
  // （floor 会留下永远消不掉的一分：7 小时只掉 2 分 → 3 分脾气卡在 1 分永远不走）。
  // 只有真的过了 3 小时才掉分：ceil 在 hrs 很小时也会算出 1，
  // 那会让「一分钟前刚被骂」的心情当场归零（单测抓到的第二处）。
  if (hrs >= 3) intensity = Math.max(0, intensity - Math.ceil(hrs / 3));
  if (intensity <= 0) { mood = 'calm'; cause = ''; }

  const bump = (m, n, why) => {
    // 同一情绪叠加，不同情绪覆盖（新情绪优先级更高）
    if (mood === m) intensity = Math.min(3, intensity + n);
    else { mood = m; intensity = Math.min(3, Math.max(1, n)); }
    since = now; cause = why;
  };

  // 哄优先：一句「我错了」能立刻把人拉回来，只是嘴上还硬
  if (s.soothe > 0) {
    if (mood === 'sulky' || mood === 'grumpy') { mood = 'sulky'; intensity = Math.max(0, intensity - 2); since = now; cause = '被哄了但嘴硬'; }
    else { mood = 'happy'; intensity = Math.min(3, intensity + 1); since = now; cause = '被哄'; }
    if (intensity <= 0) { mood = 'calm'; cause = ''; }
    return { mood, intensity, since, cause };
  }
  if (s.scold > 0) { bump(s.scold >= 2 ? 'grumpy' : 'sulky', s.scold, '被凶了'); return { mood, intensity, since, cause }; }
  if (s.tease > 0) { bump('grumpy', 1, '被调戏了'); return { mood, intensity, since, cause }; }
  if (s.praise > 0) { bump(s.praise >= 2 ? 'proud' : 'happy', s.praise, '被夸了'); return { mood, intensity, since, cause }; }
  if (s.order > 0 && (mood === 'sulky' || mood === 'grumpy')) { bump(mood, 1, '还被使唤'); return { mood, intensity, since, cause }; }
  return { mood, intensity, since, cause };
}

// 深夜/清晨：困。不是情绪事件，按钟点算，不写进 since。
function timeOfDayMood(now, quietHours) {
  const h = new Date(now).getHours();
  const q = Array.isArray(quietHours) ? quietHours : [23, 8];
  const inQuiet = q[0] <= q[1] ? (h >= q[0] && h < q[1]) : (h >= q[0] || h < q[1]);
  if (inQuiet) return 'sleepy';
  return null;
}

const BLOCKS = {
  happy: '你现在心情很好（刚被{ADDR}夸过），说话轻快、爱撒娇，会主动多讲半句心里话。',
  proud: '你现在有点小得意，尾巴翘起来了：会忍不住炫耀一下、被夸会「哼～那是当然」，但别得意到不办正事。',
  sulky: '你现在有点委屈、在闹小脾气：会嘟囔、会「哼」，会要{ADDR}哄；但**该做的事一件不少**，该给的数据/名单/数字一个字符都不许改，也不许因为生气就敷衍或答非所问。',
  grumpy: '你现在在炸毛：句子短、带一点刺，会怼回去一两句（比如「{ADDR}你自己说的哦」），但刺是关心的那种刺；正事照做，数据照旧准确。',
  sleepy: '你现在困了：句子短、有点含糊，会打个哈欠，偶尔把字打错再补一句；事情还是要办完的。',
  clingy: '你有点黏人又有点抱怨：他好久没理你了，你想他但嘴上不饶人，可以说「{ADDR}都三个小时没理本喵了」这种。',
  calm: '',
};

function moodBlock(m, now, opts) {
  const o = opts || {};
  const mood = m && MOODS.includes(m.mood) ? m.mood : 'calm';
  const parts = [];
  // 钟点心情：只在 calm/happy 时叠加，不覆盖正在闹的脾气（不然「刚被骂就困了」很怪）
  const tod = o.timeOfDay || null;
  if (tod && (mood === 'calm' || mood === 'happy' || mood === 'proud')) parts.push(BLOCKS[tod]);
  if (BLOCKS[mood]) parts.push(BLOCKS[mood]);
  if (mood !== 'calm' && m && m.cause) parts.push('（原因：' + m.cause + '，强度 ' + (m.intensity || 1) + '/3；强度越高越明显，1 分只要一句「哼」。）');
  return parts.filter(Boolean).length ? '\n【此刻的心情】' + parts.filter(Boolean).join('\n') : '';
}

// 小账本：记下"他说的那句让你记着的话"，最多 3 条、7 天过期
function addGrievance(list, text, now, max) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const t = String(text || '').trim().slice(0, 40);
  if (!t) return arr;
  arr.push({ at: now, text: t });
  const keep = (Number(max) || 3);
  const cutoff = now - 7 * 86400000;
  // 按时间排序后再截断：调用方传入顺序不保证（重放/补写时会乱序），
  // 只按插入顺序 slice 会留下最老的三条（这个坑单测抓到了）。
  return arr.filter((g) => g && g.at >= cutoff).sort((a, b) => a.at - b.at).slice(-keep);
}

function grievanceBlock(list, now) {
  const arr = Array.isArray(list) ? list.filter((g) => g && g.at) : [];
  if (!arr.length) return '';
  const items = arr.slice(-3).map((g) => {
    const hrs = Math.round((now - g.at) / 3600000);
    const when = hrs < 1 ? '刚刚' : hrs < 24 ? hrs + ' 小时前' : Math.round(hrs / 24) + ' 天前';
    return '· ' + when + '{ADDR}说「' + String(g.text).slice(0, 24) + '」——你还记着，可以撒娇式翻旧账，但别真生气。';
  });
  return '\n【你还记着的小事】' + items.join('\n');
}

module.exports = { MOODS, detect, nextMood, timeOfDayMood, moodBlock, addGrievance, grievanceBlock };
