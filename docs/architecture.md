# 架构

## 进程模型

```
┌─────────────┐   OneBot v11 (WS)   ┌──────────────────────────┐
│  NapCat      │◀──────────────────▶│  bridge.js（长驻单实例）  │
│  (QQ 客户端) │   event / action    │                          │
└─────────────┘                     │  ├─ 准入（白名单/触发词） │
                                    │  ├─ 队列（串行）          │
                                    │  └─ 会话映射 state.json   │
                                    └───────────┬──────────────┘
                                                │ spawn（每次任务一个新进程）
                                                ▼
                                   node <dshBin> --profile headless \
                                        [--session-id <sid>] --json "<prompt>"
```

桥接本身**不调模型**，只负责「把 QQ 消息变成一次 agent 任务，再把结果变成聊天消息」。

## 一条消息的完整路径

1. `ws.on(message)` → `handleEvent(evt)`。
2. **丢弃自己发的**：比 `evt.user_id` 与 `selfQQ`（不是 `self_id`）。
3. **消息去重**：`message_id` 进 500 条 LRU 集合（NapCat 重推时不重复执行）。
4. **活动留档**：`activityGroups` 里的群，在任何过滤之前先追加 JSONL（纯图片也要留）。
5. **空文本**：记一条 WARN 后返回——不允许静默。
6. **白名单**：私聊看 `allowedPrivateUsers`，群看 `allowedGroups`。
7. **谁能下命令**：`masterOnlyCommands` + `openTriggerGroups`；非主人只留档不触发。
8. **触发词**：出现在开头就剥掉、出现在中间就摘掉；群里必须命中，私聊由 `privateRequireTrigger` 决定；`@机器人` 也算。
9. **定渠道**：`group:<群号>` 或 `private:<QQ号>`，决定用哪个会话、结果发去哪里。
10. **额度闸**：该渠道累计 token 到上限且不是主人 → 回一句说明并拒绝。
11. **排队执行**：`queue.push` → `pump()`（全局串行，避免同一会话被并发写）。
12. **拼提示词**：人格块 + 渠道说明 + 渠道边界 + 说话方式 + 任务正文。
13. **spawn DSH**：`--session-id`（已绑定）或留空（新渠道首次，之后按 `--json` 的 `session` 事件或新出现的会话目录绑定）。
14. **流式解析**：`text` 累积、`final` 取最终答案、`status.step_end.usage` 累计 token；stdout 按行缓冲，避免跨块 JSON 解析失败。
15. **发送**：`humanize.planBubbles` 变成 1~N 条 → 逐条发（中间可插表情）→ 可选语音 → 收尾表情。
16. **回写状态**：token 用量、会话换代判断、`heartbeat.json`。

## 状态文件

| 文件 | 内容 | 谁写 |
| --- | --- | --- |
| `bridge.config.json` | 配置（**只在启动时读一次**，改完必须重启） | 人 / 面板 |
| `state.json` | 会话映射、token 累计、主动搭话计数、最近表情 | 桥接 |
| `heartbeat.json` | pid + 时间戳 + 连接状态（看门狗判活） | 桥接（30s） |
| `startup-notice.stamp.json` | 上次上线通知时间（独立文件，避免和 state 抢写） | 桥接 |
| `bridge.log` | 人类可读日志（5MB 滚动一份） | 桥接 |
| `activity/raw/YYYY-MM-DD.jsonl` | 活动群全量留档（只追加） | 桥接 |

## 会话与上下文

- 键：`group:<群号>` / `private:<QQ号>`；值：`session-<uuid>`。
- 已绑定会话在磁盘上找不到时：**拒绝执行并报错**，绝不静默新建（否则上下文悄悄断线）。
- 换代（可选）：按渠道累计 token 或会话年龄达阈值 → 回复发完后解绑 + 旧会话移入回收目录 → 下一条消息自动新建。
- 长期记忆由 DSH 侧的记忆插件注入，桥接不负责摘要。

## 失败与自愈

| 场景 | 行为 |
| --- | --- |
| OneBot 断开 | 1s→1.5s→…→3s 退避重连。本地回环不该长时间退避：断线期间的消息不会重放 |
| DSH 退出码非 0 | 日志记 stderr，用户只看到一句人话 |
| DSH 超时 | `taskTimeoutMs` 到点 SIGKILL，回复超时说明 |
| 会话被别的进程占用 | 放回队首、20s 后重试，最多 10 分钟，期间按速率提示 |
| 发送失败 | `Timeout: NTEvent` 视为「已提交、回调慢」，不当作失败报给用户 |
| 进程挂了 | `heartbeat.json` 变陈旧 → 计划任务里的看门狗拉起 |
| 重复实例 | 启动时读心跳：pid 活着且心跳新鲜 → 直接退出并写 `bridge-dup.log` |
