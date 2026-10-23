# 语音合成

`voice.cjs` 按配置 `voice.engine` 选择引擎：

| engine | 行为 |
| --- | --- |
| `auto`（默认） | 先试 edge-tts（微软神经语音，需联网），失败退 Windows SAPI |
| `edge` | 只用 edge-tts |
| `sapi` | 只用 Windows 自带语音（离线，音质一般） |

## 依赖

- `tts.py` 需要 Python 3 + `edge-tts`：`pip install edge-tts`
- `sapi.ps1` 用 `System.Speech`，Windows 自带，无需安装

配置里 `voice.pythonExe` 指向装了 edge-tts 的解释器；留空则用 PATH 里的 `python`。

## 两个实测坑

1. **代理**：edge-tts 走 aiohttp 且默认读 `HTTP(S)_PROXY`。如果本机代理没开，会报
   `ClientProxyConnectionError`，看起来像网络坏了。`tts.py` 里已经清掉代理变量再调用。
2. **语音名不存在**（例如把 `Xiaoyi` 写成 `Xiaomeng`）会报 `NoAudioReceived`，
   那不是网络问题，换名字即可。

缓存文件写在 `voice/out/`（默认保留最近 40 个），已进 `.gitignore`。
