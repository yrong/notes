---
title: "Polkadot XCMP MMD — Minimal POC"
source: obsidian/01-Technology
---

# Polkadot XCMP MMD — Minimal POC

Blog mirror (merged article, same substance): `yrong-blog/content/post/2026-04-09-xcmp-mmd-minimal-poc.md` → deployed as `/post/2026-04-09-xcmp-mmd-minimal-poc/` under site base URL.

Source context: [XCMP Design Discussion (Polkadot forum)](https://forum.polkadot.network/t/xcmp-design-discussion/7328)

**POC design revamp (vs forum MMD):** the forum sketch uses **one `XcmpMessageMMR` per channel** and an **`XcmpChannelTree`** over those MMR roots. For this **minimal POC** we **drop that split**: a **single append-only global `XcmpOutboxMmr`** on the source commits all outbound messages; the header digest carries **`XcmpOutboxMmrRoot`** only. Each leaf still names **`dest`** (plus `payload_hash`), so there is no loss of routing identity—only a shorter proof path and less on-chain bookkeeping. A future scale-out version can shard back into per-channel MMRs + channel tree.

**Committed structure:** the outbox is a **global MMR**—**one accumulator across all blocks**, leaves only appended, **monotonic `mmr_leaf_index`** over the lifetime of the chain (until reset / migration). We **do not** use a per-block-only binary Merkle snapshot as the primary commitment; **`XcmpOutboxMmrRoot`** in each header is the **current bagged root** after that block’s appends. **Empty blocks (POC):** **carry-forward last root** — if no leaves are appended, the digest repeats the previous block’s `XcmpOutboxMmrRoot`.

---

## POC Spec v0 (final, concrete)

This is the minimal, test-focused spec that the implementation follows.

### Semantics

- unordered, best-effort, no delivery guarantee
- no pruning / receipts / incentives in this POC
- replay protection required

### Commitments

- **Outbox accumulator:** one global append-only `XcmpOutboxMmr` (monotonic `mmr_leaf_index`)
- **Leaf:** `(dest: u32, payload_hash: H256)` (SCALE-encoded)
- **`payload_hash` (fixed):** `Keccak256(payload_bytes)` where `payload_bytes` is exactly the `Vec<u8>` drained from `XcmpQueue::take_outbound_messages`
- **Nonce (fixed):** global monotonic `u64`
- **Header digest (C1):** `DigestItem::PreRuntime(*b"xmmd", SCALE((version, XcmpOutboxMmrRoot)))`
- **Empty blocks (fixed):** carry-forward last root (repeat previous `XcmpOutboxMmrRoot` if no leaves appended)

### Relay anchoring (fixed)

- **Anchor is implicit (root only):** the verifier reads the **relay MMR root** from the current block’s
  **relay parent** (`set_validation_data`). That fixes **which accumulator** you check; it does **not**
  force you to use the **tip** relay-MMR leaf.
- **Late relayers:** because relay MMR only **appends**, a membership proof for an **older** relay leaf
  index still verifies against the **current** MMR root from a (much later) relay parent. The relayer
  supplies **`relay_mmr_leaf_index`** for the relay block whose `ParaHeadsRoot` snapshot actually contains
  the **`(source, head_bytes)`** you need.
- **Not `verify_ancestry_proof`:** it proves MMR frontier evolution (old root prefixes new), not how to
  bind `ParaHeadsRoot`/`head_bytes`. Here we just use a normal **leaf membership proof** at a chosen index
  against the current root.

### Proof types (fixed, POC)

- **Relay MMR proof (single leaf):** `sp_mmr_primitives::EncodableOpaqueLeaf` + `sp_mmr_primitives::LeafProof<H256>`  
  Verified with `pallet_mmr::verify_leaves_proof::<Keccak256,_>(relay_root, ...)` and decoded to obtain
  `leaf_extra = ParaHeadsRoot` for the **relay leaf at `relay_mmr_leaf_index`**.
- **Para-heads proof:** `binary_merkle_tree::MerkleProof<H256, Vec<u8>>` where `leaf = SCALE((source_u32, head_bytes))`
- **Outbox MMR proof (single leaf):** `sp_mmr_primitives::EncodableOpaqueLeaf` + `sp_mmr_primitives::LeafProof<H256>`  
  Verified statelessly against `XcmpOutboxMmrRoot`.

### Replay rule (fixed)

- `seen((source, mmr_leaf_index))`

### Bounds (POC/test constants)

- `MaxMessagesPerCall = 4`
- `MaxPayloadBytes = 256 * 1024` (256 KiB)
- Relay MMR proof items `≤ 128`, Para-heads proof items `≤ 32`, Outbox MMR proof items `≤ 64`
- Implied total call size target `≈ 768 * 1024` (768 KiB) via the above bounds

---

## 1) Problem and motivation

**HRMP** stores message payloads on the relay chain, which is expensive (storage + execution).

**XCMP (MMD approach)** replaces that with:
- payloads kept off the relay chain
- messages proven by **nested Merkle proofs** anchored to relay commitments

---

## 2) How MMD XCMP replaces HRMP (conceptually)

HRMP:
- relay is a **payload mailbox** (`HrmpChannelContents`)
- receiver reads relay state proofs + prunes via watermarks

MMD XCMP:
- relay is a **commitment anchor** (no payload storage)
- receiver accepts **payload + proof bundle**, verifies it, then executes the XCM.

Minimal POC semantics:
- **unordered**: messages can arrive in any order
- **best-effort**: if nobody submits the proof bundle, nothing happens
- **no delivery guarantee**: protocol does not ensure eventual delivery
- **no pruning**: source/relayers may keep messages indefinitely (POC accepts this)
- **replay protection required**: prevent executing the same proven message repeatedly

---

## 3) “Matryoshka” proof stack (minimal POC variant, simplified)

Smallest → largest commitments:

1. **`XcmpOutboxMmr`** (single global, append-only): every drained outbound page becomes one leaf. Leaf body includes **`dest_para_id`** and **`payload_hash`** (`payload_hash = Keccak256(page_bytes)`). **No separate per-channel MMR and no `XcmpChannelTree`.** Treat global **`mmr_leaf_index`** as the only monotonic identifier (“nonce”).
2. **Source parachain header**: digest item commits **`XcmpOutboxMmrRoot`** (bagged MMR root after the block’s appends; empty blocks carry-forward last root).
3. **Para-heads merkle root** (`ParaHeadsRoot`): binary merkle root over `SCALE((para_id_u32, head_bytes))`, sorted by `para_id`.
4. **Relay MMR root**: from **relay parent** header digest (implicit anchor: **which MMR root** you verify
   against). Verify a relay **MMR leaf proof** (exactly **one** leaf in POC) at explicit
   **`relay_mmr_leaf_index`** → decode leaf → `leaf_extra = ParaHeadsRoot` for that relay height.

Destination verifies nested proofs (same order as §5):

1. Get relay **MMR root** from the **current block’s relay parent** header digest (see Appendix A). This
   is the **cumulative** MMR root (includes all prior relay leaves).
2. Verify **relay MMR leaf proof** (single leaf) at **`relay_mmr_leaf_index`** → decode leaf → read
   `leaf_extra = ParaHeadsRoot` for **that** relay leaf.
3. Verify **`binary_merkle_tree::MerkleProof`** for `SCALE((source, head_bytes))` against `ParaHeadsRoot`.
4. Decode **`head_bytes`** as the source parachain **header**, then read **`DigestItem::PreRuntime(*b"xmmd", …)`** → **`XcmpOutboxMmrRoot`**.
5. Verify **outbox MMR leaf proof** (single leaf) for leaf **`(dest, payload_hash)`** at **`mmr_leaf_index`** against **`XcmpOutboxMmrRoot`**.
6. Check **`Keccak256(payload) == payload_hash`** (relayer supplies bytes).
7. Replay protection: reject if **`seen((source, mmr_leaf_index))`**.
8. POC execution: emit event / queue payload / XCM execution

---

## 4) Current relay implementation we rely on (already in place)

Westend/Rococo configure `pallet_beefy_mmr::LeafExtra = H256` and set:

- `LeafExtra = ParaHeadsRoot`
- `ParaHeadsRootProvider` computes merkle root over `sorted_para_heads()`:
  - `(para_id_u32, head_bytes)` sorted by id
  - truncated to `MAX_PARA_HEADS = 1024`

**Important**: this defines the proof format and hashing. Our verifier must match it exactly.

---

## 5) Minimal POC submission model: permissionless extrinsic

Anyone can be a relayer. The destination chain exposes an extrinsic, e.g.:

- `submit_xcmp_mmd(messages: Vec<MessageWithProof>)`

No collator/inherent pipeline changes are required for the minimal POC.

### Definitions (identifiers / hashing)

- `SourceParaId`, `DestParaId`: `u32` (SCALE where needed).
- **`relay_mmr_leaf_index`:** relay `pallet_mmr` **leaf index** for the relay block whose MMR leaf carries
  the `ParaHeadsRoot` you prove against (must match the sole leaf index in the relay `LeafProof`).
- **Routing** is implicit in each outbox leaf **`(dest, payload_hash)`**; no separate channel-tree id.
- **Hashing (fixed for POC):**
  - `payload_hash = Keccak256(payload_bytes)` where `payload_bytes` is the exact `Vec<u8>` drained from `XcmpQueue::take_outbound_messages`.
  - Para-heads merkle must match relay: `H = Keccak256`, leaf `SCALE((para_id_u32, head_bytes))`, relay sorts by `para_id`, odd-count promotion per `binary_merkle_tree` (`substrate/utils/binary-merkle-tree`).
- **Proof types (POC, concrete):**
  - Para-heads proof: `binary_merkle_tree::MerkleProof<H256, Vec<u8>>` where `leaf = SCALE((source_u32, head_bytes))`.
  - Relay MMR proof: `sp_mmr_primitives::EncodableOpaqueLeaf` + `sp_mmr_primitives::LeafProof<H256>`
    (exactly 1 leaf; indices must match **`relay_mmr_leaf_index`**).
  - Outbox MMR proof: `sp_mmr_primitives::EncodableOpaqueLeaf` + `sp_mmr_primitives::LeafProof<H256>` (exactly 1 leaf).

### What the extrinsic must carry (per message)

- **Anchor (relay MMR root):** **implicit** — the verifier reads the **relay MMR root** from the
  **current block's relay parent** (`set_validation_data`). No relay block hash/number is required **for
  the root**.
- **Relay leaf pick (explicit):** `relay_mmr_leaf_index: u64` — which relay MMR leaf supplies
  `leaf_extra = ParaHeadsRoot` for this message (often a **historical** index if the relayer was slow).
- `source: u32`, `dest: u32`, `mmr_leaf_index: u64` (outbox MMR leaf index; also acts as global nonce)
- `payload: Vec<u8>` (bounded)
- **Relay MMR (single leaf):** proof bundle for **`relay_mmr_leaf_index`** against the implicit
  `relay_root` (Appendix A)
  - Still **exactly one proven relay leaf per message** for the POC; that leaf may be **far behind** the
    relay parent on the relay chain.
- **Para-heads merkle proof:** a proof object whose leaf is exactly `SCALE((source_u32, head_bytes))` (bounded)
- **Outbox MMR (single leaf):** membership proof for committed outbox leaf `(dest, payload_hash)` at `mmr_leaf_index` under `XcmpOutboxMmrRoot` extracted from `head_bytes`

### Destination verification algorithm (per message)

1. Obtain relay parent header from validation data, extract relay MMR root from the BEEFY digest (Appendix A).
2. Verify the submitted **relay MMR leaf proof** (single leaf) **at `relay_mmr_leaf_index`** against that
   root and decode the proven leaf to read `leaf_extra = ParaHeadsRoot` for **that relay leaf**.
3. Verify the submitted **para-heads Merkle proof** against that `ParaHeadsRoot` and decode its leaf as
   `SCALE((source_u32, head_bytes))`.
4. Decode `head_bytes` as the source parachain header → extract **`XcmpOutboxMmrRoot`** digest item (`engine_id = *b"xmmd"`).
5. Verify the submitted **outbox MMR proof** (single leaf) for outbox leaf `(dest, payload_hash)` at `mmr_leaf_index` against `XcmpOutboxMmrRoot`.
6. Check `Keccak256(payload) == payload_hash`.
7. Replay protection: `seen((source, mmr_leaf_index))` must be false; then mark it seen.
8. **Post-verify:** see **POC scope: destination execution** below (staged: verify-first, then optional XCM delivery).

### POC scope: destination execution (honest staging)

This closes the gap between “**prove the outbound bytes**” and “**another test parachain runs the XCM**” without pretending the minimal verifier is already a full XCMP replacement.

#### Verifier guards (required)

- **`dest` must match this chain**: reject unless `dest == SelfParaId` (or the runtime’s canonical `u32` para id).
- **Bind extrinsic fields to commitments**: after proofs succeed, recompute / extract the committed outbox leaf and **`ensure!`** it matches the submitted **`(dest, payload_hash)`** (and that **`source`** matches the decoded para-heads leaf). Do not trust mismatched metadata once the leaf is known.
- **`relay_mmr_leaf_index` matches the relay `LeafProof`:** reject unless the proof’s sole leaf index equals
  the submitted **`relay_mmr_leaf_index`**.
- **Relay leaf vs relay parent:** `head_bytes` must be the **exact** `(source, …)` entry under the
  **`ParaHeadsRoot` carried by the relay MMR leaf at `relay_mmr_leaf_index`**. The **MMR root** still
  comes from the destination block’s **relay parent** (implicit). **Late relayers** choose a **historical**
  `relay_mmr_leaf_index` so that snapshot still contains the header you need; append-only relay MMR makes
  that valid under a **later** relay parent. **Practical limits:** wrong index → failed verify; very old
  indices → larger proofs and higher weight.

#### Phase A — verify + observe (default minimal POC)

- Emit a structured **event** with `(source, dest, mmr_leaf_index, payload_hash, maybe truncated payload)` so you can demonstrate end-to-end **proof acceptance** on the destination without touching execution.

#### Phase B — “XCM arrives” on the destination (small extension, still POC)

After Phase A checks pass:

1. Treat **`payload`** as the **same opaque page bytes** the source drained from **`take_outbound_messages`** (dual-run keeps them compatible with today’s encoding).
2. Feed those bytes into the destination runtime’s **normal inbound XCMP dispatch path** with the correct **sender origin** (`ParaId::from(source)` / `Sibling(ParaId)`), typically by invoking the configured **`XcmpMessageHandler`** (in Cumulus templates this is usually **`XcmpQueue`**) using whatever **internal hook / helper** your runtime exposes for “append sibling message bytes”.

**Important:** the exact hook differs by runtime version and pallet boundaries; the POC requirement is only conceptual: **re-use the existing handler**, do **not** invent a parallel XCM executor unless you intentionally want two dispatch paths.

#### What this is *not* (yet)

- Not a promise that **HRMP-off** works without a separate DA story.
- Not a full **ordering / delivery / fee market** for MMD; dual-run can still carry bytes on HRMP while you prove commitments.

---

## 6) Non-goals (explicit for POC)

- **Ordering** guarantees (protocol-level)
- **Delivery** guarantees / forced inclusion
- **Receipts/acks**
- **Pruning** of message stores / MMRs
- Incentive mechanism for relayers/collators
- Full “execute XCM” integration as **mandatory** scope (Phase A is events-only; Phase B is optional enqueue via existing handler — see **POC scope: destination execution**)

---

## 7) Must-haves (even for minimal POC)

- **Replay protection (fixed for POC):** `seen((source, mmr_leaf_index))`.
- **Hard bounds**:
  - max messages per call: `MaxMessagesPerCall = 4`
  - max payload size: `MaxPayloadBytes = 256 * 1024` (256 KiB)
  - relay MMR proof: exactly 1 leaf, max proof items `MaxRelayMmrProofItems = 128` (raise for devnets if
    you expect deep historical leaves)
  - para-heads Merkle proof: max proof items `MaxParaHeadsProofItems = 32`
  - outbox MMR proof: exactly 1 leaf, max proof items `MaxOutboxMmrProofItems = 64`
  - implied max total bytes per call: `MaxTotalCallBytes ≈ 768 * 1024` (768 KiB) via the above bounds
- **Deterministic source commitment (C1):**
  - During **source** block execution, the outbox must **`deposit_log`** the digest so that **`XcmpOutboxMmrRoot`** is part of the **final parachain header** for that block. The relay’s **`ParaHeadsRoot`** is computed over **`SCALE((para_id, head_bytes))`** where **`head_bytes`** is exactly that encoded header—so the commitment is binding once the source block is included on the relay. PVF / validators must agree on the same header bytes (same digest list, same root).

---

## 8) Implementation touchpoints (high level)

### Source parachain

- Outbox pallet to build:
  - **one global `XcmpOutboxMmr`** (append-only; `mmr_lib` / `merkle-mountain-range` pattern)
  - **`XcmpOutboxMmrRoot`** after each block’s appends
- Runtime: header digest item (**C1**) = **`XcmpOutboxMmrRoot`** (+ version tag).

### Destination parachain

- Verifier pallet with a permissionless extrinsic:
  - verifies relay MMR leaf proof → `ParaHeadsRoot`
  - verifies para-heads proof → `head_bytes`
  - extracts **`XcmpOutboxMmrRoot`** from `head_bytes` digest
  - verifies **outbox MMR leaf proof** (+ payload hash check)
  - replay protection + bounded execution

### Off-chain relayer tool

- Watches:
  - source collator / RPC: **outbox MMR leaf data**, global **`mmr_leaf_index`**, and **encoded source
    header** (`head_bytes`) for the block that committed the message
  - relay: for the **relay leaf** where that `head_bytes` appears under **`ParaHeadsRoot`**, record
    **`relay_mmr_leaf_index`** and build the **relay MMR leaf proof** against the MMR root that the
    destination will use (root from the destination candidate’s relay parent; append-only MMR still proves
    old leaves)
- Builds proof bundle (**relay MMR + para-heads + outbox MMR**) and submits extrinsic to destination.

---

## 9) Source outbox ↔ `pallet-xcm` (Option A): drain `XcmpQueue`, commit hash (index is the nonce)

**Decision (POC):** integrate the outbox by **draining the existing outbound queue** (no parallel `SendXcm` sink). Commit **`payload_hash`** in the source MMR and header digest (**C1**). A **permissionless relayer** later submits the **full payload bytes** on the destination, together with proofs that bind to the committed hash. The global **`mmr_leaf_index`** is the monotonic identifier (“nonce”).

### How XCM already reaches the bytes you hash

1. **`pallet-xcm`** routes sends through the runtime **`XcmRouter`**, which ends in **`XcmpQueue`’s `SendXcm`**: messages are encoded and stored as outbound pages (`OutboundXcmpMessages`).
2. **`ParachainSystem`** `on_finalize` calls **`OutboundXcmpMessageSource::take_outbound_messages`**, which (in typical runtimes) is **`XcmpQueue::take_outbound_messages`**, yielding **`Vec<(ParaId, Vec<u8>)>`**. Those **`Vec<u8>`** values are the HRMP page bytes today — they are the stable object to hash for the commitment.

### Integration pattern (no `pallet-xcm` changes)

- Add an **outbox / commitment pallet** that maintains:
  - **global `XcmpOutboxMmr`** and a **single global monotonic `OutboundNonce: u64`** (incremented once per appended leaf),
  - leaves **`SCALE(OutboxLeaf { dest, payload_hash, ... })`**,
  - **`on_finalize`** (or inline after last append) to deposit **`XcmpOutboxMmrRoot`** in the header digest (**C1**).
- In the runtime, replace `type OutboundXcmpMessageSource = XcmpQueue` with a **thin wrapper** that:
  1. Delegates to **`XcmpQueue::take_outbound_messages(maximum_channels)`**.
  2. For each **`(recipient, data)`**: compute **`payload_hash = Keccak256(data)`**; append the leaf to the local accumulator used for the digest.
  3. Returns the **same** message list unchanged so existing **`ParachainSystem`** / HRMP bandwidth behavior stays intact for a **dual-run** POC.

**Hashing note:** commit the hash of the **exact** page bytes returned by **`take_outbound_messages`**. Do not assume equality with the **`XcmpMessageSent.message_hash`** from **`deliver`** (that is a Blake2 hash over the **versioned XCM** Encoding path and may differ from the final concatenated page bytes).

### Destination and relayer

- **On-chain commitment:** the outbox leaf (in the global MMR) binds **`(dest_para_id, payload_hash)`**
  at **`mmr_leaf_index`** under **`XcmpOutboxMmrRoot`** for a specific **source header**, linked through
  **`ParaHeadsRoot`** from the **chosen relay MMR leaf** and the **implicit relay-parent MMR root**.
- **Relayer submission:** provide **`payload`**, **`relay_mmr_leaf_index`**, **outbox MMR proof** (single
  leaf), **`Keccak256(payload) == payload_hash`**, plus relay MMR leaf proof + para-heads proof. The relay
  parent is fixed by the destination block; the relay leaf is chosen so its `ParaHeadsRoot` contains your
  **`(source, head_bytes)`**.

### Where the relayer gets the full `payload` (XCM bytes)

**On-chain you only commit `payload_hash`.** The **verifier** checks that submitted **`Vec<u8>`** matches that hash; it does **not** reconstruct the message from the chain.

The **relayer** (or the user’s wallet talking to the relayer) obtains the **original page bytes**—the same **`data`** that `take_outbound_messages` returned for that drain order—from **off-chain / side observability**, for example:

- **Dual-run HRMP POC:** the relay still stores the payload in **HRMP** for that window; anyone can read **`HrmpChannelContents`** (or witness it from an archival relay) and map **`(source_para, dest_para, block)`** / queue position to the bytes that hash to **`payload_hash`**.
- **Collator / full node:** the producing collator saw **`OutboundXcmpMessages`** / HRMP pages when building the block; it can **publish** `(mmr_leaf_index, payload)` to an **indexer**, **IPFS**, **database**, or deliver it **directly** to whoever pays for relaying.
- **Block import / tracing:** a node that imports the source **block** can log drained messages in the same order the outbox used and rebuild **MMR leaf order** to attach the right bytes to each index.

So: **cryptographic binding is on-chain (hash in MMR); bytes are a data-availability problem** solved in the minimal POC by HRMP still carrying them, by **off-chain stores**, or by **explicit relayer-custody**. Turning **HRMP off** later means you **must** replace that with another **DA path** (dedicated DA layer, commitments + erasure coding, or economic assumptions that someone keeps blobs). The hash-only leaf does not magically recover the XCM without one of those sources.

### Dual-run vs HRMP-off (later)

- **Dual-run POC:** wrapper only adds commitments; full bytes can still ride HRMP as today.
- **HRMP-off:** keep the same **drain hook** for hashing; changing what is placed in **`OutboundHrmpMessage`** / transport is a separate relay-policy step.

---

## 10) Outbox pallet: global `XcmpOutboxMmr`, `XcmpOutboxMmrRoot`, header digest

This section turns §8–§9 into an implementation-shaped recipe under the **revamped** model (no channel tree).

### 10.1 When state updates (hook ordering)

Outbound pages exist only when **`ParachainSystem`** runs **`on_finalize`**, which calls **`OutboundXcmpMessageSource::take_outbound_messages`** (your **`XcmpQueue` wrapper**).

1. **During that call:** for each **`(recipient, data)`** from **`XcmpQueue::take_outbound_messages`**, call **`XcmpMmdOutbox::note_outbound(recipient, &data)`**. That **pushes one leaf** onto the **global outbox MMR** (same order as HRMP drain).
2. **After draining is done for the block:** in **`XcmpMmdOutbox::on_finalize`**, read the **bagged MMR root** → **`XcmpOutboxMmrRoot`** and **`deposit_log`**.

**Critical:** in **`construct_runtime!`**, place **`XcmpMmdOutbox` after `ParachainSystem`** so **`on_finalize`** runs **after** all **`note_outbound`** calls for this block.

### 10.2 Global `XcmpOutboxMmr` (single stream)

**Leaf content (POC):** SCALE struct or tuple **`{ dest: ParaId, payload_hash: H256 }`**. (A separate **`digest_version`** lives in the header digest wrapper; leaf layout stays fixed for the POC.)

**Nonce (fixed for POC):** use a **single `OutboundNonce: u64`** in storage incremented on every appended leaf.

**`payload_hash` (fixed for POC):** `Keccak256(payload_bytes)` where `payload_bytes` is the exact **`Vec<u8>`** from **`take_outbound_messages`**.

**MMR mechanics:** one **`mmr_lib`** MMR over **all leaves ever** appended on this chain (same storage/peak pattern as **`frame/merkle-mountain-range`**). Each drain pushes leaves in deterministic block order; **`mmr_leaf_index`** is **global** (not reset per block). After each push, the pallet holds the current **bagged root** (or recomputes it in **`on_finalize`** from peaks). The digest’s **`XcmpOutboxMmrRoot`** is a **rolling snapshot** of that accumulator at the end of the block.

**Empty blocks (fixed for POC):** **carry-forward last root** — if a block appends no leaves, the digest item repeats the previous block's `XcmpOutboxMmrRoot`.

### 10.3 Depositing the digest (C1)

In **`on_finalize`**, after the final root for this block is known:

- **`frame_system::Pallet::<T>::deposit_log(DigestItem::PreRuntime(engine_id, (digest_version, XcmpOutboxMmrRoot).encode()))`**

Use a **dedicated 4-byte `engine_id`** (e.g. `*b"xmmd"`) so you do not collide with **`CumulusDigestItem`**. Production would add a formal cumulus digest variant.

Keep the item **small** (version + `H256`).

### 10.4 One-block dataflow

```text
ParachainSystem::on_finalize
  └─ take_outbound_messages (wrapper)
       ├─ XcmpQueue::take_outbound_messages
       └─ for each (dest, data): note_outbound → push leaf on XcmpOutboxMmr

XcmpMmdOutbox::on_finalize   // after ParachainSystem
  └─ XcmpOutboxMmrRoot = bag_peaks (current MMR root)
  └─ deposit_log(PreRuntime, (version, XcmpOutboxMmrRoot))
```

### 10.5 What the destination prover needs

Prove **`head_bytes`** in **`ParaHeadsRoot`** (via relay MMR leaf → `ParaHeadsRoot` + **`binary_merkle_tree::MerkleProof`**), **decode as the source header** and read **`XcmpOutboxMmrRoot`** from the **`xmmd`** digest, then:

- **Outbox MMR leaf proof** (single leaf) for **`(dest, payload_hash)`** at **`mmr_leaf_index`** against **`XcmpOutboxMmrRoot`**, and **`payload`** with **`Keccak256(payload) == payload_hash`**, plus
- the **relay MMR** + **para-heads** layers as in §3 / §5 / Appendix A.

**Proof depth:** one MMR layer on the source instead of **MMR + channel binary tree**.

---

## Appendix A: where the relay MMR root lives (and how to read it)

### A.1 Relay header digest item

Relay runtimes configure `pallet_mmr::Config::OnNewRoot = pallet_beefy_mmr::DepositBeefyDigest<Runtime>`.
That deposits:

- `DigestItem::Consensus(BEEFY_ENGINE_ID, ConsensusLog::MmrRoot(root).encode())`

### A.2 Extracting the root from a relay header

Use:

- `sp_consensus_beefy::mmr::find_mmr_root_digest(header) -> Option<MmrRootHash>`

### A.3 Destination access 

Even with permissionless extrinsic submission, the destination runtime still has relay context per block via `set_validation_data`.
So the verifier can:

1. obtain **relay parent** header bytes from relay context (**implicit MMR-root anchor** — no relay hash
   in calldata)
2. decode header and call `find_mmr_root_digest`
3. verify the submitted **relay MMR leaf proof** (POC: exactly **one** leaf) **at `relay_mmr_leaf_index`**
   against that root to obtain leaf extra (`ParaHeadsRoot` for that leaf)

---

## Executive summary (analysis)

### Problem

**HRMP** stores **full message payloads** on the relay chain (`HrmpChannelContents`), which costs **storage and execution**. This design follows the **MMD / forum** direction: the relay becomes a **commitment anchor**, not a mailbox—**payloads live off relay storage**; delivery is proven with **nested Merkle/MMR proofs** tied to existing relay machinery.

### Design choice vs forum MMD

| Forum-style MMD | This minimal POC |
|-----------------|------------------|
| Per-channel `XcmpMessageMMR` + `XcmpChannelTree` over roots | **One global append-only `XcmpOutboxMmr`** on the source |
| More bookkeeping / proof steps | **Shorter path**: header digest commits **`XcmpOutboxMmrRoot` only**; each leaf still carries **`dest`, `payload_hash`** so routing identity is preserved |

Per-channel sharding + channel tree is explicitly a **future scale-out** step.

### Proof stack (“matryoshka”), outside → inside

1. **Relay** — BEEFY/MMR digest on the **relay parent** (implicit **MMR-root** anchor) → **relay MMR
   root**; verify a single relay leaf at **`relay_mmr_leaf_index`** → decode proven leaf →
   `leaf_extra` = **`ParaHeadsRoot`** (Westend-style, but for that relay height).
2. **`ParaHeadsRoot`** — binary Merkle over **`SCALE((para_id_u32, head_bytes))`**, sorted by `para_id` (must match relay `ParaHeadsRootProvider`, including **`MAX_PARA_HEADS`** truncation).
3. **Source parachain header** — decode `head_bytes` → read **`XcmpOutboxMmrRoot`** from **`DigestItem::PreRuntime(*b"xmmd", …)`** (C1).
4. **Source outbox** — **global MMR** over leaves **`(dest, payload_hash)`**; membership under **`XcmpOutboxMmrRoot`** (POC: single-leaf proof).
5. **Payload** — relayer supplies **`Vec<u8>`**; verifier checks **`Keccak256(payload) == payload_hash`**.

**Flow:** relay parent (implicit MMR root) → relay leaf at `relay_mmr_leaf_index` → `ParaHeadsRoot` →
source header → outbox root → leaf → bytes.

### Minimal POC semantics (scope)

- **Unordered**, **best-effort**, **no protocol-level delivery guarantee**
- **No pruning** / incentives / receipts in scope
- **Replay protection** mandatory; **hard bounds** on extrinsic and proofs

### Source chain integration (Option A)

Wrap **`OutboundXcmpMessageSource`**: drain **`XcmpQueue::take_outbound_messages`**, compute **`Keccak256(data)`**, append to **`XcmpOutboxMmr`**, return the **same** pages for **dual-run** with HRMP. Hash **exact page bytes**, not `XcmpMessageSent.message_hash` from `deliver`. **`XcmpMmdOutbox::on_finalize` after `ParachainSystem`** so digest matches drained leaves; **empty blocks carry-forward** `XcmpOutboxMmrRoot`.

### Destination

**Permissionless extrinsic**; verifies proof bundle + replay; POC may **emit events** before full XCM execution.

### Data availability

On-chain = **`payload_hash` only**. Bytes come from **HRMP dual-run**, **collator/indexer**, **archival relay**, etc. **HRMP-off** requires another **DA** path.

### Strengths

- Clear split: HRMP transport vs **commitment layer**; dual-run is practical.
- **Reuses** BEEFY MMR + **`ParaHeadsRoot`** instead of a new relay-wide outbox map.
- **Implementer-oriented**: C1, pallet order, digest `engine_id`, empty-block root, hashing pitfall.
- **Non-goals / must-haves** bound review scope.

### Risks / open points

- **Empty-block rule** for `XcmpOutboxMmrRoot` must match **exactly** between producer and verifier.
- **Para-heads** proofs must match relay **bit-for-bit** (sorting, hash, truncation).
- **Global MMR forever** → storage / migration is **post-POC** (sharding noted for later).

---


