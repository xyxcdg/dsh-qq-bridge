# dsh-qq-bridge

把 **DeepSeek Harness（DSH）** 接进 **QQ** 的 OneBot v11 桥：一个真的能干活、也有点自己的机器人后端。
人格、称呼、心情、自我状态、语音、表情包、主动搭话、群聊留档、会话换代、可视化面板、账号自愈——都在这一套里。

```
QQ 客户端 ──▶ NapCat（OneBot v11）──ws──▶ 本桥 ──spawn──▶ dsh --profile headless --json
   ▲                                                          │
   └──────────── 人格/心情/自我状态 注入提示词，结果切成「像人说的」几条 ◀────────┘
```

> 不是关键词回复机器人：每条命令交给一个带工具（读写文件、跑命令、操作电脑、查资料）的 agent，
> 再把结果按聊天习惯发回去。不同渠道各自一条对话线，上下文到点换代，长期记忆交给 DSH 侧的记忆插件。

## 功能

**对话**
- 触发词「出现即算」（中文没有词边界），支持别名、@ 机器人；私聊可免触发。
- 一个渠道一个会话；已绑定的会话在磁盘上消失时报错，绝不静默换新。
- 结果回到发起渠道；发送函数里有一道「串台闸」，目的地不对就改回发起渠道并告警。
- 长任务不装死：延迟开口、定期报进度、超时杀进程；失败只说人话。
- 新消息可插队：慢任务先让位，答完新消息再回到队尾重跑（`preemptAfterMs`）。

**人格与状态**
- 称呼三档：主人用 `addressing.master`，其他人按 QQ 资料性别叫哥哥/姐姐，查不到叫同学。
- 心情引擎：被夸→开心/得意，被凶→委屈/炸毛，被哄→消气，深夜自动困；3 小时掉 1 分，最多 9 小时回 calm。
- 自我状态：第几天、回过几次话、对每个渠道的亲近度与一句印象、未了的心事（说过就标记）、被纠正过的习惯、疲惫值。
  **全部落盘、跨重启**，并写死三条边界：只改语气与注意力、数字以工具为准、记忆里的隐私不外泄。
- 人格卡 `persona.md` 追加在提示词后面，不覆盖风格块。

**多媒体**
- 语音回复：`edge-tts`（神经语音）→ Windows SAPI；可选 ChatTTS / GPT-SoVITS 本地音色。
- 语音听得懂：QQ 语音 → ffmpeg 转 wav → 百炼 `qwen3-asr-flash` 转写；失败明确说「没听清」。
- 表情包：按概率发，避开最近 12 张；`stickers/` 下划线目录是人工审核区，永不发送。
- 语音/图片都能进任务正文，不再「只看到文字」。

**群运营**
- 全量留档：指定群的所有消息（含纯图片、入群退群）按天追加 JSONL，可追溯。
- 群聊搭话：四道门（白名单/安静期+每日上限/静默时段/不忙）+ 模型回 `SKIP` 就闭嘴。
- 按渠道注入任务边界（例如「本群只开放办公类任务」）与按渠道 token 限额。

**运维**
- 单实例锁 + 心跳；计划任务看门狗；账号离线自愈（探测 `get_login_info`，不是只看端口）。
- 本地控制台：`http://127.0.0.1:8123`（只绑 loopback，写操作要自定义 header）。
- MCP：把状态/配置/运维动作暴露成 `mcp__qqbot__*` 工具，接进 DSH。

## 模块

