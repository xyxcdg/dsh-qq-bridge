'use strict';
/**
 * 从图片搜索抓「表情包」-> 候选池（stickers/_incoming/<时间戳>/），人工看一遍再入库。
 *
 * 用法：
 *   node stickers-fetch.cjs                      # 默认关键词，下 30 张到 _incoming
 *   node stickers-fetch.cjs 摸鱼表情包 鲸鱼表情包   # 自定义关键词
 *   node stickers-fetch.cjs --limit 60
 *   node stickers-fetch.cjs --list               # 看候选
 *   node stickers-fetch.cjs --approve 003.jpg 007.png   # 把选中的移进 memes/web/（= 进入发送池）
 *   node stickers-fetch.cjs --clean              # 清空 _incoming
 *
 * 为什么要人工过一遍：机器能筛「是不是图、清不清晰、是不是同一张」，
 * 但筛不掉内容是否合适；入库这一步必须有人看一眼，别做全自动。
 * 注意：网络抓来的图片版权不明，请只作自用/测试，商用前自行确认授权。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = __dirname;
const INCOMING = path.join(BASE, 'stickers', '_incoming');
const POOL = path.join(BASE, 'stickers', 'memes', 'web');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36';

// 默认关键词可按自己的角色替换（也可命令行传参）：node stickers-fetch.cjs 猫猫表情包 摸鱼表情包
const DEFAULT_KEYWORDS = (process.env.QQ_BOT_STICKER_KEYWORDS || '表情包,摸鱼表情包,猫猫表情包').split(',');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function sniff(buf) {
  if (buf.length > 4 && buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.length > 3 && buf.toString('ascii', 0, 3) === 'GIF') return '.gif';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return null;
}

function httpGet(url, optsOrRedirects) {
  const opts = (optsOrRedirects && !Number.isInteger(optsOrRedirects)) ? optsOrRedirects : {};
  const redirects = Number.isInteger(optsOrRedirects) ? optsOrRedirects : (opts.redirects || 0);
  return new Promise((resolve, reject) => {
    const https = require('https');
    // 本机全局设了 NODE_USE_ENV_PROXY=1 + HTTP(S)_PROXY=127.0.0.1:7890（代理没开），
    // 不显式给 agent 的话 https.get 也会被塞进那个代理并 ECONNREFUSED。
    // 实测：显式 agent / agent:false 会绕过 env 代理，直连 200。
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: opts.referer || 'https://image.baidu.com/' },
      timeout: 15000,
      agent: new https.Agent({ keepAlive: false }),
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && (redirects || 0) < 5) {
        res.resume();
        resolve(httpGet(new URL(res.headers.location, url).toString(), Object.assign({}, opts, { redirects: redirects + 1 })));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => { size += d.length; if (size <= 10 * 1024 * 1024) chunks.push(d); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

// 百度图片 JSON 接口：一次 30 条，字段 middleURL/thumbURL 是 baidu 自己的 500px 缩略图
// （原图 URL 常被防盗链挡，缩略图够表情包用且一定能下）。
async function baiduUrls(keyword, pn) {
  const url = 'https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&word=' +
    encodeURIComponent(keyword) + '&pn=' + (pn || 0) + '&rn=30&face=0&istype=2&ie=utf-8&oe=utf-8';
  const buf = await httpGet(url, { Referer: 'https://image.baidu.com/' });
  if (!buf) return [];
  let json;
  try { json = JSON.parse(buf.toString('utf8')); } catch (_) { return []; }
  const data = (json && json.data) || [];
  return data
    .filter((x) => x && (x.middleURL || x.thumbURL))
    .map((x) => ({ url: x.middleURL || x.thumbURL, title: String(x.fromPageTitleEnc || ''), w: x.width, h: x.height }))
    .filter((x) => x.url && /^https?:/.test(x.url));
}

async function download(url) {
  try {
    const buf = await httpGet(url);
    if (!buf) return null;
    if (buf.length < 8000 || buf.length > 8 * 1024 * 1024) return null;
    const ext = sniff(buf);
    if (!ext) return null;
    return { buf, ext, hash: crypto.createHash('sha1').update(buf).digest('hex') };
  } catch (_) {
    return null;
  }
}

function listIncoming() {
  if (!fs.existsSync(INCOMING)) return { dir: null, files: [] };
  const dirs = fs.readdirSync(INCOMING).filter((d) => fs.statSync(path.join(INCOMING, d)).isDirectory()).sort();
  if (!dirs.length) return { dir: null, files: [] };
  const dir = path.join(INCOMING, dirs[dirs.length - 1]);
  const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f)).sort();
  return { dir, files };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--list') {
    const { dir, files } = listIncoming();
    if (!dir) { console.log('没有候选目录（先跑一次抓取）'); return; }
    console.log('候选目录: ' + dir + '（' + files.length + ' 张）');
    files.forEach((f) => console.log('  ' + f));
    return;
  }
  if (argv[0] === '--clean') {
    if (fs.existsSync(INCOMING)) {
      for (const d of fs.readdirSync(INCOMING)) fs.rmSync(path.join(INCOMING, d), { recursive: true, force: true });
    }
    console.log('已清空 _incoming');
    return;
  }
  if (argv[0] === '--approve') {
    const names = argv.slice(1);
    if (!names.length) { console.log('用法: --approve <文件名...>'); process.exit(2); }
    const { dir, files } = listIncoming();
    if (!dir) { console.log('没有候选目录'); process.exit(2); }
    fs.mkdirSync(POOL, { recursive: true });
    let ok = 0, miss = 0;
    for (const n of names) {
      if (files.indexOf(n) < 0) { console.log('跳过（不在最新候选里）: ' + n); miss++; continue; }
      const target = path.join(POOL, n.replace(/\.(png|jpe?g|gif|webp)$/i, '-web$&'));
      fs.copyFileSync(path.join(dir, n), target);
      console.log('入库: ' + path.basename(target));
      ok++;
    }
    console.log('入库 ' + ok + ' 张，跳过 ' + miss + ' 张 -> ' + POOL);
    return;
  }

  let limit = 30;
  const li = argv.indexOf('--limit');
  if (li >= 0) { limit = Math.max(1, Number(argv[li + 1]) || 30); argv.splice(li, 2); }
  const keywords = argv.length ? argv : DEFAULT_KEYWORDS;
  const outDir = path.join(INCOMING, stamp());
  fs.mkdirSync(outDir, { recursive: true });

  const seen = new Set();
  let saved = 0, tried = 0;
  for (const kw of keywords) {
    for (let page = 0; page < 3 && saved < limit; page++) {
      let items = [];
      try { items = await baiduUrls(kw, page * 30); } catch (e) { console.log('[!] 搜索失败 ' + kw + ': ' + e.message); break; }
      console.log('[搜索] ' + kw + ' 第' + (page + 1) + '页 -> ' + items.length + ' 条');
      if (!items.length) break;
      for (const it of items) {
        if (saved >= limit) break;
        tried++;
        const got = await download(it.url);
        if (!got) continue;
        if (seen.has(got.hash)) continue;
        seen.add(got.hash);
        const name = String(saved).padStart(3, '0') + got.ext;
        fs.writeFileSync(path.join(outDir, name), got.buf);
        fs.appendFileSync(path.join(outDir, 'index.txt'), name + '\t' + it.title + '\t' + it.url + '\n');
        saved++;
      }
    }
    if (saved >= limit) break;
  }
  console.log('下载 ' + saved + ' 张（试了 ' + tried + ' 个链接）-> ' + outDir);
  console.log('下一步：看一遍图（不许不正经的），再 node stickers-fetch.cjs --approve <文件名...> 入库');
}

main().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
