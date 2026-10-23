# 配置说明

把 `bridge.config.example.json` 复制成 `bridge.config.json`。带 `_note` 的键只是注释，删掉不影响运行。
配置文件路径可用环境变量 `QQ_BOT_CONFIG` 指定；改完必须重启桥接（只在启动时读一次）。

## 连接

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `onebotWs` | `ws://127.0.0.1:3001` | NapCat 的 OneBot WebSocket 地址 |
| `onebotToken` | 空 | 有就发 `Authorization: Bearer <token>` |

## 身份与准入

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `selfQQ` | 必填 | 机器人自己的号（用于丢弃自己发的消息、识别 @） |
| `masterQQ` | 必填 | 主人号；额度豁免、主动搭话对象、默认回复目标 |
| `triggerWord` | `喵喵` | 群里必须带；匹配语义是「出现即算」，不要求词边界（中文没有词边界） |
| `allowedPrivateUsers` | `[]` | 允许私聊的 QQ（空 = 不允许任何人） |
| `allowedGroups` | `[]` | 允许的群 |
| `masterOnlyCommands` | `true` | 只有 `masterQQ` 能下命令；其他人仅留档 |
| `openTriggerGroups` | `[]` | 向全体成员开放的群（仍需带触发词） |
| `privateRequireTrigger` | `true` | 私聊是否也必须带触发词 |
| `replyMode` | `channel` | `channel`=结果回发起渠道；`private`=一律私聊主人 |
| `groupAck` | 空 | 结果不回群时，在群里补的一句固定知会（不要放任务内容） |

## 会话

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `sessionLock.enabled` | `false` | 开启后永不自动新建会话 |
| `sessionLock.sessionId` | 空 | 默认渠道固定会话 |
| `sessionLock.pinned` | `{}` | 按渠道钉死，如 `{"group:100000001": "session-..."}` |
| `taskTimeoutMs` | `900000` | 单任务超时（毫秒） |
| `channelTokenBudget` | `{}` | 按渠道累计 token 上限，如 `{"group:100000001": 200000}` |
| `channelScopes` | `{}` | 按渠道注入任务边界（只对非主人生效） |
| `channelContext` | `{}` | 按渠道注入「本群职责」说明 |

## 人格与说话方式

| 键 | 说明 |
| --- | --- |
| `replyStyle.promptPrefix` | 风格要求，拼在提示词最前面。**只改语气，事实与数字必须原样** |
| `replyStyle.signature` | 尾注（可选） |
| `chatStyle.ackDelayMs` | 超过多久还没结果才说第一句（默认 9000ms） |
| `chatStyle.ackPhrases` / `progressPhrases` | 随机话术，支持 `{seconds}` 占位 |
| `chatStyle.bubbleSplit` | 拆条参数：`maxBubbles` / `maxBubbleChars` / `minTotalChars` / `gapMs` / `hardLimit` |
| `chatStyle.promptBlock` | 「像人一样说话」的硬规则（禁止机器话、别又拆又总结） |

## 表情 / 语音 / 主动搭话

| 键 | 说明 |
| --- | --- |
| `endSticker.dir` / `probability` | 表情池目录（相对路径按桥接目录解析）与发送概率 |
| `voice.enabled` / `engine` | `auto` = edge-tts 失败退 Windows SAPI |
| `voice.pythonExe` | 带 `edge-tts` 的解释器；留空走 PATH |
| `voice.privateOnly` | 只在私聊发语音 |
| `proactive.enabled` | 主动搭话总开关（默认 `false`，建议先观察再开） |
| `proactive.minSilenceMs` / `maxPerDay` / `quietHours` / `probability` | 门控参数 |

## DSH

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dshBin` | 必填 | `.../@deepseek-ai/dsh/lib/bin.js` |
| `dshHome` | `$DSH_HOME` 或 `~/.dsh` | DSH 的 home |
| `dshCwd` | 启动目录 | 任务的默认工作目录 |
| `dshProfile` | `headless` | 用的 profile |
| `nodeExe` | 当前 node | 调 DSH 用的解释器 |
| `useJsonEvents` | `true` | 用 `--json` 事件流（token 统计、会话 id 绑定都依赖它） |

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `QQ_BOT_CONFIG` | 配置文件路径 |
| `QQ_BOT_DSH_BIN` | 覆盖 `dshBin` |
| `QQ_BOT_NODE` | 覆盖 `nodeExe` |
| `QQ_BOT_CWD` | 覆盖 `dshCwd` |
| `QQ_BOT_PYTHON` | 覆盖语音用的 python |
| `QQ_BOT_STICKER_KEYWORDS` | 抓表情时的默认关键词（逗号分隔） |
| `DSH_PERMISSION_MODE` / `DSH_TOOLS_MODE` | 透传给 DSH（默认 `danger-full-access` / `ptc`） |