| 文件 | 职责 |
| --- | --- |
| `bridge.js` | 主进程：OneBot 连接、准入、队列、调 DSH、发送、状态落盘 |
| `humanize.cjs` | 纯函数：把回复排成一条/几条（名单表格不拆） |
| `proactive.cjs` | 纯函数：主动搭话的门 |
| `self.cjs` | 自我状态：连续性/关系/心事/注意力/习惯/疲惫 + 日记 |
| `mood.cjs` | 心情引擎：信号识别、迁移、半衰期、提示词渲染 |
| `senses.cjs` | 五官：本地视觉模型看屏幕、身体读数（电量/内存/CPU/前台窗口） |
| `voice.cjs` | 语音合成：edge → ChatTTS → GPT-SoVITS → SAPI，可转 amr/silk |
| `asr.cjs` | 语音转文字（百炼 ASR） |
| `persona.md` | 人格卡（可替换成你自己的角色） |
| `panel-server.cjs` / `panel.html` | 本地控制台（状态、会话、自我状态、日志尾部、白名单配置） |
| `mcp-qqbot.cjs` | MCP stdio server：`status` / `config_get` / `config_set` / `action` / `panel` |
| `qq-probe.cjs` / `qq-selfheal.ps1` / `qq-notify-all.cjs` | 账号探活、自愈、全渠道通知 |

