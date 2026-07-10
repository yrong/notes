---
author: Ron
date: 2024-03-10T14:40:00+08:00
tags:
- blockchain
- hyperbridge
- bridging
- intents
title: "Notes: Native vs Wrapped vs Intent (cross-chain assets clarified)"
---

Reading [Hyperbridge — Sovereign Intents](https://blog.hyperbridge.network/sovereign-intents/), the line that USDC is “natively issued on multiple chains” and intents move “the same native asset” across chains is easy to misread: **chains do not share consensus (Beacon, BEEFY, Tendermint/IBC) — so how can they share one native asset without wrapping?**

This note clarifies what **native / wrapped / intent** actually mean, and covers Intent Gateway.

<!--more-->

## 1. Core takeaway (read this first)

- USDC on each chain is a **separate on-chain token instance** (different contract / pallet / denom); consensus layers differ too.
- Chains **cannot** “share one native asset” in the consensus sense.
- Marketing “native” usually means **issuer-minted official token**, not “one shared ledger across chains.”

What actually happens is three layers:

| Layer | Meaning |
|------|------|
| **On-chain reality** | Each chain keeps its own books; token instances are independent |
| **Economic equivalence** | Issuers like Circle keep 1:1 via reserves + mint/burn |
| **Bridge mechanism** | CCTP, lock/mint wrappers, or intent liquidity handle cross-chain settlement |

Intents improve **UX and who bears risk** — they do not erase cross-chain physics.

## 2. What is “native USDC” on each chain?

For USDC, “native” means **Circle (or an authorized party) deployed/minted official USDC on that chain** — not an asset built into the chain’s protocol:

| Chain | What “native USDC” actually is |
|----|-------------------------|
| Ethereum | Circle’s ERC-20 contract |
| Arbitrum | Another Circle official contract (not bridged `USDC.e`) |
| Cosmos | Often issued on Noble, then IBC’d to other Cosmos chains |
| Polkadot | Circle-authorized asset on Asset Hub |
| NEAR | Circle’s NEP-141 deployment on NEAR |

Same: **same issuer, brand, and dollar claim**.  
Different: **addresses/contracts, consensus, finality**.

So “same native version” in the blog should be read as:

> The user receives **issuer-official USDC** on the destination chain — not a third-party bridge IOU.

Not:

> ~~Multiple chains share one token at the consensus layer~~ (wrong).

## 3. Native vs wrapped: who mints on the destination?

### Wrapped (classic bridge IOU)

```text
User USDC @ Chain A
  → bridge locks
  → bridge mints its own token on Chain B (USDC.e / bridged USDC)
```

- Destination mint authority sits with the **bridge**, not Circle
- Bridge hack / exit → B-side token **depegs**
- User risk = bridge operator / multisig / custody

### Issuer-native (Circle USDC, etc.)

```text
User burns official USDC on Chain A (e.g. CCTP)
  → Circle attestation
  → Circle-authorized minter mints official USDC on Chain B
```

- Destination token is minted by the **issuer**, not a bridge IOU
- If a bridge/intent protocol fails, you may still hold **real Circle USDC** (depending on what you received)
- Cross-chain linkage is **issuer attestation + mint/burn**, not “merged consensus”

| | Wrapped | Issuer-native |
|---|---------|---------------|
| Source of B-side token | Bridge mints | Circle / issuer mints |
| Depeg risk | Bridge credit | Mostly issuer / settlement path |
| Examples | Legacy lock/mint bridges | CCTP, per-chain official USDC |

## 4. What intents do — and don’t

[Sovereign Intents](https://blog.hyperbridge.network/sovereign-intents/) flow:

```text
1. User escrows assets on source; states intent (e.g. “I want 1000 USDC on Arbitrum”)
2. Filler (LP) instantly gives user official USDC from destination inventory
3. Filler submits fulfillment proof; claims escrow on source
4. Filler rebalances via CCTP / Hyperbridge / IBC / etc.
```

### What intents achieve

- **Instant delivery**: user need not wait for a round-trip message
- **Issuer-native for the user**: filler pays destination official USDC, not a wrapped IOU
- **Risk shift**: settlement delay sits with LPs, not users holding wrapped exposure

### What intents cannot do

- **Cannot erase cross-chain**: fillers still rebalance; that still needs proofs/messages (the post admits this)
- **Cannot generalize messaging**: intents are mostly **token transfers**; general messages still need Hyperbridge, XCM, IBC, etc.
- **Capital inefficient**: LPs must pre-position liquidity; cost usually exceeds mint/burn proof verification fees

Intents are **liquidity first, settlement later** — not consensus-layer asset unification.

## 5. Why Hyperbridge can avoid wrapping — via the ISMP notes

Consensus is still not shared. Hyperbridge avoids wrapped IOUs not by “magically moving assets across consensus,” but by: **the bridge does not mint destination tokens; it only carries verifiable cross-chain facts so destination apps release/mint issuer-official assets.**

Two ISMP notes explain why that path works:

> Background: [Hyperbridge ISMP — state_root, overlay_root, and mmr_root](/post/2023-04-11-hyperbridge-ismp-state-overlay-mmr/) · [state vs log addendum](/post/2023-06-22-hyperbridge-ismp-addendum-state-vs-log-workflow/)

### 5.1 Why wrapped bridges must mint their own token

Classic bridges face: **B cannot read A’s state** (Beacon ≠ BEEFY ≠ Tendermint). Without verifiable proofs, B must trust the bridge operator:

```text
Bridge says “100 USDC locked on A” → B mints the bridge’s own USDC.e
```

Mint authority on the bridge → users hold a **bridge IOU**, not Circle USDC.

### 5.2 Hyperbridge’s role: proof layer, not mint layer

ISMP splits cross-chain interaction into two layers:

| Layer | Who | What |
|----|--------|--------|
| **Asset layer** | Existing issuers per chain (Circle USDC, ERC-20s, …) | Official tokens **already on** the destination |
| **Proof layer** | Hyperbridge ISMP | Cryptographic proof that source escrowed / burned / fulfilled |

The bridge has no “mint new token on B” authority. It lets a B-side contract **verify an ISMP message**, then move **existing official USDC on B** from a vault / LP inventory / Circle minter.

That is the precise meaning of “without wrapped”: **users end with issuer-native, not a bridge-issued IOU.**

### 5.3 Proof stack: different consensus, unified verification path

Hyperbridge does not merge consensus layers. It aggregates verification on the **Hyperbridge coprocessor**, then emits a uniform proof shape to EVM/Substrate. Three layers from the notes:

```text
① Relay BEEFY MMR          — trust root for Polkadot relay / parachain
   (EVM: IConsensusV2 / ConsensusRouter + BEEFY; see §5.7)

② Hyperbridge message MMR  — ISMP request/response in the ordered log
   (EVM: HandlerV2 vs overlayRoot = mmr_root; see §5.7)

③ ISMP child trie          — commitment metadata (receipt, fee, responded)
   (OverlayProof vs StateProof; see 2023-04-11 §Which root a proof uses)
```

Key split ([2023-06-22 addendum](/post/2023-06-22-hyperbridge-ismp-addendum-state-vs-log-workflow/) §Trie vs MMR):

- **Child trie = state**: “Is this commitment registered? What is receipt/claim state?”
- **Message MMR = log**: “Where is this request/response in the ordered message log?”

Typical EVM `HandlerV2` path (addendum §What overlayRoot means on EVM; code in §5.7):

```text
handleConsensus  →  IConsensusV2 verifies BEEFY; accept Hyperbridge StateCommitment
handlePostRequests / handleGetResponses
                 →  MMR multiproof vs overlayRoot (= message MMR root)
                 →  dispatchIncoming → app callbacks onGetResponse / onPostRequest
```

**BEEFY MMR ≠ Hyperbridge message MMR** (2023-04-11 §Two MMRs): the former proves relay finality; the latter proves an ISMP message exists. Intent redeem/refund depends on the latter + coprocessor certification — not “trust the relayer’s word.”

### 5.4 Coprocessor GET flow: notarizing cross-chain facts

The [2023-06-22 addendum](/post/2023-06-22-hyperbridge-ismp-addendum-state-vs-log-workflow/) GET workflow is a core “settle without wrapping” mechanism:

```text
1. Source issues GetRequest (or POST with transfer intent)
2. Relayer assembles:
     - source proof: request committed in source ISMP state
     - dest storage proof: relevant dest state (escrow released, balances changed, …)
3. Submit GetRequestsWithProof → Hyperbridge coprocessor
4. Coprocessor verifies both proofs locally → writes GetResponse into message MMR
5. Consumers on dest/source use MMR proofs to trigger app logic (release / mint / claim)
```

What `dispatch_get_response` does (addendum §Hyperbridge coprocessor GET workflow):

- Insert `GetResponse` into the coprocessor **MMR** (log layer)
- Write `ResponseCommitments`, `Responded[request]` (trie metadata)
- Does **not** mint for the user — only **notarizes** “A requested X; B’s state is Y”

Downstream contracts, given an MMR proof, then: **transfer existing B-side official USDC from a vault**, or **release escrow to the filler on source**. No bridge-minted token required.

### 5.5 Two non-wrap paths

**Path A — ISMP message bridge (direct transfer)**

```text
User lock/burn official USDC @ Chain A
  → ISMP POST committed to source child trie + message MMR
  → Relayer submits proof to Chain B EvmHost/Handler
  → HandlerV2 verifies BEEFY + MMR (overlayRoot)
  → B-side app callback: transfer existing official USDC (or Circle minter mints official USDC)
```

User receives **issuer-native already on B**; Hyperbridge only carries a **verifiable message** — it does not create `USDC.e`.

**Path B — Intent Gateway (liquidity first)**

```text
User escrows official USDC @ Chain A
  → Filler instantly gives user B-side official USDC (from filler inventory)
  → Filler must prove “fulfilled on B”
  → Hyperbridge ISMP provides fulfillment / non-fulfillment refund proofs (replacing multisig attestation)
  → Filler claims escrow on A; later rebalances via ISMP/CCTP/IBC
```

Users still never touch a wrapped IOU; Hyperbridge solves **filler redeem and user refund trust** (the core Sovereign Intents claim).

### 5.6 How this fits “consensus is not shared”

| Question | Answer |
|------|------|
| Same token on every chain? | **No** — still separate contracts/instances |
| Can chains read each other’s consensus? | **No** — Beacon / BEEFY / Tendermint stay separate |
| Then how “no wrap”? | **Hyperbridge turns cross-chain facts into destination-verifiable proofs**; dest apps move **existing official assets** |
| Does Hyperbridge mint? | **No** — coprocessor + message bus, not a wrapped-token issuer |
| Relation to CCTP? | CCTP = issuer burn/mint; Hyperbridge = general message/state proofs. Composable: ISMP proves escrow release; CCTP does issuer-side mint |

One line: **No shared consensus → no directly shared asset; verifiable crypto proofs → no need for bridge IOUs to paper over the trust gap.**

### 5.7 Is the coprocessor “chain-agnostic”? Same proofs on every route?

**Half right:** every Hyperbridge route (Polkadot→Ethereum, Polkadot→Cosmos, Substrate→EVM, …) shares the **same coprocessor model**, but **not** the same end-to-end proof bytes.

#### What is chain-agnostic (unified model)

| Layer | Unified? | Content |
|------|----------|------|
| **Protocol semantics** | Yes | ISMP POST/GET, commitment hash, timeout/refund |
| **Proxy role** | Yes | Nexus runtime sets **Hyperbridge itself** as the sole coprocessor; connected chains point to it via `allowed_proxy()` (see code below) |
| **Coprocessor internal state** | Yes | child trie (state) + message MMR (log); see [2023-04-11](/post/2023-04-11-hyperbridge-ismp-state-overlay-mmr/) §Coprocessor vs non-coprocessor |
| **Certified artifact** | Yes | After verify, request/response leaves in **Hyperbridge message MMR** |

Unified workflow:

```text
Source ISMP commit (child trie + MMR)
  → Relayer assembles chain-specific proofs
  → Hyperbridge coprocessor verifies locally
  → Result written to Hyperbridge message MMR (+ trie metadata)
  → Destination verifies Hyperbridge finality + MMR inclusion
  → App releases native assets / runs callback
```

Proxy value ([ISMP proxies](https://docs.hyperbridge.network/protocol/ismp/proxies)): if every destination verified **every** source consensus proof itself, cost explodes; instead destinations only verify **one** Hyperbridge coprocessor output.

#### What is not unified (per-chain proof machinery)

**① Into Hyperbridge (source side) — per chain**

The coprocessor must verify each chain’s own consensus + state. ISMP plugs in **modular consensus clients / state machines** — not one proof format for all:

| Source type | Consensus proof | State proof |
|----------|------------|------------|
| Polkadot parachain | BEEFY + parachain header | Substrate `LayoutV0` / child trie OverlayProof |
| Ethereum / L2 | Beacon / execution light client | EIP-1186 storage (**not** `LayoutV0`; see [2023-04-11](/post/2023-04-11-hyperbridge-ismp-state-overlay-mmr/) §Verifying LayoutV0) |
| Cosmos | Tendermint / IBC-style client | ICS-23, etc. |

So Polkadot→Ethereum and Polkadot→Cosmos can share **source-side** proofs (both Polkadot), but GET destination **storage proof formats differ** ([2023-06-22](/post/2023-06-22-hyperbridge-ismp-addendum-state-vs-log-workflow/) §Coprocessor GET workflow).

**② Out of Hyperbridge (destination side) — same artifact, different verifiers**

Delivery is always: **Hyperbridge `StateCommitment` + message MMR proof**. Destinations verify differently:

| Destination | How it verifies |
|--------|----------|
| **EVM** | `IConsensusV2.verifyConsensus` (BEEFY for Hyperbridge finality) → `HandlerV2` MMR multiproof vs `overlayRoot` |
| **Substrate** | Runtime API / child-trie or MMR proof against coprocessor state |
| **Cosmos** | Separate clients such as `TendermintClient` (not EVM `HandlerV2`) |

**③ Do not confuse the two MMRs**

[2023-04-11](/post/2023-04-11-hyperbridge-ismp-state-overlay-mmr/) §Two MMRs:

- **Relay BEEFY MMR** — trust that a Hyperbridge/Polkadot block is final
- **Hyperbridge message MMR** — trust that this ISMP message exists (`overlayRoot` on the coprocessor)

Every route conceptually uses both layers, but the **relay consensus proof that establishes trust in Hyperbridge** depends on the **destination’s deployed consensus client** (EVM `ConsensusRouter`/`SP1Beefy` ≠ `TendermintClient`).

#### Code confirmation (`/Users/yangrong/Projects/hyperbridge`)

Checked against the current repo (read July 2026) for §5.7 claims.

**① One global coprocessor (not one per chain)**

Nexus runtime sets Hyperbridge itself as coprocessor:

```rust
// parachain/runtimes/nexus/src/ismp.rs
pub struct Coprocessor;
impl Get<Option<StateMachine>> for Coprocessor {
    fn get() -> Option<StateMachine> {
        Some(HostStateMachine::get())  // Hyperbridge points at itself
    }
}
```

`pallet_ismp::host::allowed_proxy()` returns the same `Coprocessor::get()`. Connected chains are **ISMP hosts** (e.g. `EvmHosts` map); messages are verified via Hyperbridge as proxy — matching [ISMP proxies](https://docs.hyperbridge.network/protocol/ismp/proxies).

**② state_root / overlay_root swap on coprocessor — CONFIRMED**

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

**③ Per-chain-type consensus client registry — CONFIRMED**

`ConsensusClients` tuple in `parachain/runtimes/nexus/src/ismp.rs`:

| Client | Chain type |
|--------|--------|
| `SyncCommitteeConsensusClient` | Ethereum / Gnosis beacon |
| `ParachainConsensusClient` | Polkadot parachains |
| `BeefyConsensusClient` | BEEFY finality |
| `TendermintClient` | Cosmos/Tendermint |
| `ArbitrumConsensusClient` / `OptimismConsensusClient` / `PolygonClient` / `BscClient` | L2 / other EVM |

**④ Per-chain-type state proof formats — CONFIRMED**

| Format | Code location |
|------|----------|
| Substrate `LayoutV0` | `modules/ismp/state-machines/substrate/src/lib.rs` — `StateMachineProof` + `TrieDBBuilder::<LayoutV0<...>>` |
| EVM EIP-1186 | `modules/ismp/state-machines/evm/src/utils.rs` — `TrieDBBuilder::<EIP1186Layout<...>>` |
| Cosmos ICS-23 | `modules/ismp/state-machines/evm/src/tendermint.rs` — `TendermintEvmStateMachine` verifying ICS23 KV proofs |

**⑤ EVM destination: BEEFY consensus → MMR vs overlayRoot — CONFIRMED (HandlerV2)**

`HandlerV1` is gone; current is `evm/src/core/HandlerV2.sol`:

```solidity
// handleConsensus
IConsensusV2(host.consensusClient()).verify(previousState, proof);

// handleGetResponses / handlePostRequests
bytes32 root = host.stateMachineCommitment(message.proof.height).overlayRoot;
MerkleMountainRange.VerifyProof(root, message.proof.multiproof, leaves, ...);
```

**⑥ Coprocessor GET: dual-end proof verify → MMR write — CONFIRMED**

`modules/pallets/state-coprocessor/src/impls.rs` — `handle_get_requests`:

```rust
// 1. Source membership proof
source_state_machine.verify_membership(&host, commitments, state_root, &source)?;

// 2. Dest storage proof (format chosen by dest_state_machine)
dest_state_machine.verify_state_proof(&host, req.keys.clone(), state_root.state_root, &response)?;

// 3. Push into message MMR
<T as Config>::Mmr::push(Leaf::GetResponse(get_response));
```

`validate_state_machine` routes by `StateMachine` ID to `SubstrateStateMachine`, `EvmStateMachine`, `TendermintEvmStateMachine`, etc. — **same coprocessor workflow, different proof verifiers**.

#### Direct answers

| Question | Answer |
|------|------|
| Same coprocessor **architecture** on every route? | **Yes** — proxy, GET/POST, trie+MMR, certify on Hyperbridge (code §5.7 ⑤⑥) |
| Same **proof bytes** on every route? | **No** — `ConsensusClients` + `StateMachineClient` per chain (code §5.7 ③④) |
| One coprocessor per chain? | **No** — one global Hyperbridge coprocessor; each chain is an ISMP host |
| Source consensus/state proofs | **Per source chain** |
| Dest verification of Hyperbridge output | **Per destination chain** |
| Artifact certified on Hyperbridge | **Yes, unified** (message MMR leaf) |

Analogy: HTTP is chain-agnostic; TLS handshakes and TCP stacks differ by client — **unified API, peer-specific wire crypto**.

> Hyperbridge **normalizes cross-chain facts into one coprocessor log**; it does **not** normalize how each chain proves its own consensus/state.

## 6. Intent Gateway (Hyperbridge) highlights

Existing intent protocols still lean on **trusted relays/multisigs** for redeem and refund. Hyperbridge’s **Intent Gateway**:

- Replaces optimistic oracles / multisig committees with **cryptographic proofs** (ISMP stack in §5.3–5.4)
- Fillers redeem escrow on source **immediately** with **GetResponse / MMR proof**
- Users get refunds via **non-fulfillment proofs** (state trie can show timeout / not responded)
- Initially **0 bps** bridge fees; LPs incentivized with `$BRIDGE`; later fees also settle in BRIDGE

Intent Gateway productizes §5.5 path B; it still rests on [ISMP state vs log](/post/2023-06-22-hyperbridge-ismp-addendum-state-vs-log-workflow/) dual-track proofs — not shared tokens across chains.

## 7. One diagram

```text
                    ┌─────────────────────────────────────┐
                    │  Economic layer: Circle 1:1 (off-chain) │
                    └─────────────────────────────────────┘
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
   Ethereum USDC                 Arbitrum USDC                  Noble USDC
   (separate contract)           (separate contract)            (IBC diffusion)
   Beacon consensus              Nitro consensus                Tendermint

Proof layer (Hyperbridge ISMP):
  BEEFY consensus root → message MMR (overlayRoot) → child trie (state)
  Coprocessor notarizes cross-chain facts → dest app releases existing official assets

Bridge mechanisms (pick one or combine):
  A. CCTP: burn A → attest → mint B        (issuer-native, no bridge IOU)
  B. Wrapper: lock A → bridge mint IOU@B   (bridge credit risk)
  C. Intent: LP pays B-native first → ISMP proves redeem  (better UX; LP rebalances)
```

## 8. Reading the Hyperbridge blog — translation table

| Blog wording | More accurate reading |
|----------|--------------|
| "native USDC on multiple chains" | Issuer-deployed official USDC on each chain separately |
| "same native version on another chain" | Destination receives **same-brand official token**, not the same on-chain instance |
| "without wrapped representations" | Users do not get bridge-issued IOUs; UX is official USDC |
| "bypass cross-chain messaging" | **Instant delivery** on the user path; LP rebalance still needs cross-chain |

## References

- [Sovereign Intents (Hyperbridge)](https://blog.hyperbridge.network/sovereign-intents/)
- [ISMP Proxies (Hyperbridge docs)](https://docs.hyperbridge.network/protocol/ismp/proxies)
- [Hyperbridge ISMP — state_root, overlay_root, and mmr_root](/post/2023-04-11-hyperbridge-ismp-state-overlay-mmr/)
- [Hyperbridge ISMP — state vs log addendum](/post/2023-06-22-hyperbridge-ismp-addendum-state-vs-log-workflow/)
- [Hyperbridge source (`/Users/yangrong/Projects/hyperbridge`)](file:///Users/yangrong/Projects/hyperbridge) — §5.7 code confirmation
