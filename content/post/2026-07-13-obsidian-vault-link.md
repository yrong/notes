---
author: Ron
date: 2026-07-13T02:18:00+08:00
tags:
- meta
- obsidian
title: "Obsidian vault link"
---

Local Obsidian vault is symlinked into this repo for editing alongside Quartz posts. **`01-Technology` is published** as a tracked copy under `content/01-Technology/`.

<!--more-->

## Link

| | |
|--|--|
| Vault | `/Users/yangrong/Obsidian` |
| Local browse | `content/obsidian` → vault (**gitignored**, not published) |
| Published | `content/01-Technology/` ← copy of vault `01-Technology` |
| Quartz | ignores `obsidian/**`; builds `01-Technology/**` |

## Publish / refresh Technology notes

```bash
rsync -a --delete --exclude '.DS_Store' --exclude 'index.md' \
  "/Users/yangrong/Obsidian/01-Technology/" \
  content/01-Technology/
```
Then commit. Folder index: [Technology (from Obsidian)](../01-Technology/).

## Vault map

| Path | Role |
|------|------|
| `00‑Inbox` | Capture |
| `01-Technology` | **Published** → `content/01-Technology/` |
| `01‑Technology` | Older unicode-hyphen twin (not published) |
| `02‑Research` | Research — not published yet |
| `03‑Personal` | Private |
| `04‑Tutorials` | Tutorials |
| `05‑Assets` | Assets + Notion import |
| `06‑References` | References |

## Overlap with `content/post`

| Obsidian / Technology | Also in `content/post` |
|----------|----------------------------|
| Hyperbridge / ISMP child trie | `2023-04-11-…`, `2023-06-22-…` |
| Native vs wrapped / intent | `2024-03-10-…` |
| ERC-4337 / bundler | `2026-07-10-…` |
| Merkle leaf / domain separation | `2022-09-15-…` |
| Eth2 LMD / FFG | `2024-05-12-…` |
