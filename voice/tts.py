# -*- coding: utf-8 -*-
"""TTS：把一段中文说成 mp3（edge-tts 微软神经语音，声音最像真人）。

用法（由 voice.cjs 调用，不直接给人用）：
    python tts.py --text-file <utf8.txt> --out <x.mp3> --voice zh-CN-XiaoyiNeural --rate +8% --pitch +0Hz

两条本机实测纪律：
1) **必须清掉代理环境变量**：本机全局 HTTP(S)_PROXY 指向 127.0.0.1:7890，而代理常关；
   edge-tts 用 aiohttp 且 trust_env，会去连那个死代理并报 ClientProxyConnectionError。
2) 语音名必须是真实的：zh-CN-XiaomengNeural 之类不存在，会报 NoAudioReceived（不是网络问题）。
"""
import argparse, asyncio, os, sys

for _k in list(os.environ):
    if _k.lower() in ("http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(_k, None)

import edge_tts


async def run(args):
    with open(args.text_file, "r", encoding="utf-8") as f:
        text = f.read().strip()
    if not text:
        print("EMPTY_TEXT", file=sys.stderr)
        return 2
    c = edge_tts.Communicate(text, args.voice, rate=args.rate, pitch=args.pitch, proxy=None)
    await c.save(args.out)
    if not os.path.exists(args.out) or os.path.getsize(args.out) < 2000:
        print("TOO_SMALL", file=sys.stderr)
        return 3
    print("OK %d" % os.path.getsize(args.out))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text-file", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default="zh-CN-XiaoyiNeural")
    ap.add_argument("--rate", default="+8%")
    ap.add_argument("--pitch", default="+0Hz")
    a = ap.parse_args()
    try:
        sys.exit(asyncio.run(run(a)))
    except Exception as e:
        print("ERR %s: %s" % (type(e).__name__, e), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
