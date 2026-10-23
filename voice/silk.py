# -*- coding: utf-8 -*-
"""mp3 -> silk（QQ 原生语音格式，24kHz）。由 voice.cjs 调用。

为什么要自己转 silk：把 mp3 交给 NapCat 发，它会转成 **AMR-NB（8kHz 电话音）**，
听起来就是"机械音/电子音"。自己转成 silk 再发，NapCat 原样上传，QQ 端按 24kHz 播，明显干净。
依赖：ffmpeg（C:\Tools\ffmpeg\bin\ffmpeg.exe）+ pilk（pip install pilk）。
"""
import argparse, os, subprocess, sys
import pilk

FFMPEG = r"C:\Tools\ffmpeg\bin\ffmpeg.exe"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mp3", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--rate", type=int, default=24000)
    a = ap.parse_args()
    pcm = a.out + ".pcm"
    try:
        subprocess.run([FFMPEG, "-y", "-v", "error", "-i", a.mp3, "-ar", str(a.rate), "-ac", "1", "-f", "s16le", pcm], check=True)
        # 关键：第 5 个参数 tencent=True。签名是 encode(pcm, silk, pcm_rate, silk_rate, tencent, ...)，
        # 只传 3 个参数时 tencent=False ⇒ 少了腾讯需要的 0x02 头，QQ 客户端会「听不了」。
        pilk.encode(pcm, a.out, a.rate, a.rate, True)
        size = os.path.getsize(a.out)
        if size < 2000:
            print("TOO_SMALL %d" % size, file=sys.stderr)
            return 3
        print("OK %d" % size)
        return 0
    except Exception as e:
        print("ERR %s: %s" % (type(e).__name__, e), file=sys.stderr)
        return 1
    finally:
        try:
            os.unlink(pcm)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
