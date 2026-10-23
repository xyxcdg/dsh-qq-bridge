# dsh-qq-bridge

把 **DeepSeek Harness（DSH）** 接进 **QQ** 的 OneBot v11 桥：一条命令，让 QQ 里的机器人真的能干活——
有人格、会发表情包和语音、会挑时候主动搭话、能把群聊留档、挂了会自己爬起来。

```
QQ 客户端 ──▶ NapCat（OneBot v11）──ws──▶ 本桥 ──spawn──▶ dsh --profile headless --json
   ▲                                                              │
   └──────────────── 把最终文本切成「像人说的」几条消息 ◀──────────┘
```

> 不是又一个「关键词回复」机器人：桥接把整句话交给一个带工具（读写文件、跑命令、操作电脑、查资料）的 agent，
> 再把 agent 的结果按聊天习惯发回去。会话按渠道隔离，上下文可定时换代，长期记忆由 DSH 记忆插件负责。

## 特性

- **一个渠道一个会话**：群、私聊各自独立上下文，互不串台；回复只回到发起渠道。
- **人格写在提示词里**，不是事后改写：语气可以随便萌，但姓名/数字/名单一个字符都不会被动。
- **像人一样回**：短回答一句说完；长内容拆成 2~4 条；名单/表格不拆（拆了就没法抄）。
- **延迟开口**：不是每次都先「收到」，超过 N 秒还没好才说一句，长任务定期报进度。
- **表情包 + 语音**：结束时按概率发一张（避开最近发过的 12 张）；可选 edge-tts / Windows SAPI 语音回复。
- **主动搭话**：安静够久、今天没超次数、不是深夜、不忙——才让模型决定说不说；模型回 `SKIP` 就真的不说。
- **活动留档**：指定群的所有消息（含纯图片、入群退群）按天追加到 JSONL，可追溯谁在什么时候说了什么。
- **渠道级限额与用途边界**：按渠道累计 token、到上限拒绝；按渠道注入「本群只允许办公类任务」这类约束。
- **长任务不装死**：排队串行执行、超时杀进程、进度播报、失败说人话。
- **运营脚本**：Windows 计划任务开机自启 + 看门狗自动重启；一键装/卸。

## 前置条件

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 18 | 桥接本体只依赖 `ws` |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | 提供 OneBot v11 WebSocket（默认 `ws://127.0.0.1:3001`） |
| DeepSeek Harness | 提供 `dsh` CLI；桥接用 `--profile headless --json` 跑一次性任务 |
| Windows（可选） | 只有「开机自启 + 隐藏窗口 + 看门狗」的脚本是 PowerShell |

## 快速开始

```bash
git clone https://github.com/xyxcdg/dsh-qq-bridge.git
cd dsh-qq-bridge
npm install
copy bridge.config.example.json bridge.config.json   # Windows
# cp bridge.config.example.json bridge.config.json    # macOS / Linux
```

编辑 `bridge.config.json`，至少改这五项：

```jsonc
{
  "selfQQ": "10001",          // 机器人自己的 QQ 号
  "masterQQ": "10002",        // 主人（唯一能下命令的人）
  "allowedPrivateUsers": ["10002"],
  "allowedGroups": ["100000001"],
  "dshBin": "C:/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js"
}
```

其余留空会自动推断：`dshHome` → `$DSH_HOME` 或 `~/.dsh`，`nodeExe` → 当前 node，`dshCwd` → 启动目录。

跑起来：

```bash
npm start                 # 前台，日志同时写 bridge.log
node bridge.js --selftest # 不连 NapCat、不跑 DSH，只验「切条 + 挑表情」
node bridge.js --check-stickers  # 数一下表情池里有几张
```

连上 OneBot 且白名单里有人在，就会收到一条「本喵上线啦」。

## 配置速查

完整字段见 [`bridge.config.example.json`](./bridge.config.example.json)（带逐项 `_note` 注释）。最常改的：

| 字段 | 作用 |
| --- | --- |
| `onebotWs` / `onebotToken` | NapCat 的 WebSocket 地址与 token |
| `selfQQ` / `masterQQ` | 机器人号 / 主人号（`masterOnlyCommands=true` 时只有主人能下命令） |
| `triggerWord` | 群里必须带的触发词；私聊是否需要由 `privateRequireTrigger` 决定 |
| `allowedGroups` / `allowedPrivateUsers` | 准入白名单（不在里面的消息直接忽略，并留日志） |
| `openTriggerGroups` | 向全体成员开放的群（成员带触发词即可用） |
| `replyMode` | `channel`=结果回发起渠道；`private`=一律只私聊主人 |
| `activityGroups` | 需要全量留档的群 |
| `replyStyle.promptPrefix` | 人格与风格（写进提示词，不做事后改写） |
| `chatStyle` | 延迟开口、进度话术、拆条参数 |
| `proactive` | 主动搭话的门（默认关闭） |
| `voice` | 语音回复（默认关闭） |
| `channelTokenBudget` | 按渠道累计 token 上限 |
| `channelScopes` | 按渠道注入任务边界（如「本群只允许办公类任务」） |
| `sessionLock` | 把某渠道钉死在指定会话上；会话消失时报错而不是静默换新 |

