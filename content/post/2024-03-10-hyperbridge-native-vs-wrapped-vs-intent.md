---
author: Ron
date: 2024-03-10T14:40:00+08:00
tags:
- blockchain
- hyperbridge
- bridging
- intents
title: "学习笔记：Native vs Wrapped vs Intent（跨链资产澄清）"
---

读 [Hyperbridge — Sovereign Intents](https://blog.hyperbridge.network/sovereign-intents/) 时，文中「USDC 在多条链上原生发行，Intent 可以把一条链上的 native 资产换成另一条链上的同一 native 资产」这句话容易让人误解：**不同链的共识（Beacon、BEEFY、Tendermint/IBC）并不共享，怎么可能不 wrap 就共享同一资产？**

本文单独澄清「native / wrapped / intent」三者的真实含义，并补充 Intent Gateway 的要点。

<!--more-->

## 1. 核心结论（先读这段）

- 每条链上的 USDC 都是**独立的链上 token 实例**（不同合约 / pallet / denom），共识层也完全不同。
- 链与链之间**不可能**在共识意义上「共享同一个 native 资产」。
- 营销话术里的「native」通常指 **发行方铸造的官方代币**，不是「跨链共享同一 ledger」。

真正发生的是三层分离：

| 层级 | 含义 |
|------|------|
| **链上现实** | 各链各自记账，token 实例独立 |
| **经济等价** | Circle 等发行方用储备 + mint/burn 维持 1:1 |
| **桥接机制** | CCTP、lock/mint wrapper、或 Intent 流动性，负责跨链结算 |

Intent 改善的是 **UX 与风险承担方**，不是消除跨链物理约束。

## 2. 「Native USDC」在各链上到底是什么？

以 USDC 为例，「native」在不同链上指 **Circle（或授权方）在该链上部署/铸造的官方 USDC**，而非该链协议层自带的资产：

| 链 | 「Native USDC」实际形态 |
|----|-------------------------|
| Ethereum | Circle 部署的 ERC-20 合约 |
| Arbitrum | 另一份 Circle 官方合约（非 `USDC.e` 桥接版） |
| Cosmos | 多在 Noble 发行，再经 IBC 传到其他 Cosmos 链 |
| Polkadot | Asset Hub 上的 Circle 授权资产 |
| NEAR | Circle 在 NEAR 上的 NEP-141 部署 |

共同点：**同一发行方、同一品牌、同一美元背书声明**；  
不同点：**不同链上地址/合约、不同共识、不同最终性模型**。

所以博客里的「same native version」应读作：

> 用户在目标链拿到的是 **发行方官方 USDC**，而不是第三方桥发的 IOU。

而不是：

> ~~多条链在共识层共享同一个 token~~（这是错的）。

## 3. Native vs Wrapped：关键在「谁 mint 目标链代币」

### Wrapped（传统桥 IOU）

```text
用户 USDC @ Chain A
  → 桥锁仓
  → 桥在 Chain B mint 自己的代币（USDC.e / bridged USDC）
```

- 目标链 token 的 **mint 权限在桥**，不在 Circle
- 桥被黑或跑路 → B 链代币 **depeg**
- 用户风险 = 桥运营商 / 多签 / 托管

### Issuer-native（Circle USDC 等）

```text
用户在 Chain A burn 官方 USDC（如 CCTP）
  → Circle 侧 attestation
  → Chain B 上 Circle 授权方 mint 官方 USDC
```

- 目标链 token 由 **发行方** mint，不是桥自造 IOU
- 桥/Intent 协议失败时，你手里的仍可能是 **真正的 Circle USDC**（取决于你拿到的是哪一类）
- 跨链链接靠 **发行方 attestation + mint/burn**，不是「共识合并」

| | Wrapped | Issuer-native |
|---|---------|---------------|
| B 链 token 来源 | 桥自 mint | Circle/发行方 mint |
| 脱锚风险 | 桥信用 | 主要跟发行方/结算路径 |
| 典型例子 | 老式 lock/mint 桥 | CCTP、各链官方 USDC |

## 4. Intent 做了什么？没做什么？

[Sovereign Intents](https://blog.hyperbridge.network/sovereign-intents/) 描述的 Intent 流程：

```text
1. 用户在源链 escrow 资产，声明意图（如「我要 Arbitrum 上 1000 USDC」）
2. Filler（LP）用自己在目标链的库存，立刻给用户官方 USDC
3. Filler 提交履行证明，在源链领取 escrow 补偿
4. Filler 通过 CCTP / Hyperbridge / IBC 等 rebalance 库存
```

### Intent 做到的

- **即时到账**：用户不必等跨链消息往返
- **用户拿 issuer-native**：Filler 从库存给出目标链官方 USDC，而非桥包装 IOU
- **风险转移**：结算等待期由 LP 承担，而非用户持有 wrapped 敞口

### Intent 做不到的

- **不能消除跨链**：Filler 最终仍要 rebalance，底层依赖跨链证明/消息（文中也承认）
- **不能泛化消息**：Intent 基本限于 **token 转移**；通用跨链消息仍需 Hyperbridge、XCM、IBC 等
- **资本效率差**：需要 LP 在各链预置流动性，成本通常高于 mint/burn 桥的证明验证费

Intent 是 **流动性前置 + 结算后置**，不是共识层资产统一。

## 5. 为什么 Hyperbridge 能做到「不 wrap」？——用 ISMP 笔记串起来

各链共识不共享，这一点不变。Hyperbridge 能避免 wrapped IOU，靠的不是「资产 magically 跨共识」，而是：**桥本身不 mint 目标链代币，只传递可验证的跨链事实，让目标链应用释放/铸造发行方官方资产。**

下面用两篇 ISMP 笔记说明这条路径为何可行。

> 技术背景：[Hyperbridge ISMP — state_root, overlay_root, and mmr_root](/post/2023-04-11-hyperbridge-ismp-state-overlay-mmr/) · [state vs log addendum](/post/2023-06-22-hyperbridge-ismp-addendum-state-vs-log-workflow/)

### 5.1 Wrapped 桥为什么必须「自造代币」？

传统桥要解决一个问题：**B 链无法直接读 A 链状态**（Beacon ≠ BEEFY ≠ Tendermint）。若缺少可验证的跨链证明，B 链只能信任桥运营商的声称：

```text
桥说「A 链已锁 100 USDC」→ B 链 mint 桥自己的 USDC.e
```

mint 权限在桥 → 用户持有的是 **桥 IOU**，不是 Circle 官方 USDC。

### 5.2 Hyperbridge 的角色：证明层，不是铸币层

ISMP 把跨链交互拆成两层：

| 层 | 谁负责 | 做什么 |
|----|--------|--------|
| **资产层** | 各链已有发行方（Circle USDC、链上 ERC-20 等） | 目标链上 **已存在** 的官方 token |
| **证明层** | Hyperbridge ISMP | 密码学证明「源链已 escrow / burn / 请求已履行」 |

桥不持有「在 B 链 mint 新代币」的权限；它只让 B 链合约 **验证一条 ISMP 消息后**，从协议金库/LP 库存/Circle minter 转出 **B 链上已有的官方 USDC**。

这就是「without wrapped」的精确含义：**用户最终拿到的是 issuer-native，不是桥自发 IOU。**

### 5.3 证明栈：共识各异，但验证路径统一

各链共识不同，Hyperbridge 不在共识层合并它们，而是在 **Hyperbridge coprocessor** 上聚合验证，再向 EVM/Substrate 输出统一格式的证明。笔记中的三层结构：

```text
① Relay BEEFY MMR          — 建立对 Polkadot relay / parachain 的信任根
   (EVM: `IConsensusV2` / `ConsensusRouter` + BEEFY，见 §5.8)

② Hyperbridge message MMR  — 证明 ISMP 请求/响应在有序日志中存在
   (EVM: `HandlerV2` vs `overlayRoot` = `mmr_root`，见 §5.8)

③ ISMP child trie          — 证明 commitment 元数据（receipt、fee、已响应标记）
   (OverlayProof vs StateProof，见 2023-04-11 §Which root a proof uses)
```

关键区分（[2023-06-22 addendum](/post/2023-06-22-hyperbridge-ismp-addendum-state-vs-log-workflow/) §Trie vs MMR）：

- **Child trie = state**：「这条 commitment 在 pallet 里登记了吗？receipt/claim 状态如何？」
- **Message MMR = log**：「这条 request/response 在有序消息日志的哪个位置？」

EVM 侧 `HandlerV2` 的典型路径（addendum §What overlayRoot means on EVM；代码见 §5.7）：

```text
handleConsensus  →  IConsensusV2 验证 BEEFY，接受 Hyperbridge StateCommitment
handlePostRequests / handleGetResponses
                 →  MMR multiproof vs overlayRoot（= message MMR root）
                 →  dispatchIncoming → 应用回调 onGetResponse / onPostRequest
```

**BEEFY MMR ≠ Hyperbridge message MMR**（2023-04-11 §Two MMRs）：前者证 relay 最终性，后者证 ISMP 消息存在。Intent 赎回/退款依赖的是后者 + coprocessor 认证，不是「相信 relayer 口头说已履行」。

### 5.4 Coprocessor GET 流：跨链事实如何被「公证」

[2023-06-22 addendum](/post/2023-06-22-hyperbridge-ismp-addendum-state-vs-log-workflow/) 描述的 coprocessor GET workflow，正是「不 wrap 也能结算」的核心机制之一：

```text
1. 源链发起 GetRequest（或 POST 携带转账意图）
2. Relayer 组装：
     - 源链 proof：request 已在源链 ISMP state 中 commit
     - 目标链 storage proof：目标链上相关状态（如 escrow 已释放、余额已变动）
3. 提交 GetRequestsWithProof → Hyperbridge coprocessor
4. Coprocessor 本地验证双端 proof → 写入 GetResponse 到 message MMR
5. 消费者在目标/源链用 MMR proof 触发应用逻辑（release / mint / claim）
```

`dispatch_get_response` 做的事（addendum §Hyperbridge coprocessor GET workflow）：

- 把 `GetResponse` 插入 coprocessor 的 **MMR**（log 层）
- 写 `ResponseCommitments`、`Responded[request]`（trie 层元数据）
- **不**替用户「发币」——只 **公证**「A 链请求了 X，B 链状态是 Y」

下游合约拿到 MMR proof 后，自行执行：**从金库转 B 链官方 USDC 给用户**，或 **在源链释放 escrow 给 Filler**。全程无需桥 mint 新 token。

### 5.5 两条「不 wrap」路径对照

**路径 A — ISMP 消息桥（直接转移）**

```text
用户 lock/burn 官方 USDC @ Chain A
  → ISMP POST 消息 commit 到 source ISMP child trie + message MMR
  → Relayer 提交 proof 到 Chain B 的 EvmHost/Handler
  → HandlerV2 验证 BEEFY + MMR（overlayRoot）
  → B 链 app 回调：转出现有官方 USDC（或调 Circle minter mint 官方 USDC）
```

用户收到的是 **B 链上已存在的 issuer-native**；Hyperbridge 只传递 **可验证消息**，不创建 `USDC.e`。

**路径 B — Intent Gateway（流动性前置）**

```text
用户 escrow 官方 USDC @ Chain A
  → Filler 立刻给用户 B 链官方 USDC（来自 Filler 库存）
  → Filler 需证明「已在 B 链履行」
  → Hyperbridge ISMP 提供履行证明 / 未履行退款证明（替代多签 attestation）
  → Filler 在 A 链 claim escrow；后续通过 ISMP/CCTP/IBC rebalance
```

用户侧同样不接触 wrapped IOU；Hyperbridge 解决的是 **Filler 赎回与用户退款的信任问题**（Sovereign Intents 博文的核心诉求）。

### 5.6 和「共识不共享」如何自洽？

| 问题 | 回答 |
|------|------|
| 各链 token 是同一个吗？ | **不是**——仍是独立合约/实例 |
| 各链共识能互读吗？ | **不能**——Beacon/BEEFY/Tendermint 各自独立 |
| 那「不 wrap」靠什么？ | **Hyperbridge 把跨链事实变成可在目标链验证的 proof**；目标链 app 操作 **已有官方资产** |
| Hyperbridge mint 新币吗？ | **不 mint**——它是 coprocessor + 消息总线，不是 wrapped-token 发行方 |
| 和 CCTP 的关系？ | CCTP = 发行方 burn/mint；Hyperbridge = 通用消息/状态证明。可组合：ISMP 证 escrow 释放，CCTP 做 issuer 侧 mint |

一句话：**共识不共享 → 不能直接共享资产；密码学证明可验证 → 不需要桥自造 IOU 来桥接信任缺口。**

### 5.7 Coprocessor 是「链无关」的吗？所有路由用同一套 proof 吗？

**半对半错**：所有经 Hyperbridge 的路由（Polkadot→Ethereum、Polkadot→Cosmos、Substrate→EVM 等）共享 **同一 coprocessor 模型**，但 **不是** 端到端同一套 proof 字节。

#### 什么是链无关的（统一模型）

| 层级 | 是否统一 | 内容 |
|------|----------|------|
| **协议语义** | 是 | ISMP POST/GET、commitment hash、timeout/refund |
| **Proxy 角色** | 是 | Nexus runtime 将 **Hyperbridge 自身** 设为唯一 coprocessor；各连接链通过 `allowed_proxy()` 指向它（见 §5.8） |
| **Coprocessor 内部状态** | 是 | child trie（state）+ message MMR（log），见 [2023-04-11](/post/2023-04-11-hyperbridge-ismp-state-overlay-mmr/) §Coprocessor vs non-coprocessor |
| **认证产物** | 是 | Coprocessor 验证后写入 **Hyperbridge message MMR** 的 request/response leaf |

统一工作流：

```text
源链 ISMP commit（child trie + MMR）
  → Relayer 组装各链特有的 proof
  → Hyperbridge coprocessor 本地验证
  → 结果写入 Hyperbridge message MMR（+ trie 元数据）
  → 目标链验证 Hyperbridge 最终性 + MMR inclusion
  → App 释放 native 资产 / 执行回调
```

Proxy 的价值（[ISMP proxies](https://docs.hyperbridge.network/protocol/ismp/proxies)）：若目标链须自行验证 **每一条** 源链的共识 proof，成本会爆炸；改为只验证 **Hyperbridge 一家** coprocessor 的输出。

#### 什么不是统一的（按链定制的 proof 机械）

**① 进入 Hyperbridge（源链侧）——每条链不同**

Coprocessor 要验证各链自己的共识 + 状态，ISMP 通过 **模块化 consensus client / state machine** 接入，而非一种 proof 打天下：

| 源链类型 | 共识 proof | 状态 proof |
|----------|------------|------------|
| Polkadot parachain | BEEFY + parachain header | Substrate `LayoutV0` / child trie OverlayProof |
| Ethereum / L2 | Beacon / execution light client | EIP-1186 storage（**非** `LayoutV0`，见 [2023-04-11](/post/2023-04-11-hyperbridge-ismp-state-overlay-mmr/) §Verifying LayoutV0） |
| Cosmos | Tendermint / IBC 类 client | ICS-23 等 |

因此 Polkadot→Ethereum 与 Polkadot→Cosmos **源侧 proof 可相同**（同是 Polkadot），但 coprocessor 在 GET 流程中拉取的 **目标链 storage proof 格式不同**（[2023-06-22](/post/2023-06-22-hyperbridge-ismp-addendum-state-vs-log-workflow/) §Coprocessor GET workflow）。

**② 离开 Hyperbridge（目标链侧）——同一产物，不同验证器**

交付物始终是：**Hyperbridge `StateCommitment` + message MMR proof**。但各目标链用自己的方式验证：

| 目标链 | 验证方式 |
|--------|----------|
| **EVM** | `IConsensusV2.verifyConsensus`（BEEFY 证 Hyperbridge 最终性）→ `HandlerV2` 对 `overlayRoot` 做 MMR multiproof |
| **Substrate** | Runtime API / child-trie 或 MMR proof 对 coprocessor state |
| **Cosmos** | `TendermintClient` 等独立 consensus client（非 EVM `HandlerV2`） |

**③ 两个 MMR 不要混**

[2023-04-11](/post/2023-04-11-hyperbridge-ismp-state-overlay-mmr/) §Two MMRs：

- **Relay BEEFY MMR** — 建立「Hyperbridge/Polkadot 区块已最终」的信任根
- **Hyperbridge message MMR** — 建立「这条 ISMP 消息存在」（coprocessor 上 `overlayRoot`）

每条路由在概念上都经过这两层，但 **建立对 Hyperbridge 信任的 relay 共识 proof**，随 **目标链所部署的 consensus client** 而变（EVM 上 `ConsensusRouter`/`SP1Beefy` ≠ `TendermintClient`）。

#### 代码确认（`/Users/yangrong/Projects/hyperbridge`）

以下对照当前仓库实现，验证 §5.7 的论断（2026-07 读码）。

**① 单一全局 coprocessor（非「每条链一个 coprocessor」）**

Nexus runtime 把 Hyperbridge 自身设为 coprocessor：

```rust
// parachain/runtimes/nexus/src/ismp.rs
pub struct Coprocessor;
impl Get<Option<StateMachine>> for Coprocessor {
    fn get() -> Option<StateMachine> {
        Some(HostStateMachine::get())  // Hyperbridge 指向自己
    }
}
```

`pallet_ismp::host::allowed_proxy()` 返回同一 `Coprocessor::get()`。各连接链是 **ISMP host**（如 `EvmHosts` map），消息经 Hyperbridge 代理验证——与 [ISMP proxies](https://docs.hyperbridge.network/protocol/ismp/proxies) 文档一致。

**② Coprocessor 上 state_root / overlay_root 互换 — CONFIRMED**

```rust
// modules/ismp/clients/parachain/client/src/consensus.rs
match T::Coprocessor::get() {
    Some(id) if id == state_id => StateCommitment {
        overlay_root: Some(mmr_root),      // message MMR
        state_root: overlay_root,          // child trie root
        ...
    },
    _ => StateCommitment {
        overlay_root: Some(overlay_root),  // child trie
        state_root: header.state_root,     // full chain trie
        ...
    },
}
```

**③ 按链类型的 consensus client 注册表 — CONFIRMED**

`parachain/runtimes/nexus/src/ismp.rs` 中 `ConsensusClients` tuple：

| Client | 链类型 |
|--------|--------|
| `SyncCommitteeConsensusClient` | Ethereum / Gnosis beacon |
| `ParachainConsensusClient` | Polkadot parachains |
| `BeefyConsensusClient` | BEEFY 最终性 |
| `TendermintClient` | Cosmos/Tendermint |
| `ArbitrumConsensusClient` / `OptimismConsensusClient` / `PolygonClient` / `BscClient` | L2 / 其他 EVM |

**④ 按链类型的 state proof 格式 — CONFIRMED**

| 格式 | 代码位置 |
|------|----------|
| Substrate `LayoutV0` | `modules/ismp/state-machines/substrate/src/lib.rs` — `StateMachineProof` + `TrieDBBuilder::<LayoutV0<...>>` |
| EVM EIP-1186 | `modules/ismp/state-machines/evm/src/utils.rs` — `TrieDBBuilder::<EIP1186Layout<...>>` |
| Cosmos ICS-23 | `modules/ismp/state-machines/evm/src/tendermint.rs` — `TendermintEvmStateMachine` verifying ICS23 KV proofs |

**⑤ EVM 目标链：BEEFY 共识 → MMR vs overlayRoot — CONFIRMED（HandlerV2）**

仓库中 `HandlerV1` 已不存在；当前为 `evm/src/core/HandlerV2.sol`：

```solidity
// handleConsensus
IConsensusV2(host.consensusClient()).verify(previousState, proof);

// handleGetResponses / handlePostRequests
bytes32 root = host.stateMachineCommitment(message.proof.height).overlayRoot;
MerkleMountainRange.VerifyProof(root, message.proof.multiproof, leaves, ...);
```

**⑥ Coprocessor GET：双端 proof 验证 → 写入 MMR — CONFIRMED**

`modules/pallets/state-coprocessor/src/impls.rs` — `handle_get_requests`：

```rust
// 1. 源链 membership proof
source_state_machine.verify_membership(&host, commitments, state_root, &source)?;

// 2. 目标链 storage proof（格式由 dest_state_machine 决定）
dest_state_machine.verify_state_proof(&host, req.keys.clone(), state_root.state_root, &response)?;

// 3. 写入 message MMR
<T as Config>::Mmr::push(Leaf::GetResponse(get_response));
```

`validate_state_machine` 按 `StateMachine` ID 路由到 `SubstrateStateMachine`、`EvmStateMachine`、`TendermintEvmStateMachine` 等不同 client——**同一 coprocessor 工作流，不同 proof 验证器**。

#### 直接回答

| 问题 | 答案 |
|------|------|
| 所有路由用同一 coprocessor **架构**？ | **是** — proxy、GET/POST、trie+MMR、在 Hyperbridge 上认证（代码 §5.7 ⑤⑥） |
| 所有路由用同一套 **proof 字节**？ | **否** — `ConsensusClients` + `StateMachineClient` 按链分发（代码 §5.7 ③④） |
| Coprocessor 是每条链一个？ | **否** — 一个全局 Hyperbridge coprocessor；各链是 ISMP host |
| 源链共识/状态 proof | **按源链定制** |
| 目标链验证 Hyperbridge 输出 | **按目标链定制** |
| Hyperbridge 上认证的对象 | **是，统一**（message MMR leaf） |

类比：HTTP 协议链无关，但 TLS 握手、TCP 栈因客户端而异——**API 统一，线缆层 crypto 因 peer 而异**。

> Hyperbridge 把跨链事实 **归一化进一个 coprocessor log**；它 **不** 归一化各链证明自己共识/状态的方式。

## 6. Intent Gateway（Hyperbridge）要点

针对现有 Intent 协议仍依赖**可信中继/多签**做赎回与退款的问题，Hyperbridge 提出 **Intent Gateway**：

- 用 **密码学证明**（§5.3–5.4 的 ISMP 栈）替代乐观预言机 / 多签委员会
- Filler 用 **GetResponse / MMR proof** 在源链 **即时** 赎回 escrow
- 用户用 **未履行证明**（state trie 可证 timeout / 未响应）保证退款
- 初期 **0 bps** 桥费，用 `$BRIDGE` 激励 LP；后期费用也以 BRIDGE 结算

Intent Gateway 是 §5.5 路径 B 的产品化；底层仍依赖 [ISMP state vs log](/post/2023-06-22-hyperbridge-ismp-addendum-state-vs-log-workflow/) 双轨证明，而非让各链共享同一 token。

## 7. 一张图串起来

```text
                    ┌─────────────────────────────────────┐
                    │  经济层：Circle 1:1 背书（off-chain）   │
                    └─────────────────────────────────────┘
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
   Ethereum USDC                 Arbitrum USDC                  Noble USDC
   (独立合约)                    (独立合约)                     (IBC 扩散)
   Beacon 共识                   Nitro 共识                     Tendermint

证明层（Hyperbridge ISMP）：
  BEEFY 共识根 → message MMR (overlayRoot) → child trie (state)
  Coprocessor 公证跨链事实 → 目标链 app 释放已有官方资产

跨链机制（三选一或组合）：
  A. CCTP: burn A → attest → mint B        （issuer-native，无桥 IOU）
  B. Wrapper: lock A → bridge mint IOU@B   （桥信用风险）
  C. Intent: LP 先给 B-native → ISMP 证赎回  （UX 好，LP 承担 rebalance）
```

## 8. 读 Hyperbridge 博文时的翻译对照

| 原文表述 | 更准确的理解 |
|----------|--------------|
| "native USDC on multiple chains" | 发行方在多条链分别部署的官方 USDC |
| "same native version on another chain" | 目标链接收 **同品牌官方代币**，不是同一链上实例 |
| "without wrapped representations" | 不给用户桥自发 IOU；用户侧体验是官方 USDC |
| "bypass cross-chain messaging" | 用户路径上 **即时交付**；LP 侧 rebalance 仍要跨链 |

## 参考

- [Sovereign Intents (Hyperbridge)](https://blog.hyperbridge.network/sovereign-intents/)
- [ISMP Proxies (Hyperbridge docs)](https://docs.hyperbridge.network/protocol/ismp/proxies)
- [Hyperbridge ISMP — state_root, overlay_root, and mmr_root](/post/2023-04-11-hyperbridge-ismp-state-overlay-mmr/)
- [Hyperbridge ISMP — state vs log addendum](/post/2023-06-22-hyperbridge-ismp-addendum-state-vs-log-workflow/)
- [Hyperbridge source (`/Users/yangrong/Projects/hyperbridge`)](file:///Users/yangrong/Projects/hyperbridge) — §5.7 代码确认
