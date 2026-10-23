# -*- coding: utf-8 -*-
"""用本地 ChatTTS 权重合成几句，供试听（3 个说话人 + 1 个升调版）。"""
import os, sys, traceback
for k in list(os.environ):
    if k.lower() in ("http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(k, None)

BASE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.environ.get("CHATTTS_MODELS", os.path.join(BASE, "models", "chattts"))
OUT = os.environ.get("CHATTTS_OUT", os.path.join(BASE, "out"))

TEXT = "主人主人，本喵在这儿喵～今天也要好好吃饭哦。"

def main():
    import torch, ChatTTS, soundfile as sf
    print("load custom ...", flush=True)
    chat = ChatTTS.Chat()
    ok = chat.load(source="custom", custom_path=MODELS, compile=False)
    print("loaded", ok, flush=True)
    for seed in (1, 42, 2026):
        torch.manual_seed(seed)
        spk = chat.sample_random_speaker()
        params = ChatTTS.Chat.InferCodeParams(spk_emb=spk, prompt="[speed_6]", temperature=0.3)
        wavs = chat.infer([TEXT], params_infer_code=params, use_decoder=True)
        out = os.path.join(OUT, "chattts-seed%d.wav" % seed)
        sf.write(out, wavs[0], 24000)
        print("saved", out, os.path.getsize(out), flush=True)
    print("ALL DONE", flush=True)

if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc(); sys.exit(1)
