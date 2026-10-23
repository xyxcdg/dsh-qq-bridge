# 部署（Windows 为主）

## 0. 检查三件事

```powershell
node --version                      # ≥ 18
# 1) NapCat 能给出 OneBot WebSocket（默认 3001）
# 2) DSH 能跑一次性任务：
node <dshBin> --profile headless "只回复两个字：可以"
```

DSH 的 headless profile 用**启动时的凭据**（环境变量或 `$DSH_HOME/.env`），不读凭据库；
第一次跑如果报 `MISSING_CREDENTIAL`，先把模型密钥写进环境或 `.env`。

## 1. NapCat / OneBot v11

1. 安装并登录 NapCat（扫码或快速登录），确认 QQ 在线。
2. 打开 NapCat WebUI（默认 `http://127.0.0.1:6099`），在「网络配置」里新建 **WebSocket 服务器**：
   - 端口 `3001`
   - Token 随便设一个强口令，填到 `bridge.config.json` 的 `onebotToken`
3. 验收：`Test-NetConnection 127.0.0.1 -Port 3001` 为 True；NapCat 日志出现适配器初始化完成。

> 端口在监听 ≠ 能对话：QQ 掉线时 3001 照样监听，但事件不再推送。桥接日志一行都没有时，先查账号状态。

## 2. 配置桥接

```powershell
cd <repo>
npm install
copy bridge.config.example.json bridge.config.json
notepad bridge.config.json
```

必改：`selfQQ`、`masterQQ`、`allowedPrivateUsers`、`allowedGroups`、`dshBin`。

## 3. 前台试跑与验收

```powershell
npm start
```

验收四条，缺一不可：

1. 日志出现 `已连接 OneBot WebSocket`；
2. 白名单里的账号收到「上线啦」；
3. 私聊发一句话，日志出现 `任务入队` → `调用 DSH` → `任务完成` → `已发送`，并在 QQ 里真收到回复；
4. `heartbeat.json` 的 `ts` 每 30 秒更新。

## 4. 后台常驻（隐藏窗口 + 看门狗）

```powershell
# 安装：登录自启 + 每 3 分钟看门狗
powershell -ExecutionPolicy Bypass -File scripts/install-tasks.ps1

# 卸载
powershell -ExecutionPolicy Bypass -File scripts/install-tasks.ps1 -Uninstall
```

脚本做的事：

- 在 `%LOCALAPPDATA%\dsh-qq-bridge\` 生成一个 UTF-16 的 `start-hidden.vbs`（`sh.Run cmd, 0, False`），任务动作是 `wscript.exe "<vbs>"`——**不要**把 `powershell.exe` 直接写进任务，那一定会闪窗；
- 注册 `QQBotBridge`（登录触发）与 `QQBotWatchdog`（每 3 分钟，隐藏拉起 `scripts/watchdog.ps1`）；
- 看门狗判据：`heartbeat.json` 超过 90 秒没更新，且记录的 pid 已不在 → 用同一个 vbs 重新拉起；正在运行则不动作。

## 5. 排障

| 现象 | 先看什么 | 结论 |
| --- | --- | --- |
| 完全不理人，日志 0 行 | NapCat 日志 / 账号状态 | 消息没到桥接：账号掉线或被踢 |
| 日志有「已忽略未授权」 | 配置白名单 | 群号/QQ 号没加进去 |
| 日志有「不含触发词」 | `triggerWord` / `privateRequireTrigger` | 群消息必须带触发词 |
| 回了「执行失败」 | `bridge.log` 的 stderr | `dshBin`/profile/凭据 |
| 回复很慢 | `token 用量` 每轮多少 | 上下文太大 → 开换代或瘦身记忆注入 |
| 语音没发 | 日志 `语音跳过(...)` | 没装 edge-tts / 文本超长 / 群里被 `privateOnly` 拦 |
| 计划任务 0x0 但没进程 | `%LOCALAPPDATA%\dsh-qq-bridge\watchdog.log` | vbs 路径/编码错（必须 UTF-16） |

## 6. 升级与回滚

```powershell
# 停：先删掉任务里的登录触发或直接卸载任务，再结束 node 进程
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*bridge.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

- 升级前备份 `bridge.config.json`、`state.json`、`activity/`；
- 代码回滚用 git：`git checkout <tag>` 后重启；
- 配置回滚直接把备份复制回来（桥接只在启动时读配置）。

## 7. 面板 / MCP / 自愈（可选）

**面板**：`npm run panel` → `http://127.0.0.1:8123`。只绑 loopback；改配置走白名单字段，写前自动备份，
改完提示「重启桥接生效」。需要开机自启就再加一个计划任务（动作仍是 `wscript.exe <隐藏 vbs>`）。

**MCP**：在 `$DSH_HOME/cordis.patch.yml` 的 `- insert:` 列表里追加一项：

```yaml
- insert:
    id: qqbot-mcp
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: qqbot
      transport: stdio
      command: node
      args: ['C:/path/to/dsh-qq-bridge/mcp-qqbot.cjs']
```

工具在模型侧显示为 `mcp__qqbot__status` / `config_get` / `config_set` / `action` / `panel`。

**账号自愈**：`qq-selfheal.ps1` 用 `qq-probe.cjs` 探测 `get_login_info`（端口在监听不等于能对话），
离线才重启 NapCat，冷却 5 分钟，连续失败 3 次硬冷却 30 分钟。需要 `QQ_BOT_NAPCAT_VBS` 指向隐藏启动脚本。

**可选引擎**：视觉（ollama 视觉模型）、ASR（`DASHSCOPE_API_KEY` + ffmpeg）、ChatTTS/GPT-SoVITS。
全部可失败，失败只降级、不影响文字回复。
