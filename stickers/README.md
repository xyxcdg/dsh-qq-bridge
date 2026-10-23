# 表情包目录

桥接会递归扫描本目录下**不以下划线或点开头**的子目录，取 `.png/.jpg/.jpeg/.gif/.webp` 作为发送池。

建议这样组织：

```
stickers/
├─ memes/          # 正式池（会被发出去）
├─ _incoming/      # 抓下来的候选（人工审核区，永不发送）
├─ _blocked/       # 明确不要的
└─ _collected/     # 收藏但暂不用的
```

- 下划线目录永远不会被发送——这是给人工审核留的缓冲。
- 仓库**不带任何图片**：版权与内容都得自己负责。
- 抓候选：`node stickers-fetch.cjs 猫猫表情包 摸鱼表情包`，挑完用 `--approve <文件名>` 入库。
- 同一张图会被避开最近 12 次（`state.json` 里记着）。

想关掉：配置里 `endSticker.enabled = false`。
