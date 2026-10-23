'use strict';
/**
 * 主动搭话的门（纯函数，无 IO）：决定「这一刻该不该由机器人先开口」。
 *
 * 为什么要单独抽出来：主动说话是最容易把机器人做烦的功能。
 * 判据必须是可机械检验的（安静多久、今天说过几次、是不是深夜、忙不忙），
 * 而不是"想起来就说一句"。这里只做门；说什么由模型按上下文决定。
 */

function localDayKey(now) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function inQuietHours(hour, quiet) {
  const q = Array.isArray(quiet) && quiet.length === 2 ? quiet : [23, 8];
  const from = Number(q[0]);
  const to = Number(q[1]);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
  if (from === to) return false;
  // 跨午夜：23 -> 8 表示 [23,24) ∪ [0,8)
  return from < to ? (hour >= from && hour < to) : (hour >= from || hour < to);
}

/**
 * @param {object} o
 * @param {number} o.now 当前毫秒时间戳
 * @param {number} [o.hour] 当前小时（本地），缺省从 now 推
 * @param {boolean} [o.busy] 桥接是否正在跑任务
 * @param {object} o.cfg 整个 bridge.config.json
 * @param {object} o.state state.json（用到 proactive / lastUserAt）
 * @param {function} [o.rand] 随机源，测试用
 */
function proactiveGate(o) {
  const cfg = o.cfg || {};
  const P = cfg.proactive || {};
  const state = o.state || {};
  const now = Number(o.now) || Date.now();
  const hour = Number.isFinite(o.hour) ? o.hour : new Date(now).getHours();
  const rand = typeof o.rand === 'function' ? o.rand : Math.random;

  if (P.enabled !== true) return { allow: false, reason: 'disabled' };
  if (o.busy) return { allow: false, reason: 'busy' };

  if (inQuietHours(hour, P.quietHours)) return { allow: false, reason: 'quiet-hours' };

  const day = localDayKey(now);
  const pr = state.proactive || {};
  const count = pr.day === day ? Number(pr.count || 0) : 0;
  if (count >= (Number(P.maxPerDay) || 2)) return { allow: false, reason: 'daily-cap', count };

  const lastUserAt = Number((state.lastUserAt || {})['private:' + String(cfg.masterQQ || '')] || 0);
  const silenceMs = lastUserAt ? (now - lastUserAt) : 0;
  // 从没说过话（没有记录）不算"安静很久"，否则一上线就会主动找人说第一句。
  if (!lastUserAt) return { allow: false, reason: 'no-history' };
  if (silenceMs < (Number(P.minSilenceMs) || 3 * 3600 * 1000)) {
    return { allow: false, reason: 'too-soon', silenceMs };
  }
  if (rand() > (Number.isFinite(Number(P.probability)) ? Number(P.probability) : 0.5)) {
    return { allow: false, reason: 'dice' };
  }
  return { allow: true, reason: 'ok', day, count, silenceMs };
}

/** 模型吐出来的东西能不能当"主动搭话"发出去：只收很短的一句，SKIP 一律丢弃。 */
function acceptProactive(text, maxChars) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (/^skip\b/i.test(t) || /\bSKIP\b/.test(t.slice(0, 20))) return { ok: false, reason: 'model-skip' };
  if (t.length > (Number(maxChars) || 60)) return { ok: false, reason: 'too-long' };
  if ((t.match(/\n/g) || []).length > 1) return { ok: false, reason: 'too-many-lines' };
  if (/【|】/.test(t)) return { ok: false, reason: 'template-leak' };
  return { ok: true, text: t };
}

module.exports = { proactiveGate, acceptProactive, inQuietHours, localDayKey };
