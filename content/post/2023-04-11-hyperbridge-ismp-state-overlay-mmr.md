---
author: Ron
catalog: true
date: 2023-04-11
tags:
- BlockChain
- Polkadot
- Hyperbridge
- ISMP
title: Hyperbridge ISMP — state_root, overlay_root, and mmr_root
---

Notes mirrored from **Hyperbridge - ISMP Storage Proofs & Substrate Child Trie** (Obsidian). Repo context: [`polytope-labs/hyperbridge`](https://github.com/polytope-labs/hyperbridge). Protocol docs: [docs.hyperbridge.network](https://docs.hyperbridge.network/).

> **Updated 2026-08-13** — re-verified against current `main`. The root-packing model below is unchanged, but the EVM stack is now **V2**: a single generic `EvmHost` + `HandlerV2` + `ConsensusRouter` → `EcdsaBeefy` / `SP1Beefy`. The old `OptimismHost` / `HandlerV1` / `BeefyV1` / `BeefyV1FiatShamir` names are gone. On the Rust side, `pallet-ismp` lives at `modules/pallets/ismp/`, and the `OverlayProof` / `StateProof` enum was replaced by a single `StateMachineProof` (the *calling context* picks the root).

When reading `pallet-ismp` and `SubstrateStateMachine`, three roots show up: the parachain **`state_root`**, the optional **`overlay_root` on `StateCommitment`**, and the **`mmr_root`** in the per-block **`ConsensusDigest`**. They are not interchangeable; each corresponds to a different data structure and proof type.

---

## What each root is

| Name | Role |
|------|------|
| **`state_root`** | Root of the chain’s **main** Substrate state trie (`Header::state_root`). It commits to **all** pallets. Child tries are still **included** under this trie. |
| **`mmr_root`** | Root of the **ISMP MMR** after the MMR pallet finalizes the block: an **append-only** tree over **message leaves** (full bodies stored off-chain). It appears in the header as part of **`ConsensusDigest`**, not as a separate top-level field on `StateCommitment` by itself. |
| **`overlay_root` on `StateCommitment`** | The **ISMP overlay** slot carried in consensus proofs. It is **not** a third independent trie type in the abstract—it is **whatever the chain puts in that slot** (see packing below). |

Each block, `on_finalize` builds:

- **`child_trie_root`** — `storage::child::root` for the ISMP child trie (prefix `b"ISMPv2"`), where commitment metadata and related keys live.
- **`mmr_root`** — `OffchainDB::finalize()` from the MMR accumulator.

Both go into **`ConsensusDigest { mmr_root, child_trie_root }`** in the header digest.

---

## How `StateCommitment` packs those digest fields

`StateCommitment` has `timestamp`, `state_root`, and optional `overlay_root`. The parachain consensus client maps header digest + header `state_root` into that struct. There are two regimes (`modules/ismp/clients/parachain/client/src/consensus.rs`):

**Ordinary parachain (not the coprocessor)**

- `state_root` = header state root (main trie).
- `overlay_root` = **`child_trie_root`** from `ConsensusDigest`.

**Hyperbridge as coprocessor**

- `state_root` = **`child_trie_root`** (ISMP child trie only).
- `overlay_root` = **`mmr_root`**.

So on Hyperbridge, the **MMR root** is stored in **`overlay_root`**, and the **child trie root** is stored in **`state_root`**. The naming in `StateCommitment` is easy to misread; the packing is explicit in code.

---

## Which root a proof uses

**1. POST request/response membership via Patricia trie** (`verify_membership` in `modules/ismp/state-machines/substrate/src/lib.rs`)

- Single proof type: `StateMachineProof { hasher, storage_proof }` — no `OverlayProof`/`StateProof` variants anymore; the root is chosen by the caller's context, not encoded in the proof.
- Verifies that commitment keys (`RequestCommitments`) exist under the **child trie** layout.
- Root selection: if the proof targets the **coprocessor** state machine, use **`state.state_root`** (which, for that commitment, **is** the child trie root); otherwise use **`state.overlay_root`** (child trie root on other chains).
- This path does **not** verify the MMR.

**2. Non-membership / timeouts** (`verify_non_membership`, same file)

- Same coprocessor-aware root selection as membership, but keys off **`RequestReceipts`** and asserts **absence** — proves a request was never delivered, so it can be timed out.

**3. GET / arbitrary storage reads** (`verify_state_proof`)

- Takes the root as an **explicit caller-supplied argument** — no coprocessor branch here. Full-trie reads pass `state_root`; overlay reads pass the child trie root.

**4. EVM batch delivery**

- `HandlerV2.handlePostRequests` checks **MMR multiproofs** against **`overlayRoot`** on the stored commitment. For Hyperbridge, that value **is** the **`mmr_root`**. Leaves are `keccak256(abi.encode(request))`.
- `HandlerV2.handlePostRequestTimeouts` is the mirror image: a **child-trie non-membership proof** (no `RequestReceipts` entry, `PolkadotTrie.VerifyProof`) against **`stateRoot`** = child trie root, with `request.timeout() <= state.timestamp`. So on EVM chains, **`overlayRoot` proves delivery; `stateRoot` proves non-delivery**.

---

## Scenario summary

| Scenario | What you prove | Root |
|----------|----------------|------|
| Substrate membership of ISMP commitments | Child trie (`StateMachineProof`) | `overlay_root` on normal chains; **`state_root`** when the target is Hyperbridge coprocessor (still the child trie). |
| Timeout (any chain) | Child trie **non-membership** of `RequestReceipts` | Same selection as membership; on EVM, **`stateRoot`**. |
| Arbitrary storage read | Main trie | **`state_root`**, passed explicitly to `verify_state_proof`. |
| POST batch to EVM | MMR | **`overlayRoot`** = **`mmr_root`** for Hyperbridge; MMR multiproof in `HandlerV2`. |
| “What commits the whole chain?” | — | **`state_root`**. |

**Mnemonic:** **`state_root`** = entire chain state; **child trie** = compact ISMP commitment/receipt trie; **`mmr_root`** = ordered message log for succinct proofs—on Hyperbridge exposed to MMR-speaking clients as **`overlay_root`**.

Related (Polkadot transport vs commitments): [Polkadot XCMP MMD — Minimal POC (merged)](/post/2026-04-09-xcmp-mmd-minimal-poc/).

---

## End-to-end: Bifrost ↔ Optimism through the coprocessor

Neither endpoint ever verifies the other's consensus — each only runs a light client of **Hyperbridge**, and Hyperbridge does the expensive verification of both sides.

**Bifrost → Optimism**

1. Bifrost `pallet-ismp` dispatch: leaf → offchain MMR, metadata → child trie; `on_finalize` deposits `ConsensusDigest { child_trie_root, mmr_root }` + timestamp digest in the header.
2. Hyperbridge's `ParachainConsensusClient` verifies Bifrost's header via a relay-chain state proof of `Paras::Heads` (relay root from the `RelayChainOracle`, fed by the cumulus relay-state inherent, cached ≤256 heights). Ordinary-parachain packing: `state_root = header.state_root`, `overlay_root = child_trie_root`.
3. Hyperbridge verifies the request with a child-trie membership proof vs `state.overlay_root`, accepts it as router (`is_router()` / `is_allowed_proxy`, `modules/ismp/core/src/handlers/request.rs`), and re-dispatches: leaf into **Hyperbridge's own MMR**, commitment into **Hyperbridge's child trie**.
4. On Optimism, `HandlerV2.handleConsensus` → `EcdsaBeefy`/`SP1Beefy` verifies relay **BEEFY** finality, extracts Hyperbridge's header from the parachain-heads root, and stores `StateCommitment { overlayRoot = mmr_root, stateRoot = child_trie_root }`.
5. After the challenge period, `handlePostRequests` verifies the **MMR multiproof vs `overlayRoot`** and dispatches to the module (`IApp.onAccept`).

**Optimism → Bifrost**

1. dApp calls `EvmHost.dispatch(DispatchPost)`; commitment lands in `_requestCommitments` (slot 0), value = `FeeMetadata`.
2. Hyperbridge runs **two independent consensus clients, chained but decoupled**: the beacon **sync-committee** client verifies L1 and stores its execution state root; the Optimism client then reads that **already-stored L1 commitment** from pallet state (`host.state_machine_commitment(l1_height)`, `ismp-optimism/src/lib.rs:172-176`) — the L1 and L2 updates are separate transactions. The L2 update is itself an **EIP-1186 storage proof of L1 state**: prove the `L2OutputOracle.l2Outputs[index]` slot (or `DisputeGameFactory._disputeGames`) under the verified L1 state root, then recover the L2 execution state root from the output-root **preimage**: `output_root = keccak(version ‖ l2_state_root ‖ withdrawal_storage_root ‖ l2_block_hash)` — prover supplies the preimage, client recomputes and matches.
3. Hyperbridge verifies the commitment against the verified L2 execution state root — **EIP-1186 again**: account proof of `EvmHost` → contract `storage_root` → storage proof of the slot-0 mapping key; a non-empty value (the stored `FeeMetadata`) proves the dApp really dispatched it. Then the standard router path: `RequestReceipts` for the incoming hop, request re-emitted **unchanged** (same commitment) into Hyperbridge's MMR + child trie.
4. Bifrost's `ParachainConsensusClient` (with `Coprocessor = Some(Hyperbridge)`) verifies Hyperbridge's header via the same relay-chain `Paras::Heads` proof — no BEEFY needed between siblings. Coprocessor packing: `state_root = child_trie_root`, `overlay_root = mmr_root`. Bifrost **stores** both roots but never consumes the MMR one — mirror image of Direction 1, where Bifrost's own `mmr_root` digest goes unused.
5. Delivery on Bifrost: `verify_membership` hits the coprocessor branch and checks the child-trie proof vs `state.state_root` (= Hyperbridge's child trie root). Substrate destinations consume **child-trie Patricia proofs**, never MMR proofs (see cost rationale under "Why two paths").

---

## Why a child trie for request/response data

ISMP stores commitment metadata under `ChildInfo::new_default(b"ISMPv2")` because **child tries yield cheaper Patricia proofs** than proving through the global state trie (`child_trie.rs` module comment).

- **Smaller proofs** — only the ISMP subtree, not paths under the full **`state_root`**.
- **Separation** — overlay vs full-state reads; one **`child_trie_root`** in the digest.
- **Cross-chain verifiers** — `read_child_proof` targets the child trie; less data than full-state proofs.

---

## Leaf format & `RequestCommitments` entry

**MMR leaf = the full request body**, not just its hash (`modules/pallets/ismp/src/offchain.rs:57`):

```rust
pub enum Leaf {
    Request(Request),        // Request = Post(PostRequest) | Get(GetRequest)
    GetResponse(GetResponse),
}
```

These are the only two variants. The full body is persisted in the **offchain DB** keyed by commitment (so relayers can fetch bodies and build multiproofs); the **on-chain MMR accumulator keeps only the leaf hash** (`Node::Data` hashed with Keccak256, parents = `keccak(left ++ right)`, `modules/pallets/mmr/src/mmr/mod.rs:37-45`).

The leaf hash is `keccak256(leaf.preimage())`, and `preimage()` for a request is `req.encode()` — **not SCALE**: `Request::encode()` is an inherent method calling `abi::encode_request` (`modules/ismp/core/src/router.rs:265`, `modules/ismp/core/src/abi.rs`), i.e. ABI encoding matching Solidity's `abi.encode(struct)`. Therefore:

> **MMR leaf hash = `keccak256(abi.encode(request))` = the request commitment** — the same value `HandlerV2` recomputes on EVM as `leaf.request.hash()` (`Message.sol`). One hash, three roles: child-trie key suffix, MMR leaf hash, EVM-side identifier.

**`RequestCommitments` child-trie entry** (`modules/pallets/ismp/src/child_trie.rs`, `dispatcher.rs:67`):

- **Key**: raw concat `"RequestCommitments" ++ commitment` (32 bytes, no extra hashing), under `ChildInfo::new_default(b"ISMPv2")`. Sibling namespaces: `ResponseCommitments`, `RequestReceipts` (value = relayer address, keyed by request commitment), `ResponseReceipts`.
- **Value**: SCALE-encoded `RequestMetadata { offchain: LeafIndexAndPos { leaf_index, pos }, fee: FeeMetadata { payer, fee }, claimed: bool }`.

So the child trie stores *metadata about* the request (its MMR position, fee accounting); the body itself lives only in the offchain DB. When Hyperbridge proxies a request it re-emits it **unchanged** (source stays e.g. Bifrost), so the commitment hash on Hyperbridge is identical to the source chain's — and Hyperbridge writes both a `RequestReceipts` entry (incoming hop, replay protection) and a fresh `RequestCommitments` entry + MMR leaf (outgoing hop).

Note: in coprocessor mode the *source parachain's* MMR is never consumed — Hyperbridge proves requests out of the source's **child trie** only. The MMR path exists for EVM verifiers following Hyperbridge.

---

## Coprocessor vs non-coprocessor

`Coprocessor: Get<Option<StateMachine>>` names an optional **ISMP proxy** (usually Hyperbridge). See [ISMP proxies](https://docs.hyperbridge.network/protocol/ismp/proxies).

| | Non-coprocessor | Coprocessor |
|--|-----------------|-------------|
| Config | `None` | `Some(Hyperbridge)` |
| `StateCommitment` | `overlay_root` = child trie; `state_root` = header | swapped: `overlay_root` = MMR, `state_root` = child trie |
| Membership proof root | `state.overlay_root` | For proofs about Hyperbridge id, `state.state_root` (= child trie in that encoding) |

The packing branch is `modules/ismp/clients/parachain/client/src/consensus.rs` (~line 194), keyed on `T::Coprocessor::get()`. Careful: the local variable named `overlay_root` there actually holds the **child trie root** read from `ConsensusDigest`.

Non-coprocessor: no single proxy. Coprocessor: heavy verification aggregated on Hyperbridge; downstream uses cheaper proofs / proxy routing (`allowed_proxy()` = coprocessor).

---

## Why two paths — child trie vs MMR

Not two redundant proofs of the same fact.

| Path | Proves | Typical use |
|------|--------|---------------|
| Child trie (Patricia proof) | Commitment **stored** in pallet state (metadata, fees, index) — or **absent** (receipts, for timeouts). | Substrate `verify_membership` / `verify_non_membership`; EVM timeout proofs |
| MMR | Commitment as **leaf in the message log** for relay / batch delivery. | `HandlerV2` vs `overlayRoot` (MMR root on Hyperbridge) |

Trie = **state** registration; MMR = **ordered relay log**. Destinations usually require **one** style, not both. Same commitment hash, two structures for different verifiers and costs.

**Cost rationale — careful, the obvious framing is backwards.** MMR verification is *not* expensive on Substrate (it's just keccak merkle hashing, cheap anywhere). The real asymmetry:

- **Substrate destinations use child-trie proofs because they're native and self-contained**: `sp_trie` Patricia verification is standard runtime machinery, and proofs are served from **on-chain state** via the ordinary `read_child_proof` RPC — any full node can produce them, no offchain indexer needed. The child trie being tiny (ISMP keys only) keeps proofs compact.
- **The MMR exists for the EVM side**, where the cost profile inverts: Patricia verification in Solidity is gas-heavy (SCALE node decoding, nibble traversal — `PolkadotTrie.VerifyProof`), while MMR multiproofs are cheap keccak ops and **batch well** — one multiproof covers many requests per `handlePostRequests` call. The EVM side still pays the Patricia cost on the rare **timeout** path (`stateRoot` non-membership); it just avoids it on the hot delivery path.
- The MMR's price is infrastructure: leaf bodies live in the **offchain DB**, so proving requires an indexer-capable node — fine for relayers targeting EVM chains, unnecessary overhead for Substrate-to-Substrate delivery.

Summary: child trie = native + on-chain-servable for Substrate verifiers; MMR = gas-optimal + batchable for Solidity verifiers.

---

## Verifying a `LayoutV0` storage proof

**`LayoutV0<H>`** (`sp_trie`) is the Substrate Patricia trie layout; **`H`** is the node hasher (must match the source chain). Ethereum storage uses a different layout (e.g. **`EIP1186Layout`** in `modules/trees/ethereum` — RLP / EIP-1186), not `LayoutV0`.

Verification pattern in `SubstrateStateMachine` (`modules/ismp/state-machines/substrate/src/lib.rs`):

1. `StorageProof::new(nodes).into_memory_db::<H>()`
2. `TrieDBBuilder::<LayoutV0<H>>::new(&db, &root).build()`
3. `trie.get(&key)` — check value

Used by `verify_membership` and `verify_state_proof`. Helpers: `read_proof_check`, `read_proof_check_for_parachain` in the same file. Test: `modules/pallets/testsuite/src/tests/child_trie_proof_check.rs`.

---

## EVM: one generic `EvmHost`, no per-chain hosts

There is **no `OptimismHost.sol`** anymore. A single **`EvmHost`** (`evm/src/core/EvmHost.sol`) derives its identity from `block.chainid` — `StateMachine.evm(block.chainid)` → `"EVM-10"` on Optimism.

- **Outgoing:** `dispatch(DispatchPost)` stores `keccak256(abi.encode(request))` in the **`_requestCommitments`** mapping (**slot 0** of the contract) and emits `PostRequestEvent`. That storage slot is the entire proof anchor on the L2.
- **`EvmHost`** holds ISMP state; all proof logic lives in **`HandlerV2`** (`evm/src/core/HandlerV2.sol`): `handleConsensus` → `IConsensusV2.verify` on the configured consensus client; `handlePostRequests` → MMR verify vs `overlayRoot`, then `dispatchIncoming` (`IApp.onAccept`); `handlePostRequestTimeouts` → child-trie non-membership vs `stateRoot`.

Incoming messages from Substrate (e.g. Bifrost via Hyperbridge) are proved on L2 with **Hyperbridge MMR + BEEFY consensus updates** — no chain-specific code on the EVM side.

**The reverse direction (how Hyperbridge verifies Optimism)** is a two-layer light-client chain on the Rust side:

1. **L1:** beacon **sync-committee** client (`modules/ismp/clients/sync-committee/`) verifies an attestation → yields Ethereum's execution-layer `state_root`.
2. **L2:** the Optimism client (`modules/ismp/clients/{optimism,ismp-optimism}/`) proves the posted output root against that verified L1 root — either the legacy **`L2OutputOracle`** path (`l2Outputs[index]`, slot 3) or the fault-proof **`DisputeGameFactory`** path (`_disputeGames` slot 103, impl bound via `gameImpls` slot 101, game must be unchallenged; incl. **OP-Succinct** zk games).
3. **Message:** `EvmStateMachine` (`modules/ismp/state-machines/evm/`) does an EIP-1186 account proof of `EvmHost`, then storage proofs of the commitment slots (`REQUEST_COMMITMENTS_SLOT = 0`, `REQUEST_RECEIPTS_SLOT = 1`).

---

## `IConsensusV2` on EVM (BEEFY stack)

**Interface:** `sdk/packages/core/contracts/interfaces/IConsensusV2.sol` — `verify(trustedState, proof) → (newState, IntermediateState[], nextAuthoritySetId)`. Each `IntermediateState` carries `StateCommitment { timestamp, overlayRoot, stateRoot }`.

Implementations under `evm/src/consensus/`: **`ConsensusRouter`** dispatches on the first proof byte — `0x00` → **`EcdsaBeefy`** (full on-chain ECDSA: ⅔+1 signatures vs the authority-set merkle root, relay MMR leaf inclusion, parachain-header multiproof), `0x01` → **`SP1Beefy`** (zk; same statement proven in SP1). `BeefyV1` / `BeefyV1FiatShamir` no longer exist.

Both extract the `StateCommitment` from Hyperbridge's header via `HeaderImpl.stateCommitment` (`evm/src/consensus/Types.sol`): the `"ISMP"` consensus digest yields `overlayRoot = mmr_root` (bytes 0–32) and `stateRoot = child_trie_root` (bytes 32–64); timestamp from the `"ISTM"` digest. Deployed address is **`HostParams.consensusClient`**; **`HandlerV2.handleConsensus`** calls it.

Rust has a matching SP1 verifier: `modules/consensus/beefy/verifier/src/sp1.rs` (`verify_sp1_consensus`).

---

## Two MMRs (relay vs message)

**Relay BEEFY MMR** — checked in **`EcdsaBeefy.verifyMmrUpdateProof`** (`RelayChainProof`): Polkadot relay finality / authority / relay MMR. **Not** “this ISMP message exists.”

**Hyperbridge message MMR** — checked in **`HandlerV2.handlePostRequests`** against **`overlayRoot`**: ISMP request leaves on Hyperbridge. **Not** the same tree as the relay MMR.

Order: **`handleConsensus`** (trust roots) → **`handlePostRequests`** (message MMR membership, after the challenge period).
