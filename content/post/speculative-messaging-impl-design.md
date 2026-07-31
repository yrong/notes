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
(`lexnv/spec-msg-poc-mvp`) — **14 / 15 implemented**; the one gap is monitoring metrics (#12597). Dynamic DHT
peer discovery (part of #12595) was the other deferred item and is now implemented on the stacked branch
[#12736](https://github.com/paritytech/polkadot-sdk/pull/12736).

| Work stream | Leaf issue | PoC |
|---|---|---|
| **[#12346](https://github.com/paritytech/polkadot-sdk/issues/12346) primitives** | [#12700](https://github.com/paritytech/polkadot-sdk/issues/12700) Stream ID + MMR primitives | ✅ `stream_id`, `mmr` |
| | [#12701](https://github.com/paritytech/polkadot-sdk/issues/12701) Commitment trie + consumption/channel records | ✅ `tree`, `record`, `channel` |
| | [#12702](https://github.com/paritytech/polkadot-sdk/issues/12702) Requires lifts | ✅ `lift` |
| **[#12349](https://github.com/paritytech/polkadot-sdk/issues/12349) relay** | [#12347](https://github.com/paritytech/polkadot-sdk/issues/12347) Expose `Provides`/`Requires` UMP signals | ✅ `polkadot-primitives` v9 |
| | [#12704](https://github.com/paritytech/polkadot-sdk/issues/12704) `RecentProvides` checks on the relay | ✅ `spec_msg` pallet |
| **[#12707](https://github.com/paritytech/polkadot-sdk/issues/12707) node/client** | [#12593](https://github.com/paritytech/polkadot-sdk/issues/12593) `SpeculationStore` | ✅ `SpecMsgArchive` (+ `SpecMsgPool`) |
| | [#12595](https://github.com/paritytech/polkadot-sdk/issues/12595) p2p layer for fetching messages | ✅ fetch/serve over `/spec-msg/exchange/1` · ✅ on-chain-driven relay-DHT peer discovery ([#12736](https://github.com/paritytech/polkadot-sdk/pull/12736), reusing RFC-0008 `/paranode`; supersedes the static `PeerRegistry`) |
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
client-side timing deep-dive in [PoC internals](speculative-messaging-poc-internals.md#12707--nodeclient-cumulus-client-spec-msg))
so a message fetched a few ms ago still makes *this* block — then
`build_inherent` (`pool.rs:774`) hands the budget-limited continuation (`InherentBudget` 256KiB/8 streams);
runtime `consume_channel_item` (`:1690`) hashes each onto `InboundFrontier[(2000,C)]` (`:720`) in order, delivers
XCM to the sink, appends `Interval` to `ConsumptionOutbox` (`:1745`). Leftover stays pooled — partial
consumption is routine **once the fetch has caught up to the head** (any prefix is liftable from the retained
leaves); a **mid-backlog** stream (`ledger.end < head`) drains only **wholesale** until the fetch reaches the
head, as only its endpoint is then liftable (§8). Example: inherent `messages:[(2000,C,[P0,P1,P2])]`;
`InboundFrontier: 0→3`; record
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

Each stage is expanded (code links + worked data) in [PoC internals](speculative-messaging-poc-internals.md),
by #12531 work stream: proof shapes (#12346); relay ring — stages 3 & 10 (#12349); verification 5–7 +
client-side timing 4–8 (#12707); sender 0–2, lift 9, ack stream 0/11–12, flow control 11–12 (#12708).

> _The stage-by-stage **deep-dives** (sender, relay-ring, proof shapes, verification, client-side timing, lift, ack-stream, flow-control) moved to [PoC internals](speculative-messaging-poc-internals.md), by #12531 work stream. §1–§8 below are the component summaries._

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
- **Expose `PeerRegistry` to the fetch consumer** (#12744). Discovery populates the registry, but nothing
  external reads it yet — it's created in `start_node` and moved into `run_source_discovery` (loop-internal,
  drives retry/peerless detection). Intentional follow-up: wire it when the fetch pipeline lands. Preferred
  mechanism is in-scope shared-`Arc` DI, *not* an `OnceLock` handle — both writer and reader spawn in the same
  `start_node` scope, so construct the `Arc<PeerRegistry>` once and hand `Arc<PeerRegistry>` to the writer and
  `Arc<dyn SourcePeers>` to the reader (no `OnceLock`/return-type change; there's no forward reference to solve).
  Do the hoist + inject atomically when the consumer arrives (pre-hoisting now would be a used-once binding).

Known limitations surfaced in review (correctness/liveness, not yet issue-tracked):

- **Partial consumption under deep backlog (Case-B).** `build_inherent` takes a byte-budget prefix without
  checking `ledger.end < head`. A mid-backlog stream whose remaining run exceeds the 256 KiB inherent budget
  yields `endpoint < end` → `channel_lift` returns `NotCovered` → collation fails (liveness, not safety — no
  invalid candidate; self-resolves once the fetch reaches the head, but until then that stream drains nothing
  and each block wastes a collation attempt). Fix: in Case-B, take `[cursor..end)` only if the whole run fits,
  else withhold the stream (a `continue`, like the stale-`binding.root` guard).
- **`TreeNodes` unbounded growth.** The commitment trie never deletes — streams are eternal, so it grows
  monotonically (N distinct streams → N−1 inner nodes). This is an MVP *persistence strategy*, not
  protocol-mandated: the design requires only the root, and the primitives' stateless `streams_root(entries)`
  recompute needs no persisted tree at all. Bound it by evicting closed + fully-confirmed + horizon-aged
  leaves, or drop the persisted trie for recompute.

## Related documents

- [Speculative Messaging design](speculative-messaging-design.md) — canonical v0.5 vision (local mirror; Quartz-ignored).
- [Low-Latency Parachains v2](https://github.com/paritytech/polkadot-sdk/pull/11413) — the foundation.
- [Off-Chain Block Verification](offchain-block-verification-design.md) — speculative/optimistic tiers (local mirror; Quartz-ignored).
- [E2E test runbook](speculative-messaging-e2e-test.md) — the `spec_msg_penpal` full-workflow test.
- [v0.5 alignment note](speculative-messaging-v0.5-alignment.md) — reconciliation of the `rk-spec-msg-*` branches vs v0.5 + the PoC (branch deltas, retention/DHT proposals, issue replies).
- [Notes index](speculative-messaging-index.md) — start-here hub for this cluster.
