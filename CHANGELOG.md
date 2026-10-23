# Changelog

## 1.1.0

把线上跑了三周的那一版整理开源。

- 自我状态（`self.cjs`）：第几天、回过几次话、对每个渠道的亲近度与印象、未了心事、被纠正过的习惯、疲惫值；全部落盘跨重启，越界只改语气
- 心情引擎（`mood.cjs`）：被夸/被凶/被哄/被调戏/被使唤 → 心情与强度，3 小时衰减、深夜叠「困」
- 五官（`senses.cjs`）：本地视觉模型看屏幕（缩图后只回一句描述）、身体读数缓存注入；拿不到就不注入
- 语音：edge-tts → ChatTTS → GPT-SoVITS → SAPI 的降级链，可转 amr/silk；语音转文字（百炼 ASR）
- 称呼三档（`addressing`）：主人 / 哥哥姐姐 / 同学，按 QQ 资料性别解析并缓存
- 插队（`preemptAfterMs`）：新消息先答，慢任务回队尾重跑
- 会话换代：按 `totalTokens` 或会话年龄解绑重建（`sessionRecycle`）
- 群聊搭话（`groupChime`）、按渠道任务边界与 token 限额
- 本地控制台（`panel-server.cjs`）、MCP server（`mcp-qqbot.cjs`）、账号自愈（`qq-selfheal.ps1` + `qq-probe.cjs`）
- 11 个回归测试，含真起假 OneBot/假 DSH 断言「真正发出去的提示词」
- 所有路径/凭据改为配置或环境变量；仓库不含任何真实 QQ 号、群号、会话与素材

## 1.0.0

首个开源版本。

- OneBot v11 接入（NapCat），单实例锁 + 心跳 + 断线快速重连
- 渠道级会话隔离；会话消失时报错而不是静默换新
- 触发词（出现即算）、@ 机器人、私聊可选免触发
- 主人专用命令 + 开放群白名单 + 消息去重
- 回复排版：短答一句、长答拆条、名单/表格不拆（`humanize.cjs`）
- 延迟开口与进度播报；失败兜底只说人话
- 表情包（按概率、避开最近 12 张）与语音（edge-tts → SAPI）
- 主动搭话门（安静时长/每日上限/静默时段/忙碌/掷骰，`proactive.cjs`）
- 活动群全量留档（JSONL，只追加）
- 按渠道 token 限额与任务边界（`channelScopes` / `channelContext`）
- Windows 计划任务安装/卸载 + 看门狗脚本
- 四个回归测试（`npm test`）