## 前置条件

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 18 | 桥接只依赖 `ws` |
| [NapCat](https://github.com/NapNeko/NapCatQQ) | 提供 OneBot v11 WebSocket（默认 `ws://127.0.0.1:3001`） |
| DeepSeek Harness | 提供 `dsh` CLI；桥接用 `--profile headless --json` 跑一次性任务 |
| Windows（可选） | 隐藏启动、计划任务、账号自愈脚本是 PowerShell |
| Python 3（可选） | 只有 edge-tts / ChatTTS / GPT-SoVITS 语音引擎需要 |

## 快速开始

```bash
git clone https://github.com/xyxcdg/dsh-qq-bridge.git
cd dsh-qq-bridge
npm install
copy bridge.config.example.json bridge.config.json   # Windows
# cp bridge.config.example.json bridge.config.json    # macOS / Linux
```

最少改五项：

```jsonc
{
  "selfQQ": "10001",
  "masterQQ": "10002",
  "allowedPrivateUsers": ["10002"],
  "allowedGroups": ["100000001"],
  "dshBin": "C:/path/to/node_modules/@deepseek-ai/dsh/lib/bin.js"
}
```

```bash
npm start                      # 前台，日志同时写 bridge.log
node bridge.js --selftest      # 不连 NapCat、不跑 DSH，只验「切条 + 挑表情」
node bridge.js --check-stickers
```

## 配置速查

完整字段见 `bridge.config.example.json`（每个键都带 `_note`）。常改的：

| 字段 | 作用 |
| --- | --- |
| `triggerWord` / `triggerAliases` | 群里必须带的词；出现即算，不要求词边界 |
| `privateRequireTrigger` / `privateTriggerForOthers` | 私聊是否要触发词（两个开关叠加，注意组合） |
| `allowedGroups` / `allowedPrivateUsers` / `openTriggerGroups` | 准入与开放群 |
| `masterOnlyCommands` | 只有主人能下命令 |
| `replyMode` | `channel` 回发起渠道 / `private` 一律私聊主人 |
| `addressing` | 称呼三档 |
| `replyStyle` / `chatStyle` | 人格与说话方式（写进提示词，不做事后改写） |
| `personaMood` / `self` | 心情引擎、自我状态 |
| `proactive` / `groupChime` | 私聊主动搭话、群聊搭话（都默认关） |
| `voice` | 语音引擎与概率 |
| `sessionRecycle` | 按 token 或年龄换代 |
| `channelScopes` / `channelContext` | 按渠道注入任务边界与本群职责 |
| `channelTokenBudget` | 按渠道累计 token 上限 |
| `sessionLock` | 钉死会话；会话消失时报错 |

## 可选能力

- **视觉**：本机跑 `ollama` 且有视觉模型（如 `qwen2.5vl:3b`）时，`senses.cjs` 会截图→缩图→只把一句描述写进提示词；图片不进历史。
- **语音**：`pip install edge-tts` 即可用神经语音；ChatTTS 需要本地权重与服务（`voice/tts_server.py`）；GPT-SoVITS 用 `QQ_BOT_GSV_ROOT` 指向安装目录。
- **ASR**：需要 `DASHSCOPE_API_KEY`（写进环境或 `$DSH_HOME/.env`）与 `ffmpeg`（`QQ_BOT_FFMPEG` 可指定路径）。
- **面板**：`npm run panel`，浏览器打开 `http://127.0.0.1:8123`（只读状态 + 白名单字段修改）。
- **MCP**：在 `$DSH_HOME/cordis.patch.yml` 的 `- insert:` 里加一个 `@deepseek-ai/dsh-mcp-client`，命令指向 `mcp-qqbot.cjs`。

## 测试

```bash
npm test
```

11 个测试，覆盖：触发词解析、`self_id` 陷阱、回复切分、主动搭话门、自我状态、心情迁移、日记、称呼三档（真起一个假 OneBot + 假 DSH，断言**真正发出去的提示词**）、白名单矩阵、插队顺序、按时间换代。

## Windows：开机自启 + 自愈

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-tasks.ps1
powershell -ExecutionPolicy Bypass -File scripts/install-tasks.ps1 -Uninstall
```

装两个计划任务：登录时用 `wscript` 隐藏启动；每 3 分钟检查 `heartbeat.json`。账号离线自愈另见 `qq-selfheal.ps1`（需要 `QQ_BOT_NAPCAT_VBS` 指向 NapCat 的隐藏启动脚本）。

## 设计笔记（都踩过）

1. **`self_id` 永远是机器人自己**：判断「是不是我发的」要比 `user_id`，否则每条消息都在日志之前被丢掉。
2. **一个渠道一个会话**：共用会让群里问出私聊内容；会话消失必须报错，不能静默换新。
3. **风格写进提示词**：事后正则改写会碰到姓名、数字、名单。
4. **满载看 `totalTokens`**：`inputTokens` 只是本轮新增，用它当阈值会导致「永不换代」，会话涨到几十万 tokens/轮。
5. **失败兜底只说人话**：exit code、英文 stderr 只进日志。
6. **静默丢弃必须留痕**：空文本、未授权、不含触发词……每条都留一行，否则「被忽略」和「链路断了」长得一样。
7. **串台闸放在发送函数里**：靠结构，不靠每个新代码路径自己记得。
8. **状态必须落盘**：只在内存里 tick 的心情，重启就是假的；时间衰减不能设比 tick 间隔还大的死区。
9. **控制组/夹具取自真实输出**：自己臆造的事件形状只能证明「代码能跑」，证明不了「线上会走这条分支」。
10. **长任务要能插队**：不给新消息让位，用户看到的就是「它不理我」。

更细的取舍见 `docs/design-notes.md`。

## 隐私与安全

- 默认只有 `masterQQ` 能下命令；群是公开渠道，提示词里明确要求不带本机路径、进程、私事。
- `bridge.config.json`、`state.json`、`activity/`、`tmp/`、日志、语音缓存、表情图都在 `.gitignore` 里。
- 桥接以 `DSH_PERMISSION_MODE=danger-full-access` 拉起 DSH（否则 headless 下做不了事）。只在自己的机器上跑，并想清楚「谁能给机器人下命令」。

## FAQ

**完全不理人？** 先看 `bridge.log` 有没有任何一行。连「不含触发词」都没有 ⇒ 消息没到桥接，去查 NapCat 与账号状态（掉线时端口照样监听）。

**回了「执行失败」？** 看日志里的 stderr：`dshBin` 路径、profile、模型凭据。

**回复很慢？** 看每轮的 `token 用量` 与「会话换代」日志；上下文太大就开换代或瘦身记忆注入。

**能不能不接 DSH？** 可以，但要改 `pump()`：桥接依赖 DSH 的 `--json` 事件（`session` / `text` / `final` / `status.step_end.usage`）。

## License

[MIT](./LICENSE)。仓库不带任何第三方图片/音频；表情与音色请自行确认版权。
