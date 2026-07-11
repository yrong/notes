---
author: Ron
date: 2024-05-12T00:20:00+08:00
tags:
- blockchain
- ethereum
- consensus
- eth2
title: "Notes: LMD GHOST + Casper FFG (Eth2Book Capella §2.3.3–2.3.4)"
---

Bilingual study notes on [§2.3.3 LMD Ghost](https://eth2book.info/capella/part2/consensus/lmd_ghost/) and [§2.3.4 Casper FFG](https://eth2book.info/capella/part2/consensus/casper_ffg/) (Ben Edgington, Capella). Section summaries only — not a full translation. Gasper / proposer boost deferred.

<!--more-->

# English

## TL;DR

- **LMD GHOST** = fork choice: pick the best head from local blocks + attestations; GHOST follows the heaviest subtree; LMD tallies only each validator’s latest head vote.
- **LMD ≠ forgiveness**: fork choice may use only the latest vote; conflicting signed messages remain **slashable**.
- **Casper FFG** = finality gadget: justify → finalize checkpoints; classical safety when &lt; 1/3 adversarial; conflicting finals priced by **accountable safety** (≥ ~1/3 stake slashable).
- One attestation, three votes: `beacon_block_root` (LMD) + `source`/`target` (FFG).

## 1. Naming

| Piece | Meaning |
|-------|---------|
| **GHOST** | *Greedy Heaviest-Observed Sub-Tree* (Sompolinsky & Zohar, 2013) — more stable under latency than longest-chain |
| **LMD** | *Latest Message Driven* — fork choice driven by attestations (messages), keeping only each validator’s newest vote |

**Related variants (not Ethereum’s production rule):** IMD (all attestations at their time), FMD (current + previous epoch only), RLMD (latest vote expires after *N* epochs).

In PoW, “votes” are proposers building on a tip. In Ethereum PoS, **every validator** attests ~once per epoch (~every 6.4 minutes on average), so the network has far denser view information.

## 2. Role in consensus

LMD GHOST is a **fork choice rule** (like Nakamoto’s heaviest/longest chain): given a block tree and votes, output a head → linear history back to a root.

- View is **local** (your Store) — no global God’s eye.
- Honest nodes build and attest on the best head they see.
- Desiderata: majority-honest progress, stability (good predictor of future head), manipulation resistance.

Happy path here; failure modes → Issues and Fixes; FFG → §11.

## 3. Latest messages (the LMD part)

### Where the vote lives

In attestation data, the LMD vote is `beacon_block_root`:

```python
class AttestationData(Container):
    slot: Slot
    index: CommitteeIndex
    beacon_block_root: Root   # LMD GHOST vote
    source: Checkpoint        # FFG
    target: Checkpoint        # FFG
```

- Each validator attests once per epoch (one assigned slot); ~1/32 of the set per slot.
- Votes arrive via attestation gossip and inside blocks.

### Store updates (`on_attestation`)

Before recording a vote, basic checks (among others):

- Not too old (current/previous epoch) or too new (no later than previous slot)
- Voted block is known
- Signature OK; not slashably conflicting

Then `update_latest_messages()`: keep **one** latest head vote per validator (newer replaces older).

**Key property:** a vote must be *heard* soon after it is made to enter the Store, but once stored it **persists indefinitely** until a newer vote replaces it (unlike Goldfish / RLMD).

## 4. Finding the head (the GHOST part)

`GetHead(Store) → HeadBlock`. Relevant Store pieces:

- Block tree (parent links)
- Latest messages
- Effective balances (vote weights; usually 32 ETH max)

Algorithm starts from a **root** (genesis in pure GHOST; **last justified checkpoint** in full Ethereum Gasper) and ignores blocks not descending from it.

### Weights

- **Vote weight** for a block = sum of effective balances of validators whose **latest** head vote points at that block.
- **Branch / subtree weight** = votes for the root block **plus** weights of child branches  
  → a vote for a descendant also supports all ancestors.

### Walk

From the root, recursively take the **heaviest child branch**. Ties → highest child block hash (arbitrary). Stop at a leaf → that leaf is the head.

**Contrast with longest chain:** longest chain might pick a deep minority branch; GHOST picks the branch with greatest **total** validator support (e.g. prefer \(A \leftarrow C \leftarrow E\) over a longer thin branch ending at \(G\)).

Spec entry points: `get_head()`, `get_weight()` (production `get_weight` also includes **proposer boost** — a temporary weight bump for the current slot’s block, to blunt balance attacks; deferred).

## 5. Why GHOST over longest chain?

When propagation latency ≈ slot time, forks are common and not everyone sees every block in time. Votes on different children of the same parent still confirm support for the **parent’s** branch. GHOST keeps that information; longest chain throws it away and can let a deep **minority** branch win (more blocks ≠ more stake).

## 6. Confirmation rule (not finality)

LMD GHOST alone does **not** finalize. A research confirmation rule (Asgaonkar) can say a block is **safe** under synchrony:

- \(q_b^n\) = weight of subtree at \(b\) at slot \(n\) / total vote weight cast since \(b\) was produced  
  (e.g. 80% of post-\(b\) votes on \(b\)’s subtree → \(q = 0.8\))
- \(q_{\min} = \tfrac{1}{2} + \beta\) where \(\beta\) is assumed adversarial stake fraction (\(< \tfrac{1}{3}\))
- If \(q > q_{\min}\) for \(b\) and all non-finalized ancestors → **confirmed**

Idea: once a branch has a durable majority of available weight, honest validators keep voting for it. \(\beta\) pads against dishonest vote-switching; still needs network synchrony. Integration with FFG and proposer boost adds subtleties (see paper). Clients: aimed at **safe block** API; not universally shipped when the chapter was written.

| | Confirmation | Finality |
|--|--------------|----------|
| Time | ~1 slot ideal; usually &lt; ~1 min | ≥ 2 epochs (~13 min) |
| Assumptions | Stay synchronous until finality | No synchrony assumption |
| Breakage | Reorg if synchrony fails | Conflicting finality if &gt; 1/3 slashable |

## 7. Incentives

- **Proposers:** implicit — build on wrong head → orphan → lose block rewards.
- **Attesters:** explicit micro-reward for accurate head vote included in the **next** slot (~22% of a perfect validator’s rewards). Proposers get a cut for including those attestations.
- Accurate = matches what becomes canonical (including correctly voting a skip).
- **No penalty** for wrong/missed head votes (removed in Altair; stress/late blocks make head voting hard).

## 8. Slashing (nothing at stake)

PoS signing is cheap → temptation to vote on every fork. **Slash** on cryptographic proof of contradictory signed messages: burn stake + eject.

| Kind | What is punished | Proof |
|------|------------------|-------|
| **Proposer** | Two blocks in the same slot | `ProposerSlashing` = two signed headers |
| **Attester** | Equivocation or FFG commandment break (double / surround) | `AttesterSlashing` = two conflicting signed attestations |

Detection is out-of-band (clients / slashers); a later proposer includes the proof and is rewarded.

## 9. History (one line)

Zamfir’s Casper CBC / “Friendly Ghost” → Eth2 mini-spec switched IMD → **LMD GHOST** (Nov 2018) for stability → today’s shape, wrapped by Gasper + proposer boost.

## 10. Bridge: LMD vs FFG vs slashing (and Polkadot)

### Two layers in one attestation

| Field | Layer | Role |
|-------|--------|------|
| `beacon_block_root` | LMD GHOST | Current **head** |
| `source` | Casper FFG | Highest **justified** known (round-2 hard commit) |
| `target` | Casper FFG | Next checkpoint to justify (round-1 soft commit) |

LMD updates the tip every slot (~12s). FFG works on **epoch checkpoints** (32 slots ≈ 6.4 min). Detail in §11.

### “Latest message”

- Store: **one** latest head vote per validator; newer (by slot) replaces older in LMD weights.
- Older votes may already count in FFG history; an offline validator’s last vote **keeps weighting** until replaced.

### LMD tolerance ≠ no slashing

| Concern | Fork choice (LMD) | Protocol law |
|---------|-------------------|--------------|
| Conflicting signed messages | Tally **latest** only | Still **slashable** on-chain |
| Same slot, two heads | Latest for weights | Attestation equivocation |
| Surround / double FFG | — | Casper commandments (§11) |
| Two blocks in one slot | — | Proposer slashing |

Slash sketch: immediate penalty → forced exit (~36 days) → **correlation penalty** (solo cheap; mass simultaneous can burn up to 32 ETH).

### vs Polkadot (BABE + GRANDPA)

| | Ethereum (Gasper) | Polkadot |
|--|-------------------|----------|
| Tip | LMD GHOST | BABE fork choice |
| Finality | Casper FFG (~2 epochs typical) | GRANDPA (async rounds; often ~12–60s) |
| Double vote | Slash when proven; LMD still tallies latest | GRANDPA equivocation → slash (no latest-wins soft landing) |

GRANDPA rounds ≠ BABE’s 6s slot: a round ends at ≥ 2/3 pre-vote/pre-commit; under stress it can stall then **batch-finalize**.

## 11. Casper FFG ([§2.3.4](https://eth2book.info/capella/part2/consensus/casper_ffg/))

### Why it exists

LMD alone never forbids a competing branch forever. **Casper FFG** is a **finality gadget** on tip consensus: checkpoints honest nodes will not revert when &lt; 1/3 adversarial, plus **accountable safety** if conflicting finals appear.

Two ideas: **two-phase commit** (justify → finalize) and **accountable safety** (slash commandment breakers).

### Naming & place

- **Casper** from Zamfir’s “Friendly Ghost” lineage; Vitalik’s **FFG** = *Friendly Finality Gadget* — not CBC/TFG, and **does not use GHOST**.
- Meta-protocol on top of underlying chain consensus (here LMD); the paper barely discusses the base chain.

Async BFT: \(n &gt; 3f\) → tolerate &lt; **1/3** faulty/adversarial stake.

### Epochs, checkpoints, votes

- Epoch = 32 slots. Each validator attests **once per epoch** (assigned to one slot via committees / RANDAO) → ~1/32 of the set votes each slot. Same attestation carries FFG + LMD votes.
- Per-validator: one attestation / epoch. Network-wide: every slot has an on-duty committee refreshing LMD head weight; their `source`/`target` usually aim at the **same epoch-boundary checkpoint**.
- **Checkpoint** = first slot of an epoch (slot \(32N\)) + block root. The protocol finalizes **checkpoints**, not “whole epochs” (finalizing \(N\) covers through slot \(32N\)).

```python
class Checkpoint(Container):
    epoch: Epoch
    root: Root
```

**Link** \(s \rightarrow t\): source + target in one message.

| Half | Meaning |
|------|---------|
| **Target** | “Next checkpoint I want justified” — soft / conditional (round 1) |
| **Source** | “Highest justified I know; hard-commit never to revert it” (round 2) |

Honest pattern: source = highest justified in view; target = current-epoch checkpoint descending from source (jumps allowed). Invalid link (target not a descendant of source) contradicts yourself but is **not** itself slashable.

**Eth2 detail:** FFG tallies only votes **included in blocks** (shared record). LMD may use gossiped attestations; FFG does not.

**Supermajority link:** same \(s \rightarrow t\) from &gt; 2/3 stake, timely, in blocks.

### Justify and finalize

| Step | Rule (paper / ideal) | Meaning |
|------|----------------------|---------|
| **Justify** \(c_2\) | Supermajority link from justified \(c_1\) to \(c_2\) | Soft agreement forming |
| **Finalize** \(c_1\) | Supermajority \(c_1 \rightarrow c_2\) with \(c_2\) the **direct child** of justified \(c_1\) | “2/3 have seen that 2/3 committed to \(c_1\)” — revert needs ≥ 1/3 slashable flip |

Pipeline: ~**1 epoch to justify**, ~**2 epochs (~12.8 min) end-to-end to finalize**; once primed, one checkpoint can finalize **every epoch**. On-chain settlement at **epoch processing**.

**k-finality (Eth2: 2-finality):** finalize \(a_m\) via \(a_m \rightarrow a_{m+k}\) if intermediates are justified. Beacon keeps a short justification window (four epochs / two-epoch targets).

### Casper commandments (slash if broken)

1. **No double vote:** at most one vote per **target epoch** \(h(t)\).
2. **No surround vote:** no distinct links with \(h(s_1) &lt; h(s_2) &lt; h(t_2) &lt; h(t_1)\).

Detection often off-protocol (esp. surround); on-chain proof = two conflicting signed attestations. Slash size scales with **correlation** in a window — underpins economic finality.

### Fork-choice modification

Underlying rule: **follow the chain containing the highest justified checkpoint.**

→ LMD starts from **highest justified**, ignores tips not descending from it. That pins finality into tip-following and matches **plausible liveness**.

### Guarantees

| Guarantee | Claim |
|-----------|--------|
| **Classical-style safety** (&lt; 1/3 bad) | Honest nodes never revert a finalized checkpoint |
| **Accountable safety / economic finality** | Conflicting finals ⇒ ≥ ~1/3 stake broke a commandment (burnable) |
| **Plausible liveness** | ≥ 2/3 honest + tip extends highest justified ⇒ can keep finalizing **without honest self-slash** |

Sketch: two conflicting finals ⇒ surround of supermajority links ⇒ ≥ 1/3 surround voters. With asynchrony + &gt; 1/3 attacker, partitions can still diverge; economic finality + social recovery are the backstop.

### Incentives (chapter numbers)

Ideal staking reward share: **~22% source**, **~41% target** (vs ~22% LMD head). Wrong/late source or target → **penalty ≈ reward**. Wrong source ≈ wrong branch → treated as missing both FFG votes.

## See also

- Next: **Gasper** (FFG ⨯ LMD, empty slots, timeliness).
- Spec: `get_head` / `get_weight` / `on_attestation`; epoch processing justify/finalize; attester slashing.
- Issues and Fixes (proposer boost, attacks); RLMD GHOST paper.

## Source

- [2.3.3 LMD Ghost](https://eth2book.info/capella/part2/consensus/lmd_ghost/) · [2.3.4 Casper FFG](https://eth2book.info/capella/part2/consensus/casper_ffg/) (Ben Edgington, CC BY-SA 4.0)

---

# 中文

基于 [§2.3.3 LMD Ghost](https://eth2book.info/capella/part2/consensus/lmd_ghost/) 与 [§2.3.4 Casper FFG](https://eth2book.info/capella/part2/consensus/casper_ffg/) 的双语学习笔记。章节摘要，非全书翻译。Gasper / proposer boost 另述。

## 要点速览

- **LMD GHOST** = 分叉选择：根据本地区块 + attestation 选最佳 head；GHOST 走最重子树；LMD 计票只认最新 head 票。
- **LMD ≠ 免罚**：计票可只认最新票；冲突签名仍可 slash。
- **Casper FFG** = 最终性插件：checkpoint 上 justify → finalize；&lt; 1/3 作恶时经典安全，冲突最终性则靠 **accountable safety**（至少约 1/3 权益应被 slash）。
- 一张 attestation 三票：`beacon_block_root`（LMD）+ `source`/`target`（FFG）。

## 1. 命名

| 部分 | 含义 |
|-------|---------|
| **GHOST** | *Greedy Heaviest-Observed Sub-Tree*（Sompolinsky & Zohar, 2013）— 高延迟下比最长链更稳 |
| **LMD** | *Latest Message Driven* — 由 attestation（消息）驱动分叉选择，只保留每个验证者最新一票 |

**相关变体（非以太坊生产规则）：** IMD（保留各时刻证明）、FMD（仅当前与上一 epoch）、RLMD（最新票在 *N* 个 epoch 后过期）。

PoW 里 “投票” 是矿工在 tip 上出块。以太坊 PoS 中**每个验证者**大约每个 epoch 投一次（平均约每 6.4 分钟），网络对视图的信息密度高得多。

## 2. 在共识中的角色

LMD GHOST 是**分叉选择规则**（类似中本聪最重/最长链）：给定区块树和选票，输出 head → 回溯到某 root 的线性历史。

- 视图是**本地的**（你的 Store）— 没有上帝视角。
- 诚实节点在自己看到的最佳 head 上出块和投票。
- 期望性质：多数诚实可推进、稳定性（能预测未来 head）、抗操纵。

此处只讲 happy path；异常 → Issues and Fixes；FFG → §11。

## 3. 最新消息（LMD 部分）

### 选票在哪里

attestation 数据里，LMD 票是 `beacon_block_root`：

```python
class AttestationData(Container):
    slot: Slot
    index: CommitteeIndex
    beacon_block_root: Root   # LMD GHOST 票
    source: Checkpoint        # FFG
    target: Checkpoint        # FFG
```

- 每个验证者每个 epoch 投一次（分到某一 slot）；每个 slot 约 1/32 集合在投票。
- 票经 attestation gossip 以及区块内传播。

### Store 更新（`on_attestation`）

记入前的基本检查（等）：

- 不太旧（当前/上一 epoch）也不太新（不晚于上一 slot）
- 所投区块已知
- 签名正确；无 slashable 冲突

然后 `update_latest_messages()`：每个验证者只保留**一条**最新 head 票（更新者覆盖旧票）。

**关键性质：** 票必须在发出后较快被听到才能进入 Store；一旦进入则**长期保留**，直到被更新（不同于 Goldfish / RLMD）。

## 4. 找 head（GHOST 部分）

`GetHead(Store) → HeadBlock`。相关 Store 内容：

- 区块树（parent 链接）
- 最新消息
- effective balance（票权；通常上限 32 ETH）

算法从某 **root** 开始（纯 GHOST 为创世；完整以太坊 Gasper 为**最近 justified checkpoint**），忽略非其后代的块。

### 权重

- 某块的**投票权重** = 最新 head 票指向该块的验证者 effective balance 之和。
- **分支 / 子树权重** = 根块上的票权 **加上** 子分支权重  
  → 对后代的投票也支持所有祖先。

### 行走

从 root 起，递归选**最重的子分支**。平局 → 子块 hash 更大者（任意打破平局）。到叶子 → 该叶子为 head。

**对比最长链：** 最长链可能选出又深又窄的少数派分支；GHOST 选**总支持**最大的分支（例如偏好 \(A \leftarrow C \leftarrow E\)，而不是更长但更瘦、止于 \(G\) 的分支）。

规范入口：`get_head()`、`get_weight()`（生产里 `get_weight` 还含 **proposer boost** — 给当 slot 块的临时权重加成，缓解 balance attack；另述）。

## 5. 为何用 GHOST 而非最长链？

当传播延迟 ≈ slot 时间时，分叉常见，并非人人及时看到每个块。对同一父块的不同子块投票，仍确认对**父分支**的支持。GHOST 保留这些信息；最长链丢掉它们，可能让又深又窄的**少数派**分支胜出（块更多 ≠ 权益更多）。

## 6. Confirmation rule（不是最终性）

单独的 LMD GHOST **不提供** finality。研究中的 confirmation rule（Asgaonkar）可在同步假设下称某块 **safe**：

- \(q_b^n\) = slot \(n\) 时以 \(b\) 为根的子树权重 / 自 \(b\) 产生以来投下的总票权  
  （例如 \(b\) 之后 80% 票在 \(b\) 子树上 → \(q = 0.8\)）
- \(q_{\min} = \tfrac{1}{2} + \beta\)，\(\beta\) 为假设敌方权益比例（\(< \tfrac{1}{3}\)）
- 若 \(b\) 及其所有未 finalized 祖先都有 \(q > q_{\min}\) → **confirmed**

直觉：一旦某分支对可用票权形成可持续多数，诚实验证者会继续投它。\(\beta\) 用来抵御不诚实换票；仍依赖网络同步。与 FFG、proposer boost 结合有细节（见论文）。客户端方向是 **safe block** API；该章写作时尚未普遍落地。

| | Confirmation | Finality |
|--|--------------|----------|
| 时间 | 理想约 1 个 slot；通常 &lt; ~1 分钟 | ≥ 2 个 epoch（约 13 分钟） |
| 假设 | 直至 finality 保持同步 | 无同步假设 |
| 破坏 | 失同步可被 reorg | &gt; 1/3 slashable 才可能冲突 finalize |

## 7. 激励

- **提议者：** 隐式 — head 选错 → 孤儿块 → 丢出块奖励。
- **证明者：** 显式 — 准确 head 票在**下一** slot 被打进块则有微奖励（完美验证者约 22% 协议奖励来自准确 head 票）。提议者因收录这些票也获分成。
- 准确 = 与最终规范链一致（包括正确投 skip）。
- **无惩罚** 错误/错过的 head 票（Altair 去掉；压力/迟到块下 head 很难投对）。

## 8. Slashing（nothing at stake）

PoS 签名几乎无成本 → 易在每个分叉上投票。对矛盾的签名消息做密码学证明后 **slash**：罚没权益 + 踢出。

| 类型 | 惩罚什么 | 证明 |
|------|----------|------|
| **Proposer** | 同一 slot 两个块 | `ProposerSlashing` = 两个已签名 header |
| **Attester** | 双签或违反 FFG 戒律（double / surround） | `AttesterSlashing` = 两份冲突已签名 attestation |

检测在协议外（客户端 / slasher）；后续提议者打包证明并获奖励。

## 9. 历史（一行）

Zamfir 的 Casper CBC / “Friendly Ghost” → Eth2 mini-spec 因稳定性将 IMD 改为 **LMD GHOST**（2018-11）→ 形态基本沿用至今，再由 Gasper + proposer boost 包装。

## 10. 桥接：LMD vs FFG vs Slashing（及 Polkadot）

### 一张 attestation 里的两层

| 字段 | 层级 | 作用 |
|------|------|------|
| `beacon_block_root` | LMD GHOST | 当前 **head** |
| `source` | Casper FFG | 已知最高 **justified**（round-2 硬承诺） |
| `target` | Casper FFG | 希望下一站 justified（round-1 软承诺） |

LMD 每个 slot（~12s）更新 tip；FFG 在 **epoch checkpoint**（32 slot ≈ 6.4 分钟）上工作。细节见 §11。

### 「最新消息」

- Store：每验证者一条最新 head 票；更新者覆盖 LMD 计权。
- 旧票可能已进入 FFG 历史；掉线后最后一票**持续计权**直至被更新。

### LMD 计票宽容 ≠ 免罚

| 情形 | 分叉选择（LMD） | 协议法律 |
|------|-----------------|----------|
| 冲突签名 | 只认**最新**计权 | 证据上链仍可 **slash** |
| 同 slot 两 head | 最新票计权 | attestation equivocation |
| Surround / double FFG | — | Casper 戒律（§11） |
| 同 slot 两块 | — | proposer slashing |

Slash 略：即时扣款 → 强制退出（~36 天）→ **correlation penalty**（单独误配轻；大量同时 slash 可罚至满额 32 ETH）。

### 对比 Polkadot（BABE + GRANDPA）

| | 以太坊（Gasper） | Polkadot |
|--|------------------|----------|
| Tip | LMD GHOST | BABE 分叉选择 |
| 最终性 | Casper FFG（常约 2 epoch） | GRANDPA（异步 round；顺畅时常 12–60s） |
| 双投 | 可证则 slash；LMD 仍用最新票 | GRANDPA equivocation → slash（无「只认最新」软着陆） |

GRANDPA round ≠ BABE 的 6s slot：≥ 2/3 才结束一轮；卡顿时可 stall 后**批量 finalize**。

## 11. Casper FFG（[§2.3.4](https://eth2book.info/capella/part2/consensus/casper_ffg/)）

### 为何需要

单独 LMD 无法禁止永久另开分支。**Casper FFG** 是 tip 共识上的 **finality gadget**：在 &lt; 1/3 作恶时给出诚实节点不回滚的 checkpoint；若出现冲突最终性，则用 **accountable safety**（破戒律者 slash）定价。

两大支柱：**两阶段提交**（justify → finalize）与 **可问责安全**。

### 命名与位置

- 名字承接 Zamfir「Friendly Ghost」谱系；Vitalik 的 **FFG** = *Friendly Finality Gadget* — 不是 CBC/TFG，也**不用 GHOST**。
- 元协议：跑在底层链共识之上（此处为 LMD）；论文几乎不谈底层链。

异步 BFT：\(n &gt; 3f\) → 容忍 &lt; **1/3** 故障/敌对权益。

### Epoch、checkpoint、选票

- Epoch = 32 slot。每验证者每 epoch **投一次**（经委员会 / RANDAO 分到某一 slot）→ 每 slot 约 1/32 集合在投票。同一 attestation 携带 FFG + LMD 票。
- 对单个验证者：每 epoch 一张票。对全网：每个 slot 都有当班委员会刷新 LMD head 权重；其 `source`/`target` 通常指向**同一 epoch 边界 checkpoint**。
- **Checkpoint** = epoch 首 slot（\(32N\)）+ 区块 root。协议 finalize 的是 **checkpoint**，不是「整个 epoch」（finalize \(N\) = 确认到 slot \(32N\)）。

```python
class Checkpoint(Container):
    epoch: Epoch
    root: Root
```

**Link** \(s \rightarrow t\)：source + target 合成一条消息。

| 半票 | 含义 |
|------|------|
| **Target** | 「我想 justify 的下一 checkpoint」— 软/有条件承诺（round 1） |
| **Source** | 「我见过的最高 justified；硬承诺永不回滚它」（round 2） |

诚实模式：source = 视图中最高 justified；target = 源自 source 的当前 epoch checkpoint（允许跳跃）。target 非 source 后代 = 自相矛盾，但**本身不是** slash 条件。

**Eth2 要点：** FFG 只统计**打进区块**的票（共同记录）。LMD 可用 gossip；FFG 不行。

**Supermajority link：** &gt; 2/3 权益投同一 \(s \rightarrow t\)（及时入块）。

### Justify 与 Finalize

| 步骤 | 规则（论文理想形） | 含义 |
|------|--------------------|------|
| **Justify** \(c_2\) | 从已 justified 的 \(c_1\) 到 \(c_2\) 的超多数 link | 软共识形成 |
| **Finalize** \(c_1\) | 超多数 \(c_1 \rightarrow c_2\) 且 \(c_2\) 是 \(c_1\) 的**直接子** checkpoint | 「2/3 已见 2/3 承诺了 \(c_1\)」— 回滚需 ≥ 1/3 可证改口 |

流水线：理想约 **1 epoch justify**，端到端约 **2 epoch（~12.8 分钟）finalize**；管道灌满后可每 epoch finalize 一个。链上在 **epoch processing** 时结算。

**k-finality（Eth2：2-finality）：** 若中间 checkpoint 都已 justified，可用 \(a_m \rightarrow a_{m+k}\) finalize \(a_m\)。Beacon 保留短 justification 窗口（四 epoch / 两 epoch target）。

### Casper 戒律（违反则 slash）

1. **No double vote：** 同一 **target epoch** 高度至多一票。
2. **No surround vote：** 禁止 \(h(s_1) &lt; h(s_2) &lt; h(t_2) &lt; h(t_1)\)。

检测常链下（尤其 surround）；上链证明 = 两份冲突已签名 attestation。罚没随窗口内其他 slash **相关放大** — 支撑经济最终性。

### 分叉选择改写

底层必须：**跟随含有最高 justified checkpoint 的那条链。**

→ LMD 从**最高 justified** 起步，忽略不在其下的 tip。最终性由此钉住 tip 算法，并匹配 **plausible liveness**。

### 保证

| 保证 | 含义 |
|------|------|
| **类经典安全**（&lt; 1/3 坏） | 已 finalize 的 checkpoint 诚实节点不回滚 |
| **Accountable safety / 经济最终性** | 冲突 finalize ⇒ 至少约 1/3 权益破戒律（可被烧） |
| **Plausible liveness** | ≥ 2/3 诚实且 tip 延伸最高 justified ⇒ 可继续 finalize，**无需诚实者自砍** |

直觉：两冲突 finalize ⇒ 超多数 link 互相 surround ⇒ ≥ 1/3 surround。异步 + &gt; 1/3 攻击仍可能分区；经济最终性 + 社群分叉选择是后手。

### 激励（章内比例）

理想质押奖励粗分：**source ~22%**，**target ~41%**（LMD head ~22%）。错/晚的 source 或 target → **惩罚 ≈ 奖励**。source 错 ≈ 在错误分支 → 等同 FFG 两票都缺席。

## 延伸阅读

- 下一章：**Gasper**（FFG ⨯ LMD、空 slot、时效规则）。
- 规范：`get_head` / `get_weight` / `on_attestation`；epoch processing 的 justify/finalize；attester slashing。
- Issues and Fixes（proposer boost、攻击）；RLMD GHOST 论文。

## 来源

- [2.3.3 LMD Ghost](https://eth2book.info/capella/part2/consensus/lmd_ghost/) · [2.3.4 Casper FFG](https://eth2book.info/capella/part2/consensus/casper_ffg/)（Ben Edgington, CC BY-SA 4.0）
