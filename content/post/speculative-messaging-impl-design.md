---
title: "Speculative Messaging — Implementation Design (v0.5)"
author: Ron
date: 2026-07-25T03:20:00+08:00
tags:
- polkadot
- parachain
- speculative-messaging
- design
---

# Speculative Messaging — Implementation Design (v0.5)

Implementation companion to the canonical [Speculative Messaging design](speculative-messaging-design.md)
([PR #12659](https://github.com/paritytech/polkadot-sdk/pull/12659); v0.5 — streams + POV lifts + per-sender
ring), which builds on [Low-Latency Parachains v2](https://github.com/paritytech/polkadot-sdk/pull/11413) and
[Off-Chain Block Verification](offchain-block-verification-design.md). The canonical design is the source of
truth for behaviour; this document is the **component breakdown of the working reference PoC**
(`lexnv/spec-msg-poc-mvp`), whose end-to-end test (`spec_msg_penpal_xcm_delivery` — rococo-local relay + two
penpal collators) passes the full HRMP→spec-msg cutover flow. The upstreaming is tracked under
[#12531](https://github.com/paritytech/polkadot-sdk/issues/12531) (*Overarching MVP Inclusion Based
Speculation*), decomposed into five work streams — primitives
([#12346](https://github.com/paritytech/polkadot-sdk/issues/12346)), relay
([#12349](https://github.com/paritytech/polkadot-sdk/issues/12349)), node/client
([#12707](https://github.com/paritytech/polkadot-sdk/issues/12707)), parachain pallets
([#12708](https://github.com/paritytech/polkadot-sdk/issues/12708)) and testing/rollout
([#12709](https://github.com/paritytech/polkadot-sdk/issues/12709)); the PoC implements across all of them
(sub-issue status below). (The linked design docs land in `docs/` when their PRs merge.)

## Model in one paragraph

Each sender parachain accumulates outgoing messages per **stream** (keyed by a structured 8-byte `StreamId` —
`Channel` / `Ack` / `Broadcast` / `Private`) into a per-stream append-only MMR, and a block that touches at
least one stream commits to *every* stream's root with a single hash — the **`StreamsRoot`**, root of a binary
compact trie keyed by the canonical `StreamId` encoding (leaves = the streams' MMR roots) — emitted as a
`Provides(StreamsRoot)` UMP signal. Blocks never emit `Requires`: the messaging inherent records a
**`ConsumptionRecord`** (per touched stream, the MMR interval consumed), and the `validate_block` wrapper
**synthesizes** `Requires(RequiresSet = {(source ParaId, StreamsRoot)})` from that record plus POV-carried
**lifts** (`RequiresLift`: `stitch` the intervals → MMR extension to the current stream root → tree proof up
to the `StreamsRoot`). The relay keeps a bounded per-sender ring of recent `StreamsRoot`s and admits a
candidate only if every `Requires` root is present in the referenced source's ring. Payloads flow
**collator-to-collator off-chain**; the relay sees only the two commitments. `StreamId` is bound *into* the
`StreamsRoot` but never revealed to the relay (relay state is `ParaId`-keyed and fixed-size).

## Status matrix

| Component | Status | Location |
|---|---|---|
| Parachain-side primitives | ✅ | `cumulus-primitives-spec-messaging` |
| Relay-visible primitives (`StreamsRoot`, `RequiresSet`, UMP signals) | ✅ | `polkadot-primitives` |
| Runtime API (`SpecMsgApi`) | ✅ | `cumulus-primitives-core` |
| Relay matching pallet (inclusion tier) | ✅ | `runtime/parachains::spec_msg` |
| Parachain pallet (sender + receiver + channels) | ✅ | `cumulus-pallet-spec-messaging` |
| PVF requires-lift synthesis | ✅ | `parachain-system::validate_block` |
| Off-chain subsystem (archive / fetch / monitor / inherent / lifts) | ✅ | `cumulus-client-spec-msg` |
| XCM router + `SpecMsg` origin | ✅ | pallet `xcm_router` |
| E2E (relay + 2 penpal, full cutover) | ✅ | `zombienet-sdk` `spec_msg_penpal` |
| Weights / benchmarks | ⬜ | PoC unmetered |
| Governance-configurable `W`, offboarding prune | ⬜ | `spec_msg` pallet |
| Live / speculative tier (header-digest triggers, DA, live push, virtual window) | ⬜ deferred | super-chains |

Legend: ✅ implemented in the PoC · ⬜ not yet / deferred (see §8).

## Sub-issue status — [#12531](https://github.com/paritytech/polkadot-sdk/issues/12531)

The overarching MVP issue decomposes into five work streams (15 leaf issues). Status against the PoC
(`lexnv/spec-msg-poc-mvp`) — **14 / 15 implemented**; the gaps are monitoring metrics (#12597) and dynamic
DHT peer discovery (part of #12595).

| Work stream | Leaf issue | PoC |
|---|---|---|
| **[#12346](https://github.com/paritytech/polkadot-sdk/issues/12346) primitives** | [#12700](https://github.com/paritytech/polkadot-sdk/issues/12700) Stream ID + MMR primitives | ✅ `stream_id`, `mmr` |
| | [#12701](https://github.com/paritytech/polkadot-sdk/issues/12701) Commitment trie + consumption/channel records | ✅ `tree`, `record`, `channel` |
| | [#12702](https://github.com/paritytech/polkadot-sdk/issues/12702) Requires lifts | ✅ `lift` |
| **[#12349](https://github.com/paritytech/polkadot-sdk/issues/12349) relay** | [#12347](https://github.com/paritytech/polkadot-sdk/issues/12347) Expose `Provides`/`Requires` UMP signals | ✅ `polkadot-primitives` v9 |
| | [#12704](https://github.com/paritytech/polkadot-sdk/issues/12704) `RecentProvides` checks on the relay | ✅ `spec_msg` pallet |
| **[#12707](https://github.com/paritytech/polkadot-sdk/issues/12707) node/client** | [#12593](https://github.com/paritytech/polkadot-sdk/issues/12593) `SpeculationStore` | ✅ `SpecMsgArchive` (+ `SpecMsgPool`) |
| | [#12595](https://github.com/paritytech/polkadot-sdk/issues/12595) p2p layer for fetching messages | ✅ fetch/serve over `/spec-msg/exchange/1` · ⚠️ dynamic DHT peer discovery deferred (MVP uses a static `PeerRegistry`) |
| | [#12583](https://github.com/paritytech/polkadot-sdk/issues/12583) Monitor relay for `Provides` | ✅ `monitor.rs` |
| **[#12708](https://github.com/paritytech/polkadot-sdk/issues/12708) parachain** | [#12350](https://github.com/paritytech/polkadot-sdk/issues/12350) `pallet-spec-messaging` sender part | ✅ sender half |
| | [#12591](https://github.com/paritytech/polkadot-sdk/issues/12591) Forward messages to XCM queue | ✅ enqueue under `SpecMsg(source)` |
| | [#12535](https://github.com/paritytech/polkadot-sdk/issues/12535) SpecMsg XCM router | ✅ `xcm_router.rs` |
| | [#12592](https://github.com/paritytech/polkadot-sdk/issues/12592) `SpecMsgApi` runtime API | ✅ `cumulus-primitives-core` |
| | [#12594](https://github.com/paritytech/polkadot-sdk/issues/12594) Propagate via inherent | ✅ `inherent` + `enact_messages` |
| **[#12709](https://github.com/paritytech/polkadot-sdk/issues/12709) testing** | [#12596](https://github.com/paritytech/polkadot-sdk/issues/12596) E2E HRMP-replacement test | ✅ `spec_msg_penpal_xcm_delivery` (passing) |
| | [#12597](https://github.com/paritytech/polkadot-sdk/issues/12597) Monitoring metrics (operational readiness) | ❌ not wired (no prometheus metrics) |

Beyond the tracked leaves, the production-hardening gaps in §8 (weights, governance-configurable `W`,
offboarding prune) are not separately issue-tracked.

## End-to-end walkthrough — worked example (code-linked)

The complete MVP end-to-end loop across sender pallet, relay, receiver client crate, receiver pallet, and PVF.
**Running example:** Sender **A=2000** sends 3 XCMs to Receiver **B=2001** on
`C = Channel{recipient:2001,domain:0,num:0}`; B's ack rides `K = Ack{recipient:2000,domain:0,num:0}`.
`P_i = SpecMsgKind::Data(X_i).encode()`, `L_i = hash_leaf(0x00, P_i)`. Pallet refs are
`cumulus/pallets/spec-messaging/src/lib.rs` unless noted; client crate = `cumulus/client/spec-msg/src/`.

**Stage 0 — Channel open (one-time handshake).** `send_signal(OpenChannel)` (`:1091,1447`) → B accepts →
`publish_register` (`:1485`) emits B's first `Register{ up_to:0, grant:{max_messages:100,max_bytes:1MiB}, closed:false }`
on `K`. A reads it → `OutChannels[C].register` set → A has credit.

**Stage 1 — Sender: XCM in, credit-gated, appended.** `SpecMsgRouter` (XCM `SendXcm`, `xcm_router.rs`, `:67`) →
`send` (`:1433`) → `can_send` (`:1401`) → `ensure_credit` (`:1467`) → `append_to_stream` (`:1336`) →
`OutboundMessages` (`:625`). Gate: `ensure!(meta.sizes.len() < grant.max_messages, NoCredit)` +
`ensure!(meta.bytes < grant.max_bytes)`. `NoCredit` → router returns `SendError::Transport` (backpressure to the
XCM caller, `:1462`), no hidden queue. Example: `OutboundMessages[C]=[P0,P1,P2]`, in-flight 3 < 100.

**Stage 2 — Sender: end-of-block commit → `Provides` + digest.** `commit_streams_root` (`:1560`) folds *touched*
streams → `BlockStreamsRoot`, deposits `DigestItem::Consensus(SPMS_ENGINE_ID, root)`, `provides_root` (`:1932`)
emits `UMPSignal::Provides(SR)`. **Idle blocks emit nothing** (`!touched → None`). Next block boundary:
`OutboundMessages::drain()` folds P0..P2 into cumulative `OutboundFrontier[C]` (`:889-894`). Node archiver
`run_spec_msg_archiver` (`worker.rs:79`) stores payloads+leaves off-chain via `outbound_messages()`. Example:
`SR = tree_root{ C→SRoot3, K→…, … }`.

**Stage 3 — Relay: included → ring pushed.** `spec_msg::note_provides`
(`polkadot/runtime/parachains/src/spec_msg.rs:190`) → `RecentProvides::mutate(2000, |r| r.push(SR, now))` (`:192`).
Example: `RecentProvides[2000] = [ …, SR]`.

**Stage 4 — Receiver: monitor picks up the root.** `run_relay_provides_monitor` (`monitor.rs:258`) →
`process_relay_block` (`:339`) → `read_recent_provides` (`:229`) → `RelayProvidesEvent::Included(2000, SR, 0xR)`.

**Stage 5 — Receiver: fetch payloads + proofs.** `fetch_included` (`fetch.rs:620`) → `fetch_source` (`:146`) →
`fetch_channel_stream` (`:252`) → `MessagesRequest` over `/spec-msg/exchange/1` (`exchange.rs`) → sender
`SpecMsgArchive::serve_messages` (`archive.rs:499`). Example:
`MessagesRequest{ C, start:0, under:SR, 512KiB }` → `MessagesResponse{ base:0, payloads:[P0,P1,P2], start_peaks:[], extension:EMPTY, tree_proof:⟨C↪SR⟩ }`.

**Stage 6 — Receiver: trust-free verify.** `verify_messages_response` (`verify.rs:94`): hash+append each payload,
`extension.verify → stream root`, `tree_proof.verify → StreamsRoot`, compare `under`. Mismatch ⇒ discard + peer.
Example: `{0,[]}→{3,[N01,L2]}`, `root=SRoot3`, `tree→SR==under` ✓ → `VerifiedMessages{ end:{3,[N01,L2]}, head:3 }`.

**Stage 7 — Receiver: pool.** `note_chunk` (`pool.rs:429`) → `ChannelLedger` (`:147`); `complete_round` (`:507`).
`ChannelLedger{ base:{0,[]}, end:{3,[N01,L2]}, payloads:[P0,P1,P2], leaves:[L0,L1,L2], binding:{root:SR,head:3,extension:EMPTY,tree_proof:⟨C↪SR⟩} }`, `target[2000]=SR`.

**Stage 8 — Receiver: author + consume (budget-sliced).** `inherent_data_at` (`authoring.rs:89`) — first
grants any in-flight fetch round a bounded grace window (`wait_for_in_flight_rounds`, `pool.rs:600`; see the
client-timing deep-dive below) so a message fetched a few ms ago still makes *this* block — then
`build_inherent` (`pool.rs:774`) hands the budget-limited continuation (`InherentBudget` 256KiB/8 streams);
runtime `consume_channel_item` (`:1690`) hashes each onto `InboundFrontier[(2000,C)]` (`:720`) in order, delivers
XCM to the sink, appends `Interval` to `ConsumptionOutbox` (`:1745`). Leftover stays pooled (partial consumption
routine). Example: inherent `messages:[(2000,C,[P0,P1,P2])]`; `InboundFrontier: 0→3`; record
`[(2000,{C:Interval{start:<root@0>, end:{3,[N01,L2]}}})]`.

**Stage 9 — Receiver: POV lift + `Requires` (trust boundary, 3 contexts).** Node-side **generates**:
`lift_assembler` (`authoring.rs:339`) → `assemble_collation` (`:234`) → `channel_lift` (`pool.rs:860`) → lift in
POV (`ParachainBlockData::V3`). Runtime does neither (only `consumption_record`). PVF `validate_block` wrapper
**verifies** the POV lifts + emits `UMPSignal::Requires`; `build_requires` runs node-side *and* PVF-side
(byte-identical). Example: `channel_lift(endpoint=3)` → `RequiresLift{[],EMPTY,⟨C↪SR⟩}` → `Requires({(2000,SR)})`.

**Stage 10 — Relay: match `Requires` vs ring.** `spec_msg::check_requires` (`spec_msg.rs:200`): each
`(source,root) ∈ RecentProvides[source]`. `SR ∈ RecentProvides[2000]` ✓ → valid. (B consumed only by *proving* it
read committed data the relay still vouches for.)

**Stage 11 — Receiver: report watermark back via ack.** `on_initialize` age sweep / ¼-window trigger
(`:906-918`, `:1533-1546`) → `publish_register` (`:1485`); this is itself Stage 1–3 on **B's** side (B is `K`'s
sender). Example: B emits `Register{ up_to:3, grant:{100,1MiB}, closed:false }` on `K` → `SR_B` committed +
pushed to B's ring. Lossy latest-wins.

**Stage 12 — Sender: read ack, free credit, gate next send.** A's monitor picks up `SR_B` → `fetch_register`
(`fetch.rs:367`) → `verify_event_response` (`verify.rs:152`, inclusion not recomputation) → `note_register`
(`pool.rs:473`) → `build_inherent` register read → runtime `consume_register_read` (`:1756`) →
`OutChannels[C].register` + `confirm(up_to)` (`:355`) releases in-flight below the watermark → credit freed. The
read is lifted (`register_lift`, `pool.rs:905`) → `Requires({(2001,SR_B)})`, matched on the relay. A's archiver
`prune_payloads(C, 3)` (`archive.rs:418`) drops confirmed payloads (leaf hashes kept per lossy-head/horizon).
Example: `register.up_to: 0→3`, in-flight released → `ensure_credit` sees 0/100 → A may send X3,X4,… (Stage 1). A
`grant:{0,…}` (suspend) or `closed:true` blocks / tears down.

**The loop.** Two independent send pipelines (A's data on `C`, B's register on `K`) each run Stages 1–10; coupled
by Stage 8 (B's frontier) → Stage 11 (B's register) → Stage 12 (A's credit/watermark). Data-plane
(fetch/verify/consume), consensus-plane (POV lift → `Requires` → ring match), and flow-control-plane (register →
credit/watermark → prune) all wire together; backpressure (`ensure_credit`) + ring-matched lifts keep it safe and
bounded. **It closes end-to-end.**

Expanded below with code links and worked data: sender (0–2), relay ring (3 & 10), proof shapes,
verification (5–7), client-side timing (4–8), lift (9), ack stream (0, 11–12), flow control (11–12).

## Sender deep-dive — Stages 0–2: sends → `StreamsRoot`

How three XCMs become one 32-byte commitment, in `cumulus-pallet-spec-messaging` (refs `lib.rs`).

**Credit gate (Stage 1).** `can_send` (`:1401`) / `ensure_credit` (`:1467`): a send needs room in the peer's
granted window. *In-flight* = the count and byte-sum of leaves at positions ≥ B's read watermark; `send`
requires in-flight strictly below **both** `grant.max_messages` and `grant.max_bytes`. Over either →
`SendError::Transport`, surfaced to the XCM caller as backpressure (no hidden queue). With B's opening grant
`{100, 1 MiB}` and watermark 0, A's three sends sit at `3 / 100` msgs and `|P0|+|P1|+|P2| / 1 MiB` — admitted.

**Append (Stage 1).** `append_to_stream` (`:1336`) pushes each payload onto `OutboundMessages[C]` (`:625`) —
*this block's* sends, host-appended O(1). The stored `OutboundFrontier[C]` (`:616`) is untouched mid-block, so
`position = frontier.leaf_count + index` is stable across the whole block (frontier 0 → P0@0, P1@1, P2@2).

**Commit (Stage 2, `on_finalize` `:931`).** `commit_streams_root` (`:1560`) runs the fold *transiently* —
`OutboundFrontier` is not mutated yet:

```
leaves      L_i = hash_leaf(LEAF_VERSION=0x0, SpecMsgKind::Data(X_i).encode())   (mmr.rs:90)
              preimage domain-tagged LEAF_TAG=0x1 (lib.rs:143)
stream MMR  fold C's stored frontier (empty) + [L0,L1,L2]:
              N01 = merge(INNER_TAG=0x2, L0, L1);  peaks = [N01, L2]
              SRoot3 = bag(PEAK_TAG=0x3, peaks)          ← C's new root at leaf_count 3
commit tree leaf(C) = tree_leaf_hash(C, SRoot3)          (tree.rs:75, TREE_LEAF_TAG=0x5)
              inner via tree_inner_hash(bit, l, r)        (tree.rs:88, TREE_INNER_TAG=0x6)
              SR = compute_streams_root({C→SRoot3, K→…})  (tree.rs:195)   ← the StreamsRoot
```

`commit_streams_root` then **memoizes** `SR` for `provides_root` (`:1932` → `UMPSignal::Provides(SR)`) and
deposits the header digest `DigestItem::Consensus(SPMS_ENGINE_ID, SR)` (`lib.rs:170`), ≤ 1 per header. An idle
block (no touched stream) folds nothing, emits nothing, deposits nothing.

**Advance (next `on_initialize` `:874`).** The pending `[L0,L1,L2]` are hashed into `OutboundFrontier[C]`
(leaf_count 0 → 3) and `OutboundMessages` cleared — one atomic step. So block N's sends stay readable in **N's**
state, where the `outbound_messages()` runtime API extracts them for the archiver (Stage 2), never via storage
after the fact.

```
block N   : append P0,P1,P2 (frontier stays 0) → on_finalize: fold → SR + digest + Provides(SR)
              OutboundMessages[C]=[P0,P1,P2], OutboundFrontier[C]=0
block N+1 : on_initialize: frontier[C] 0→3, OutboundMessages cleared
              (N's sends already committed under SR; archiver already read them from N's state)
```

Key invariant: the commitment is *derived, never declared* — `SR` is recomputable from the frontiers alone, so
anyone with the payloads can reproduce it. That is exactly what makes the fetch trust-free (verification
deep-dive below).

**Marker leaf — an opened channel is never empty.** The `StreamsRoot` commitment is inclusion-only, so you
cannot prove a stream is *empty* — "empty", "peer lagging" and "peer withholding" would be indistinguishable (a
real attack surface). The fix is a marker leaf: `open_channel` (`lib.rs:1067`) commits `OpenChannel` as the
channel stream's **leaf 0** at open (`open_channel` → `send_signal` → `append_to_stream`). So an opened channel
always carries ≥ 1 leaf; **cursor 0 is always provable**, and the receiver can tell "nothing sent yet" (only the
`OpenChannel` leaf) from a stalled or withholding peer. The `OpenChannel` leaf is window-counted like any send.

## Relay-ring deep-dive — Stages 3 & 10: `RecentProvides` window match

The relay's only spec-msg state (`spec_msg` pallet, refs `spec_msg.rs`). Everything below `SR` is
parachain-side; the relay just remembers *which roots each sender recently committed* and checks receiver
`Requires` against them.

**Push (Stage 3).** On each *enactment* of a sender candidate that emitted `Provides`, `inclusion::enact_candidate`
calls `note_provides` (`:190`) → pushes `SR` into `RecentProvides[A]` (`:149`), a per-sender ring of the last
`RECENT_PROVIDES_WINDOW = 128` roots (`:58`). Idle blocks push nothing, so an inactive sender's window never
ages out.

**Match (Stage 10).** In `paras_inherent::sanitize_backed_candidates`, `check_requires` (`:200`) tests every
`(source, root)` in the candidate's `Requires` set for `root ∈ RecentProvides[source]`. A miss **drops the
candidate from the inherent — never a dispute** (`paras_inherent:1049`): the submitter regenerates its POV
lifts against the *then-current* provides and resubmits. Matching is receiver-agnostic — any para may require
any sender's root.

**Why 128 is slack, not lag tolerance.** The window only has to cover a receiver candidate's authoring →
backing → inclusion pipeline depth (~2–3 relay blocks, more under elastic scaling). Consumption *lag* is
absorbed by the POV lift advancing the endpoint to a current root (Stage 9) — not by the window. Outrunning the
window is not a failure mode; the candidate is just rebuilt.

```
relay block   RecentProvides[A]  (newest → oldest, cap 128)
  R           [ …, SR ]                    ← A's candidate enacted (Stage 3)
  R+1         [ …, SR, SR' ]               B's candidate (Requires {(A,SR)}) backed → check_requires ✓
  R+2         [ …, SR, SR', SR'' ]         B included; SR still well inside the window
  …
  R+128       SR falls off the tail        (matters only if B never got backed → rebuild vs SR_current)
```

**Dispute revert.** On a revert, `paras_inherent` calls `evict_after_revert` (`:216`) to roll the affected
sender rings back to the revert height — the PoC evicts explicitly rather than trusting state-revert alone.

## Proof shapes — `MmrInclusionProof` vs `MMRExtensionProof`

Two MMR proof types recur across the read and lift deep-dives below; they split by **shape**, not by stream:

- **`MmrInclusionProof`** (`mmr.rs:263`) — proves **one leaf** is in the stream MMR: `verify_head` (the head,
  `:299`) or `verify_leaf` (a position, `:332`). Used **only for the ack/register (event) reads** — the single
  lossy-latest leaf — and re-checked at three points on that path: client fetch (`verify_event_response`), the
  inherent (`SpecMsgInherentData.register_reads`, `inherent.rs:58`), and in-runtime (`consume_register_read` →
  `verify_head`, `lib.rs:1779`).
- **`MMRExtensionProof`** (`mmr.rs:366`) — bridges a **frontier/endpoint → a later root** over a range
  (`verify`, `:409`). Used for **two** things: message-payload fetch verification (`MessagesResponse.extension`,
  verification deep-dive) **and every POV lift** (`RequiresLift.extension` / `advances`, `lift.rs:62`), verified
  by `build_requires` node- and PVF-side.

So `MMRExtensionProof` is *not* message-only: a **register read touches both** — `MmrInclusionProof` for the
read itself, `MMRExtensionProof` for its lift (`register_lift` → `Requires`). Rule of thumb: **one leaf →
inclusion; a range or endpoint→root → extension**. Either way, the proof binds to the `StreamsRoot` only
through the accompanying `TreeInclusionProof`.

## Verification deep-dive — Stages 5–7: trust-free response checking

Why the receiver can fetch payloads from an **untrusted** peer and safely act on them: it never trusts the
response — it *recomputes* the sender's commitment from the bytes and compares to the root the relay already
vouches for.

**Request names the root.** `MessagesRequest{ stream, start, under, max_bytes }` — `under` is the exact
`StreamsRoot` the requester will depend on (from `RecentProvides`, Stage 4). The response is proven under *that*
root or discarded.

**Response.** `MessagesResponse{ base, payloads, start_peaks, extension, tree_proof }` — `base` = frontier the
payloads extend from, `extension` = `MMRExtensionProof` bridging the recomputed leaves to the stream root,
`tree_proof` = `TreeInclusionProof` from the stream root up to `SR`.

**`verify_messages_response` (`verify.rs:94`)** — pure recompute-and-compare:

```
1. from base {0,[]}, for each payload: L_i = hash_leaf(0x0, P_i); append → frontier {3,[N01,L2]}
2. extension.verify(&frontier) → SRoot3          (mmr.rs:409, MMRExtensionProof::verify)
3. tree_proof.verify(&C, &SRoot3) → SR'          (tree.rs:143, TreeInclusionProof::verify)
4. SR' == under ?   yes → VerifiedMessages{ end:{3,[N01,L2]}, head:3 }
                    no  → discard response AND peer (poisoned) → refetch elsewhere
```

No signature, no trusted transport, no relay-state read below the root: the payloads are self-authenticating
against a hash the relay chain already put in `RecentProvides`. A lying peer can only produce bytes that hash to
something ≠ `under`, which step 4 rejects. Register (ack) reads follow the same recompute-and-compare
discipline but over a single-leaf **head** proof rather than a range extension, because the ack stream is lossy
latest-wins — see the ack-stream deep-dive below. Verified message runs land in `SpecMsgPool` as a
`ChannelLedger` binding
`{root: SR, head, extension, tree_proof}` — the exact material the lift assembler re-serves as the POV lift
(Stage 9) without re-fetching.

## Client-side timing deep-dive — the fetcher↔proposer grace window (Stages 4–8)

Stages 4–8 hide a race: the **fetcher** (monitor → fetch → pool, Stages 4–7) and the **proposer**
(`inherent_data_at`, Stage 8) both fire off the *same* relay-block import and run concurrently. A fetch round
takes ~15–40 ms on loopback; if the proposer snapshots the pool a few ms before the round lands, the message
misses this block's inherent and slips to the receiver's *next* block — a full receiver-block of latency,
defeating the HRMP-latency target.

**The fix.** Before snapshotting, `inherent_data_at` waits on any in-flight round for a bounded
`ROUND_GRACE_WINDOW` (`authoring.rs:80`, 250 ms) via `wait_for_in_flight_rounds` (`pool.rs:600`). Idle (no
round) the wait is free. 250 ms is generous for the ~15–40 ms it targets yet ≤ ⅛ of the ~2 s authoring budget,
so a *hung* fetch can't wedge authoring — it gives up and builds without the message (correctness intact: the
relay ring still vouches `SR`, so it just arrives next block).

**Three states** (`RoundsInFlight`, `pool.rs:307`), because fetcher and proposer aren't in lockstep:

| State | Meaning | Set / cleared |
|---|---|---|
| `started` | a round is actively running | `begin_round` (`pool.rs:523`) / `end_round` (`:560`) |
| `pending_offers` | monitor pushed the offer, fetcher hasn't begun the round yet | `note_pending_offer` (`:545`, from `monitor.rs:395`), superseded by `begin_round` |
| `completed` | round finished a hair before the snapshot; writes not yet in the read view | `end_round` retains for `COMPLETION_RETENTION` (`:301`, 5 ms) |

Without `pending_offers` the proposer could snapshot in the gap after the offer is sent but before the round
starts (nothing `started` yet); without `completed` retention it could seal an empty inherent microseconds
after a round dropped its guard.

**Worked timeline** — B authors block N+1; relay block R carries A's included `SR` over stream `C = [P0,P1,P2]`:

```
t=0ms   R imported → both fire off it:
        · monitor:  note_pending_offer(A)  → pending_offers={A}; sends the offer
        · proposer: inherent_data_at → wait_for_in_flight_rounds(250ms);
          entry {started:∅, pending:{A}, completed:∅} → waits (not an empty snapshot)
t=2ms   fetcher:  begin_round(A) → {started:{A}, pending:∅}; fetch + verify P0..P2
t=28ms  end_round(A) → {started:∅, completed:{A}} (retained 5 ms); waiters woken
t≈29ms  proposer wakes, retention lapses, writes visible → wait returns (≈29 ms ≪ 250)
        → inherent messages:[(A, C, [P0,P1,P2])] delivered THIS block ✓
```

At that exit `started==0 && pending_offers==0` → classified `RetentionElapsed` (a benign settle), logged
distinctly from a true `BoundExpired` (a round still live after the full 250 ms — e.g. A's collator
unreachable → build N+1 without the message; it lands in N+2).

**Below the design layer.** The window only decides whether a message lands in block N+1 vs N+2 — a node-local
latency optimization on the fetcher↔proposer seam. It changes nothing committed, verified, or delivered (a
missed message just waits one block), which is why it lives entirely in the node/client stream
([#12707](https://github.com/paritytech/polkadot-sdk/issues/12707)), not the protocol.

## Lift deep-dive — Stage 9: POV lift → `Requires`, and UMP-signal transport safety

### The lift/`Requires` path (5 steps, 3 contexts)

1. **Consumption record (runtime output).** `consume_channel_item` (`lib.rs:1690`) / `consume_register_read`
   (`:1756`) write per-`(source,stream)` `Interval`s into transient `ConsumptionOutbox`, exposed by
   `consumption_record()`. Runtime stores **only frontiers** (`InboundFrontier`) + this record — enough to
   *verify* a lift, never to *generate* one.
2. **Lift generation (node-side).** `lift_assembler` → `assemble_collation` (`authoring.rs:234`) →
   `channel_lift`/`register_lift` (`pool.rs:860/905`) pulls extension-over-retained-leaf-hashes + tree proof
   from the pool; multi-block candidates `stitch` interval chains in bundle order (`chain_endpoint`) —
   consecutive intervals must chain (`next.start == prev.end.root()`) or an `advances` extension proves the gap
   is a forward step (present only when a fresher root was read mid-bundle). A mispaired or forged chain can't
   fold to the committed root — the soundness guard.
3. **POV carriage.** Lifts ride in `ParachainBlockData::V3` — the PVF's *input*.
4. **PVF synthesis (`validate_block` wrapper, post-execution).** Reads `consumption_record()`, takes POV lifts,
   `build_requires(records, lifts)` **advances each endpoint to a current in-window root** (extension+tree →
   `StreamsRoot`; invalid → `LiftError` fails candidate; per source must converge → `DivergentRoots` else),
   produces canonical `RequiresSet`, appends `UMPSignal::Requires(set)` to `UpwardMessages`.
5. **Byte-identity.** Collator also runs `build_requires` node-side to declare the same signal; PVF re-derives
   it — a mismatch is rejected at backing.

**The primitive encodes the invariant.** `UMPSignal::Requires` doc (`polkadot/primitives/src/v9/mod.rs:2750-2761`):
*"NEVER emitted by parachain block execution … the validate_block wrapper synthesizes this signal from the record
via POV-carried lifts … Relay-side semantics are window membership only."* `Provides` (`:2744`): *"Emitted only
by blocks that touched at least one stream."* Matches the `validate_block`-hook synthesis (§4) and the PoV-format
rollout order (§7).

### `UpwardMessages` + UMP signals — what it is and why it's safe

The emitter (`append(UMP_SEPARATOR)` then each signal) builds the candidate's `upward_messages` commitment, which
has **two regions split by `UMP_SEPARATOR = vec![]`** (`v9:2867`):
- **before** the separator → real UMP (XCM to relay, queued);
- **after** → **UMP signals** (`SelectCore`/`ApprovedPeer`/`Provides`/`Requires`) — parsed and acted on, **never
  queued as XCM**.

So `Provides` (sender) and `Requires` (receiver, from the wrapper) are appended as post-separator signals.

**Does not break relay UMP processing — safe by construction:**
1. **XCM queueing excludes signals** — the relay uses `skip_ump_signals` (`inclusion/mod.rs:950,1004`) =
   `take_while(m != separator)` (`v9:2873`); post-separator signals are never dispatched as XCM.
2. **Signals don't consume XCM UMP budget** — count/size checks run on the `skip_ump_signals` output (pre-sep
   only); signal count is separately bounded by `MAX_UMP_SIGNALS = 4` (`v9:2770`; duplicates → error).
3. **Mechanism pre-exists** — same separator+signal transport as `SelectCore`/`ApprovedPeer`; `Provides`/`Requires`
   add two enum variants + two handlers: `note_provides` (`inclusion:918-921` → ring) and `check_requires`
   (`paras_inherent:1044-1052` → drop candidate if root not in window). Parsed via `commitments.ump_signals()`
   (`v9:2879`).

**Real hazard = uneven deploy (not the mechanism).** Emitting `Provides`/`Requires` to a relay whose runtime
lacks the enum variants → `UMPSignal::decode` fails → candidate rejected. The safeguard is **release-first
ordering** (§7): the relay runtime with UMP-signal support must reach ⅔+ validators *before* any parachain emits
the new signals (decode-first upgrade order). There is deliberately **no feature bit** — the earlier
`SpeculativeMessaging` node-feature / consumer-side gate was dropped, so `note_provides` and `check_requires` run
**unconditionally** (gated only by a `Requires` being present); with no on-chain toggle to hold candidates back,
deploy-before-emit ordering is the sole migration safeguard. The transport is sound; safety rests on release
ordering, not a runtime gate.

## Ack-stream deep-dive — Stages 0, 11–12: the register head read

The ack stream `K = Ack{recipient: sender, domain, num}` is an ordinary per-stream MMR like the data stream
`C`, but consumed under the **opposite discipline — lossy latest-wins**: only B's *newest* `Register` matters,
so A reads just the **head** leaf of `K`, never the history. (Data stream `C` is ordered no-skip — A reads
*every* leaf via a range + extension proof, verification deep-dive above.)

**No direct ack — the register is just a stream leaf.** B's `publish_register` (`lib.rs:1485`) only
`append_to_stream`s the `Register` onto `K`; it never pushes anything to A (the local `Event::RegisterPublished`
is a FRAME event for RPC, not a cross-chain signal). The `StreamsRoot` update isn't in `publish_register`
either — it's the ordinary end-of-block `commit_streams_root` fold: `K` is now a touched stream, so B's block
commits a fresh `SR_B` and emits `Provides(SR_B)`. Delivery to A is then the **identical** path as data,
just B→A — `note_provides` → `RecentProvides[B]` → monitor → fetch → verify → inherent — with B as `K`'s
sender and A its reader. So the ack is **asynchronous** (it round-trips through relay inclusion + an
off-chain fetch), which is exactly why flow control is windowed/advisory: A sends up to the `grant` without
waiting for a per-message ack, and B's watermarks catch it up later.

**Head read, not range.** `fetch_register` (`fetch.rs:367`) issues `EventRequest{ stream:K, under:SR_B, at:None }`
— `at:None` = "the head as of `under`". The reply is a single leaf, not a run:
`EventResponse{ payload: Register.encode(), inclusion: MmrInclusionProof, tree_proof }`.

**`verify_event_response` (`verify.rs:152`)** — head branch:

```
leaf = hash_leaf(LEAF_VERSION, payload)                              (= the served Register)
(position, frontier) = inclusion.verify_head(leaf)   (mmr.rs:299)    → position = leaf_count-1
root = frontier.root()
streams_root = tree_proof.verify(K, root)            (tree.rs:143)
streams_root == under ?   yes → VerifiedEvent{ position, frontier }
                          no  → RootMismatch → discard + peer
```

**What `verify_head` proves (head-ness, not mere inclusion).** `MmrInclusionProof{ mmr_size, items }` — `mmr_size`
fixes `leaf_count`. The head leaf is the rightmost leaf of the last (smallest) peak's subtree, so its sibling
path is *exactly* `leaf_count.trailing_zeros()` LEFT siblings plus `count_ones()−1` other peaks; the item count
is checked exactly, so the proof has **one valid form**. It reconstructs the full frontier and returns
`position = leaf_count−1`.

**Why lossy-latest-wins is still trust-free.** `under = SR_B` commits `K`'s root at a *specific* leaf count. A
lagging or malicious peer that serves a **stale** register as the head puts the wrong leaf in the head slot →
a different frontier root → `≠ under` → rejected (`verify.rs:150`: *"under fixes the stream's leaf count, so a
stale leaf served as the head yields a different stream root and fails the comparison"*). So A can be *behind*
(it only sees whichever `SR_B` it points at) but never *fooled* into treating an old register as current.

**Data / timeline** — B acknowledges A's `C=[P0,P1,P2]`; A reads B's register off `K` (B is `K`'s sender, A its
reader; every register publish touches `K`, so B commits a fresh `StreamsRoot` and pushes it to its ring):

```
K leaf   Register (B → A on stream K)                 B's StreamsRoot    relay ring RecentProvides[B]
  0       {up_to:0, grant:{100,1MiB}, closed:false}    SR_B0  (Stage 0)   [ …, SR_B0 ]
  1       {up_to:3, grant:{100,1MiB}, closed:false}    SR_B1  (Stage 11)  [ …, SR_B0, SR_B1 ]
  2       {up_to:5, …}   (if B consumes more later)    SR_B2             [ …, SR_B1, SR_B2 ]

A (Stage 12), currently pointing at SR_B1:
  EventRequest{ K, under:SR_B1, at:None }
   → EventResponse{ payload: Register#1, inclusion: head @ leaf_count=2, tree_proof: ⟨K↪SR_B1⟩ }
   → verify_head → position 1, frontier{leaf_count:2}, root → tree → SR_B1 == under ✓
   → consume_register_read (lib.rs:1756): OutChannels[C].register = {up_to:3}; confirm(3) (lib.rs:355)
     → credit freed  (→ flow-control deep-dive)
```

Pointing at `SR_B2` instead would yield `Register#2 {up_to:5}` — the newer head; registers #0/#1 are simply
superseded, never fetched. The head read always returns exactly the latest register committed under the root A
depends on. And the read is itself POV-lifted (`register_lift`) → `Requires({(B, SR_B*)})`, matched on the
relay like any data read — so even reading an ack is proven against a committed root.

## Flow-control deep-dive — Stages 11–12: credit / watermark / prune

Entirely bilateral — no relay involvement. One channel = A's data stream `C` + B's register stream `K`
(`Ack{recipient:A,…}`, lossy latest-wins). B's whole voice is its `Register` (refs `lib.rs`).

**Register.** `Register{ up_to, grant{max_messages,max_bytes}, closed }` — `up_to` = B's consumption watermark
(how far it has read `C`), `grant` = advisory credit B extends to A, `closed` = teardown. B publishes on
acceptance, ~¼-window consumption progress, or age: `note_consumption` (`:1525`) sets the `due` flag,
`publish_register` (`:1485`) emits it onto `K`.

**The credit loop (Stage 12).** A reads B's register out-of-band over `K` (`fetch_register` → `verify_event_response`
→ `note_register` → inherent → `consume_register_read` `:1756`), then `confirm(up_to)` (`:355`) releases
in-flight below the watermark → credit freed for the next send.

```
A: send P0,P1,P2       → in-flight = 3 msgs, |P0|+|P1|+|P2| bytes   (below grant {100,1MiB} → OK)
B: consume to pos 3    → InboundFrontier[(A,C)] = 3, watermark up_to = 3
B: publish Register{ up_to:3, grant:{100,1MiB}, closed:false } on K   (¼-window / age trigger)
A: read register → confirm(3): no in-flight positions ≥ 3 → in-flight 0 / 100
   → ensure_credit sees 0/100 → A may send X3, X4, …
A: prune_payloads(C, 3) (archive.rs:418) → drop confirmed payloads (leaf HASHES kept per horizon)
```

`grant:{0,…}` suspends (backpressure); `closed:true` tears the channel down. Because the register read is
proven against a committed root (ack-stream deep-dive), even *credit* accounting is trust-free — never taken on
a peer's word.

---

## 1. Primitives — `cumulus-primitives-spec-messaging`

`no_std`, consumed by the pallet, the PVF wrapper and the off-chain subsystem. Modules:

- **`stream_id`** — `StreamId` with a frozen 8-byte big-endian canonical encoding (the encoding *is* the trie
  key), reserved-kind rejection, frozen test vectors.
- **`mmr`** — domain-tagged `SpecMerge`/`SpecHasher` (blake2) over a peaks-only frontier matching `mmr-lib`:
  `hash_leaf`, `MmrRoot`, `MmrFrontier`, `MessagePosition`, plus the two proof shapes —
  `MmrInclusionProof` (single-leaf head/positional) and `MMRExtensionProof` (frontier → later root). Frozen
  root vector.
- **`tree`** — the stream commitment trie over `(StreamId, stream root)` → `StreamsRoot`:
  `compute_streams_root`, `prove_stream`, `tree_leaf_hash`/`tree_inner_hash`, `TreeInclusionProof`.
- **`record`** — `ConsumptionRecord`, `Interval` — what a block's consumption did (per touched stream, the
  MMR interval), stitched and lifted by the wrapper.
- **`lift`** — `RequiresLift` and its canonical per-source `LiftsBySource` (POV-carried), plus the wrapper's
  synthesizer: `stitch` / `build_requires_entry` / `build_requires` (and `LiftError`).
- **`wire`** — the off-chain protocols: fetch (`MessagesRequest`/`MessagesResponse`), lossy event/register
  read (`EventRequest`/`EventResponse`, via `MmrInclusionProof::verify_head`) and the `/spec-msg/exchange`
  envelope (`ExchangeRequest`/`ExchangeResponse`, frozen variant indices) multiplexing the two. Every
  response is independently verifiable against a requester-named root.
- **`channel`** — channel-layer payloads and views: `SpecMsgKind` / `SpecMsgSignal`, `Register` /
  `WindowGrant`, `ChannelId` / `ChannelPhase`, and the API view types `ConsumedStream` / `OutChannelState` /
  `InChannelState`.
- **`inherent`** — `SpecMsgInherentData` + `INHERENT_IDENTIFIER` (`specmsg0`): fetched payloads in, no roots.

Domain tags (RFC 6962-style separation): message MMR `LEAF_TAG=0x1` / `INNER_TAG=0x2` / `PEAK_TAG=0x3` /
`EMPTY_TAG=0x4` (defined root of an empty frontier — `mmr-lib` errors on empty); commitment tree
`TREE_LEAF_TAG=0x5` / `TREE_INNER_TAG=0x6`; `LEAF_VERSION=0x0` (leaf preimage-layout epoch, present from
leaf #0); `SPMS_ENGINE_ID = *b"SPMS"` (the header digest carrying the `StreamsRoot`).

Relay-visible types live in **`polkadot-primitives`** (so the relay decodes them without a `polkadot →
cumulus` edge): `StreamsRoot`, `RequiresSet` (canonical sorted `(ParaId, StreamsRoot)` set),
`UMPSignal::Provides | Requires`, `MAX_UMP_SIGNALS = 4`. `cumulus-primitives-core` re-exports the
parachain-side set and declares `SpecMsgApi` (§6).

## 2. Relay chain — `runtime/parachains::spec_msg`

A dedicated relay pallet — the only historical-commitment storage in the system (everything below a
`StreamsRoot` is parachain-side):

- **`RecentProvides`** — per sender, a ring of the last `RECENT_PROVIDES_WINDOW` (`W = 128`) `StreamsRoot`s.
  Pushed on each *enactment* of a sender candidate that emitted a `Provides` (from `inclusion::enact_candidate`);
  idle blocks push nothing, so an inactive sender's window never expires. `W` is pipeline slack, not lag
  tolerance (lag is covered by POV lifts) — ~128 covers authoring→inclusion depth including elastic-scaling
  bursts.
- **`check_requires`** — receiver-agnostic membership match, called from `paras_inherent`'s
  `sanitize_backed_candidates`. A miss **drops the candidate from the inherent, never disputes it** — the
  submitter regenerates its POV lifts against the then-current provides and resubmits. Unconditional: gated
  only by a `Requires` signal being present (legacy / `Provides`-only candidates short-circuit). No feature
  bit (§7).
- **`evict_after_revert`** — on dispute revert, `paras_inherent` calls this to roll the affected sender rings
  back to the revert height (the PoC evicts explicitly rather than relying on state-revert alone).

**Not yet productionized:** weights (`check_requires` ≤ `W` reads/candidate, `note_provides` a read+write
per enacted candidate — currently unmetered); offboarding prune of `RecentProvides[para]`; `W` as a
governance-adjustable `HostConfiguration` field (currently a compile-time constant).

## 3. Parachain pallet — `cumulus-pallet-spec-messaging`

Both halves of the transport in one pallet, plus channels and the XCM router.

**Sender (outbox).** `append_to_stream` pushes a payload onto `OutboundMessages` (this block's per-stream
sends; O(1), frontier untouched mid-block so `position = frontier.leaf_count + index` is stable). At
`on_finalize` the touched streams' new MMR roots are computed *transiently* (stored frontier + this block's
leaves) and folded into the commitment tree (`TreeNodes` / `TreeRoot`, a rebuildable cache — the frontiers are
the source of truth) — one path write per touched stream; the resulting `StreamsRoot` is memoized for the
`Provides` signal and deposited as the `DigestItem::Consensus(SPMS_ENGINE_ID, root)` header digest (≤1/header;
an idle block folds/emits/deposits nothing). At the *next* block's `on_initialize` the pending messages are
hashed into the frontiers and `OutboundMessages` cleared — so block N's sends stay readable in N's state,
where the runtime API (never storage) reads them. Pallets that append must be ordered before this one in
`construct_runtime`.

**Receiver (inbox).** `enact_messages` (the `specmsg0` inherent) consumes fetched payloads — no roots, no
relay-state reads: the runtime verifies by *recomputation* only, and binding results to committed sender roots
is the PVF's job (§4). It writes the transient `ConsumptionRecord` (per touched stream, `Interval`, grouped by
source, `StreamId`-sorted).

**Channels & flow control** (unidirectional, entirely bilateral — no relay involvement). One channel = the
sender's ordered data stream (`Channel{recipient, domain, num}`: `Data` + lifecycle `Signal` leaves) and the
receiver's register stream (`Ack{…}`: lossy, latest-wins). The receiver's whole voice is its `Register`
(acceptance, consumption watermark, advisory credit, close).

- `open_channel` creates the `OutChannels` entry (phase `Opening`) and emits the `OpenChannel` signal — the
  one message sendable without credit, still window-counted. `accept_open_channel` is the receiver's local
  acceptance: the `InChannels` entry joins the consumed set and the initial register is published. Either
  order works (accept-first = pre-authorization); an unaccepted open leaves zero receiver state.
- `send` enforces the peer's granted window: in-flight = count + byte sum of leaves at positions ≥ the read
  watermark, required strictly below the grant on both limits.

**XCM integration** (`xcm_router.rs`). The `SpecMsg(ParaId)` origin is **sibling-identical** — it converts to
the exact `Location` the HRMP `Sibling` origin does (property-tested over para ids), so the HRMP→spec-msg flip
is invisible to XCM programs, barriers and downstream filters.

## 4. PVF / `validate_block` — `validate_block/spec_messaging.rs`

`SpecMessagingSignals::build` runs in the wrapper after executing each block of a bundle: it folds the
bundle's block-emitted `Provides` (last emitter wins) and **synthesizes** the `Requires` set from the
bundle-ordered consumption records and the POV-carried `LiftsBySource` (`build_requires`). It **panics —
invalidating the candidate — on a block-emitted `Requires` or any lift-verification failure**. The wrapper
cannot judge staleness (no relay state in-wasm; window matching stays relay-side, §2) — its rule is
mechanical: one lift per recorded stream, verified, roots converging per source. Built on both the plain and
scheduling-override paths (a scheduling override never touches the messaging commitments).

Rollout: the `ParachainBlockData` lift field is decoded only by the para's own PVF; gate on the runtime
`api_version` for the PoV format; PVF-decodes-first upgrade order; relay UMP support ships before paras emit
signals (§7).

## 5. Off-chain subsystem — `cumulus-client-spec-msg`

The off-chain half around the `StreamsRoot`. Request-response only (MVP): no notification/announce protocol,
no DA, no live push — triggers come from *included* roots only.

**Sender side.**
- `SpecMsgArchive` persists every block's sends keyed by `(stream, position)` (payloads + leaf hashes — proofs
  need hashes even where payloads were pruned) with per-block frontier boundaries; serves the two root-keyed
  fetch requests, each proven under exactly the `StreamsRoot` it names (`under`).
- `run_spec_msg_archiver` follows best blocks, extracts each block's sends via `SpecMsgApi` (version-gated —
  idle on runtimes without the API) and maintains retention to the `SERVING_HORIZON` (~25 h).
- `SpecMsgRequestHandler` answers `/spec-msg/exchange`; `spec_msg_protocol_config` is the registration.
- `verify_messages_response` / `verify_event_response` are the requester side — untrusted responses,
  verification recomputes the frontier and walks extension + tree proofs against the named root; a mismatch
  discards response *and* peer.

**Receiver side.**
- `run_relay_provides_monitor` watches imported relay blocks for consumed sources' newly *included*
  `StreamsRoot`s (the inclusion-tier trust anchor) and offers each once as a `RelayProvidesEvent`.
  `read_recent_provides` is the shared relay-state read.
- `run_spec_msg_fetcher` fetches the source's consumed streams (chunked, resumable) + ack-register head reads
  from its peers (`SourcePeers` / `PeerRegistry`), verifies against exactly that root, lands it in
  `SpecMsgPool`; a poisoned response discards response + peer and refetches.
- `inherent_data_at` builds the block's `specmsg0` inherent from the pool (an `InherentDataProvider`);
  `assemble_lifts` / `lift_assembler` build the candidate's POV lifts from the built blocks' consumption
  records, for `CollatorService::with_spec_msg_lift_assembler`.

## 6. Runtime API & XCM boundary

`SpecMsgApi` (declared in `cumulus-primitives-core`, version-gated like collation info):

- `outbound_messages()` — this block's sends per stream, canonical order (archive extraction).
- `consumed_streams()` — everything this chain consumes, grouped by source, from which position (what the
  inherent provider fetches; suspended channels omitted — the omission is how collators learn to stop
  fetching).
- `out_channels()` / `in_channels()` — channel views for authoring decisions and which ack registers to read.
- `consumption_record()` — the block's touched streams + intervals. **One definition, two callers**: node-side
  extraction *and* the `validate_block` wrapper in-wasm (byte-identical records).

The `SpecMsg` origin and XCM router live in the pallet (§3); the origin is Sibling-identical.

## 7. Migration & rollout ordering

**Release-first — no feature bit.** There is no `FeatureIndex::SpeculativeMessaging` and no relay-side consumer
gate; the relay's `note_provides` / `check_requires` handlers run unconditionally once the relay runtime ships
UMP-signal support. Rollout safety therefore rests entirely on deploy-before-emit ordering:

- The relay runtime with UMP support (`MAX_UMP_SIGNALS = 4` + `Provides`/`Requires`) must be on ⅔+ validators
  **before** any parachain emits the new signals (else `TooManyUMPSignals` / `UmpSignalDecode` on old nodes).
  With no on-chain toggle to hold candidates back, this ordering is the sole safeguard — relay first.
- Emission is gated by the parachain runtime opting in (PoV format via `api_version`, §4); the para's own PVF
  decodes the lift field first (PVF-decodes-first upgrade order).

## 8. Remaining work (PoC → production)

- **Weights / benchmarks** — relay (`check_requires`, `note_provides`) and pallet paths are unmetered.
- **Relay housekeeping** — offboarding prune of `RecentProvides[para]`; `W` as a governance-adjustable host
  configuration field (currently `const 128`).
- **Live / speculative tier** — header-digest triggers (co-arrival in the same relay block), DA, live push,
  and the virtual window + atomic enactment dependencies — *deferred to super chains*. Only the inclusion tier
  (included-root triggers) is in the MVP.

## Related documents

- [Speculative Messaging design](speculative-messaging-design.md) — canonical v0.5 vision (local mirror; Quartz-ignored).
- [Low-Latency Parachains v2](https://github.com/paritytech/polkadot-sdk/pull/11413) — the foundation.
- [Off-Chain Block Verification](offchain-block-verification-design.md) — speculative/optimistic tiers (local mirror; Quartz-ignored).
- [E2E test runbook](speculative-messaging-e2e-test.md) — the `spec_msg_penpal` full-workflow test.
- [v0.5 alignment note](speculative-messaging-v0.5-alignment.md) — reconciliation of the `rk-spec-msg-*` branches vs v0.5 + the PoC (branch deltas, retention/DHT proposals, issue replies).
- [Notes index](speculative-messaging-index.md) — start-here hub for this cluster.
