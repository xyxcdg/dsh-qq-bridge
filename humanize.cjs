'use strict';
/**
 * 说话方式（纯函数，无 IO）：把 DSH 的最终文本排成「像人聊天」的一条或几条消息。
 *
 * 为什么单独成文件：这段逻辑决定了「一句一句回」还是「汇总成一条」，
 * 是这一版人格化的核心，必须能被 test-humanize.cjs 直接钉住，
 * 而不是埋在 bridge.js 的消息处理里靠肉眼验。
 *
 * 三条硬纪律：
 *  1) 只做「切分」，绝不改写内容 —— 数字、姓名、路径、名单一个字都不能动。
 *     测试里有 join 回原文的断言。
 *  2) 结构化内容（名单/表格/编号列表）不拆 —— 名单被拆成几条消息，人就没法抄了。
 *  3) 拆不出意义（只有一句、或长度不足）就原样一条发出去，别硬凑。
 */

const DEFAULTS = {
  enabled: true,
  maxBubbles: 4,
  maxBubbleChars: 260,
  minTotalChars: 16,
  gapMs: 650,
  hardLimit: 1800,
};

function cfgOf(cfg) {
  const c = cfg || {};
  return {
    enabled: c.enabled !== false,
    maxBubbles: clampInt(c.maxBubbles, 1, 8, DEFAULTS.maxBubbles),
    maxBubbleChars: clampInt(c.maxBubbleChars, 40, 1800, DEFAULTS.maxBubbleChars),
    minTotalChars: clampInt(c.minTotalChars, 0, 1000, DEFAULTS.minTotalChars),
    gapMs: clampInt(c.gapMs, 0, 5000, DEFAULTS.gapMs),
    hardLimit: clampInt(c.hardLimit, 200, 4000, DEFAULTS.hardLimit),
  };
}

function clampInt(v, lo, hi, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** 结构化内容：编号/项目符号列表、表格 —— 这类必须整段发，不许拆。 */
function isStructured(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return false;
  const listy = lines.filter((l) =>
    /^\s*(?:[-*•·]|\d+[.、)]|[（(]\d+[）)]|[一二三四五六七八九十]+[、.]|[A-Za-z][.、)])\s*/.test(l)
  ).length;
  if (listy >= 2) return true;
  // 表格：至少一行里有两根竖线以上
  if (lines.some((l) => (l.match(/\|/g) || []).length >= 2)) return true;
  return false;
}

/** 按句末标点切句；超长句再按逗号/空格软切，保证每条不会太长。 */
function splitSentences(text, softLimit) {
  const limit = softLimit || 120;
  const raw = [];
  let buf = '';
  for (const ch of String(text || '')) {
    buf += ch;
    if (ch === '\n' || '。！？!?；;'.includes(ch)) {
      if (buf.trim()) raw.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) raw.push(buf.trim());

  const out = [];
  for (const p of raw) {
    if (p.length <= limit) { out.push(p); continue; }
    let rest = p;
    while (rest.length > limit) {
      const window = rest.slice(0, limit);
      let cut = Math.max(
        window.lastIndexOf('，'),
        window.lastIndexOf(','),
        window.lastIndexOf('；'),
        window.lastIndexOf(' '),
        window.lastIndexOf('、')
      );
      if (cut < Math.floor(limit * 0.35)) cut = limit - 1;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
  }
  return out.filter(Boolean);
}

/** 把特别短的句子并到下一句（避免单独发一个「嗯。」）。 */
function mergeTiny(sentences, minLen) {
  const out = [];
  let carry = '';
  for (const s of sentences) {
    const cur = carry ? carry + s : s;
    if (cur.length < minLen) { carry = cur; continue; }
    out.push(cur);
    carry = '';
  }
  if (carry) {
    if (out.length) out[out.length - 1] += carry;
    else out.push(carry);
  }
  return out;
}

function chunks(text, size) {
  const out = [];
  let s = String(text || '');
  while (s.length > size) { out.push(s.slice(0, size)); s = s.slice(size); }
  out.push(s);
  return out.filter((x) => x.length);
}

/**
 * 返回要依次发送的消息数组。
 * 空文本 -> ['（无输出）']。
 */
function planBubbles(text, cfg) {
  const c = cfgOf(cfg);
  let t = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
  if (!t) return ['（无输出）'];
  if (!c.enabled) return chunks(t, c.hardLimit);
  if (t.length <= c.minTotalChars) return [t];
  if (isStructured(t)) return chunks(t, c.hardLimit);

  const sentences = mergeTiny(splitSentences(t, Math.min(120, c.maxBubbleChars)), 6);
  if (sentences.length < 2) return chunks(t, c.hardLimit);

  // 每条一句；如果句数超过上限，或者加起来太长，就按字数贪心打包到上限条数。
  let bubbles;
  if (sentences.length <= c.maxBubbles && sentences.every((s) => s.length <= c.maxBubbleChars)) {
    bubbles = sentences.slice();
  } else {
    bubbles = [];
    let cur = '';
    for (const s of sentences) {
      if (!cur) { cur = s; continue; }
      if (cur.length + s.length + 1 <= c.maxBubbleChars && bubbles.length < c.maxBubbles - 1) {
        cur += s;
      } else {
        bubbles.push(cur);
        cur = s;
      }
    }
    if (cur) bubbles.push(cur);
    if (bubbles.length > c.maxBubbles) {
      // 兜底：超出上限的部分并进最后一条（汇总，而不是继续刷屏）
      const keep = bubbles.slice(0, c.maxBubbles - 1);
      keep.push(bubbles.slice(c.maxBubbles - 1).join(''));
      bubbles = keep;
    }
  }
  // 超长单条兜底
  const final = [];
  for (const b of bubbles) {
    if (b.length <= c.hardLimit) final.push(b);
    else final.push(...chunks(b, c.hardLimit));
  }
  return final.filter((x) => x && x.trim());
}

function pickRandom(list, rand) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!arr.length) return null;
  const r = typeof rand === 'function' ? rand() : Math.random();
  return arr[Math.floor(r * arr.length) % arr.length];
}

module.exports = { planBubbles, isStructured, splitSentences, pickRandom, cfgOf, DEFAULTS };
