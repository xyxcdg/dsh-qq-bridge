# 贡献指南

欢迎 issue / PR。三条约定：

1. **改动前先跑测试**：`npm install && npm test`，四项必须全绿。
2. **不要提交任何真实凭据或隐私数据**：QQ 号、群号、OneBot token、会话 id、聊天留档一律用占位符；
   `bridge.config.json` / `state.json` / `activity/` 已在 `.gitignore` 里，别强行 add。
3. **面向用户的文案改动请顺带更新测试**：说话方式（`humanize.cjs`）、主动搭话门（`proactive.cjs`）、
   触发词解析（`test/test-trigger.mjs`）都有回归断言，改逻辑就要改断言，别只改实现。

PR 描述里写清：改了什么、为什么、怎么验证（命令或截图）。
