# -*- coding: utf-8 -*-
"""ChatTTS 常驻服务：模型只加载一次，之后按请求合成。

POST /tts   {"text": "...", "out": "C:\\\\...\\\\x.wav", "seed": 42}
GET  /health -> {"ok": true}

为什么常驻：ChatTTS 加载一次约 20~40 秒，每次说话都重新加载不可用；
桥接在第一次要发语音时把它拉起来，之后一直复用。
"""
import json, os, sys, threading, traceback
for k in list(os.environ):
    if k.lower() in ("http_proxy", "https_proxy", "all_proxy"):
        os.environ.pop(k, None)

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.environ.get("CHATTTS_MODELS", os.path.join(BASE, "models", "chattts"))
PORT = int(os.environ.get("CHATTTS_PORT", "8571"))
SEED = int(os.environ.get("CHATTTS_SEED", "42"))

chat = None
spk = None
lock = threading.Lock()


def init():
    global chat, spk
    import torch, ChatTTS
    c = ChatTTS.Chat()
    ok = c.load(source="custom", custom_path=MODELS, compile=False)
    if not ok:
        raise RuntimeError("load failed")
    torch.manual_seed(SEED)
    spk = c.sample_random_speaker()
    chat = c
    print("TTS server ready on %d (seed=%d)" % (PORT, SEED), flush=True)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": chat is not None})
        else:
            self._json(404, {"ok": False})

    def do_POST(self):
        if self.path != "/tts":
            self._json(404, {"ok": False}); return
        try:
            n = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(n).decode("utf-8"))
            text = (req.get("text") or "").strip()
            out = req.get("out")
            seed = int(req.get("seed", SEED))
            speed = str(req.get("speed", "[speed_6]"))
            if not text or not out:
                self._json(400, {"ok": False, "error": "text/out required"}); return
            import torch, ChatTTS, soundfile as sf
            with lock:
                torch.manual_seed(seed)
                s = chat.sample_random_speaker()
                params = ChatTTS.Chat.InferCodeParams(spk_emb=s, prompt=speed, temperature=0.3)
                wavs = chat.infer([text], params_infer_code=params, use_decoder=True)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            sf.write(out, wavs[0], 24000)
            self._json(200, {"ok": True, "path": out, "bytes": os.path.getsize(out)})
        except Exception as e:
            traceback.print_exc()
            self._json(500, {"ok": False, "error": "%s: %s" % (type(e).__name__, e)})


if __name__ == "__main__":
    init()
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