## 目录结构

```
bridge.js                 # 主进程：OneBot 连接、消息准入、任务队列、调 DSH、发送
humanize.cjs              # 纯函数：把一段回复排成「一条 / 几条」
proactive.cjs             # 纯函数：主动搭话的门（安静时长/每日上限/静默时段/忙碌）
voice.cjs                 # 语音合成（edge-tts → Windows SAPI 回退）
stickers-fetch.cjs        # 抓表情候选图，人工过一遍再入库
voice/tts.py, voice/sapi.ps1
test/                     # 四个回归测试，npm test 一次跑完
scripts/                  # Windows 安装/卸载/看门狗
docs/                     # 架构、配置、部署、设计笔记
```

## 测试

```bash
npm test
```

覆盖四件事：触发词解析（中文没有词边界，`喵喵自己修复` 也算命令）、
`self_id` 陷阱（判断「是不是自己发的」必须看发送者）、
回复切分（不丢字、名单不拆）、主动搭话的门（九种不该开口的情形）。

## Windows：开机自启 + 自愈

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-tasks.ps1
powershell -ExecutionPolicy Bypass -File scripts/install-tasks.ps1 -Uninstall
```

装两个计划任务：登录时隐藏启动桥接；每 3 分钟检查 `heartbeat.json`，心跳超过 90 秒且进程不在就重新拉起。
窗口通过 `wscript` + `sh.Run(..., 0, ...)` 隐藏——直接把 `powershell.exe` 写进任务动作一定会闪窗。
详见 [`docs/deployment.md`](./docs/deployment.md)。

## 设计笔记（踩过的坑，都写进代码了）

1. **`self_id` 永远是机器人自己**。判断「这条消息是不是我发的」必须比 `user_id`；比 `self_id` 会把每一条消息都丢掉，而且日志里一个字都没有。
2. **一个渠道一个会话**。共用一个会话 = 群里能问出私聊里的内容；已绑定的会话在磁盘上消失时必须报错，不能静默换一个新的（那等于悄悄丢掉上下文）。
3. **风格写进提示词，不做文本后处理**。事后正则改写会碰到姓名、数字、名单——一次替换就能把名单改错。
4. **判「上下文满载」看 `totalTokens`，不是 `inputTokens`**。后者只是本轮新增，用它当阈值会导致「永不换代」，会话一路涨到几十万 tokens/轮。
5. **失败兜底只说人话**。exit code、英文 stderr、内部路径只进日志，不给用户看。
6. **静默丢弃必须有日志**。空文本、未授权、不含触发词……每一条被忽略的分支都要留一行，否则「被忽略」和「链路断了」在用户眼里一模一样。
7. **串台闸放在发送函数里**。目的地与发起渠道不一致就改回发起渠道并告警——靠结构而不是靠每个新代码路径自己记得。

更细的架构与取舍见 [`docs/architecture.md`](./docs/architecture.md) 与 [`docs/design-notes.md`](./docs/design-notes.md)。

## 隐私与安全

- 默认 `masterOnlyCommands: true`：只有 `masterQQ` 能下命令；其他人只被留档/忽略。
- 群是公开渠道：提示词里明确要求不要把本机路径、进程、私事带进群；有需要可把 `replyMode` 设成 `private`。
- `bridge.config.json`、`state.json`、`activity/`、日志都已进 `.gitignore`。**不要把真实 QQ 号、token、聊天记录提交上来。**
- 桥接会以 `DSH_PERMISSION_MODE=danger-full-access` 拉起 DSH（否则 agent 在 headless 下做不了事）。请只在自己的机器上跑，并想清楚「谁能给机器人下命令」。

## FAQ

**机器人完全不理人？** 先看 `bridge.log` 有没有任何一行。连「不含触发词」都没有 ⇒ 消息没到桥接，去查 NapCat 与 QQ 账号状态（掉线时端口照样监听）。

**回了「退出码 1」？** 那是 DSH 调用失败：看 `bridge.log` 的 stderr 段，通常是 `dshBin` 路径错、profile 不存在，或者模型凭据没配。

**语音没声音？** `voice.enabled=true` 且需要 `edge-tts`（`pip install edge-tts`）或 Windows 自带语音；看日志里的 `语音跳过(...)` 原因。

**能不能不接 DSH？** 可以，但需要改 `pump()`：桥接只依赖 DSH 的 `--json` 事件（`session` / `text` / `final` / `status.step_end.usage`），换成别的 CLI 时按这四个事件产出即可。

## License

[MIT](./LICENSE)。表情包/语音素材请自行确认版权，仓库不带任何第三方图片。
