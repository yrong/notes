# v0.5 alignment — foundation vs `speculative-messaging-design.md` v0.5

The canonical design jumped to **v0.5** ([PR #12659](https://github.com/paritytech/polkadot-sdk/pull/12659),
"streams + POV lifts"), a **full rewrite** that supersedes the v0.3-flat model our `ron/spec-msg-point3`
foundation is built on. This note maps the foundation to v0.5 and gives the re-shape plan. **It changes
what we build next** — the point-3 integration must not be started in the v0.3-flat shape.

## v0.5 in brief (what changed)

- **Commitment = one `StreamsRoot` per sender block** — the root of a *keyed commitment tree* over all the
  sender's stream roots (keyed by `StreamId`). UMP signal `Provides(StreamsRoot)`. The flat per-destination
  `(ParaId, Hash)` `CommitmentSet` is gone.
- **Streams, not destinations.** Per-stream MMRs keyed by a structured **8-byte `StreamId`** (`Channel` /
  `Ack` / `Broadcast` / `Private`) with a **frozen, consensus-critical, big-endian manual SCALE encoding**
  (encoding *is* the tree-key derivation; sorts lexicographically = numerically). The relay never sees ids.
- **Requires: blocks never emit it.** The messaging inherent writes a **`ConsumptionRecord`** (per-stream
  `Interval { start: MmrRoot, end: MmrFrontier }`, grouped by source, `StreamId`-sorted). The
  **`validate_block` wrapper synthesizes** `Requires(RequiresSet = Vec<(ParaId, StreamsRoot)>)` — one entry
  per source — from the record via POV-carried **lifts** (`RequiresLift { advances, extension, tree_proof }`):
  `stitch` the intervals → `extension` yields the stream's current root → `tree_proof` walks to the
  `StreamsRoot`; all of a source's streams must lift to the *same* root. **0.3's in-block catch-up and
  late-block proofs are unified into this one mechanism.**
- **Relay = one ring per sender** (`RecentProvides: StorageMap<ParaId, RecentRoots>`, last W `StreamsRoot`s,
  W×32 B, ~800 KB relay-wide at 200 paras). Membership match of `requires` against the sender's ring,
  virtually extended by same-block candidates' `Provides` (→ enactment dependencies). W covers only the
  authoring→inclusion pipeline; consumption lag is covered by lifts, not the window.
- **Channels are unidirectional** with lossy flow control via a latest-wins **`Register`** on the receiver's
  `Ack` stream (acceptance / credit / watermark / close). **Event streams** give native pub-sub, zero relay
  state per feed/subscriber. **Super chains** factored into their own doc.

## Foundation → v0.5 mapping

| Our foundation (`ron/spec-msg-point3`) | v0.5 | Status |
|---|---|---|
| MMR: `SpecMerge`/`mmr-lib`/`root_from_peaks`/`Mmr` accumulator | per-**stream** MMRs (still MMRs) | ✅ **reused** |
| `OutgoingMessage::hash_leaf` = `LEAF_TAG++LEAF_VERSION++payload` | unchanged | ✅ **reused** (our leaf-simplify was right) |
| `CommitmentSet<N>(BoundedVec<(ParaId,Hash)>)` + manual sorted `Decode` | `RequiresSet(BoundedVec<(ParaId,StreamsRoot)>)` — same shape + same canonicality discipline | ✅ **reused as RequiresSet** |
| `frontier` module (binary Merkle tree over `(dest, root)` + membership proof) | `StreamsRoot` = **keyed** commitment tree over `(StreamId, stream_root)` + `tree_proof` | ⚠️ **rework** — same *idea* (we anticipated it), re-key `ParaId`→`StreamId`, and the tree is **keyed/trie-like** (clusters by `StreamId` encoding), likely not plain `binary_merkle_tree` |
| head-commit digest (`SPMS_FRONTIER_ENGINE_ID`, cumulative frontier) | `Provides(StreamsRoot)` — one hash, the primary commitment | ⚠️ **vindicated + promoted** (optimization → the model) |
| `ProvidesCommitment = CommitmentSet` (flat per-dest set) | `Provides(StreamsRoot)` (single hash) | ❌ **rework** (set → one root) |
| outbox per-destination `OutgoingMMRState` keyed by `ParaId`; `compute_provides` (flat delta set) | per-**stream** MMRs keyed by `StreamId`; `compute` → **`StreamsRoot`** (tree root) | ❌ **major rework** (re-key + set→root) |
| inbox `get_requires_commitments` (block emits requires); `ingest_verified_messages` records requires | blocks write a **`ConsumptionRecord`**; `validate_block` wrapper synthesizes requires via **lifts** | ❌ **replaced** (biggest change) |
| `verify_speculative_batch` (frontier membership + MMR) | subset of **lift verification** (`stitch`+`extension`+`tree_proof`) inside `validate_block` | ⚠️ **partial reuse** |
| dropped `late_block_proofs` | unified POV **lifts** | ✅ **vindicated** |
| off-chain verification as a separate consumed subsystem | its own doc, unchanged direction | ✅ **vindicated** |
| relay per-pair / per-dest window (never ported) | per-**sender** `StreamsRoot` ring + virtual-window match | ❌ **new shape** (nothing to un-learn) |
| — (nothing) | **channels flow-control `Register`**, **event streams**, `StreamId` primitive | 🆕 **new subsystems** |

## Re-shape plan (before any integration build)

1. **`StreamId` primitive** — new: the frozen 8-byte canonical encoding + `Ord` + decode-rejects-reserved,
   with test vectors (consensus-critical). Base of everything.
2. **Streams in the outbox** — re-key `OutgoingMMRState` from `ParaId` to `StreamId`; one MMR per stream;
   `record_outbound_messages` per stream (channel/ack/broadcast).
3. **`StreamsRoot`** — replace `compute_provides`/`compute_cumulative_frontier_root` with a **keyed
   commitment tree** over `(StreamId, stream_root)` → one `StreamsRoot`; re-target the `frontier` module's
   tree+proof to it (this is where our head-commit code mostly moves).
4. **Requires via consumption record + lifts** — replace the inbox's requires-emission: the inherent writes
   a `ConsumptionRecord`; add the `validate_block`-side `stitch`/`build_requires_entry` synthesizer and the
   `RequiresLift`/`MMRExtensionProof`/`TreeInclusionProof` primitives. Retire `get_requires_commitments`.
5. **Primitives**: `ProvidesCommitment` (set) → `StreamsRoot` (hash); `UMPSignal::ProvidesRoots(set)` →
   `Provides(StreamsRoot)`; keep `RequiresCommitment`/`CommitmentSet` as `RequiresSet`.
6. **Relay** (when integrating): per-sender `RecentProvides` ring + virtual-window membership match.
7. **New subsystems** (later): channel flow-control `Register` (see below), event streams.
   - **Flow-control *type primitives* — ✅ landed** (`cumulus-primitives-spec-messaging::flow_control`):
     `SpecMsgKind` / `SpecMsgSignal` (channel-stream leaf payload), `Register` / `WindowGrant` (ack-stream
     payload), with frozen-core encoding vectors (`OpenChannel` = variant index 0; `Register` byte layout).
     `MessagePosition` gained `MaxEncodedLen` + `Default`. Re-exported via `lib.rs` + `cumulus-primitives-core`.
   - **Still deferred to the pallet phase** (logic, not wire types): `ChannelId`, `OutChannels`/`InChannels`
     storage, the `send()` sender interface (an *in-runtime* pallet trait, not an `sp_api` runtime API — see
     the delivery/pull note), window accounting, monotonic version-min enforcement, the `accept` extrinsic.
   - **Event streams**: not started.

## Flow control — `Ack`-stream `Register` replaces our relay-derived watermark

A notable shift, and its own (later) subsystem. In v0.5 a channel's receiver maintains a **`Register`** on
its `Ack { sender, .. }` stream — a **latest-wins, lossy blob** of `{ acceptance, credit, watermark, close }`,
read by the sender **out-of-band** (off-chain, never via the relay). It drives both pruning and
backpressure:

- **watermark** → **pruning**: the sender *retains everything above the confirmation watermark* and prunes
  below it (the watermark never passes the receiver's real consumption boundary — that is what makes
  pruning safe, and what guarantees lift/extension proofs remain serviceable for the unconsumed tail).
- **credit** (`WindowGrant { max_messages, max_bytes, max_message_size }`) → **backpressure**: the receiver
  paces the sender. It is **advisory, not enforced** (registers are lossy + read with delay; on an ordered
  stream the receiver can't reject without stalling). The *hard* bound is the `MaxMsgLen` consensus
  constant in the sender's STF.

Our foundation derives this from the **relay-matched `requires`** — the v0.4-flavored precursor v0.5
replaces:

| Our foundation (relay-derived) | v0.5 (out-of-band `Register`) |
|---|---|
| `apply_ack` maps an acked `requires` root → position | receiver's `Ack`-stream `Register` **watermark**, read off-chain |
| `ConsumedWatermark` / `PrunedUpTo` pruning | retain-above-watermark from the `Register` |
| `MaxBacklogPerDestination` / `BacklogCapReached` hard cap | **advisory `WindowGrant` credit** + the sender's own STF gate |
| `CommittedRootPosition` (root → position index for acks) | not needed — consumption depth is **not** derived from `requires`; the `Register` carries it |

Design's own words: *"Consumption depth is NOT derivable from `requires`; don't build acknowledgement or
pruning logic on it — the `Register` of Flow Control carries the consumption watermark instead."*

Scope note: this is a **later** step (a whole subsystem — the `Ack` stream, the `Register`, the
`accept_open_channel` extrinsic, credit gating), *not* part of the chunk-2 `StreamsRoot` re-key. And a
terminology guard: this `Ack` **stream** carries inter-parachain **confirmations** — unrelated to the
collator **acknowledgements** (`verify_acks`/`Confidence`) of Low-Latency v2. Collators *acknowledge
blocks*; parachains *confirm messages*.

## Resolved: relay ring vs. MMR-inclusion anchor

Settled with Robert on
[PR #12659](https://github.com/paritytech/polkadot-sdk/pull/12659#discussion_r3594251086)
(2026-07-16). **The relay ring stays; the MMR-inclusion anchor is rejected.**

The question: for the **inclusion tier**, does the relay need to carry/match the `StreamsRoot`
at all? The relay already commits every para head under `mmr.rootHash` (each MMR leaf's
`extra_data` = the `ParaHeadsRootProvider` binary-Merkle root over para heads, head bytes as the
leaf preimage). So a receiver could anchor the `StreamsRoot` **entirely in its own PVF** — MMR
inclusion → `para_heads` Merkle → head digest → the consumed stream (the last leg is the unchanged
requires-lift: per-stream `stitch` + `MMRExtensionProof` + `tree_proof`). Two MMRs meeting at the
`StreamsRoot`: **inclusion** on the relay MMR (its history subsumes the ring's window),
**extension** on the per-stream MMR. No relay-side changes.

Technically valid (Robert conceded it works for the inclusion tier), but **not adopted**, for three
reasons — the third is decisive:

1. **Doesn't cover the speculative / same-block / super-chain tier.** A source candidate included in
   the *same* relay block isn't in any header/MMR leaf the receiver can read, so the ring is needed
   there regardless. Using the ring for the inclusion tier too is **one mechanism**; the MMR anchor
   would be a **second code path serving a strict subset** of what the ring already covers.
2. **The ring is cheaper on PoV.** O(1) window match vs. composed per-source proofs (relay-MMR
   inclusion path + `para_heads` proof + head bytes) in *every* receiver block. "No relay changes"
   just moves — and grows — the cost in the receiver's PoV. Relay-side, the ring is trivial (one root
   per candidate, W×32 B backlog).
3. **`ParaHeadsRootProvider` is flawed today — the anchor is incorrect at scale.**
   `sorted_para_heads()` truncates to `MAX_PARA_HEADS = 1024` (`paras/mod.rs`, intermediate cap for
   the unbounded-registration DoS, [#4737](https://github.com/paritytech/polkadot-sdk/issues/4737)),
   so the root commits **at most 1024** heads — any para past that by id simply isn't in it and its
   `StreamsRoot` can't be anchored. Relying on it would mean solving #4737 first. The recent-provides
   ring is itself **the fix**: the truncation existed only for offchain XCMP, which speculative
   messaging replaces.

**POC-staging note (not a design change):** the concession that the inclusion tier *is* verifiable
receiver-side is still useful — the MMR-read path runs against an **unmodified relay** (no custom
relay runtime in zombienet), so it's a legitimate bootstrap for an early inclusion-tier e2e (the
`MAX_PARA_HEADS` cap is irrelevant at POC scale). But it's throwaway vs. the ring, so prefer building
toward the ring unless the custom-relay-runtime friction proves blocking.

## Requires-lift `validate_block` hook — model on LLv2 scheduling — ✅ IMPLEMENTED (lexnv/spec-msg-poc-mvp)

> **Status update:** this was originally a *plan* ("integration step that will call the primitives"). It is now
> **implemented** on `lexnv/spec-msg-poc-mvp` in a dedicated
> **`cumulus/pallets/parachain-system/src/validate_block/spec_messaging.rs`** (`SpecMessagingSignals::build` /
> `emit_into`), wired into `implementation.rs`. The model below held up: the impl faithfully follows the
> scheduling precedent. Line numbers refreshed to the current tree.

Step 4's synthesizer runs **inside `validate_block`, no new PVF entry point** — the design's "like
Low-Latency v2's scheduling checks" is literal, and that check exists as the sibling to copy the *shape* from:

- **`cumulus/pallets/parachain-system/src/validate_block/scheduling.rs`** — `check_scheduling`
  (`:143`, pure/deterministic, panics on failure) + `validate_v3_scheduling` (`:83`, feature gate). *(refs still
  current)*
- **`.../validate_block/implementation.rs`** — the wrapper decodes `ParachainBlockData`, calls
  `validate_v3_scheduling(..., block_data.scheduling_proof(), ...)` (`:146`), and folds the result
  into the returned `ValidationResult`.

The lift hook **composes two established wrapper patterns** (scheduling needed only the first; UMP
assembly is the second):

1. **POV-carried proof verified in-wrapper.** `SchedulingProof` rides in `ParachainBlockData::V2`;
   a `RequiresLift` rides in `ParachainBlockData` the same way (`lifts = block_data.lifts()`,
   `implementation.rs:175`), checked by `build_requires` / `stitch` (pure, `LiftError`) — the analogue of
   `check_scheduling`.
2. **`ValidationResult` assembled from pallet state after execution.** The wrapper filters the
   `UMP_SEPARATOR`/signals out of `upward_messages` post-execution (`implementation.rs:~316`) and injects the
   synthesized signals at the scheduling injection point (`scheduling_signals.emit(spec_msg_signals, …)`,
   `:399`). The **consumption record** is read the same way (`consumption_record()` runtime API, in-wasm per
   block, bundle order, `:337-338`), and the synthesized **`Requires(RequiresSet)`** signal is emitted right
   after `Provides` (`spec_messaging.rs::emit_into`, `:75-84`).

So the hook is a **hybrid**: read-record-after-execution (pattern 2) → verify POV lifts against it
(pattern 1) → append the `Requires` signal. **Actual entry point:**
`SpecMessagingSignals::build(&upward_message_signals, &consumption_records, lifts)` (`implementation.rs:393`) →
`build_requires(records, lifts)`, which **panics on `LiftError`** (`spec_messaging.rs:59-61`), invalidating the
candidate. Two bonuses from the precedent that carried over: scheduling handles **initial vs. resubmission**
(`scheduling.rs:~135-140, ~201`) — the "permanent block, transient candidate, regenerate against a newer context"
problem the lifts face on resubmission; and it established the panic-on-invalid-proof style.

**Borrowed the scaffolding, not the body**: `check_scheduling` verifies a relay-header chain; the lift verifies
MMR extension + keyed-trie inclusion (the `lift.rs` primitives, `rk-spec-msg-primitives`) via `build_requires`.
The integration that calls them is **done** in `validate_block/spec_messaging.rs`; both the primitives and the
wrapper hook are complete on the PoC branch.

## What NOT to build

- The **point-3-flat integration** (flat `CommitmentSet`, per-destination, inbox-emits-requires) — v0.5
  replaces all three axes. The migration plan's W2 (relay match) is now the per-sender `StreamsRoot` ring;
  W3/W4 change shape (consumption record + lifts, per-stream collation).

## Bottom line

The pivot is real but **smaller than a rewrite**: the MMR primitive, leaf hashing, the `CommitmentSet`
shape (as `RequiresSet`), the tree-commitment machinery (re-keyed), and the drop-LBP / thin-relay /
off-chain-verification directions all survive — several of our calls were vindicated. What changes: the
**addressing** (`StreamId`), the **provides** model (`StreamsRoot`), and the **requires** model
(consumption record + POV lifts in `validate_block`) — plus the new channels/events layer. Re-shape the
foundation to v0.5 first; then integrate.

## Requires-lift & window matching — how a block's consumption binds to a matchable `StreamsRoot`

Setting: a receiver is far behind a sender (a large backlog of pending messages), consumes only *part*
of it in a block, and the PVF must tie that consumption to a `StreamsRoot` the relay can match against
the sender's ring — even though the roots that were current *when the messages were sent* may have aged
out of the window.

### 1. The lift binds to the *current* root, never the old boundary root

The block consumes up to some position `P` **mid-backlog** (its boundary lands under no committed root's
entry). Naively you'd fear it must bind to the old root at `P`, which may have aged out. It does not.
The `RequiresLift` has two stages:

- **`extension: MMRExtensionProof`** — bridges the consumption endpoint (`P`) *forward across the whole
  unconsumed tail* to the sender's **current** stream root; verification *yields* that current root.
- **`tree_proof`** — walks from that current stream root to the sender's **current `StreamsRoot`**.

So the synthesized entry is `(source, current_StreamsRoot)` — the newest — even though the block only
*consumed* up to `P`. The extension proves "the messages I consumed are a genuine *prefix* of the stream
committed under the current root." The old boundary root never appears in the requires entry.

**Consequence — backlog is decoupled from the window:**

| Concern | Absorbed by |
|---|---|
| How far behind the receiver is (backlog / consumption lag) | the lift's **`extension`** (bridges the tail) |
| Authoring→inclusion pipeline gap (a few sender blocks) | the ring **window `W`** |

A huge backlog → a *bigger* extension proof, but it's an **O(log n)** ancestry proof (not O(tail)), and
it still targets the current, in-window root. `W` never has to be as deep as the backlog. (Design: *"W
covers only the authoring→inclusion pipeline; consumption lag is covered by lifts, not the window."*)

### 2. "Current" = the newest **included** root (ring head), per tier

The ring (`RecentProvides`) is populated **on enactment** — a `StreamsRoot` enters it only when the
sender's provides candidate is *included*. So the ring holds *included* roots only, and a `Requires`
entry can only match an included one. Therefore, per tier (`MessagesRequest.under` = *"the newest, or
newest **included**, per its tier policy"*):

- **Inclusion tier** (the backlog-catchup case): bind to the sender's **newest *included*** root — the
  **ring head** (equivalently the `StreamsRoot` in the sender's latest *included* head, via
  `para_heads`). *Not* the sender's locally-latest-but-unincluded root — that isn't in the ring, so it
  would not match.
- **Speculative tier**: bind to the newest root, possibly *not yet included*; matching then relies on the
  **virtual window** (same-block candidates' `Provides` extending the ring) / eventual settlement — the
  super-chain / live-comms case the design defers to its own doc.

### 3. So how is it "in the window by construction"?

Inclusion tier: the receiver reads the newest *included* root `S_k` (off the ring / `para_heads`) and
lifts to it. `S_k` is in the ring because it's included. The only remaining gap is **relay-side**:
between reading `S_k` and the *receiver's own* candidate being included, the sender may have had `m` more
roots enacted, advancing the ring head. `S_k` is still in the ring iff `m < W`. So `W` covers *how far
the ring head advances while the receiver's candidate is in flight* — a handful of blocks, not the
backlog. Resubmission re-reads the then-newest-included root (the block body is fixed; only the POV lift
refreshes), so a permanent block never goes stale.

Edge: the target ages out only if the **pipeline** (lift-regenerate → include) exceeds `W` sender blocks
— pathological, not caused by backlog size. Recourse is the design's rule: *freshness is the receiver's
job* — re-fetch and re-lift under a newer authenticated root.

### TL;DR

You never bind to the old root where consumption stopped. The lift's `extension` carries the consumed
*prefix* forward to the sender's **newest included** `StreamsRoot` (ring head, inclusion tier), which is
in the ring by construction; the `tree_proof` binds it; the window `W` only absorbs how far the ring head
moves before the receiver's own inclusion. **Backlog depth → a log-sized extension proof; window depth →
the relay pipeline. The two are deliberately independent.**

### The two dimensions — `extension` vs `tree_proof` (a common confusion)

Easy to point the two proofs the wrong way. The mistake is treating it as one "position line." There
are **two orthogonal dimensions**:

- **Horizontal — the sender's *stream MMR***. One append-only MMR for the channel; messages are leaves
  at positions `0, 1, 2, …`. With 100 backlogged messages → positions `0..99`, and the MMR root over all
  of them is `R` (the **current stream root**).
- **Vertical — the keyed *`StreamsRoot` tree***. At the sender's latest included block, `R` sits as one
  leaf (keyed by its `StreamId`) in the Patricia tree whose top is `S` (the **current `StreamsRoot`** =
  ring head).

(Per-sender-block `StreamsRoot`s are *vertical, one per block* — not positions. Don't conflate "position
20" (horizontal) with "the `StreamsRoot` at sender-block 20" (vertical).)

Scenario: receiver consumed the first 20 messages → frontier `F₂₀` (leaf_count 20); sender's stream is at
100.

```
          extension  (horizontal: bridge the UNCONSUMED tail, forward)
          20 ─────────────────────────────────────► 100
   pos: 0..............20(F₂₀)....................99   ← sender's stream MMR
                        │                          │
              receiver stopped here          current tip = stream root R
                                                   │
                                            tree_proof  (vertical: walk UP the keyed tree)
                                                   │
                                                   ▼
                                              StreamsRoot  S   (ring head)
```

- **`extension`**: from `F₂₀` (position 20, where the receiver *stopped*) **forward across the unconsumed
  tail (20 → 100)** to the current stream root `R`. Yields `R`. → **20 → 100**, *not* "start → 20".
- **`tree_proof`**: from `R` (one stream-root hash) **up the keyed tree** to `S`. Yields `S`. → **`R` →
  `S`** (a tree walk), *not* a position span "20 → 100".

And the "last-consumed anchor" is a *third* thing — the interval's `start`, used only to **chain
intervals across a bundle** (`stitch`/`advances`), never touched by `extension`:

| Piece | From → To | Dimension |
|---|---|---|
| `stitch` / `advances` | interval `start` → `end`, block-to-block | horizontal — *chaining* the record (bundles only) |
| `extension` | interval `end` (20) → current stream root `R` (100) | horizontal — *bridging the unconsumed tail* |
| `tree_proof` | stream root `R` → `StreamsRoot` `S` | **vertical** — up the keyed tree |

The trick in one line: you consumed only up to 20, but you **prove that 20-prefix forward into the
current committed stream `R`** (`extension`), then **up to the current `S`** (`tree_proof`) — so the
relay matches the newest (in-window) `S`, never the stale root at position 20.

### Where the `start` anchor lives — persistent frontier vs transient record

Persistent state and the per-block record are two different things:

- **Persistent runtime storage** = the receiver's **per-stream MMR frontier** (peaks + leaf_count) — the
  state it carries block-to-block. Design: *"Channel receiver tracks: per-stream MMR frontier (position
  and root derived from it)."*
- **`Interval { start, end }` (the consumption record)** = **transient, per-block** STF output — written
  to the `UpwardMessages` storage family, read via `consumption_record()`, then discarded. *Produced by
  the block*, not carried across blocks.

So the *record* is not persistent; the *frontier* is.

**Where `start` comes from (channels):** it's derived from the stored frontier, not free input:

- Block N reads the persistent frontier as of its parent, `F_prev` (root = the anchor), appends the
  newly-consumed messages, ending at `F_new`; writes `Interval { start: root(F_prev), end: F_new }`, and
  **updates the persistent frontier to `F_new`**.
- Because consumption *is* that single stored frontier, **`start == previous end` holds "by
  construction"** — the STF can't consume from anywhere else, so the channel chain check is free (the PVF
  doesn't re-verify `start` against storage; the STF guarantees it).

**Caveat — only for channels.** Register / event **reads** pick their read context freely (a fresher
root mid-bundle is the point), so `start` there is *the context the block read against*, **not** a
monotonic stored frontier. That's why read contexts *can* jump, and why the `stitch` chain + highwater
exist — to make a fabricated/backward context break the chain. Channels never gap; reads can.

**One frontier, two jobs:** the same persistent per-stream frontier is also what the *collator* reads to
set `MessagesRequest.start` (where to fetch from). So it anchors both the *fetch* and the consumption
record's *`start`* — while the `Interval` wrapping it stays transient.

### Feeding the frontier back to the sender — the out-of-band `Register` (not the relay)

After consuming to 20 the receiver's frontier becomes `leaf_count 20` (the next block's `start`). How
does the *sender* learn this — for pruning and backpressure? **Not through the relay.**

**Why the relay can't carry it.** The requires-lift binds to the sender's **current `StreamsRoot`** (the
`extension` bridges the tail 20 → 100), so the `Requires` entry `(source, S_current)` reveals *that*
consumption happened — **but not the depth**; position 20 never leaves the receiver. Design: *"Consumption
depth is NOT derivable from `requires`; don't build acknowledgement or pruning logic on it — the Register
of Flow Control carries the consumption watermark instead."*

**The mechanism — the receiver's `Ack`-stream `Register`.** A **latest-wins, lossy** blob of
`{ acceptance, credit, watermark, close }` on the receiver's `Ack { sender, … }` stream, read by the
sender **out-of-band** (off-chain — it fetches the register from the receiver, *not* via relay state):

- **`watermark` → pruning.** The receiver's *confirmed* (irreversible) consumption position. The sender
  **prunes below it, retains above.** It **never passes the receiver's real boundary** (`watermark ≤
  frontier = 20`, lagging by the reversibility margin) — which is what makes pruning safe *and* keeps the
  unconsumed tail's `extension`/lift proofs serviceable (the sender must not prune what the receiver still
  needs to bridge over).
- **`credit` (`WindowGrant`) → backpressure.** Advisory pacing; the *hard* bound is the sender's own
  `MaxMsgLen` STF gate.

**Two separate feedback paths:**

| What the sender learns | Path | Carries |
|---|---|---|
| "some consumption happened, bound to my `StreamsRoot`" | **relay** (`Requires` match) | the anti-fabrication floor — *not* depth |
| "receiver confirmed up to 20; here's your credit" | **out-of-band `Register`** | the **watermark** (pruning) + **credit** (backpressure) |

So the frontier is read three ways on the *receiver* side (STF continues from it; collator sets
`MessagesRequest.start` from it), and its *confirmed* value is republished as the `Register` watermark for
the *sender* to prune/pace against. This `Register` machinery is the **flow-control subsystem** (deferred
— "step 7", alongside event streams); the branch's primitives don't implement it yet.

### Why the lift is in the PVF (`validate_block` wrapper), not the runtime (STF)

The messaging inherent (STF) writes only the **`ConsumptionRecord`** (which streams, what interval — no
roots). The **lift** (`stitch`/`extension`/`tree_proof` → `Requires`) is synthesized in the
**`validate_block` wrapper**, not the runtime. Why:

The clean way in: the STF's output must be a **pure function of `(block body, parent state)`**, but a lift
binds to the sender's *current committed `StreamsRoot`* — **external, time-varying relay/sender state**.
So it can't live in the block.

**Three-layer split:**

| Layer | Verifies | Sees a `StreamsRoot`? | Where |
|---|---|---|---|
| **STF (runtime)** | payloads continue my frontier — **by recomputation** | No | in the block, metered weight |
| **PVF (`validate_block` wrapper)** | binds recorded endpoints to a *current committed* root via lifts → synthesizes `Requires` | Yes (computes it) | POV, validation budget |
| **Relay** | that `StreamsRoot` ∈ the sender's ring | Yes (matches it) | relay runtime |

The STF only does *recomputation* (does this payload sequence continue my stored frontier?) — needs **no
`StreamsRoot`**. Binding to a committed root is pushed out of the runtime for four reasons:

1. **Block must be a pure function of `(body, parent)`.** A lift targets the sender's *current* committed
   root — external state that changes as the sender produces blocks. If the STF computed it, the block
   would depend on "the sender's latest root right now" → not deterministic → not a *permanent* block. The
   POV lift keeps the block pure while the lift is regenerated per candidate.
2. **Resubmission.** A sealed (permanent) block may be resubmitted after the window slid; each attempt
   **regenerates the lift against the then-current root without changing the block** (regenerable by
   anyone from public data), so it "never goes stale." A lift baked into the STF would freeze the block to
   one root and make it unincludable once that root aged out.
3. **A tree proof in the STF verifies nothing.** The inherent data (payloads, any root) is *collator-
   chosen*; the STF has no relay-state access to authenticate a `StreamsRoot`, so checking `tree_proof`
   against one would "bind to a hash the inherent provider chose, verifying nothing." The *real* check —
   is this root actually committed — is the **relay's ring match**; the PVF only *synthesizes* the
   `Requires` the relay matches. (Design: *"the runtime never sees a `StreamsRoot`."*)
4. **Weight.** Proof verification runs in the **PVF validation budget**, not metered block weight.

**Trust split this creates:** the **record is authoritative** (STF output — consumption can't be hidden);
the **lifts are untrusted-but-verified** POV (the wrapper checks `stitch`/`extension`/`tree_proof` yield a
`StreamsRoot`; the relay checks that root is really in the ring). Runtime says *what* was consumed
(permanent, deterministic); wrapper says *which committed root it lifts to* (regenerable, POV); relay says
*that root is real* (ring match).

### The two "receiver" checks — off-chain fetch vs in-PVF requires (don't conflate)

The word "receiver check" is overloaded: **two different checks** run the *same* `extension` + `tree_proof`
machinery, which is why the design describes it once and why our `verify_messages_response` and
`build_requires_entry` share it — but they live in different places and end differently. Mixing them up is
an easy trap (the design's **"Off-Chain Verification"** section says *"receiver check: recompute the frontier
→ verify extension and tree proof → compare the resulting root against the digest payload"* — that is the
**fetch** check, *not* the receiver PVF).

| | **Fetch verification** | **Requires-synthesis** |
|---|---|---|
| "receiver" = | the **node receiving a fetched `MessagesResponse`** | the receiver parachain's **PVF** |
| where | off-chain, foreign/collator node (no chain state) | `validate_block` wrapper |
| code | `verify_messages_response` | `build_requires` |
| compares against | the sender's **header digest** (`SPMS_ENGINE_ID`) — a root it already trusts | **nothing on-chain** — it *emits* the root |
| authoritative match | (self-contained: root == digest) | the **relay ring** (`Provides` window), at inclusion |

So the design's "compare against the digest payload" belongs to the **fetch** path (a foreign node
authenticating fetched payloads against a header it trusts). The **receiver PVF** path does *not* compare
against a digest — it folds the POV lift to a `StreamsRoot`, emits `Requires`, and the **relay ring** is the
authoritative match.

Two things to keep straight about the PVF path:

- **It is not "no verification".** `build_requires` *does* verify the lift (`extension.verify` +
  `streams_root_from_proof`); that's load-bearing — the append-only `extension` means the lift can only bind
  to a `StreamsRoot` whose stream root **contains the consumed prefix**. What it does *not* do is compare the
  result against a known-good root (no relay state in-PVF); that comparison is the ring match. So: proof
  verification yes, compare-against-committed-root no.
- **The `StreamsRoot` comes from the lift, not from executing payloads.** Executing the payloads yields the
  *consumption interval* (what/how much was consumed). The sender's `StreamsRoot` is reconstructed by folding
  the **POV lift** (extension bridges the consumed endpoint → sender's current stream root; `tree_proof`
  folds that → `StreamsRoot`). The receiver never recomputes the sender's commitment from message execution.

Trust chain end-to-end: **extension** (consumed prefix ⊆ current stream root) + **tree_proof** (that root ∈
`StreamsRoot`), both verified in-PVF, then **ring match** (that `StreamsRoot` is one the sender actually
committed) at the relay. Drop the ring match and the whole thing is forgeable — the relay match is where the
real enforcement is.

### Multiple streams from one sender → the same `StreamsRoot` (one `Requires` entry per source)

The single-channel walk above generalises. If a receiver consumes from **several streams of the same
sender** in a block (e.g. two channels, or a channel + its ack register), each stream lifts
**independently**:

- stream `i`: `stitch` its intervals → `extension` → its own current **stream root `Rᵢ`** → `tree_proof`
  walks `Rᵢ` up to a `StreamsRoot`.

**All of a source's streams must yield the *same* `StreamsRoot` `S`.** That's not a coincidence — `S` is
the sender's *one* `StreamsRoot` at a block, committing **all** its streams' roots as leaves of the keyed
trie. So the different streams are different **leaves** (different `StreamId` keys) whose `tree_proof`s
climb to the **same top** `S`.

```
   R_channelB   R_ackB   R_channelC          ← per-stream roots (horizontal extensions land here)
        \         |         /
         \        |        /  tree_proof per stream (vertical, keyed by StreamId)
          \       |       /
           ►►►  StreamsRoot S  ◄◄◄            ← one root; the single Requires entry for this source
```

`build_requires_entry` enforces this: it requires all a source's streams to fold to one `S`
(`DivergentRoots` otherwise), and emits exactly **one** `Requires` entry `(source, S)` — hence *"one entry
per source, covering all its streams."* Horizontally each stream catches up to its own current root;
vertically they all prove into the sender's single committed `StreamsRoot`.

### Building the `StreamsRoot` each block — accumulated MMRs, snapshot tree, idle streams still count

A common question: if a stream got **no new message** this block, do we recompute its MMR root, and is it
"accumulated"? Separate the two layers — only one is an accumulator:

- **Per-stream MMR = the accumulator.** Append-only, kept as persistent peaks-only state
  (`Mmr::from_parts`/`into_parts`, O(log n)); it carries across blocks. An idle block appends nothing, so
  the stream's root is **byte-identical to last block** — you *read* the stored root, you don't recompute
  it. Only streams that got a message pay the O(log n) append.
- **`StreamsRoot` = a per-block snapshot**, the keyed Patricia-trie root over `(StreamId, current stream
  root)` for **all active streams**. It is **not** an MMR/accumulator — it's a fresh commitment each block
  to whatever the current stream roots are.

So "it's accumulated" is **yes for the per-stream MMR** (idle stream → root unchanged, zero work), but the
`StreamsRoot` itself is re-derived per block, not accumulated.

**Idle streams still appear as leaves.** An idle-but-active stream still contributes its (unchanged) leaf to
this block's `StreamsRoot` — it does *not* drop out when quiet. It must stay, because a receiver lifting its
consumption on that stream needs a `tree_proof` for it **against the current `StreamsRoot`**; if idle streams
vanished from the tree, the receiver couldn't prove membership. The trie spans all active streams every
block.

**Work per block is not a full rebuild:** idle streams → reuse the cached subtree (no hashing); `k` changed
streams → O(log n) append each + re-walk only their `k` trie paths (O(k·log S)); the rest is untouched. If
**no** stream changed at all (a block with zero outgoing messages), the whole `StreamsRoot` is identical to
the previous block's — just re-commit the same hash. (Our `streams_root(entries)` primitive is a *stateless*
rebuild-from-scratch for clarity/testing; the integrated outbox keeps persistent per-stream accumulators and
does the incremental update — see the outbox re-key note below.)

### Cross-destination non-forgery lives in the streams tree, not the leaf

`#12346` (written for v0.3) wanted the **message leaf** to bind the destination — `LEAF_TAG ++ … ++
destination ++ …` — so a leaf minted for dest A can't be replayed as a leaf for dest B. v0.5 makes the leaf
**payload-only** (`LEAF_TAG ++ leaf_version ++ payload`) and moves that binding **one layer up**, to the
`StreamsRoot` tree. This is worth writing down because "the leaf doesn't bind the destination" *sounds* like a
weakening — it isn't.

**Where the binding is instead:**
1. **Streams-tree leaf binds the `StreamId`.** Each stream's MMR root is a trie leaf hashed as
   `STREAMS_LEAF_TAG ++ key(StreamId) ++ stream_root`, and `key(StreamId)` contains the recipient (e.g.
   `Channel { recipient, .. }`). So the *whole stream* is tied to *who it's for* — once, at stream
   granularity, instead of per message.
2. **Keyed walk makes proofs non-transferable.** `streams_root_from_proof` / `verify_stream_membership` are
   driven by the caller's `StreamId`: each step's direction is checked against that key's bits, so a proof
   built for stream A folds to a different root under B's key and fails (test:
   `proof_is_not_transferable_between_streams`).
3. **Positional requires matching closes it in-PVF.** `build_requires_entry` pairs lifts positionally to the
   *trusted* consumption record's `StreamId`-sorted streams and walks `tree_proof` with the **record's** key;
   a mispaired lift (proof-for-A vs record-entry-for-B) can't verify.

**Why the forgery fails:** to make receiver B depend on A's messages, the lift must fold B's stream root to
the sender's committed `StreamsRoot` using `key(Channel{recipient: B})` — B's own STF fixes that key. A proof
built over A's stream, walked with B's key bits, folds to ≠ the committed root → `BadTreeProof`, rejected.
And there's no shared message pool to reinterpret: A's messages physically live in A's MMR, whose root sits
under A's `StreamId` leaf; B can only ever prove into B's leaf.

**Why up is better than in-leaf:** the tree *must* be `StreamId`-keyed anyway (so a receiver can prove *its*
stream), so the destination binding is already there for free — repeating it in the leaf is redundant. Binding
the whole stream is stronger and cheaper than per-message, and it keeps the leaf a pure payload — which is
exactly why v0.5 could drop `OutgoingMessage`'s `destination`/`position` fields (now structural: the
`StreamId` you prove under, and the MMR index).

*One-liner:* v0.5 ties each **stream** to its destination (via the `StreamId`-keyed tree leaf), not each
**message** — and the keyed proof walk + positional matching make that binding non-forgeable, so the leaf can
stay destination-free.

### `StreamId` fields are a stream *selector*, not a message counter

`Channel { recipient: ParaId, domain: u8, num: u16 }` — a common misread is that `num` increments per
message. It does **not**. A channel is identified by **(sender, recipient, domain, num)** (sender implicit in
its own outbox), fixed for the channel's lifetime:

- `recipient` — who it's addressed to.
- `domain: u8` — an application-level grouping (≤ 256).
- `num: u16` — a **channel index** so a sender can open **multiple independent parallel channels** to the
  same `(recipient, domain)` (`num = 0, 1, 2, …`, ≤ 65 536). Chosen once at open, then constant.

Each distinct `StreamId` is **one MMR** (one ordered stream) with its own ordering and its own `Ack{…, num}`
register. The **per-message counter is the MMR leaf index** — `MessagePosition(u64)` — which is *structural*,
not in the `StreamId`: message `i` is leaf `i` of that stream's MMR (which is exactly why a v0.5 leaf is
payload-only — source/stream/position are all implicit). Type sanity check: `num` is a `u16` (~65k max), far
too small to be a per-message position; positions are `u64`.

**Why `num` exists:** independent ordered lanes to the same recipient — one ordered channel has
head-of-line blocking, so `num` lets a sender run parallel streams (priority lanes / per-app flows) that are
ordered and flow-controlled *independently*, each `Channel{…, num: n}` pairing with its own `Ack{…, num: n}`.

*One-liner:* `(recipient, domain, num)` names *which ordered channel*; the **MMR leaf index** names *which
message within it*. `num` is a stream selector, not a sequence number.

### A channel's two halves live on *different* chains — `Channel{B}` vs `Ack{B}` are opposite directions

A subtle trap: on chain A, `Channel{B, 0}` and `Ack{B, 0}` share the `(recipient=B, num=0)` key and *look*
like the two halves of one bidirectional pipe. **They aren't** — they belong to two opposite-direction
channels, and the two halves of any *one* channel sit on *different* chains.

A channel is unidirectional. `Channel{recipient, num}` is the **payload** stream, written by the **sender**;
flow control rides a separate `Ack{recipient, num}` — the lossy **Register** (watermark/credit/close) —
written by the **receiver** and *addressed to the sender* (`recipient` = the sender, who reads it out-of-band
to prune + backpressure). So one channel **X→Y** splits across both endpoints:

```
Channel X→Y:  Channel{Y, n} @X  (X writes messages)   ↔   Ack{X, n} @Y  (Y writes the Register, read by X)
```

Apply to A's stream set:

```
Channel{B,0} @A  =  A's half of A→B   (A is SENDER — writes messages)
Ack{B,0}     @A  =  A's half of B→A   (A is RECEIVER — writes the Register back to B)

full pairings:  A→B : Channel{B,0}@A ↔ Ack{A,0}@B
                B→A : Ack{B,0}@A     ↔ Channel{A,0}@B
```

The **kind** (`Channel` vs `Ack`), not the key, selects the direction: `Channel{B}` on A is A→B; `Ack{B}` on
A is B→A. Matching `num`s are two independent channels each numbered 0 — coincidence, not pairing.

What the design note is saying:
- **"nothing of A's completes A's own channels"** — A's outbound channel A→B is complete on A's side with
  just `Channel{B,0}`; its ack half (`Ack{A,0}`) lives on **B**. Don't read `Channel{B,0}` + `Ack{B,0}` on A
  as a bidirectional pair — the ack for A's *send* is on the other chain.
- **`Ack{B,0}` exists only because B opened a channel toward A** — it's A's *receiver-side* obligation for a
  B→A stream, unrelated to A's A→B channel.
- **a chain that only ever sends to B has no Ack streams at all** — Ack streams are receiver-side; a pure
  producer owns only `Channel{…}` (+ any `Broadcast` feeds), zero `Ack`s. Acks appear only for channels
  pointed *at* you.

**Why:** your stream set is asymmetric by role — a `Channel` per flow you **send**, an `Ack` per flow you
**receive** — each half sitting with the chain that has the data to write it (sender has payloads, receiver
has the consumption watermark). So your `StreamsRoot` covers exactly the streams *you* author, and flow
control stays receiver-owned + read out-of-band (see [Flow control](#flow-control--ack-stream-register-replaces-our-relay-derived-watermark)),
not round-tripped through the relay.

### Delivery is receiver-pull, not sender-push — B fills its own inherent from A's outbox

`Channel{B}` on A being "A→B (you send)" describes *stream ownership/direction*, **not** a push. A never
writes to B's state; delivery is **pull-based, receiver-driven**:

1. `Channel{B}` on A is just A's **append-only outbox MMR** — A appends payloads and commits a `StreamsRoot`
   each block. That is all A does; it routes nothing to B.
2. **B's collator** (off-chain node, *not* B's runtime) fetches a contiguous range of A's `Channel{B}` from
   B's frontier via the fetch protocol (`MessagesRequest` → `MessagesResponse`), and **verifies** it
   (`verify_messages_response`) against a `StreamsRoot` of A's it has independently authenticated.
3. It **fills those verified payloads into B's block's messaging inherent**; B's STF consumes them (advances
   B's frontier), writes the `ConsumptionRecord`, and the PoV lift binds that consumption to A's
   `StreamsRoot`.

**The one nuance — "push" exists only at the networking layer.** The design's *live propagation* has A's
collators proactively push new `MessagesResponse`s to B's collators (the hot path), so B needn't poll. But
that's just **delivery speed** — B's collator still decides what enters B's inherent; fetch is the
catch-up/gap fallback. Networking = hybrid (push + pull); consensus/state = always receiver-pull (the
messages are in *B's* block because *B* put them there).

**Contrast with HRMP/XCMP:** that's relay-routed *push* (A → relay → B dequeues relay data). v0.5 spec-msg:
the **relay never sees payloads** — only `StreamsRoot`/`requires` commitments — and bytes flow
collator-to-collator off-chain, pulled into B's block.

**Pulling untrusted data is safe (fail-closed):** B's collator can fetch anything, but B's block emits
`Requires(A, StreamsRoot)` from what it consumed, and the relay accepts it **only if that `StreamsRoot` is
really in A's committed ring**. Garbage → no match → B's candidate rejected. The commitment match downstream
is the enforcement, not the fetch.

**Decoupling this buys:** A produces (append + commit) regardless of B; B consumes (pull + include + lift) at
its own pace (bounded only by A's retention); the `Ack{B}` **Register** — B's receiver-side stream, read by A
out-of-band — is the only back-channel (B's watermark → A's safe pruning), and it doesn't go through the relay
either.

*One-liner:* A appends to an outbox and commits a root; **B pulls the messages into its own block's inherent
and proves consumption against A's committed root** — no push into B's state, and the relay only checks the
commitments match.

## Primer: the relay chain's parachain pipeline (`disputes → availability → backing`)

Background for the relay-matching section below — the existing candidate lifecycle spec-msg hooks into.
The relay chain doesn't run parachain logic; it **coordinates validators** to check and carry candidates,
advancing everything through **one special transaction per relay block, the `ParachainsInherent`**
(processed on-chain in `paras_inherent::process_inherent_data`).

**A candidate's journey.** A parachain block + its PoV = a **candidate**. It travels a pipeline, one hop per
relay block, before its outputs are applied:

- **Backing** — a rotating **backing group** (validators assigned to that para) fetches the PoV, **runs the
  PVF**, and signs backing statements. A backable candidate is recorded onto a scheduled **core** as
  *pending availability* — this is **inclusion**: it's *in* a relay block but its outputs are **not applied
  yet**.
- **Availability** — the PoV is erasure-coded into per-validator chunks; each validator holding its chunk
  sets a bit in its **availability bitfield**. When **>2/3** attest, the candidate is *available* → the
  runtime **enacts** it: applies head data, processes UMP/HRMP, frees its core. **Enactment (a few blocks
  after inclusion) is when the parachain block truly counts.**
- **Disputes** — any validator can later dispute an included candidate; if it concludes *invalid*, the relay
  **reverts + freezes** (won't build parachains forward on the bad fork). The safety backstop. (Approval
  voting is a separate off-chain re-check layer, not part of this inherent.)

**Cores** = parallel lanes; each is *occupied* by its pending candidate from backing until it's available.

**Why the inherent processes them `disputes → availability → backing`** (backwards, finish→admit):
- **Disputes first** — validity trumps all; a concluded-invalid candidate frees its core and may freeze
  *before* any decision assuming the chain is sound (if frozen, include no parachains this block).
- **Availability before backing** — a core is occupied until its candidate becomes available and **vacates**;
  so process availability first to **free** cores, then backing to **fill** them. Fill-before-vacate has
  nowhere to go.

So each relay block advances every occupied core one notch: resolve disputes, graduate the now-available
candidates (enact them), admit fresh ones. On-chain that's: `process_checked_multi_dispute_data` /
`free_disputed` → `process_bitfields` / `update_pending_availability_and_get_freed_cores` → `enact_candidate`
→ `sanitize_backed_candidates` → `process_candidates`.

Spec-msg hangs two hooks: **① match at backing** (`sanitize`) and **② record at enactment**
(`enact_candidate`); dispute reverts need no hook — the node's state-revert rolls the window back with the
chain. Because ② is at *enactment* and ① is at *backing*, a receiver always depends on an already-enacted
(earlier) sender root — which is why the ring window only spans the short backing→availability gap. Details
next.

### Availability ≠ validity (a common misconception)

The **availability bitfield is not a validity vote.** Each validator's bit means *"I'm holding my
erasure-coded chunk of this candidate's data"* — a data-custody claim, set without running the PVF or judging
correctness. So "the candidate reached 2/3 → enacted" is right, but the 2/3 is **2/3 hold their chunk**, not
2/3 say it's valid.

- **Erasure coding**: the PoV (+ validation data) is split into `n` chunks (one per validator), recoverable
  from any **~1/3** (`f+1`, `n=3f+1`). **Availability is declared at >2/3** (`2f+1`) attesting they hold their
  chunk. The gap is the point: even if 1/3 withhold, the honest ≥1/3 remaining still reconstruct — so
  "available" = **provably recoverable under adversarial withholding**.
- **Validity lives elsewhere**: (1) **backing** — the backing group *does* run the PVF + sign validity, but
  it's a small group (weak); (2) **approval voting** — the *routine* re-check, run for **every** candidate
  after availability: randomly-assigned validators (not the backers) **recover the PoV from the chunks and
  re-run the PVF**; only *possible* because availability guaranteed the data exists; (3) **disputes** — the
  *escalation* when an approval checker (or anyone) finds an approved candidate invalid.

  Note the resolution mechanism: a dispute is **not** a succinct "proof of invalidity." A disputing validator
  recovers the PoV, **re-runs the PVF itself**, and casts a signed **invalidity vote**; the dispute concludes
  by **supermajority of votes** (independent re-execution + disagreement with the backers), and *that* triggers
  the revert + freeze. So the chain of re-checks is:

  ```
  backed (backers ran PVF) → available (data guaranteed recoverable)
        → approval checkers recover + re-run PVF   [routine, every candidate]
        → if invalid found → dispute → recover + re-run + vote → revert + freeze
  ```

So enactment at the 2/3 availability threshold is **optimistic**: validity is only backing-strength at that
instant; the strong guarantee arrives *afterward* via approval, with disputes as backstop. Polkadot's core
design: **enact fast on availability + backing, secure it later with approval + disputes**.

**The attack availability defends against (the crisp "why").** Without it, a colluding backing group could
**back an invalid candidate and then withhold the PoV** — no one else could obtain the data to disprove it, so
the invalid block would be *un-disputable*. Availability forces the data out into the open (erasure-distributed
across all validators) so it **can't be withheld** — the precondition that makes approval and disputes work at
all. That's why availability sits between backing and real validation.

**Why it matters for spec-msg:** `record_provides` (②) fires at *enactment* — the optimistic point — so a
`StreamsRoot` enters the window under backing-strength validity only. If approval/disputes later invalidate
that sender candidate, the relay **reverts** past its enactment, and the **node's state-revert** rolls
`RecentProvides` back with the chain (it's ordinary storage) — the reverted root is simply gone on the
canonical fork, together with any receiver that consumed it. No explicit eviction needed; that's the design's
bare ring.

## Relay-side matching (#12349) — full picture, as implemented on `rk-spec-msg-relay`

How speculative matching works on the relay and hooks into the existing candidate lifecycle. The relay
**never sees messages/streams/positions/proofs** — only two UMP signals in `CandidateCommitments.
upward_messages`: `Provides(StreamsRoot)` (sender's one committed root) and `Requires(RequiresSet)`
(receiver's `(source, StreamsRoot)` dependencies). Its whole job is a **windowed membership match**: admit a
candidate carrying `Requires` only if every required root is one that source actually committed recently.

### The one piece of relay state

```rust
// inclusion pallet — bare ring, per the v0.5 design (no block tag, no explicit eviction)
RecentProvides: StorageMap<ParaId /*source*/, BoundedVec<StreamsRoot, ConstU32<128>>>
```

One bounded ring **per sender**, newest-last, ≤ `MAX_PROVIDES_WINDOW_SIZE` (const 128 = the design's `W`; a
`const`, not a `HostConfiguration` field, for the MVP). A `Provides` is a single root over *all* the sender's
streams → no per-destination axis.

**Key-space split — relay is `ParaId`-keyed, parachain is `StreamId`-keyed.** The parachain folds its
`StreamId`-keyed per-stream MMRs into one `StreamsRoot` (the commitment tree), and only `(ParaId, StreamsRoot)`
crosses to the relay — so `RecentProvides` is keyed by **`ParaId`**, never `StreamId`. This keeps relay state
fixed at `O(paras × W × 32 B)`, independent of a sender's stream count (which parachains control). `StreamId`
is **committed but invisible**: bound *into* the root (leaf `H(STREAMS_LEAF_TAG ++ key(StreamId) ++
stream_root)`) so proofs can't be forged across streams, but never *revealed* to the relay — the binding is
checked below the hash, inside the receiver's PVF (see [cross-destination non-forgery](#) and [`num` is a
stream selector](#)).

### Two hooks + node-handled reverts

Every relay block runs `paras_inherent::process_inherent_data`:

```
process_inherent_data(block N):
  1. import disputes                       (dispute revert → node state-revert rolls RecentProvides back)
  2. if frozen { return }
  3. process bitfields / availability ─► ② enact_candidate → record_provides   [RECORD]
  4. sanitize_backed_candidates ──────► ① check_speculative_messaging   [MATCH / ADMIT]
  5. process_candidates (include survivors as pending-availability)
```

The two hooks sit at **opposite ends of a candidate's life**:

- **① Match — at inclusion** (`sanitize_backed_candidates` → `check_speculative_messaging`): the admission
  gate for newly-backed candidates. **Feature off** → drop any candidate carrying `Provides`/`Requires`
  (migration safety). **Feature on** → if it carries `Requires`, `inclusion::requires_satisfied(requires)`
  must find every `(source, StreamsRoot)` in that source's ring, else drop. Dropping breaks the para chain,
  so `filter_unchained_candidates` drops descendants too.
- **② Record — at enactment** (`inclusion::enact_candidate` → `record_provides`): when a candidate reaches
  *availability* (a later block than its inclusion), parse `ump_signals().provides()` and push the sender's
  `StreamsRoot` into `RecentProvides[sender]` (drop-oldest trim). A root enters the ring only when the sender
  is **available**, not merely backed — avoids seeding it with availability-timeouts.

**No explicit eviction on dispute-revert.** `RecentProvides` is ordinary runtime storage, so a dispute revert
rolls it back with the chain via the **node's state-revert** — the canonical fork branches from before the
reverted sender was enacted, so its `record_provides` write simply isn't there (exactly like every other
pallet's state). This is the v0.5 design's bare ring. *(Earlier this branch carried the #12349 block-tag +
`evict_provides_after` STF eviction; it was dropped — it's redundant with the node revert and actually inert:
the freezing block early-returns (no matching) and is itself reverted, and the freeze halts all inclusion
until the chain unfreezes on the already-clean state. It also introduced an unbounded full-map scan. Divergence
from #12349's "hook after dispute imports" is deliberate — flag to the design owner.)*

**Draft reply for #12349 (post later):**

> **On the mandated `evict_provides_after` hook — proposing we drop it in favor of the design's bare ring.**
>
> While implementing the relay side I built the block-tagged `ProvidesEntry { root, block }` +
> `evict_provides_after(revert_to)` hooked after dispute imports, as specified here. But on review it looks
> **redundant and effectively inert**, so I've reverted to the design's bare ring (`RecentProvides:
> StorageMap<ParaId, BoundedVec<StreamsRoot, W>>`, no eviction). Reasoning:
>
> 1. **The node's state-revert already handles it.** `RecentProvides` is ordinary runtime storage. A dispute
>    concluding invalid reverts the chain to before the disputed sender's inclusion, so the canonical fork
>    branches from before that sender was enacted — its `record_provides` write simply isn't on the canonical
>    chain, exactly like every other pallet's state on a revert.
> 2. **The STF eviction is inert anyway.** It runs in the freezing block `D`, which (a) early-returns after the
>    freeze check, so no candidate matching happens against the stale window; (b) is itself reverted
>    (`revert_to < D`), so its state is discarded; and (c) the freeze halts *all* parachain inclusion until the
>    chain unfreezes on the already-clean reverted state. So there's no point at which a stale `StreamsRoot`
>    could be matched — on any fork.
> 3. **It's inconsistent with how reverts are handled elsewhere.** `revert_and_freeze` only sets `Frozen` +
>    deposits the `Revert` log; it doesn't scrub `inclusion`'s own storage (e.g. `PendingAvailability`) — all
>    of that relies on the node revert. The explicit `evict_provides_after` would be the odd one out.
> 4. **It has real costs.** The eviction is an unbounded `RecentProvides::iter_keys()` full-map scan on every
>    freeze (O(#senders), unmetered), it compounds the "prune on offboard" leak (leaked keys inflate the scan
>    indefinitely), and it forces adding `frozen_block()` to the `DisputesHandler` trait.
>
> The design's "one small ring per sender" section already specifies a bare `BoundedVec<StreamsRoot>` with
> **no eviction** — so dropping the hook actually brings the impl *back in line with the design*; the block tag
> + eviction were the divergence.
>
> Am I missing a scenario where node-revert-alone is insufficient (e.g. a partial/non-freezing revert path)?
> If not, I'd suggest updating this issue to drop the `evict_provides_after` requirement.

### The two-candidate flow over time (sender A → receiver B)

```
relay block M:    A backed & INCLUDED (carries Provides(S_A))
relay block M+j:  A AVAILABLE → enact → record_provides(A, S_A)   ② → RecentProvides[A] ∋ S_A
   ... B fetches A's msgs off-chain, verifies vs S_A, includes them; B's PVF lifts to Requires{(A,S_A)} ...
relay block N:    B backed → sanitize → requires_satisfied({(A,S_A)})? S_A ∈ RecentProvides[A] ✓   ① ADMIT
relay block N+k:  B AVAILABLE → enact (B's consumption of A now canonical)
```

For the match at N, `S_A` must be recorded (A enacted) *before* N — B always depends on an **already-committed**
root. The window `W` only absorbs how far `RecentProvides[A]`'s head advances while B is in flight
(inclusion→settlement) — a handful of blocks, **not** B's backlog (that's the PVF lift, off-relay). If A is
later reverted, the node's state-revert drops `S_A` from the ring, and since B was included *after* A enacted
(`revert_to < N`), the same revert unwinds B too — which is exactly why **one-phase matching is safe** (no
enactment re-check needed).

### Trust boundary recap

| Layer | Who | Guarantees |
|---|---|---|
| PVF lift (receiver) | receiver's validators | consumption lifts to *some* `StreamsRoot` `S` (extension + tree_proof) |
| **Relay ring match** ① | **all relay validators** | **`S` is a root the sender actually committed** |
| Enactment ② | all relay validators | sender's `S` enters the ring when available |
| Dispute revert | node state-revert | a reverted sender's `S` leaves the ring with the chain (no STF hook) |

The relay contributes exactly the middle guarantee — it can't see whether messages are real, but it verifies
the receiver's declared dependency names a root its source genuinely committed, and drops it otherwise. Remove
the match and the scheme is forgeable. Two hooks bolted onto the existing dispute → availability → backing
pipeline (reverts handled by the node's state-revert); nothing else touched. (Feature-gated on `SpeculativeMessaging` bit 5; the feature-off drop in ① is
the consumer-side migration safety that prevents a `TooManyUMPSignals` dispute storm — see
[UMP compat](#).)

### Design-vs-impl delta — the branch is a deliberate **inclusion-tier subset**

Checked the branch against the design's authoritative relay section (design doc: *"one small ring per sender"*
+ *"Window Depth"* + *"Matching Against the Virtually Extended Window"*). Core semantics match (per-sender
ring, push-on-enactment, idle-pushes-nothing, receiver-agnostic all-or-nothing membership match). What
**diverges / is missing**:

- **Virtually-extended window — MISSING (but correctly deferred, not a near-term gap).** The design's
  *"one check"* is against `stored ∪ {Provides of all candidates in this relay block}` — *"candidates
  arriving together (live communication) are not a special case."* The MVP matches against the **stored ring
  only**, so a receiver matches a sender **already enacted** into the ring but **not a co-scheduled,
  same-relay-block sender**. Two-part cost:
  - *Matching* is **moderate** — restructure the per-candidate `sanitize` check into the design's batch
    `verify_requires(candidates, stored)` (build the virtual window from all candidates, then match each).
    Self-contained.
  - *Atomic enactment dependencies* are the **hard, load-bearing half** and inseparable: a match against a
    *transient, not-yet-enacted* `Provides` can only enact if that candidate enacts → all-or-nothing groups +
    cycle handling. This is **new relay machinery that doesn't exist** (today candidates enact independently
    per core), and the spec-msg design routes the cases that need it — mutual requires, co-arriving
    candidates, **Basti blocks / super chains** — to **super chains (future work, separate design)**.
    *Checked against the LLv2 design (PR #11413, `low-latency-v2-design.md`):* **LLv2 does NOT specify this
    enactment-group machinery.** LLv2 provides the *foundation* — relay-parent decoupling + scheduling
    parent, the **acknowledgement-confidence tiers** (its "you may ack only if the sending block is
    seen-acknowledged" rule — this is what powers the *speculative/optimistic tiers*), and PVF-side
    scheduling verification in `validate_block`. The relay-side enactment groups are **super-chains**
    territory, built *on* that foundation. (Earlier "LLv2 co-scheduling" was imprecise.)
  - **The inclusion tier doesn't need it:** normal authoring→inclusion is covered by the window's `W`-block
    slack; only *same-relay-block co-arrival* (live comms / super chains) requires the virtual extension.
  (Marker at `check_speculative_messaging`.)
- **Storage shape — now matches the design.** Bare `BoundedVec<StreamsRoot>` (no block tag), and **no
  explicit eviction**: a dispute revert is handled by the node's state-revert, per the design. *(The branch
  initially carried the #12349 block-tag + `evict_provides_after`; it was dropped — redundant with the node
  revert and actually inert (the freezing block early-returns and is itself reverted; the freeze halts all
  inclusion until the chain unfreezes on the clean state), and it introduced an unbounded full-map scan +
  compounded the offboarding leak + forced a `frozen_block()` trait break. Divergence from #12349's "hook
  after dispute imports" is deliberate — flag to the design owner.)*
- **`W` value — now matches the design.** Set to `const 128` (the design's `W`), sized to cover the pipeline
  *including elastic-scaling bursts* (~36 sender blocks/18 s at 500 ms), ~4 KB/sender. The design makes W
  governance-adjustable via a `HostConfiguration` field; the branch keeps it a `const` (MVP decision #3) — so
  the *value* is design-conformant, only the tunability is deferred.
- **Scan order (minor).** Design says *newest-first*; the branch's `iter().any()` is oldest-first. Negligible.

**Bottom line:** correct and safe as an *inclusion-tier* implementation, matching the MVP scope we chose. The
one substantive design feature it lacks — the virtually-extended window + atomic enactment dependencies — is
**not a near-term gap in this workstream**: its load-bearing half is new relay machinery the spec-msg design
routes to **super chains (future work)**, built on the LLv2 foundation (which provides the ack-confidence
tiers + scheduling verification, but *not* the enactment groups). The inclusion tier is fully served by the
window's `W`-block slack without it. Also deferred (smaller): the `provides_window` runtime API (collator
support), W tunability (const vs `HostConfiguration`), and the enactment re-check (speculative/optimistic-tier
hook).

## Pipeline-integration assessment — is the relay matching soundly wired in?

Re-checked the on-branch relay matching against the full inclusion pipeline (protocol-overview.md +
`paras_inherent`/`inclusion` code). **Verdict: correctly integrated for the relay's role, but not
"complete" — two intentional gaps.**

### Verified in code — the ordering is right

Inside `enter` (`paras_inherent::process_inherent_data`) the order is:

1. Disputes (`free_disputed`, `mod.rs:481`)
2. **Availability** → `update_pending_availability_and_get_freed_cores` (`:503`) → `enact_candidate`
   (`inclusion:624`) → **`record_provides`** (`inclusion:1201`)
3. **Backing sanitize** → `sanitize_backed_candidates` (`:613`) → `check_speculative_messaging` (`:1131`) →
   **`requires_satisfied`** (`:1212`)
4. `process_candidates` (`:629`)

So within one block, **provides are recorded (at availability) before requires are matched (at backing)**;
unsatisfied requires ⇒ `continue` (drop), and `filter_unchained_candidates` drops the para's descendants.
Fail-closed, confirmed.

### Where it's solid

- **Right stages.** Record at *availability/enact* → a sender's `Provides` is matchable only once it reaches
  the pipeline's **Included** state (not mere backing). Match at *backing sanitize* → a receiver whose deps
  aren't included is dropped before it's noted.
- **Tightest correct coupling.** Availability precedes backing in the same inherent, so a sender available in
  block N is matchable by a receiver backed in N — no artificial one-block lag, yet never matches a
  not-yet-available sender.
- **Dispute integrity, for free.** The receiver reads `RecentProvides` as chain state, so it can only match a
  sender whose write is an **ancestor** on the same fork (`R_send ⪯ R_recv`). Revert `R_send` ⇒ `R_recv`
  (a descendant) reverts too. Hence: bare ring needs no eviction, and **no requires re-check at the
  receiver's approval/inclusion** is needed — the fork structure guarantees a dependency can't outlive its
  sender. (See [the two-relay-block revert model](#why-the-bare-ring-needs-no-dispute-eviction--the-two-relay-block-revert-model).)

### Gap 1 — only the conservative *inclusion tier* is built (the speculative win is not)

Same-relay-block co-arrival (sender and receiver both *backed* in block N, receiver consuming the sender's
not-yet-available `Provides`) is **unsupported** — and that's exactly the low-latency point of "speculative"
messaging. `check_speculative_messaging`'s own doc says so: *"a `Requires` is satisfiable by a sender already
enacted into the ring, not by a co-arriving same-relay-block sender … omitted here."* So the branch implements
**inclusion-tier matching = the safe floor**; the speculative/optimistic tiers (the actual latency/throughput
benefit over plain HRMP) are still ⬜. The name oversells what's shipped.

### Gap 2 — the relay match is one half of a two-sided mechanism

`requires_satisfied` only checks `(source, StreamsRoot) ∈ RecentProvides[source]` — it confirms the sender
*committed* that root. It does **not** bind the bytes the receiver consumed to that root's contents; that's
the receiver-side **requires-lift in `validate_block` (PoV lift)**, still ⬜ on this branch. So the relay half
is a correct *necessary* check, but end-to-end soundness ("the receiver really consumed what the sender really
provided") isn't closed until the PoV-lift half lands.

### Non-blocking

- **Window sizing** `W = 128` vs. pipeline depth under elastic scaling / async backing — fine today; the
  parameter most likely to bite if the backing→availability gap grows. Sizing, not correctness.
- **Session boundaries** — `RecentProvides` correctly persists across sessions (only offboarding removes an
  entry), so no spurious cross-session match failures.

**One-liner:** the relay side is the *correct safe floor* — inclusion-tier matching, fail-closed, dispute-safe
by fork structure — but it is neither the speculative tier (Gap 1) nor the full mechanism (Gap 2, the PoV
lift). Treat it as "relay half of the inclusion tier, done," not "speculative messaging, integrated."

## Scope of #12349 (confirmed from the issue) + deliberate divergences

Fetched [#12349](https://github.com/paritytech/polkadot-sdk/issues/12349) (`gh issue view`) to settle the
scope question. **It is relay-chain-only.**

- **Title:** `spec-msg/relay: Implement relay chain changes`.
- **Body:** a provides window in the `inclusion` pallet, a match check in `sanitize_backed_candidates`, the
  feature-gate drop, and "tested in isolation." **No** `validate_block` / requires-lift / parachain emission
  / fetch. Feature enablement is a *separate* issue (#12347).
- (GitHub `assignees` is empty — not formally assigned, whatever the informal tasking.)

**⇒ The receiver-side PoV-lift is *not* in #12349.** It's parachain-layer work (cumulus `validate_block` +
`parachain-system` + cumulus spec-msg primitives), tracked as a **separate parachain-side issue**, sibling to
#12347/#12349 under a shared umbrella. #12349 = pieces 2 & 4 of the layer table; the lift is piece 3.
Recommendation: relay matching and the PoV-lift ship as **separate PRs on separate rollout gates** (para
`api_version` PVF-decodes-first, then the relay `SpeculativeMessaging` feature bit); don't merge parachain
PVF code into the relay-matching change. Whoever owns #12349 still owns the cross-half deploy-order
coordination.

**The shipped code deliberately diverges from the issue's literal design** — the issue text is now stale on
these three points (improvements, not omissions; note them when closing #12349):

| Issue proposes | Shipped on `rk-spec-msg-relay` | Why |
| --- | --- | --- |
| `LatestProvides` keyed by **`(source, destination)`** | `RecentProvides` keyed by **`ParaId` (source only)** | the receiver names the source in `RequiresSet`; destination isn't needed for the match |
| `ProvidesEntry { root, block }` (block-tagged) | bare **`StreamsRoot`** (no block tag) | bare ring; ordering is ring position |
| `fn evict_provides_after(revert_to)` hooked after dispute imports | **no explicit eviction** | node state-revert unwinds reverted-block writes for free (see the two-relay-block model) |

> The third row is the origin of the *"what is `evict_provides_after` doing?"* question — it's the issue's
> proposed hook, which we consciously **did not** implement and confirmed doesn't exist in the tree.

## Integration notes (for when the pallet work starts)

Two concrete reminders for the deferred integration, kept here alongside the design study.

### Outbox storage — re-key `ParaId → StreamId`, and re-shape

Re-key the *whole* per-destination outbox storage family from `ParaId` to `StreamId` (not just
`OutboundMessages` — also the per-stream MMR state and MMR node store). Input stays `(ParaId dest,
payload)` from `XcmpMessageSource::take_outbound_messages`; the pallet maps `dest → Channel { recipient:
dest, domain: 0, num: 0 }`.

It's a **re-shape, not just a rename** — the design splits what the legacy `OutgoingMessages<ParaId, u64,
Vec<u8>>` conflated into one map:

- `OutboundMessages<StreamId, …>` — a **transient per-block accumulator** (appended to the per-stream
  frontiers at the *next* block's init, then cleared).
- the **persistent per-stream MMR frontier** — the committed state carried block-to-block.
- a **retained-payload store** above the flow-control watermark — for serving `MessagesResponse`.

Why `StreamId` (not `ParaId`): it's what lets a sender run multiple streams to one recipient (channel +
ack register + broadcasts + domains); `ParaId` keying structurally can't. The full re-key was deferred
during the commitment-layer swap because it was isomorphic in the current one-channel-per-recipient model.

### Requires-lift hook — in `validate_block/implementation.rs`, post-execution

Model it on the LLv2 scheduling check (`validate_block/scheduling.rs` + its call site). It's a **hybrid**
of validate_block's two patterns: *read-pallet-state-after-execution* (like `UpwardMessages`/
`HrmpWatermark`, ~lines 305–332) **plus** *verify-PoV-proof* (like scheduling).

Placement: at the `ValidationResult`-assembly stage, **after** executing the block/bundle (not the
pre-execution scheduling stage — the `ConsumptionRecord` is STF *output*). Steps:

1. Bundle of N blocks: after **each** block's execution, read its transient `consumption_record()`
   **in-wasm** (call the API impl / read the pallet storage, like `ValidationResult` reads
   `crate::UpwardMessages::get()`), accumulate `[ConsumptionRecord; N]`.
2. Decode the **PoV-carried** `RequiresLift`s from `ParachainBlockData` (add a lifts field the way V2
   carries `scheduling_proof`; lifts are never in the block body).
3. Run `build_requires(records, lifts)` **once** over all records + lifts (it `stitch`es intervals across
   the bundle → per-source lift → one `Requires` entry per source).
4. On success, append the `Requires(RequiresSet)` to `upward_messages` at the **same injection point**
   scheduling signals use (~lines 366–376) — producing the set isn't enough; it must enter the UMP
   signals so the relay can match it.
5. On `LiftError`, **fail the candidate** (panic), like `validate_v3_scheduling` fails a bad proof.

(Why the PVF wrapper, not the STF: covered above — a lift binds to the sender's *current committed*
`StreamsRoot`, external time-varying state, so it can't be a pure function of `(body, parent)`; the block
stays deterministic + resubmittable while the lift is regenerated per candidate from public data.)

### PoV format change (`ParachainBlockData` + lifts) — compatibility & rollout

Concern: adding `RequiresLift`s to `ParachainBlockData` changes the PoV format — how do upgraded and
legacy nodes coexist?

**Key: `ParachainBlockData` is decoded only by the parachain's *own* PVF** (its registered
`validation_code`) — **not** by the relay chain (which treats the PoV as opaque: availability + pass to
PVF; it only reads the descriptor + commitments + UMP signals) nor by other parachains. So it's an
internal **collator ↔ own-runtime** contract, a much narrower surface than it first looks.

`ParachainBlockData` is already a **versioned enum** (`V1`, `V2` added `scheduling_proof: Option<…>`);
lifts go in additively — old decoders reject the new variant, new decoders accept both. So it reduces to
**upgrade ordering**, via two independent gates:

- **Gate 1 — parachain runtime API version** (`SPECULATIVE_API_VERSION`'s role): governs the **PoV
  format**. The collator produces lifts only when its runtime exposes the speculative APIs
  (`api_version::<Speculative…Api>()`), so it **never produces a PoV its own PVF can't decode**. Standard
  cumulus pattern (V3 scheduling did this). *This is why that const comes back at integration.*
- **Gate 2 — relay `SpeculativeMessaging` node-feature bit**: governs the **UMP signals**
  (`Provides`/`Requires`). **Verified against the legacy `ron/speculative-messaging-poc` branch, this is a
  consumer-side (relay/validator) gate, NOT an emitter-side check** — a correction to the intuitive "the
  collator checks the bit before emitting":
  - *Emission (parachain side)* is gated by the **parachain runtime opting in** — `parachain-system::
    send_ump_signals` pushes `Provides`/`Requires` only when `T::speculative_extension()` returns
    `Some(V4{…})`. It never consults `FeatureIndex::SpeculativeMessaging`.
  - *Acceptance (relay side)* is where the bit gates, in `paras_inherent::sanitize_backed_candidates`
    (`speculative_enabled = FeatureIndex::SpeculativeMessaging.is_set(node_features)`): **feature OFF →
    drop any candidate carrying `Provides`/`Requires`** (explicit migration-safety check, ~line 1049 —
    else it would silently populate the provides window); **feature ON → additionally enforce
    `speculative_requires_satisfied`** (~line 1189).
  - The real invariant is "**the relay refuses to give these signals meaning until the bit is on, and the
    bit flips only after every validator can decode them**". Old validators can't even decode
    `UMPSignal` variant 2/3 (→ `UmpSignalDecode`) and cap at 2 signals (→ `TooManyUMPSignals`), so they'd
    reject such a candidate regardless — but the bit is never enabled while old validators exist. **When
    wiring emission onto the primitives base, the load-bearing thing to port is that `paras_inherent`
    drop-while-disabled check — not an emitter-side feature-bit test.**

  On the current primitives branch `SpeculativeMessaging = 5` is only a `FeatureIndex` enum entry
  (`v9/mod.rs`), referenced nowhere, and `Provides`/`Requires` have no emission path — so the gate is an
  unwired placeholder here; the above is what to port at integration.

  Aside — `MAX_UMP_SIGNALS = 4`: `ump_signals()` is itself a consensus function, and master hardcodes
  "exactly 2 signals" (2 variants). The branch generalizes that to `MAX_UMP_SIGNALS = 4` for the 4
  variants. The value is **required, not arbitrary** — it must equal the variant count, or a legit
  4-signal candidate is wrongly rejected as `TooManyUMPSignals`. It's the same Gate-2 rollout that keeps
  this consensus change safe under uneven deployment.

**Upgrade order (PVF-decodes-first):**

1. Ship runtime with speculative APIs + new `ParachainBlockData` decode (PVF can *read* lifts) — old
   collators still produce old format, nothing breaks.
2. Ship collators that produce lifts, **gated on runtime api_version** (Gate 1).
3. Deploy relay node support to ⅔+, then enable `SpeculativeMessaging` (Gate 2) — collators now also
   emit the UMP signals.

**Legacy coexistence:**

| "Legacy node" | Interaction | Coexistence |
|---|---|---|
| old collator of the *same* para | produces old-format PoV | upgraded PVF (backward-compat versioning) validates it fine; new collators only produce lifts once the PVF supports them |
| old relay validator | runs the PVF, *never decodes the PoV*; only judges UMP signals | Gate 2 (consumer-side) — a candidate carrying the signals is *dropped* by an upgraded relay while the bit is off, and an old validator can't decode the signals anyway; the bit is only enabled once all validators understand them |
| other parachain's node | never touches this para's PoV | irrelevant — the format is parachain-internal |

At every step an un-upgraded actor is either not involved (relay/other paras don't parse the PoV) or
protected by a gate. No legacy node ever has to understand the new `RequiresLift` bytes — only the
parachain's own PVF does, and it is upgraded *before* any collator produces them.

## Extension-proof node size — 40 B (ours) vs 32 B (design's "Proof Size Considerations")

The design's proof-size section counts extension proofs in **hashes (32 B)**; our
`MMRExtensionProof.connecting_nodes: Vec<(u64, Hash)>` carries a **position per node → 40 B**, so measured
extensions run ~25% above the doc (≈240 B extra on a 30-node day-scale lift). This is an **optimization gap,
not a design conflict** — worth an explicit reconciliation.

- **Why the positions are there:** we build/verify via mmr-lib (`polkadot-ckb-merkle-mountain-range`)
  verbatim — `gen_ancestry_proof(...).proof_items()` emits `(u64 position, Hash)` and
  `NodeMerkleProof::calculate_root` consumes the same. The position is mmr-lib's structural glue (height /
  left-right sibling).
- **Why the design can count hashes only:** the MMR is deterministic, so the connecting-node **positions are
  a pure function of `prev_size` (frontier `leaf_count`) + `new_mmr_size`** — both known at verify time. The
  positions are *derivable, not information*; the hash list + two sizes suffice.
- **Why we didn't strip them:** stripping means a compact codec that **reconstructs the ordered positions at
  verify time**, byte/order-exact to mmr-lib's own selection — consensus-critical logic mirroring an external
  library's internals, easy to get subtly wrong. For the primitives stage, carrying positions is the simple,
  provably-correct choice (mmr-lib produces them, mmr-lib consumes them). Cost ~8 B/node; doesn't threaten
  the budget (day-scale test: ~3,750 touched streams still fit `MAX_POV_SIZE`).
- **Reconcile:** (1) *now* — have the doc count 40 B/node so estimates match the shipping format (zero code
  risk); (2) *post-MVP* — add the position-stripping codec behind a **differential test** against mmr-lib's
  own proof output, once the extension format is otherwise frozen. Prefer (1) now; (2) is a size optimization,
  not worth the reconstruction risk at this stage. (The `pov_cost_report` test documents the 40 B/node figure.)

**Draft comment for eskimor (PR #12659 / the design doc):**

> **Proof Size Considerations — extension proof is 40 B/node, not 32 B.** The section counts MMR extension
> (ancestry) proofs in hashes (32 B), but the shipping `MMRExtensionProof.connecting_nodes` is
> `Vec<(u64 position, Hash)>` = 40 B/node, because it's built and verified straight through
> `polkadot-ckb-merkle-mountain-range` (`gen_ancestry_proof` / `NodeMerkleProof::calculate_root`), whose proof
> items are position-tagged. So real extensions are ~25% larger than the doc (e.g. the day-scale ~30-node case
> ≈ 1.2 KB, not ~960 B). The positions are redundant — deterministically derivable from `prev_size` +
> `new_mmr_size` — so they *could* be stripped, but that needs a compact codec that reconstructs mmr-lib's
> exact node ordering at verify time (consensus-critical). Proposal: **count 40 B/node in the doc now**, and
> treat position-stripping as a post-MVP optimization behind a differential test against mmr-lib. Net PoV
> impact is small (a day-scale lift is ~2.8 KB incl. one advance proof; ~3,750 such touched streams still fit
> `MAX_POV_SIZE`), so this is about estimate accuracy, not a budget risk.

## Threat: "Acknowledgement Without Verification" — why inclusion-failure is *not* the slash trigger

Reviewing the threat entry:

> **Attack**: Collator acknowledges a block without verifying message availability.
> **Mitigation**: If the block later fails inclusion due to unmet requires, the acknowledging collator
> violated Low-Latency v2 rules and is slashable.

**Verdict: the direction (ack accountability via LLv2) is right, but the mitigation as phrased is
unsound — and it's not how [`offchain-block-verification-design.md`](offchain-block-verification-design.md)
actually works.** Checked against that doc's Security Analysis (2026-07; branch `rk-speculative-message-0.5`).

**Separate the two guarantees the phrasing blurs:**
- **Safety = fail-closed inclusion, not slashing.** If a receiver consumed speculatively and its `requires`
  aren't matched in the sender's ring at inclusion, its candidate is **rejected** — the consumption never
  becomes canonical. A false ack can't commit bad state; it can only make the receiver waste work. The doc
  is explicit: verifying unincluded state transitions is a **non-goal**; "inclusion remains the enforcement
  floor," speculative/optimistic are "faster but less certain."
- **Slashing = a separate incentive layer**, and it triggers on an **attributable offense pair**, never on
  inclusion outcome.

**Two conflations in the mitigation:**
1. *Availability ≠ unmet requires.* The attack is about message **availability**; the mitigation fires on
   **unmet requires at inclusion**. Those differ: unmet requires is usually **timing** — the sender's
   `StreamsRoot` aged out of window `W`, or the sender block isn't included yet — with the block perfectly
   available. Honest acks + unmet requires can coexist.
2. *Inclusion-failure is a normal, benign event, not a fraud proof.* In spec-msg a receiver candidate
   failing because a dependency aged out is expected — the remedy is "re-fetch and re-lift under a newer
   root." Slashing on it would punish honest collators for timing they don't control, and it isolates no
   actor and carries no verifiable artifact.

**How the design actually attributes ack faults (and it matches the critique):**
- Acknowledgements are **consensus commitments from slot authors**, measured by consecutive-slot-author
  coverage; a tip ack is **transitive over ancestry** (staking on the whole verified chain).
- Slashing is **entirely LLv2's** and is an **equivocation-style offense pair**: "abandoning an acked block
  requires a *subsequent slot author* to build around it — if that author acked, the ack plus their
  conflicting block form a slashable offense pair." Attributable, provable — **not** "a downstream block
  failed inclusion."
- The doc **deliberately leaves the residual unslashed**: "all acked authors staying passive — is
  deliberately unslashed (it would punish honest outages) and is exactly why confidence below `Max` is not a
  guarantee." So lazy/passive acking is *by design* not slashable — the exact opposite of the reviewed
  mitigation — and the safety net is that **confidence < Max is explicitly not a guarantee** (consume at
  your own risk), backstopped by fail-closed inclusion.

**Corrected framing:** safety is fail-closed (unmet requires → candidate rejected; the speculator bears the
wasted-work cost). Slashing triggers only on an LLv2 **offense pair** (ack + a conflicting build by a slot
author who also acked), i.e. abandoning/equivocating on an acked block — not on availability-lying and not
on inclusion failure. Availability-lying with no conflicting-build artifact is *deliberately* left to the
"confidence < Max isn't a guarantee" residual, because an on-chain **unavailability** proof for a
not-yet-included block doesn't exist. (Invalidity is provable via dispute and *is* attributable; unavailability isn't.)

*One-liner:* inclusion-failure is the *safety* mechanism (fail-closed), not the *slash* trigger; the slash
trigger is an attributable equivocation offense pair, and the design intentionally accepts an unslashed
residual of lazy acking (hence "confidence < `Max` is not a guarantee").

## Code-review replies

### [HIGH-2] "UMP Signal Trailing Garbage Bypass (State Bloat Vector)" — reclassify to Low, not fixed here

**Finding:** `CandidateUMPSignals::try_decode_signal` calls `UMPSignal::decode(buffer)` and never checks the
buffer was fully consumed, so a signal message shaped `[valid signal ‖ trailing garbage]` decodes fine; and
because `check_upward_messages` runs `skip_ump_signals` before applying `max_upward_message_size` /
`max_upward_message_num_per_candidate`, those trailing bytes escape the per-message size caps.

**Reply (draft):**

> The decode-doesn't-enforce-full-consumption mechanism is accurate, but the impact and severity don't hold
> up, and this isn't the right branch to change it.
>
> **Not "massive state bloat."** `UpwardMessages` is `BoundedVec<Vec<u8>, ConstU32<16384>>` — the count is
> capped; each message's bytes are bounded only by the *relay block length*, since the candidate receipt
> rides in `paras_inherent` data (not the PoV). So the payload is (a) bounded by block size, not unbounded,
> (b) paid for by the attacker with their own candidate's block space, and (c) **transient**:
> `PendingAvailability` is cleared on inclusion or timeout, and at `enact_candidate` the raw
> `upward_messages` are dropped (real messages queued via `skip_ump_signals`, signals and any trailing
> bytes discarded). Nothing persists past the availability window — there's no amplification and no
> permanent on-chain bloat, just an attacker briefly occupying their own core.
>
> **Pre-existing and accepted.** The identical non-consumption behavior has existed on the live
> `SelectCore` / `ApprovedPeer` signal path since those shipped (it's unchanged on `master`) and has never
> been treated as a vulnerability — consistent with it being an accepted property rather than a bug. Spec
> messaging only adds `Provides` / `Requires` variants that ride the same path.
>
> **Wrong place to fix.** Enforcing full consumption tightens the **shared** signal-decode path, changing
> candidate-acceptance semantics for `SelectCore` / `ApprovedPeer` too. Diverging from `master`'s validation
> rule on an established consensus path, in a feature branch, for a low-severity strictness gain, is the
> wrong trade. If it's worth doing it's a defense-in-depth hardening that belongs **upstream**, applied
> uniformly to all signal variants — not carried here.
>
> Reclassifying to **Low / won't-fix-in-this-branch**; happy to raise the upstream hardening separately.

*Status:* prototyped the `remaining_len()`-based fix + a `ump_signals_rejects_trailing_bytes_in_signal`
regression test on `rk-spec-msg-relay`, then **reverted** both after this analysis — the branch stays aligned
with `master` on the shared signal-decode path.

### [INFO] "Feature Gate Ignores Enactment Phase" — agree, no functional change

**Observation:** the `speculative_enabled` check runs at sanitize, not at enactment. If the feature is
disabled *between* sanitize and enactment, a candidate carrying `Provides` that's already pending
availability is still enacted and recorded into `RecentProvides`.

**Assessment:** benign, and the ungated record is intentional:
- The write is **bounded** (drop-oldest window) and **metered** — `enact_candidate` always exercises the
  record path, so the cost is in the weight regardless of feature state.
- It's **never queried while off**: `Requires`-carrying candidates are rejected at sanitize, so nothing
  reads the entry.
- It stays **semantically valid** if the feature is re-enabled — the sender genuinely committed that
  `StreamsRoot`, so a later match isn't wrong.

Adding an enactment-time feature re-check would cost a `node_features` read per provides-candidate to
suppress a harmless bounded write — net negative, and it contradicts the "recording needs no feature gate"
design. **No code change.**

*Doc-only follow-up (not yet applied to code):* the record-site comment in `inclusion::enact_candidate`
overclaims that a provides candidate "is only ever included with the feature enabled" — the sanitize→enact
race is the counterexample. Tighter wording to adopt if/when the file is next touched:

> A candidate carrying `provides` reaches enactment only after passing sanitize with the feature enabled;
> if the feature is disabled between sanitize and enactment the record still runs, but the entry is bounded,
> metered in `enact_candidate`, and never queried while off (requires-carrying candidates are rejected at
> sanitize) — so recording needs no separate feature gate.

## Why the bare ring needs no dispute eviction — the two-relay-block revert model

The bare-ring design (no explicit `RecentProvides` eviction on dispute) rests on the fact that the window
write is *relay-chain state written at inclusion*, so it lives and dies with the relay fork. To see why the
"guaranteed revert unwinds it" claim holds, separate the **two relay blocks** in a candidate's life:

1. **Relay parent (the context).** The candidate's descriptor pins a `relay_parent` — the relay block whose
   state the collator built the PoV against. This is where the parachain block is "generated from."
2. **Inclusion block (the effect).** The candidate is backed and then **enacted** in a *later* relay block
   (a descendant of the relay parent). `RecentProvides` is written **here**, in `enact_candidate` — not at
   the relay parent.

Forks are all-or-nothing along ancestry (a canonical block can't have a non-canonical ancestor), so:

- Revert the **relay parent** → every descendant, including the inclusion block, is reverted → the
  `RecentProvides` write goes with it.
- Revert **only the inclusion block** (the typical dispute case: the dispute concludes *against this
  candidate*, and the relay chain reverts to *before* the block that included it) → the relay parent may
  survive, but the inclusion block and its write are abandoned.

Either way the write is unwound, because it's relay-chain state governed by relay-chain fork choice. A manual
`RecentProvides::remove(...)` would be compensating for a write that *never becomes canonical* anyway — hence
inert (the freezing block early-returns and is itself on the reverted branch). Contrast **offboarding**
(commit `e1e4c4360ad`): that's a normal *canonical* event with no revert, so it *does* need an explicit
`remove`.

*"Reverted" = the relay-chain state recording the inclusion leaves the canonical chain.* The PoV/candidate as
a data blob still exists off-chain and a merely-unlucky (valid) candidate could be re-included on another
fork; a disputed-**invalid** one won't be. Spec-msg doesn't care — the old entry from the abandoned branch is
gone regardless.

### When is a parachain block (and its asset XCM) *really* final?

Only when the **inclusion relay block is GRANDPA-finalized**. Stages of a candidate:

- **Backed** — in a relay block, unapproved, revertible.
- **Included / available** — state effects applied (`enact_candidate`, `RecentProvides` write), but still on
  an *unfinalized* relay block; a dispute concluding invalid can still revert it.
- **Approved** (approval-checking) — strong, but finality is the hard guarantee.
- **Finalized** — the inclusion relay block is GRANDPA-finalized (finalizing any descendant finalizes it
  too). Now irreversible: no dispute reverts a finalized block.

So the parachain block — and the asset XCM committed in it — is irreversibly valid only once its inclusion
relay block is GRANDPA-finalized (why bridges/exchanges wait for **relay finality**, not just inclusion).
Caveat: relay finality settles the *emitting* block; if the XCM crosses to another chain (UMP/HRMP/bridge),
the destination's processing is a further step with its own inclusion + finality.

### REVISION — "fully redundant" was too strong: the freeze + `force_unfreeze` case *does* need eviction

Prompted by lexnv's [#12349 reply](https://github.com/paritytech/polkadot-sdk/issues/12349#issuecomment-5032842662).
The earlier "eviction is fully redundant / inert" claim (above, and in the drafted #12349 comment) holds for the
**fork-revert** path but is **wrong for one case**: a bad candidate that is **finalized** can't be reverted, so
the dispute **freezes** the chain; governance `force_unfreeze`s → **no rollback** → the invalid candidate's
provides root **stays in `RecentProvides`** → after unfreeze a `requires` can match it → consume an invalid
sender's messages. Our "governance can just `killPrefix` it" counter was too glib — it relies on governance
*remembering* to clean `RecentProvides` during `force_unfreeze`, which the standard recovery doesn't do. So
**automatic eviction for the freeze path is genuinely warranted.** Concede lexnv's point; the fork-revert half
of the argument still stands.

**But block-tagging every entry (lexnv's `evict_after_revert`) is the wrong fix — prefer `clear-on-freeze`:**

- lexnv's surgical `evict_after_revert(revert_to)` pays a **permanent block-tag on every ring entry, forever**,
  exercised only in this apocalyptic case — and it depends on `Frozen`'s `revert_to` precisely bracketing the
  invalid root (if `revert_to ≥ M`, the finalized invalid candidate's height, it won't even evict that root).
- **Lighter + more robust:** keep the **bare ring** and just `RecentProvides::clear()` at the freeze transition
  (same hook). A freeze only happens in the catastrophic can't-revert case, so nuking the whole ring is fine —
  it self-heals as senders re-provide over the next `W` blocks, and nothing is included while frozen. It handles
  **both paths uniformly** (fork-revert abandons the `clear` with the branch; freeze persists it), with **no
  per-entry cost** and **no `revert_to`-precision dependency**.

**Net revised position:** the design's bare ring is still right; drop `evict_provides_after` (surgical,
block-tagged) — but add a **full `RecentProvides::clear()` on the freeze transition** to cover the finalized-
invalid → `force_unfreeze` case. So it's *not* "no eviction at all" (our earlier stance) and *not* the
block-tagged surgical evict (lexnv's) — it's **bare ring + clear-on-freeze.**

**AGREED with lexnv** ([#12349 comment](https://github.com/paritytech/polkadot-sdk/issues/12349#issuecomment-5034598119),
2026-07-21): *"we shouldn't have extra tracking if we can clear out the window entirely … it should self heal
and we'll eliminate the entry overhead."* So this is settled, not just proposed — bare ring + clear-on-freeze
**supersedes** the issue's block-tagged `evict_provides_after`. Implemented in
[yrong/polkadot-sdk#25](https://github.com/yrong/polkadot-sdk/pull/25) (freeze-transition detection in
`paras_inherent` → `inclusion::clear_provides()`; uncommitted on `rk-spec-msg-relay` pending review).

## `StreamId` `domain` vs. XCM `Location` — not a conflict, a different layer

The design's *"a chain can delegate address space to applications — hand a pallet or contract subsystem a
`domain`, within which it manages `num` autonomously"* is **not** XCM addressing, and doesn't clash with
"XCM has only `Location`."

`domain`/`subdomain`/`num` are **fields inside `StreamId`** — the messaging-layer *trie key*, not a consensus
address:

```rust
enum StreamId {
    Channel   { recipient: ParaId, domain: u8,  num: u16 },
    Ack       { recipient: ParaId, domain: u8,  num: u16 },
    Broadcast { domain: u16, subdomain: u8, num: u32 },
}
```

`StreamId` is the key whose leaves form the `StreamsRoot`, and the design mandates a **fixed, canonical,
manual 8-byte SCALE encoding** because it's an index into a keyed accumulator. `domain`/`num` are just a
**sender-local partition of that key space**: give a pallet/contract a `domain` and it allocates `num`s
autonomously with no cross-app collision. Unused ⇒ everything sits at `domain 0`.

**Why `ParaId + domain + num` and not a `Location`:**

- `StreamId` must be a **fixed, compact, canonical trie key**. `Location` is variable-length, versioned, and
  arbitrarily deep (`Parachain/PalletInstance/GeneralIndex/…`) — a poor, unstable key. 8 bytes of
  `ParaId + domain + num` is a good one.
- `domain`/`num` play the role XCM gives to **interior junctions** (`PalletInstance`, `GeneralIndex`) —
  addressing a *sub-chain endpoint* — but as a compact field the chain assigns **locally**, not a
  consensus-wide junction path.

So `ParaId` = *which chain* (the XCM-ish part), `domain`/`num` = *which stream / which app within it*.

**Fair critique to keep in mind:** because `recipient` is a bare `ParaId` (not a `Location`), the scheme
addresses **chains, not pallets/accounts** — sub-chain routing is pushed into `domain`/`num`, which the two
endpoints agree on out-of-band (no globally-meaningful registry the way `Location` junctions are). That's a
narrower, convention-driven model than XCM; whether it beats e.g. hashing a `Location` into the key is a
legitimate design discussion — but given the fixed-width-trie-key constraint, `ParaId + domain + num` is a
coherent choice, not a confusion of XCM concepts.

## Channel = data stream + register; `recipient` always names the *reader*

A logical channel A→B is physically **two independent one-way streams** — data forward, flow-control back:

| stream | writer | reader | `StreamId` | lives in |
| --- | --- | --- | --- | --- |
| data | A | B | `Channel { recipient: B, d, n }` | **A**'s `StreamsRoot` |
| register (ack) | B | A | `Ack { recipient: A, d, n }` | **B**'s `StreamsRoot` |

A writes data + signals into the channel; B consumes. B writes the *register* (acceptance / advisory credit /
watermark / close) into the ack stream; A reads it. Each chain only ever commits the streams **it writes**.

**The one rule:** the `recipient` field names **who READS the stream**, not who writes it — uniformly for both
directions (data's reader is B ⇒ `recipient: B`; the register's reader is A ⇒ `recipient: A`). Symmetric
naming, one key-derivation rule for both legs.

**Why it's collision-free inside one chain's stream set.** A chain's own set mixes (a) channels it *sends*
(`Channel` kind, various recipients) and (b) registers it keeps for channels sent *to* it (`Ack` kind, one per
originating sender). Two fields keep them disjoint:

- **kind tag** (`Channel` `0x00` vs `Ack` `0x01`) separates "channels I send" from "registers I hold" — even
  at the same `(d, n)`;
- **`recipient`** separates registers for *different* senders' channels (`Ack{recipient: A}` vs
  `Ack{recipient: C}`).

So `(kind, recipient, domain, num)` is naturally unique within a chain's stream set — no extra dedup needed.

## Sender-side payload storage — node-side archive, mechanism still open

**Where the actual messages live (per design).** Payloads are **not on-chain** — the runtime commits only
frontiers/roots (`StreamsRoot`, MMR peaks). The payloads sit in a **sender-side archive that is explicitly
*"node-side disk, not consensus state"*** (design §Archive Pruning):

- keyed `(stream, position) → payload`, retained for a serving horizon (**~25 h, mirroring availability
  retention**), pruned below the confirmation watermark;
- **re-derivable** — *"the archive rebuilds during sync if the node executes the missed blocks (each block's
  `outbound_messages()` regenerates in passing)"*; it's a cache of a runtime-API output, not authoritative
  state;
- pruning is *"policy, not protocol"* — purely node-local.

The design mandates node-side non-consensus storage but **does not pin the Substrate mechanism** (it just says
"archive" / "sender storage").

**What's built today: none of it.** `cumulus/primitives/spec-messaging` is **primitives only** (`message`,
`mmr`, `stream`, `streams_root`, `lift`, `flow_control`). No outbox pallet, no archive store, no payload
retention, no `offchain_index` use, no `cumulus/client` spec-msg subsystem. (The only `offchain_index` in the
tree is the generic `parachain-system` PVF no-op shim — unrelated.) Sender emission / outbox / fetch are all
still ⬜.

**So `--enable-offchain-indexing` or another DB? — undecided, a future impl choice.** Two realistic candidates:

1. **Offchain indexing** — runtime `sp_io::offchain_index::set` during block execution writes payloads to the
   node's offchain DB. **This is the path that needs `--enable-offchain-indexing`**; it's how
   `pallet-mmr`/BEEFY persist leaves, and re-sync-with-execution re-populates it (matches "regenerates in
   passing").
2. **Bespoke client archive subsystem** — a node service calls the `outbound_messages()` runtime API per
   imported block and stores into its own DB column (like `availability-store`). **No offchain-indexing flag
   needed.**

The design's re-derivability language fits either; nothing forces offchain indexing. Option 1 is the
lower-effort, precedent-backed default (and would then require the flag), but it's open until the sender-side
work is designed. This storage hangs off the outbox re-shape (re-key `ParaId`→`StreamId`; transient
accumulator / persistent frontier / retained payloads).

## Liftability — three layers back it, all over the same ~25 h window

**The guarantee.** A *lift* must be generatable whenever a not-yet-included receiver block needs it (else "a
permanent block could become permanently unincludable"). Two kinds of material are at stake:

- **lift-proof material = leaf hashes** (the MMR extension/advance proof between recorded state and current
  root — payloads *not* needed);
- **consumption material = payloads** (to execute the messages).

The three layers keep **both** available across ~25 h. They aren't redundant belt-and-suspenders — they're
**three independent failure domains** so the guarantee degrades gracefully instead of having a single point of
failure.

| Layer | Holds | Assumption | Fails on |
| --- | --- | --- | --- |
| **1. Receiver's own collators** (first line, free) | ranges it already fetched to consume — the collator holding a pending block already has that block's consumed ranges | the builder collator still has its data | collator churn/restart |
| **2. Sender-side serving obligation** (backstop) | channel streams above the pruning watermark; event streams from any block boundary in the last 25 h | ≥1 honest source collator online in the window | the whole source chain going dark |
| **3. Relay-chain availability of included sender PoVs** (last resort) | erasure-coded PoVs; **stateless re-execution reproduces every send — payloads and leaf hashes alike** (`outbound_messages()` is pure STF, `leaf_hash` regenerates hashes) | only what already secures parachains (avail + deterministic re-exec) | availability dropping it (past ~25 h) |

**Why it's the clever bit:**

- **Same ~25 h window** throughout (matched to relay availability retention / LLv2 relay-parent age) — by
  expiry the receiver block is included or abandoned.
- **No new trust assumption** — layer 3 reduces liftability to the *exact* guarantee already securing
  parachains (available PoV + re-execution); the messaging layer invents no new availability system.
- **Graceful degradation, strictly-weakening liveness**: local-cache hit → fetch from sender → reconstruct
  from availability.

**Two caveats:**

1. **Layer 3 covers *included* sender blocks only** ("committed … POVs" = candidate reached availability). A
   *speculative* (pre-inclusion) send isn't in availability yet, so pre-inclusion liftability rests on layers
   1 & 2 plus the bet that the sender's block *will* be included — layer 3 is the inclusion-tier floor.
2. **Hashes vs payloads** — the lift *proof* needs only leaf hashes; consumption needs payloads. All three
   layers happen to serve both, so "hashes and payloads alike" holds for layer 3 and across the stack.

## `check_speculative_messaging`: malformed `ump_signals()` → `return true` is safe

The admission check opens with:

```rust
let Ok(signals) = candidate.candidate().commitments.ump_signals() else {
    return true; // keep
};
```

Returning **keep** on an `Err` (undecodable signal set) is correct — verified end to end:

- **The malformed candidate is dropped by a *different* check that gates the same admission.** In
  `sanitize_backed_candidates` both checks drop via `continue`, so a candidate must pass **both**:
  `check_descriptor_version_and_signals` (line ~1119) *then* `check_speculative_messaging` (line ~1131).
- The former calls `parse_ump_signals` and returns `false` on `Err`; and `parse_ump_signals`'s **first line**
  is `let signals = self.commitments.ump_signals()?;`. So `ump_signals()` failing ⟹ `parse_ump_signals`
  fails ⟹ candidate dropped. `parse_ump_signals` is a strict **superset** of `ump_signals()`.
- ⇒ By the time `check_speculative_messaging` runs, `ump_signals()` is guaranteed `Ok`; the `else` branch is
  **unreachable for malformed input** (purely defensive). And since both checks AND-together via `continue`,
  this holds **regardless of their order** — the descriptor check drops it either way.
- **Even if reached, it's benign:** `record_provides` uses `ump_signals().ok().and_then(|s| s.provides())`,
  so `Err` → `None` → nothing recorded; and there's no decodable `Requires` to act on. A malformed set is
  simply treated as "no speculative signals."

**Verdict: correct**, matching the doc comment ("A malformed UMP-signal set is treated as no speculative
signals (rejected separately by `check_descriptor_version_and_signals`)"). The only implicit coupling is that
`parse_ump_signals` stays a superset of `ump_signals()` — which is guaranteed by construction (`ump_signals()?`
is its first line).

## Runtime frontier-recompute vs. PVF lift — the "interim old root → advance to in-window root" model

Two phases, sharp division of labor, and the reason the lift exists at all.

**Runtime (recomputation only).** On the inherent's payloads, the STF hashes each into its leaf
(`H(LEAF_TAG ‖ version ‖ payload)`) and folds it, in order, into the tracked **frontier** (MMR peaks) for that
stream. That frontier is the receiver's **consumption boundary** — an *interim* state. This is *all the runtime
does*: it proves the payloads are self-consistent (wrong order/count ⇒ wrong frontier, caught later). It
**never binds to a `StreamsRoot`** — a root checked in the STF is one the **inherent provider (block author)
chose**, so binding to it verifies nothing.

**PVF (lift).** Takes that recomputed frontier and **advance-proves it forward** to a `StreamsRoot` the
collator has independently verified at its tier (a relay-window entry / verified header digest). Two steps:
`extension` (frontier at the consumed position → the stream root at a **newer** target position) + `tree_proof`
(that stream root → the target's `StreamsRoot`). The `Requires` then names *that* in-window root.

```
consumption boundary root (interim, likely OUT of the window)
        --- lift: extension (advance forward) + tree_proof --->
    a NEWER StreamsRoot that IS in the relay ring window  ->  Requires match succeeds
```

**Why split this way.** The receiver **consumes at authoring** (possibly speculatively, before the sender's
block is even included), but the relay `Requires` match happens **later**, at backing — by which point the
sender's committed root has moved on. Pinning to the exact consumption-boundary root would age out of the
window (only W recent roots). The lift **decouples "where I consumed" from "what root I bind to"**, advancing
the consumed prefix to a *current* in-window root — the design's *"authoring always targets the newest root at
its tier; the relay window is pipeline slack only,"* and *"gaps advance-proven forward."* The lift absorbs the
pipeline lag.

**Why the binding can't be in the runtime.** The trusted anchor (a root the relay actually vouches for) only
exists where the collator has independently verified it — node-side / PVF, not the STF. So the runtime does
self-consistency (frontier recompute); the PVF does the committed-root binding (lift).

*Terminology nit:* consumption yields a **frontier (peaks)**, not "a root" directly — the lift *extends the
frontier forward* rather than matching its root as-is; and "the latest" = the newest in-window `StreamsRoot`
the collator targets **at its tier** (speculative / optimistic / inclusion), not the sender's absolute head.

### Why the lift is POV-carried, not in the block body — the resubmission case

The design ([§Requires Lifting (POV Proofs)](https://github.com/paritytech/polkadot-sdk/blob/rk-speculative-message-0.5/docs/speculative-messaging-design.md#requires-lifting-pov-proofs))
motivates the POV lift via three cases where a block's consumption root aged out
by inclusion time (the window slides one entry per provides-emitting *sender* block): **partial consumption**,
**bundling**, and **resubmission**. The resubmission line — *"the block sat sealed while the window slid on;
the block body can't change (blocks are permanent, candidates transient — PR #11413)"* — decodes as:

- **block sat sealed** — the parachain block was authored + sealed, submitted as a candidate, but that candidate
  **failed inclusion** (e.g. availability timeout); it waited, unchanged.
- **window slid on** — meanwhile the sender emitted more `Provides`, so the root the block consumed under **aged
  out** of the relay window.
- **block body can't change** — you can't re-author the sealed block to chase the newer root; it's immutable.
- **blocks permanent, candidates transient (PR #11413)** — the LLv2 **block/candidate split**: a **block** is
  the permanent parachain block (body + STF); a **candidate** is the transient relay wrapper (receipt + PoV).
  On resubmission you build a **new candidate around the *same* unchanged block**.

**So the root-binding must live in the transient, regeneratable layer, not the block body:** the block records
only a root-agnostic **consumption interval** (never sees a `StreamsRoot`); the **POV-carried lift** is
**regenerated at every (re)submission** to bind that consumption to a *current in-window root*. A permanent
block therefore stays includable indefinitely — each retry re-lifts against the then-current provides, so "a
block never goes stale." And a lift is a **pure function of public data** (the source's streams + committed
roots — no signature, no secret), so *anyone* can regenerate it around the unaltered block; resubmission needs
no cooperation from the original author.

One line: the block is frozen but the target root keeps moving — so the binding lives in the **regeneratable POV
lift** (transient candidate), re-computed against the current window each resubmission. Same
interim-anchor→advance-to-in-window-root decoupling as above, seen through resubmission.

### The "bundling" case — the *source* bundled, so the boundary root was never committed

The third of the design's lift-motivating cases: *"data consumed from a source's intermediate, never-committed
blocks (a source that is itself bundling)."*

- A **sender** can bundle blocks A1, A2, A3 into one candidate (`ParachainBlockData { blocks: Vec<Block> }`).
  The relay records **only one `Provides` per candidate** at `enact_candidate` — the candidate-level (i.e.
  **final**, A3) `StreamsRoot`. The **intermediate** roots (A1, A2) live in their headers inside the PoV but are
  **never individually committed** → they never enter any provides window.
- A **receiver** that consumes a prefix ending inside an intermediate block (e.g. up to A2, typically
  speculatively before the source's bundle is included) has its boundary at **A2's root** — never committed, so
  the relay has **nothing to match**.
- The **lift advance-proves that boundary forward to A3's (committed, in-window) root**, so the synthesized
  `Requires` binds to a matchable root.

**All three lift cases side by side** — "boundary sits at a root the relay can't match → lift advances to a
current committed root":

| case | why the boundary root isn't matchable | lift advances to |
| --- | --- | --- |
| **Partial consumption** | receiver consumed only *part* of the backlog (own weight/PoV budget) → mid-backlog, under no committed root | the source's current committed root |
| **Resubmission** | the block waited while the window **slid**; its root aged out | a *current* in-window root |
| **Bundling** | receiver consumed from the **source's intermediate bundle blocks**, whose roots were never committed (only the final is) | the final (committed) bundle root |

One mechanism (the POV lift) covers all three + the no-lag identity case: blocks never emit `Requires`/never see
a `StreamsRoot`; they record a consumption interval, and `validate_block` synthesizes the requires via one
POV-carried lift per stream, binding to a current committed root.

## `stitch` — collapsing a bundle's interval chain, and why it's a soundness guard

**Data model.** A stream is consumed across a **bundle** of parachain blocks. Each block that touches the
stream records an `Interval { start: MmrRoot, end: MmrFrontier }` (`start` = the stream root it began reading
from, `end` = the frontier it stopped at). A bundle produces a sequence `I1..In` per stream. `stitch`
collapses that into **one endpoint frontier**, which the lift's `extension` then advances to the committed
root.

**What it does** (walk `I1.end` forward through the rest):

```
current = I1.end
for next in I2..In:
    if next.start == current.root():   # contiguous — free, no proof
        ()
    else:                              # a gap
        advance = next unused proof     (else MissingAdvance)
        require advance.verify(&current) == next.start   (else BrokenChain)
    current = next.end
require no leftover advances            (else StrayAdvance / UnusedAdvances)
return current
```

Each interval must connect to the previous one **either contiguously** (`next.start == current.root()`) **or
via a proven forward extension** — an `MMRExtensionProof` that takes `current`'s frontier and yields *exactly*
`next.start`.

**Why it's necessary — what each check prevents:**

- **`BrokenChain` (connectivity)** — the soundness core: a receiver can't fabricate a discontinuous claim; a
  jump to `next.start` is accepted only if it's provably a *later state of the same stream*, reachable forward
  from where the previous interval ended. Without it you could stitch intervals from **different/forged stream
  states**.
- **`NotForward` (inside `MMRExtensionProof::verify`)** — advances only go forward, so "verified states never
  regress": no backward jumps / replay of an older root as newer.
- **`MissingAdvance`** — a gap with no proof is rejected (no unproven skips).
- **`StrayAdvance` / `UnusedAdvances`** — exactly one advance per gap; no padding.

**Channels vs. event/register — advances are usually empty.** For **channels**, `start == previous end`
holds *by construction* (ordered contiguous reads), so the chain check is free and `advances` is empty —
`stitch` just walks to the last `end`. The gap machinery exists for **lossy skip-ahead** (register/event reads
jumping to a fresher context mid-bundle); a fabricated context breaks the chain rather than hiding behind a
later genuine one. So it costs nothing on the channel hot path.

**Ours vs. lexnv: equivalent — ours fully enforces contiguity.** (Corrects an earlier mis-read that "ours was
thinner / single-extension.") Both have `RequiresLift { advances: Vec<MMRExtensionProof>, extension,
tree_proof }`, the same `stitch`, and the same `build_requires`/`build_requires_entry` bundle-merge. Every
check matches; only error *names* differ (`StrayAdvance`/`EmptyRecord` vs `UnusedAdvances`/`BrokenChain`).

**Scope note (both impls).** `stitch` verifies **intra-bundle** connectivity only — it does *not* check that
`I1.start` anchors to the receiver's **persistent frontier** from before this bundle (resuming where it left
off). That anchoring is the consumption-record generator's job, a separate layer — not a gap between the two
impls, just where `stitch`'s responsibility ends.

## Trust boundary — anchors, and how faked sender data is caught

The obvious worry: `stitch`/lift inputs ultimately derive from data fetched off the (possibly malicious)
sender's collators. What stops fabricated payloads/proofs?

**Where the inputs come from.** Not directly "from the sender." The `intervals` are the *receiver's own
recomputation*: the runtime hashes the fetched payloads into leaves and folds them into the tracked frontier
(the recomputation phase). But the **raw material** — payloads and the `advances`/`extension`/`tree_proof` —
is fetched p2p from the sender's collators and is **untrusted**.

**The two anchors:**

- **Receiver-side — its own persistent frontier.** `I1.start` resumes from the consumption frontier in the
  receiver's *own prior chain state* (its own consensus). Trusted because it's its own state.
- **Sender-side — a trusted `StreamsRoot`, obtained independently of the collator response:**
  - *Inclusion tier:* a root in the relay's `RecentProvides` window — committed via **relay consensus**
    (sender candidate backed + included). Strongest.
  - *Speculative / optimistic tier:* a **verified header digest** — the sender block header carries the root,
    checked via off-chain block verification. Weaker (block may still fail inclusion → consume at own risk,
    confidence < Max).

  Both anchor to the sender's *real committed/authored state*, never to raw wire bytes.

**How faked data dies — derive-and-compare, never trust bytes** (the "derived, never declared" rule):

```
recompute leaf hashes from fetched payloads → frontier
  → extension.verify(frontier)  → stream root   (yielded)
  → tree_proof.verify(id, root) → StreamsRoot    (yielded)
  → COMPARE against the anchor (the root the request named)
```

Match ⇒ response authenticated; **mismatch anywhere ⇒ discard response + drop peer**. Faked payloads/proofs
derive a *different* `StreamsRoot` that won't equal the anchor; forging one that does needs a **hash collision**
against a `blake2` commitment — infeasible. A bad collator is a dumb pipe; garbage doesn't verify.

**Two enforcement points (defense in depth):**

1. **Node-side, at fetch** — the receiver's collator authenticates each response against the named anchor
   *before* building on it, so faked data never enters the block.
2. **On-chain, at inclusion** — even if a receiver built on bad data, the lift's derived `StreamsRoot` enters
   `Requires`, and the relay's `check_requires` matches it against the provides window → a fake root ∉ window
   ⇒ **candidate dropped**.

**`stitch`'s narrow role.** `stitch` does **not** compare against the sender anchor — only intra-bundle
connectivity. The anchor comparison is the fetch-auth (node-side) + relay requires-match (on-chain). So:
`stitch` (chain is internally connected) → `extension`+`tree_proof` (derives *some* root) → **anchor check**
(that root is the sender's genuinely committed one). The last step is where "malicious sender faked data" dies
— without it, `stitch` would happily connect a chain built on fabricated frontiers.

## Why multiple intervals exist — multi-block bundling per candidate

A candidate can bundle **multiple parachain blocks**: `ParachainBlockData { blocks: Vec<Block> }`
(`cumulus/primitives/core/src/parachain_block_data.rs`) — the PoV carries a *vector* of blocks (elastic
scaling / multi-block-per-candidate, upstream). `validate_block` loops over `block_data.blocks()`, executing
each.

**That is exactly why there are multiple intervals.** In the `validate_block` loop, **each bundled block
pushes one `consumption_record()`** (in bundle order), then after the loop `build_requires(&consumption_records,
lifts)` runs:

```
candidate bundles N blocks
  → validate_block executes each → N consumption_records (bundle order)
    → build_requires merges: per (source, stream) → Vec<Interval>   ← multiple intervals
      → stitch collapses each stream's interval chain into one endpoint
```

Each block records **one interval per stream it touches**; over an N-block bundle a stream accrues **up to N
intervals** — the `Vec<Interval>` `stitch` walks.

**The nuance:**

- **1 block / candidate** (common) → 1 record → **1 interval per stream** → `stitch` trivial (returns the
  single `end`; `advances` empty). The `build_requires`/`stitch` machinery collapses to almost nothing — the
  hot path.
- **N blocks / candidate** → the cross-block merge + multi-interval `stitch` earn their keep.
- Even bundled, **channels stay contiguous** (block B starts where A ended), so `advances` is still empty —
  multiple *contiguous* intervals. `advances`/gaps only appear for **event/register reads jumping to a fresher
  context between blocks**.

So multi-block bundling is *why* `build_requires` (cross-block merge) and multi-interval `stitch` exist:
without bundling there'd be one interval per stream and the machinery would be dead weight; with it, `stitch`
also becomes the guard that the per-block intervals form one connected consumption chain.

### When `advances` actually appear — "a fresher read mid-bundle"

Two kinds of read, two interval shapes:

- **Channel (contiguous consumption).** Consume messages in order, range after range. Block A consumes
  `[0,5)`, block B consumes `[5,10)` — B starts where A ended. Intervals chain **contiguously**, no gap,
  `advances` empty.
- **Register / event (lossy point-read).** These streams are lossy — you want the **latest value** (a
  flow-control register's watermark/credit/close; an event feed's head). A read is a **snapshot at a
  *context*** (the stream's frontier/root when read), not a range: `start = context root`, `end = context
  frontier`, nothing advances *within* the read.

**The gap comes from re-reading a lossy stream at a fresher context across the bundle.** The later block reads
the same stream after the *source advanced it*:

```
Source register stream:  ...leaf 8 (watermark W1) ... 9,10,11 ... leaf 12 (watermark W2)

Block A1 (earlier):  reads register at context C1  → frontier @ 8
   ... source publishes updates 8..11 ...
Block A2 (later):    reads register at context C2  → frontier @ 12   ← fresher
```

A2 reads @12, A1 @8 → **gap `[8,12)`**. A2 doesn't want the stale intermediate register states — it wants the
newest watermark. So it *jumps*. **"A fresher read mid-bundle is the point"**: for lossy streams, skipping to
the latest value is the desired behavior (you subscribe to get the latest, not to replay every update) — the
gap is a feature.

**Why the gap needs an `advance`.** To `stitch` C1 and C2 into one chain, an `MMRExtensionProof` must show
C2's context (root @12) is a genuine **forward extension** of C1's (frontier @8) — that 8..11 are real
appended leaves of the *same* stream. That's the security bit — *"a fabricated context breaks the chain
instead of hiding behind a later genuine one"*: a receiver can't slip in a made-up fresher context; it must
*prove* the jump forward-extends the previous one, or `stitch` → `BrokenChain`. You may skip *values*, but
every context you land on must be a proven descendant of the last.

One line: **channel** = adjacent ranges → contiguous → no `advances`; **register/event** = fresher snapshots
of a lossy stream → gaps → `advances` bridge them (proven forward). `advances` show up precisely when a bundle
re-reads a lossy stream at a newer context.

**The skip costs only proof material, not payloads.** Bridging `8→12` needs only the `advance`
(`MMRExtensionProof`) — **connecting nodes derived from leaf *hashes*, never the raw payloads** of 9,10,11.
So over the wire it's a **payload-free fetch** (`MessagesRequest` with `max_bytes = 0`), and those leaves are
**never executed** — you advance *past* them (the lossy skip). It's even leaner than "3 leaf hashes": an
ancestry proof is **O(log n) connecting nodes**, so a contiguous run like 8..11 collapses to ~one
subtree-root hash + placement — skipping 3 or 3,000 costs about the same.

The one payload you *do* need is the **head you actually read** — leaf 12 (the fresh watermark W2): it needs
its payload + a `verify_head` inclusion proof, because that's the value being consumed.

| range | what you fetch | why |
| --- | --- | --- |
| leaves 8..11 (skipped) | extension proof (connecting-node hashes) | just advance the frontier past them |
| leaf 12 (the read) | payload W2 + inclusion proof | it's the latest value being consumed |

This is exactly what a **channel can't** do: a channel must execute *every* payload in the range, in order —
it can't "skip 9,10,11 with a proof." That's why channels have no gaps, and lossy register/event streams
reduce the intermediate leaves to a single O(log) advance instead of N payload executions.

## Primitives delta — ours (`rk-spec-msg-primitives`) vs. lexnv PoC (`spec-msg-poc-mvp`)

**REFRESHED (full public-API diff — supersedes the earlier module-surface pass).** Extracted every `pub`
item from both crates and diffed. **The commitment + relay-match foundation is complete in ours; the delta is
the sender/receiver/plumbing layer** (≈ our ⬜ next-phase items). Two new misses the earlier pass didn't catch:
`ProvideUmpSignals` and lossy-read `MmrInclusionProof`.

**Genuinely missing in ours — by priority:**

*HIGH (load-bearing for the E2E flow):*

| Missing | lexnv module | What it is |
| --- | --- | --- |
| **`ProvideUmpSignals` trait** | `lib.rs` | Runtime integration **seam** — emits the `Provides` UMP signal from the end-of-block tree fold + drives `Requires` synthesis from consumption records; the sender/receiver runtime implements it. Ours has **no equivalent**. |
| **`SpecMsgInherentData` + `INHERENT_IDENTIFIER`** | `inherent` | Receiver block-injection plumbing (fetched payloads + POV lifts into the block) — the concrete realization of the requires-lift `validate_block` hook. No inherent module in ours. |
| **`ChannelId`, `ChannelPhase`, `InChannelState`, `OutChannelState`, `ConsumedStream`** | `channel` | Channel lifecycle + flow-control *state*. Ours' `flow_control` has only the *signals* (`Register`/`WindowGrant`/`SpecMsgKind`/`SpecMsgSignal`), not the enforcing state. |

*MEDIUM:*

| Missing | lexnv module | What it is |
| --- | --- | --- |
| **`MmrInclusionProof` (+`verify_head`/`verify_leaf`) + `MmrError`** | `mmr` | Inclusion proofs for **lossy consumers** — register/event *head* reads verify by inclusion proof, not recomputation. Ours has `MMRExtensionProof` (channels/lifts) but no inclusion-proof path. |
| **`EventRequest`, `EventResponse`, `ExchangeRequest`, `ExchangeResponse`** | `wire` | Event-stream fetch + top-level exchange enum. Ours has core `MessagesRequest`/`Response` only. |

*LOW / cosmetic:* `LiftsBySource` + `LiftsError` (collection newtype/error; ours has `build_requires` +
`LiftError`); `StreamIdError` (decode error); `EMPTY_TAG` + defined empty root (ours reserves `0x1`, returns
`Option`).

**Present in ours — do *not* re-add (renamed / different shape):**

- `RequiresSetError` → ours' **`CommitmentError`** (`v9/speculative.rs`, alongside `StreamsRoot`, `RequiresSet`).
- `TREE_LEAF_TAG`/`TREE_INNER_TAG` → ours' `STREAMS_LEAF_TAG`/`STREAMS_INNER_TAG`; `hash_leaf` → `leaf_hash`.
- lexnv tree API (`compute_streams_root`/`prove_stream`/`TreeInclusionProof`) → ours' `streams_root.rs`
  (`StreamProof`/`gen_stream_proof`/`streams_root_from_proof`/`verify_stream_membership`/`TreeStep`).
- lexnv uses `mmr_lib` directly → ours has an **extra `Mmr`/`MmrAccumulator` abstraction** lexnv lacks.

**Value differences in shared types (decide, not "missing"):** `RequiresSet` cap — ours
`MAX_SOURCES_PER_BLOCK = 128` vs lexnv `MAX_COMMITMENT_ENTRIES = 256`; tag bytes — ours `0x2–0x6` vs lexnv
`0x1–0x6`.

**Reading:** the misses map to the ⬜ sender/receiver/plumbing layer. Two are *integration seams* rather than
pure primitives — **`ProvideUmpSignals`** (runtime) and **`SpecMsgInherentData`** (inherent) — needed the
moment the pallets are wired, not for the primitives in isolation. The channel state machine is where the
flow-control *logic* lives; the lossy `MmrInclusionProof` + event/exchange wire are needed for event/register
streams specifically.

### Empty streams are omitted from the tree — and it's structural in lexnv (not a filter)

Followed up on the `EMPTY_TAG` / empty-root question by finding *where* empty streams get omitted. In lexnv it's
**structural, not an explicit `if empty { skip }`** — the tree is folded incrementally over *touched* streams.
`commit_streams_root` (`cumulus/pallets/spec-messaging/src/lib.rs:1560`):

```rust
let mut touched = false;
for (stream, messages) in OutboundMessages::<T>::iter() {   // only streams that got messages
    let mut frontier = OutboundFrontier::<T>::get(stream);
    for payload in &messages {
        frontier.append_leaf(hash_leaf::<SpecHasher>(LEAF_VERSION, payload));
    }
    Self::upsert_tree_leaf(&stream, tree_leaf_hash(&stream, &frontier.root()));  // folds a NON-empty root
    touched = true;
}
if !touched { return None; }   // idle block: nothing folded
```

Two things make the omission automatic:

1. **The loop iterates `OutboundMessages`** (this block's per-stream sends) — a stream with **0 messages is never
   in it**, so it's never folded into `TreeNodes`/`TreeRoot`. An opened-but-unused stream has a `frontier`
   (leaf_count 0) but no tree entry.
2. **Leaves are appended *before* `frontier.root()` is taken** → the folded root is always for ≥1 leaf; the empty
   root `H(EMPTY_TAG)` is **never** what gets folded.

(`tree::compute_streams_root` is the pure/test version; it separately returns `None` for the empty *set* — a
whole block with no streams.)

**Precise correction to "both impls state this":**
- **Ours** *states* it as a documented invariant (comment: "empty streams are omitted … callers always pass a
  non-empty slice").
- **lexnv** *enforces* it structurally (folds only touched streams, always non-empty root) — it *can't* fold an
  empty stream, no comment needed.

**Conclusion on `EMPTY_TAG`:** since the fold only ever writes non-empty roots, `H(EMPTY_TAG)` is **never
committed to the tree** — it exists only as an internal frontier value (an empty frontier's `root()`, and the
extend-from-empty / identity cases in `MMRExtensionProof::verify`). So it's a purely internal convenience
(total `root()`), never a matched/committed value → genuinely minor, as flagged. (Ours' `Option`-on-empty is
the equivalent, arguably-safer choice.)

## #12593 (`SpeculationStore`) — lexnv covers it with a **dedicated store**, not offchain-indexing

Checked whether the PoC realizes the sender-side store as offchain-indexing (what I argued for) or a bespoke
store (what the issue proposed). **It's the dedicated store** — the offchain-indexing route was *not* taken.
No `offchain_index` anywhere in the spec-msg code.

**What it is:** `SpecMsgArchive<Block, AUX>` in a full client subsystem `cumulus/client/spec-msg/`
(`archive.rs` ~1054 lines + `fetch.rs`, `verify.rs`, `protocol.rs`):

- Backed by the client's **auxiliary KV store** (`aux: Arc<AUX>`) with in-memory indexes (`streams:
  BTreeMap<StreamId, StreamState>`, `root_index: BTreeMap<StreamsRoot, BlockNumber>`).
- **Populated on block import** (`import_block`), payloads keyed by `(stream, position)`.
- Serves p2p `MessagesRequest`s against retained state.

This is the "bespoke client archive subsystem" option (my option 2), i.e. the *issue's* design — the opposite
of the offchain-indexing line in the draft #12593 comment.

**Retention is the *reconciled* view, not a raw `--speculation-window`:**

- **Primary — flow-control watermark:** `prune_payloads` drops below the confirmation watermark (the safe-prune
  rule).
- **Plus — `SERVING_HORIZON` window** as *"the default policy knob **on top of** the watermark rule"*
  (`prune_horizon`).

So lexnv **already respects the watermark** (my core retention point) and layers the horizon as a *policy knob*,
not the sole mechanism — close to where we landed (watermark primary, window as policy), just in a dedicated
store rather than offchain-indexing.

**Implication for the #12593 comment:** the *storage-mechanism* half (offchain-indexing) is now a live
disagreement with a working `SpecMsgArchive`, so the ask becomes "replace the bespoke store" (harder) rather
than "don't build one." The *retention* half is already partially adopted (watermark + horizon knob, not a pure
time window). Re-read `archive.rs` before pushing the offchain-indexing line further.

### `archive.rs` retention vs. our flow-control view — two axes, and our view was channel-payloads-only

Re-read the pruning logic (`archive.rs:414–488`). It's a **two-axis** model, and comparing honestly shows our
"retention falls out of flow control" position was **right about payloads but incomplete overall**.

| What | Pruned by | Function |
| --- | --- | --- |
| **Payloads** (consumption) | the peer's **confirmation watermark** | `prune_payloads(stream, below=watermark)` — deletes payloads `[floor, watermark)`; **keeps leaf hashes** |
| **Leaf hashes** (extension/proof material) | a **25 h serving horizon** | `prune_horizon(now − 25h)` — drops old boundaries, deletes leaf hashes below the horizon floor (+ any payloads still there) |

The move our view *didn't* make: **payloads and leaf hashes prune on different axes.** A watermark-pruned range
*"refuses payload requests but still serves extension material"* — the payloads-vs-hashes split from the
Liftability discussion, made concrete.

**Where it matches us — ✓ payloads.** `prune_payloads(below = confirmation watermark)` is exactly our flow-control
claim; the doc even calls `SERVING_HORIZON` *"the default policy knob on top of the watermark rule, not the
primary mechanism."* So our core point holds — **for channel payloads.**

**Where our view was too strong.** "Retention falls out of flow control, no window needed" misses:

1. **Leaf-hash serving is time-bounded, not watermark-bounded** — even after payloads are confirmed/pruned, the
   sender must serve **extension proofs** (leaf hashes) so receivers can *lift* old consumption to a current
   root (the 25 h Liftability obligation). We collapsed payloads and hashes into one "retention"; they differ.
2. **Event/broadcast streams have *no watermark*** — for them the 25 h horizon is the **primary** retention, not
   a knob. Our view implicitly assumed channels everywhere.
3. **The horizon also caps the stalled-watermark (dead-receiver) case** (`archive.rs:479` "dead weight even if
   the watermark stalls") — the give-up backstop we'd attributed to backpressure; lexnv enforces it directly.

**Qualifier for the #12593 stance (correction).** Our "retention should fall out of flow control without a
`--speculation-window`" holds **only for channel payloads**. It does **not** hold for event-stream / leaf-hash
proof material, where a serving horizon is **structurally required** (no watermark to drive it; proof-serving is
inherently time-bounded). So the `SERVING_HORIZON` is **not** merely a dead-receiver policy knob as the draft
framed it — lexnv's two-axis model (watermark for payloads, 25 h horizon for leaf hashes) is the fuller-correct
picture, and the "no window" line should be dropped/qualified before pushing it in the issue.

### Channels are "reliable" only within ~25 h — a long receiver stall is a liveness failure

Follow-up: for channels, are leaf hashes governed by the watermark or the horizon, and what happens on a long
stall? Precise floors per stream:

- **payload floor** = `max(confirmation watermark, horizon floor)` (`archive.rs:484`).
- **leaf-hash floor** = the **horizon floor (25 h)**.

| receiver state | payloads retained | leaf hashes retained |
| --- | --- | --- |
| **keeping up** (watermark recent) | `[watermark, tip]` — pruned *early* by watermark | `[25h-floor, tip]` — full 25 h |
| **stalled** (watermark old) | `[25h-floor, tip]` — watermark is *behind* the horizon, so horizon governs both | `[25h-floor, tip]` |

So **channel leaf hashes are always horizon-governed (25 h)**; the watermark only prunes *payloads* earlier when
the receiver keeps up. The **25 h horizon is the outer bound for everything**, including unconfirmed material
*above* the watermark.

**Receiver stalls 3 days ⇒ can't catch up from normal collators.** After 25 h, `prune_horizon` advances the
floor past the stalled watermark and **deletes the pending (unconfirmed) messages** older than 25 h — payloads
*and* leaf hashes. Catch-up then depends on:

1. **Receiver's own nodes** (Liftability L1) — *if* it fetched the range before stalling (a receiver that fell
   behind without fetching has nothing).
2. **Archive nodes** — the only sender-side path past 25 h.
3. **Relay-availability re-execution** (L3) — but availability is *also* ~25 h, so gone at 3 days.

⇒ At 3 days, only **archive nodes** (or the receiver's own cache) can serve the pruned range; if none has it,
the **channel stalls** (ordered, no skipping) until recovered or torn down.

**Why intended, not a bug:**
- **25 h is the *guaranteed* window**, mirroring availability retention + "collators online ≥ once/day." A
  3-day stall is outside the guarantee by design; fallback is archive nodes, not the normal path.
- The design *permits* it: safe rule = "prune below the watermark"; above it a **"generous age-based cutoff" is
  explicitly allowed as policy** (§Archive Pruning). The 25 h horizon *is* that cutoff.
- **Liveness degradation, not safety violation** — no bad state commits; the receiver just can't progress on
  that channel. Same class as an availability timeout.
- **Backpressure bounds the loss**: a stalled receiver's watermark doesn't advance → sender hits the ~10 MiB
  cap and **stops sending**, so the aged-out tail is bounded (~10 MiB), not unbounded.

**Net — the honest caveat on "channels are reliable":** reliability is bounded by the **serving horizon**
(~25 h + archive-node reach). A receiver down for days risks the channel **stalling** on the pruned tail —
recoverable only via archive nodes or its own cache; if truly gone, the channel can't advance. A conscious
availability-parity trade, not unconditional reliable delivery.

### Backpressure enforcement — `ensure_credit` in the sender STF

Where "backpressure stops the sender" actually lives: `Pallet::ensure_credit`
(`cumulus/pallets/spec-messaging/src/lib.rs:1467`), on the `send` path (`send` → `can_send` → `ensure_credit`):

```rust
let grant = state.register.map(|r| r.grant).unwrap_or_default();   // receiver's advisory credit
let meta  = OutChannelsMeta::<T>::get(channel);                    // in-flight (unconfirmed) accounting
ensure!((meta.sizes.len() as u64) < grant.max_messages, Error::NoCredit);  // in-flight COUNT < granted
ensure!(meta.bytes < grant.max_bytes, Error::NoCredit);                    // in-flight BYTES < granted
```

- **In-flight = unconfirmed backlog** (`OutChannelsMeta`: count + bytes), incremented per send (`account_send`),
  released as the receiver's watermark advances.
- **The bound is the receiver's grant** (`WindowGrant { max_messages, max_bytes }`, carried in its `Register`).
  Default grant is 0 ⇒ before any register only `OpenChannel` is sendable.
- **When full → `Error::NoCredit`**, surfaced by the XCM router as `SendError::Transport` — the sender **can't
  push more** until consumption is confirmed. A stalled receiver never advances its watermark → `meta` never
  shrinks → gate stays shut. So the aged-out tail is **bounded** (`grant.max_bytes`; design's "~10 MiB" is the
  example, `channel.rs:462` test default is 4096), enforced deterministically in the STF. The sender enforces a
  *receiver-supplied* grant on itself ("the grant is advice … honoring it protects the sender's own archive").

### Is "payloads by watermark, leaf hashes by horizon" consistent with v0.5? — mostly, with over-retention

The design (§Archive Pruning, line ~2047): *"Prune payloads **(and leaf hashes)** below watermark W …"* — for
channels, prune **both** below the watermark. §Liftability: event streams have *"no watermark … the obligation
is bounded in time instead"* (25 h).

- **Design:** channels → watermark (payloads *and* leaf hashes); events → 25 h horizon (leaf hashes).
- **lexnv:** payloads → watermark (channels) / horizon (events); **leaf hashes → 25 h horizon for *all* streams,
  including channels.**

So the **payload axis matches** the design. The difference is **channel leaf hashes**: lexnv keeps them to the
25 h horizon rather than pruning them below the watermark. Since a channel is 1↔1 and only the receiver reads
it, channel leaf hashes below the receiver's watermark are never needed — so this is **over-retention** (a
uniform "all leaf hashes by horizon" simplification), *safe and within the design's latitude* (pruning is a
lower bound / "policy"), just slightly more storage than the design minimum. **Consistent in the safe
direction, not identical.**

### Do archive nodes never prune? — no such mode exists in the current code

Checked, because the #12593 example leans on *"only archive nodes can provide back messages."* **The current
impl has no non-pruning archive mode.** The worker (`worker.rs:170–181`) unconditionally runs both prunes on
every best block:

```rust
archive.prune_payloads(&stream, register.up_to)?;                       // watermark
archive.prune_horizon(now_secs().saturating_sub(SERVING_HORIZON.as_secs()))?;   // 25 h — hardcoded const
```

`SERVING_HORIZON` is a hardcoded `const` (25 h), **not configurable**, and `run_spec_msg_archiver` is wired
unconditionally in the omni-node (`common/spec_msg.rs:136`) — no archive-mode / `--no-prune` branch. So:

- **Every node prunes identically at 25 h; no node retains longer.** The "archive nodes" fallback is a
  design/issue *concept*, **not realized** in this PoC.
- **Implication:** after 25 h the pruned tail is gone from *all* spec-msg collators — so a receiver stalled
  > 25 h currently has **no spec-msg recovery path at all** (worse than the earlier "archive nodes can serve"
  framing, which assumed a retention tier that doesn't exist yet). If non-pruning archive nodes are intended,
  they'd need a config knob on `SERVING_HORIZON` (or a skip-prune mode) that isn't there.

### A "no-prune" mode isn't archive-specific — it's absent *and* decoupled from the node's archive concept

Followed up on whether the missing retention tier maps to a spec-msg flag or the node's existing archive mode.
Confirmed via grep: the spec-msg client reads **none** of the node's pruning/archive config
(`--blocks-pruning`, `--state-pruning`, `is_archive` — all absent), and `SERVING_HORIZON` has no override path.

- **There is no `--no-prune` flag** (spec-msg-specific or otherwise), **and** `SpecMsgArchive` pruning is
  **decoupled from Substrate's archive-node concept**: running `--blocks-pruning archive` / `--state-pruning
  archive` does *not* extend spec-msg retention — it still prunes at the hardcoded 25 h. **A Substrate archive
  node is *not* a spec-msg archive node.**

**If archive-node retention is wanted, the clean design is the *existing* archive mode, not a bespoke flag:**

1. **Tie `prune_horizon` to the node's existing archive mode** (`--blocks-pruning archive` etc.), so "archive
   node" means one coherent thing across the node and spec-msg — no new operator concept.
2. **Re-derive on demand instead of retaining.** An archive node already keeps all **block bodies + state**,
   and spec-msg payloads are a *deterministic re-execution* of those blocks (`outbound_messages` "regenerates
   in passing"). So it could serve a pruned range by **re-executing the historical blocks** — no second
   retention store, no duplicated config. Arguably cleanest: "archive node serves old spec-msg data" falls out
   of the existing archive guarantee for free.

**Net:** #12593's "only archive nodes can provide back messages" currently maps to **nothing in the code** —
neither an archive-specific flag nor the general archive mode. If intended, it should hang off the node's
existing archive mode (or on-demand re-derivation from retained blocks), so there's a *single* "archive node"
notion rather than a spec-msg `--no-prune` special case.

### lexnv over-prunes channel *payloads* at the horizon — breaking > 25 h catch-up that recomputation would allow

Prompted by: "if the watermark lags > 25 h, payloads are kept but leaf hashes pruned — can the receiver catch
up?" Two layers:

**As implemented (lexnv): no — it prunes the payloads too.** `prune_horizon` deletes payloads in
`[watermark, horizon_floor)`, not just leaf hashes (`archive.rs:476–481`):

```rust
for position in state.floor.leaf_count..new_floor {   // new_floor = horizon floor
    deletes.push(keys::leaf(&id, position));
    if position >= state.payload_floor {               // payload above watermark, still present
        deletes.push(keys::payload(&id, position));    // ← deleted too
    }
}
```
justified as *"payloads below the horizon floor are unreachable (no peaks can be built below it) — dead weight
even if the watermark stalls."* So `payload_floor = max(watermark, horizon)`: a watermark lagging > 25 h drops
**both** payloads and leaf hashes → the channel can't catch up (the stall case).

**But the premise is right for the *design*, and it reveals an over-prune.** The key fact, from the code
itself (`mmr.rs`, `MmrInclusionProof` doc): **"channel consumption verifies by *recomputation* and needs no
proofs."** Because `leaf = hash(payload)`, a receiver fetches **payloads**, re-hashes them, and extends its
*own* persistent frontier — it never needs the sender's *stored leaf hashes* for the consumed range. So if
payloads are **retained** (leaf hashes pruned):

- fetch payloads `[watermark, tip]` → recompute leaf hashes → extend frontier to `tip`;
- final lift needs only a **recent** extension + tree proof (`[tip, current root]`, within the horizon, kept);
- **⇒ it *can* catch up.** Pruned leaf hashes are recomputed from payloads; only payloads are essential.

**So the real blocker is the payload horizon-cap, not the leaf-hash pruning.** lexnv couples payload-pruning to
leaf-hash-pruning ("no peaks ⇒ payloads unprovable ⇒ drop") — correct for *proof-based* reads
(register/event), but **wrong for channels**, which consume by recomputation and don't need the sender's
proofs. The design *permits retaining the above-watermark payload tail* (bounded by backpressure ~10 MiB, not
unbounded), which **would** let a > 25 h-late channel receiver recover. lexnv's 25 h payload cap is **stricter
than the design** and forecloses that recovery.

**Flag for the PoC:** `prune_horizon` dropping channel payloads as "unprovable dead weight" is an **over-prune**
— channel payloads remain usable via recomputation, so retaining the above-watermark tail (backpressure-bounded)
would restore > 25 h channel catch-up. The essential retention unit for channels is the **payload**, not the
leaf hash.

## Findings to raise on the PoC (#12699) — DRAFT, not yet filed

### Summary of drafted issues

Three drafted issues so far (details below), none published. All are **completeness / robustness**, none are
**safety** — fetched data is always verified against a trusted anchor regardless.

| # | Issue | Type | Severity | Where | One-line |
| --- | --- | --- | --- | --- | --- |
| 1 | `prune_horizon` over-prunes channel payloads | correctness / over-prune | **Med** | `archive.rs:474–485` | Prunes above-watermark channel payloads at 25 h as "unprovable dead weight" — but channels verify by *recomputation*, so retained payloads would allow > 25 h catch-up; forecloses recovery the design permits (backpressure-bounded tail). |
| 2 | Dynamic peer discovery (DHT scraping) unimplemented | completeness / deployment blocker | **High** (for deploy) | `exchange.rs` (`PeerRegistry`/`SourcePeers`), `spec_msg.rs:143–148` | Peer sourcing is a static, config-populated registry; relay-chain DHT / authority-discovery is architected-but-not-built. Works only on a manually-configured peer set — can't self-discover counterpart collators. PR flags it. |
| 3 | Serving horizon hardcoded 25 h `const`, no archive mode | completeness / retention | **Med** | `archive.rs:87`, `worker.rs:170–181`, `spec_msg.rs:136` | Every node prunes at a fixed 25 h; ignores `--blocks-pruning`/`--state-pruning`. The "archive nodes serve back messages" fallback maps to nothing → > 25 h-stalled receiver has no recovery path. Needs a configurable horizon (or re-derivation on a state-archive node). |

**Common thread:** #1 and #3 are the same root cause seen twice — **retention is under-designed** (a hardcoded
25 h horizon that both over-prunes channels and ignores the operator's archive window). #2 is orthogonal (the
discovery layer). None block safety; #2 blocks real deployment, #1/#3 block long-outage recovery.

**Overall state of #12699:** functional end-to-end MVP on a **static peer set**, one **discovery layer** (#2)
and a **retention revamp** (#1 + #3) short of deployment-complete for #12531. (See the #12531 coverage table
below: 7/8 flow steps done, step 6 partial.)

### Consolidated: the retention model (issues #1 + #3 are one revamp)

#1 and #3 are the **same root cause** — retention is governed by **one hardcoded wall-clock `const`**
(`SERVING_HORIZON = 25 h`, `prune_horizon`) applied bluntly to *all* material on *all* streams. It's wrong on
**two axes**:

- **#1 — it prunes the wrong *thing*.** It drops **channel payloads** above the watermark as "unprovable dead
  weight," but channels verify by **recomputation** (`leaf = hash(payload)`), so retained payloads are exactly
  what a late receiver needs. The *payload* is the recovery unit for channels, not the leaf hash.
- **#3 — it's the wrong *size* and not configurable.** Hardcoded 25 h, ignores the operator's intent; no way to
  run a longer-retention / archive node.

**The correct model — one prune keyed by *stream type*, each covering *both* payloads and leaf hashes:**

| stream type | prune rule | fix |
| --- | --- | --- |
| **channel** | **watermark** — retain everything above the confirmation watermark (payloads *and* leaf hashes), prune below; tail is backpressure-bounded | **#1:** don't drop above-watermark channel payloads at a horizon — they're the recovery unit (recomputation) |
| **event / broadcast** | **horizon** (~25 h) — no watermark exists, so time-bounds *both* materials | — |
| **the window (events)** | — | **#3:** make `--speculation-window` a real config (time **and** size, default 25 h). Sized large, **the store *is* the archive** — self-contained (own aux DB, populated at import, serves without block/state), so **no node archive mode needed** |

> **Framing correction:** the *materials* split (payloads vs leaf hashes) is real, but the prune *rule* is keyed
> on **stream type**, not material — channels by watermark (both materials together), events by horizon (both).
> The "payloads by watermark, leaf hashes by horizon uniformly" phrasing is **lexnv's over-complication**, and
> the source of *both* defects: channel leaf-hashes over-retained (kept 25 h below W) + channel payloads
> over-pruned (dropped at the horizon).

**One revamp resolves both.** For **channels**, prune payloads *and* leaf hashes by the **same watermark rule**
(retain above W); reserve the **horizon** for **events** (no watermark). Make `--speculation-window` a real,
generously-sizable config. That fixes #1 (channel > 25 h catch-up via retained payloads + recomputation), fixes
#3 (operator-tunable, store-as-archive without node archive mode), and is *stricter-correct* than both the v0.5
design's single-window *prose* framing **and** lexnv's uniform two-axis *implementation*.

**What it does *not* fix:** discovery of a long-retention node still needs issue #2 (a large window is useless
if receivers can't find the node serving it), and dead-**sender** cases remain unrecoverable (no in-window root
to lift to — see "#12593 revisited").

### [PoC issue] `prune_horizon` over-prunes channel payloads → forecloses > 25 h channel catch-up

*Status: draft, not published.*

**Where:** `cumulus/client/spec-msg/src/archive.rs:474–485` (`prune_horizon`).

**What:** `prune_horizon` deletes not just leaf hashes below the 25 h horizon floor but also the **payloads**
that are still present there (`if position >= payload_floor { delete payload }`) — i.e. the pending,
above-watermark payloads of a slow/stalled receiver. Justified in-code as *"payloads below the horizon floor
are unreachable (no peaks can be built below it) — dead weight."*

**Why it's wrong for channels:** that justification holds for **proof-based reads** (register/event, which use
inclusion proofs) but **not for channels** — *"channel consumption verifies by recomputation and needs no
proofs"* (`mmr.rs`, `MmrInclusionProof` doc). Since `leaf = hash(payload)`, a late receiver fetches the
**payloads**, re-hashes them, extends its own frontier, and needs only a *recent* extension + tree proof to
bind — the sender's stored leaf hashes for the consumed range are never needed. So a retained above-watermark
payload is **not** dead weight; it's exactly what a > 25 h-late channel receiver needs.

**Impact:** a channel receiver stalled > 25 h **cannot catch up** even though recomputation would allow it —
the payloads it needs are pruned. Recovery falls to archive nodes / relay-availability re-exec, both also
~25 h, so effectively unrecoverable. This is *stricter than the v0.5 design*, which permits retaining the
above-watermark tail (bounded by backpressure ~10 MiB, `ensure_credit`), not a hard time cap.

**Suggested fix:** decouple channel payload retention from the leaf-hash horizon. Retain the above-watermark
payload tail (backpressure already bounds it to ~grant bytes) rather than horizon-capping it; keep the horizon
prune for leaf hashes / proof-based (register/event) material. Net: the essential retention unit for a channel
is the **payload**, not the leaf hash.

**Cross-refs:** related to the #12593 discussion (retention = watermark for payloads + horizon for leaf hashes)
and the "channels reliable only within ~25 h" caveat above.

### [PoC issue] Dynamic peer discovery (DHT scraping) unimplemented → static `PeerRegistry` placeholder

*Status: draft, not published.* (The PR flags this itself: *"doesn't implement full DHT scraping for counterpart
parachain."*)

**Where:** `cumulus/client/spec-msg/src/exchange.rs` (`PeerRegistry`, `SourcePeers` trait) +
`cumulus/polkadot-omni-node/lib/src/common/spec_msg.rs:143–148` (wiring).

**What:** step 6 of #12531 ("fetch + verify messages from the parachain via P2P **added dynamically**") is only
half done. Fetch (`fetch.rs`) and verify (`verify.rs`) work, but **peer sourcing is a static `PeerRegistry`**
manually populated from node config (`registry.add_peer(source, peer)` from a single configured
`(ParaId, PeerId, Multiaddr)`). The intended **dynamic discovery of a source's collators via relay-chain DHT /
authority discovery** is *architected but not built* — `exchange.rs:30–32`: *"would be discovered dynamically
via the relay chain DHT … plugs in behind the `SourcePeers` trait."*

**Impact:** the flow is **end-to-end functional only on a manually-configured peer set**. A receiver can't find
a counterpart parachain's collators on its own, so this is a **deployment blocker** — every source's peers would
have to be hardcoded/operator-provisioned, which doesn't scale to the parachain set and breaks on peer churn.
It's a *completeness* gap, not a safety one (fetched data is still verified against a trusted anchor regardless
of which peer served it).

**Suggested direction:** implement a `SourcePeers` impl backed by **relay-chain authority discovery / DHT** —
resolve a source `ParaId` → its current collators' `PeerId`s/addresses — behind the existing trait seam (no
call-site changes needed; the seam is already there). MVP-acceptable interim: keep the static registry for
tests / controlled deployments.

**Also covers archive-fetch peer selection (the wire protocol does *not* change).** Recovering an over-pruned
range from an **archive node** needs no `MessagesRequest`/`Response` format change — the wire is already
archive-ready: `MessagesRequest { stream, start, under, max_bytes }` (`wire.rs:54`) fetches from an **old
`start`** verifiable under a **current in-window `under` root**, chunked and resumable, and the response carries
`start_peaks` + `extension` + `tree_proof` binding `[start, under]`. A retaining archive node serves it verbatim;
a pruned node returns a `below-serving-horizon` `ServeError`. So the archive-recovery gap is **discovery, not
wire**:

- **Capability advertisement (this issue):** discovery must surface **which peers are archive nodes** (retain
  deep history) vs. regular ~25 h nodes — as peer metadata or a small handshake field — so the receiver routes
  deep-history requests to archive nodes instead of collecting `below-horizon` errors from regular peers and
  wasting round-trips. Discovery advertises **capability/retention, not just liveness.**
- **Fetch orchestration (`fetch.rs`, node-side):** the fetcher must **fall back to an archive node** on a
  `below-horizon` error and **page** the large historical range (multiple `start`/`max_bytes` round-trips). Client
  logic, not wire format.

So this doesn't add a 4th issue — it *sharpens* discovery: advertise/surface archive-node capability + fetcher
archive-fallback. (The wire format being archive-ready as-is is a credit to the design.)

**Cross-ref:** the #12531 coverage table above (step 6 = the only ⚠️ partial step); archive recovery = this +
issues #1 + #3 (see "#12593 revisited").

### [PoC issue] Serving horizon is a hardcoded 25 h `const` — no archive/long-retention mode

*Status: draft, not published.*

**Where:** `cumulus/client/spec-msg/src/archive.rs:87` (`pub const SERVING_HORIZON: Duration = 25 h`) +
`worker.rs:170–181` (unconditional `prune_payloads` + `prune_horizon`) +
`omni-node/…/spec_msg.rs:136` (archiver wired unconditionally).

**What:** every node prunes spec-msg material at a **hardcoded 25 h**, with **no config knob and no archive
mode**. The client reads none of the node's pruning/archive config (`--blocks-pruning` / `--state-pruning` /
`is_archive`). So a Substrate archive node is *not* a spec-msg archive node, and #12531's/#12593's "only archive
nodes can serve back messages" fallback **maps to nothing** — after 25 h the pruned tail is gone from *all*
collators, leaving a > 25 h-stalled receiver with no recovery path.

**Revamp needed:** `SERVING_HORIZON` must become **configurable, tracking the operator's retention window**, not
a fixed const. An archive / long-retention node (e.g. `--blocks-pruning` ≈ 30 days) should serve spec-msg data
for that window, not 25 h. Ideally auto-derived from the node's retention config so "run an archive node" gives
a spec-msg archive with no separate flag.

**Mechanism subtlety — which window, and re-derivation is bounded by *state*-pruning, not *blocks*-pruning:**

- **Serve from the store** for N days → set the archive's own retention to N days (works regardless of state
  pruning; duplicates data the node already has as blocks). Bound = the archive retention config.
- **Serve via re-derivation** (no duplicate storage) → the sender pallet **clears `OutboundMessages` every
  block** (transient, `pallet lib.rs:48`), so you must **re-execute** old blocks, which needs the **parent
  state** ⇒ bounded by **`--state-pruning`**, *not* `--blocks-pruning`. A node with 30-day block bodies but
  `--state-pruning 256` can only re-derive ~256 blocks. `--state-pruning archive` is the clean "serve
  everything" case.

**Suggested direction:** (a) make the horizon a config (default 25 h); (b) gate `prune_horizon` on the node's
archive mode (extend/disable in archive mode); (c) if using re-derivation for the long tail, key it off
`--state-pruning` (state availability), not block-body retention.

**Simplest fix — treat the Speculation Store *as* the archive (a large `--speculation-window`); no node archive
mode needed.** The store is **self-contained**: `SpecMsgArchive` holds payloads + leaf hashes + boundaries in its
**own aux DB**, populated at import, and serves *from that DB* — it never touches block bodies or state. So a
generously-sized window (`hours(30d)` or `size(1GB)`) makes it a spec-msg archive that serves that whole window
**regardless of how aggressively the node prunes blocks/state**. This sidesteps the two archive-mode caveats
entirely — **no `--state-pruning archive` requirement, no re-execution, O(1) lookups** — so retention becomes a
**first-class spec-msg policy (one knob)**, decoupled from the node's role. It **supersedes options (b)/(c)
above as the simplest path.** Trade-offs:

- **Duplicates data** — the store keeps its own copy on top of the node's blocks; a 30-day window ≈ 30 days of
  spec-msg data on disk. Bounded (`size(1GB)` = hard cap, time = soft). This is the disk-for-simplicity trade
  vs. re-derivation (stores nothing extra, but needs state-archive + re-exec).
- **Backfill** — a store only has data from when the node started *executing* imports, so a fresh archive-store
  node **accumulates** the window over time; **warp-sync skips execution ⇒ a gap** until it's run long enough (or
  you backfill via re-derivation / peer fetch).
- **Size vs. time** — a `size(1GB)` cap needs a size-based (oldest-first) eviction policy alongside the existing
  time (`prune_horizon`) and watermark (`prune_payloads`) axes — a small addition.

⇒ Core fix reduces to: **make `--speculation-window` a real, generously-sizable config (time *and* size), default
25 h.** Archive recovery then just needs *some* node running a large window + discovery to find it (issue #2) —
no archive-mode coupling, no re-derivation.

**Re-derivation option — attractive but two hard qualifiers (not a free "just re-execute" win):**

*Where it's simpler:* no second long-tail retention store, no `SERVING_HORIZON` knob to reconcile, no double
storage, and correctness is clean (deterministic re-exec → re-derived payloads/hashes/roots match committed
roots, verify against the anchor).

1. **Needs a *state* archive, not just a *blocks* archive.** `--blocks-pruning archive` keeps block *bodies*,
   but re-executing a historical block needs the **parent state**, and the sender pallet **clears
   `OutboundMessages` every block** (transient) — so you can't read old outputs from state, you must
   *re-execute*. That requires **`--state-pruning archive`**. `--blocks-pruning` 30 days + `--state-pruning 256`
   ⇒ can only re-derive ~256 blocks.
2. **Serving is expensive per request.** A store answers with an O(1) lookup; re-derivation **re-executes a
   *range* of blocks** — one block for a single payload, but *every block in the range* for an extension/proof
   (state gives the aggregate *frontier*, not individual leaf hashes — those live only in the pruned archive).
   Real CPU cost + a **DoS surface** (a cheap request forcing many re-executions).

⇒ Re-derivation is best as a **cold-tail fallback on state-archive nodes, behind the fast hot-window store**
(don't re-execute on normal ≤ 25 h fetches), with a **rate-limit / cost guard** — *not* a wholesale replacement
for the store.

**Cross-refs:** the "no-prune mode isn't archive-specific" discussion and the #12593 store-mechanism section
above (offchain-indexing is *worse* here — it ignores pruning mode entirely).

## #12535 (SpecMsg XCM router) — addressed in code (issue still open on GitHub)

`SpecMsgRouter` in `cumulus/pallets/spec-messaging/src/xcm_router.rs` implements `SendXcm`, wired into real
runtimes. Requirement-by-requirement:

| #12535 requirement | Status |
| --- | --- |
| Implement `SpecMsgRouter` (`SendXcm`: `validate`/`deliver`) | ✅ |
| Placed **before** `XcmpQueue` in the router tuple | ✅ `penpal/xcm_config.rs:458–460`, `asset-hub-westend/xcm_config.rs:532–534` |
| HRMP channel open ⇒ `SendError::NotApplicable` (fall through to XcmpQueue) | ✅ `xcm_router.rs:103–107` |
| Deliver via `append_messages(XCM(payload))` | ✅ via `Pallet::send(channel, encoded_xcm)` (`:139`) |
| Check dest is a spec-msg destination | ✅ **but different mechanism** — `is_outbound_channel_open(dest)` (dynamic per-channel state) instead of a static `SpecMsgDestinations` set (`:115`) |

**Refinements beyond the issue text:**

- **`Full` HRMP channel counts as open** — HRMP wins even at capacity (`:96–100`).
- **HRMP `Closing` lifecycle** handled — during drain-before-close the still-open HRMP keeps draining (`:103`).
- **Spec-msg channel at capacity ⇒ hard `SendError::Transport`, never `NotApplicable`** (`:127–132`) — so
  backpressure surfaces to the app rather than silently falling through (HRMP is gone by then). Same
  `ensure_credit` → `NoCredit` path as the backpressure section above.
- Wired into a **production-shaped runtime** (asset-hub-westend), not just a test.

So: implemented, more precisely than the issue text (dynamic channel-state check, capacity semantics,
HRMP-closing lifecycle), correctly placed. Only deviation: `is_outbound_channel_open` in place of a static
`SpecMsgDestinations` list — same intent, arguably better. (GitHub issue still shows OPEN / unassigned — code
done, issue not closed.)

## #12531 (umbrella MVP) — PR #12699 coverage: 7 of 8 flow steps done, discovery is the gap

#12531's 8-step end-to-end flow (its sub-issue list) mapped to the PoC code:

| # | Step | Status | Where |
| --- | --- | --- | --- |
| 1 | Sender: route XCM to spec-msg if no HRMP | ✅ | `SpecMsgRouter` (#12535), before `XcmpQueue` |
| 2 | Sender: append + emit `Provides` | ✅ | pallet `OutboundMessages` + `commit_streams_root` → `Provides` UMP + header digest |
| 3 | Sender/node: extract via runtime API + serve P2P | ✅ | `consumption_record()` API + `SpecMsgArchive` + `SpecMsgRequestHandler` |
| 4 | Relay: `LatestProvides` window matches `Requires` | ✅ | `spec_msg` pallet / `RecentProvides` (#12349) |
| 5 | Receiver/node: monitor relay for matching UMP signals | ✅ | `run_relay_provides_monitor` |
| 6 | Receiver/node: **fetch + verify via P2P added dynamically** | ⚠️ **partial** | fetch/verify ✅ (`fetch.rs`/`verify.rs`); **dynamic peer discovery ✗** |
| 7 | Receiver/node: propagate via inherent | ✅ | `SpecMsgInherentData` + `lift_assembler` |
| 8 | Receiver: forward to XCM queue | ✅ | `enact_messages` → `Queue::enqueue_message` (mirrors XCMP path) |

**The one core gap — step 6's "added dynamically":** the PR flags it (*"doesn't implement full DHT scraping for
counterpart parachain"*), and the code confirms a **placeholder** — peer sourcing is a **static `PeerRegistry`**
manually populated from node config (`omni-node/…/spec_msg.rs:143–148`); the intended **DHT / authority-discovery
of a source's collators** is architected but not built (`exchange.rs:30–32`, "*plugs in behind the `SourcePeers`
trait*"). So the flow is **end-to-end functional on a manually-configured peer set, not self-discovering** — a
real deployment blocker.

**Secondary robustness gaps (not flow steps, but affect completeness):**
- `prune_horizon` over-prunes channel payloads → > 25 h-stalled channel can't catch up (drafted PoC issue above).
- No archive-node retention mode → hardcoded 25 h for all nodes; the "only archive nodes serve" fallback isn't
  realized.

**Bottom line:** substantially addressed, **not fully**. All 8 steps have working implementations wired into
real runtimes (asset-hub-westend, penpal), and the individual sub-issues (#12349/#12535/#12592/#12593) are done
— but it's a **functional end-to-end PoC on a static peer set**, one discovery layer + two retention fixes short
of deployment-complete for #12531.

## Offchain-indexing would *not* respect archive mode — refines the store-mechanism debate

Question: if the store were offchain-indexing instead of the bespoke `SpecMsgArchive`, would it respect the
node's archive mode and keep > 25 h on archive nodes? **No — and it'd be a worse fit for the archive tier.**

**Offchain-indexed data isn't governed by block/state pruning.** `offchain_index::set` writes to a **separate
offchain-storage column**, distinct from block bodies (`--blocks-pruning`) and trie state (`--state-pruning`);
neither knob touches it. So the data:

- **persists regardless of archive vs. pruned mode** — a pruned node keeps it as long as an archive node;
- is **not reverted on reorg** and **not pruned on finalization** (why `pallet-mmr` needs fork-aware
  temp/canonical keys + a canonicalization gadget);
- goes away only when the **runtime explicitly `offchain_index::clear`s** it.

⇒ offchain-indexing gives **"every node retains indefinitely until cleared"** — *unbounded* growth on all
nodes, arguably **worse** than the bespoke store (which at least bounds at 25 h). It does **not** yield "archive
keeps > 25 h, others prune."

**And archive-awareness is *harder* with offchain-indexing.** Its retention/clearing decision lives in the
**runtime** (which writes/clears offchain data during execution), and the runtime **can't see `--blocks-pruning`
mode** (node config, not on-chain state) — so you can't cleanly gate it on archive mode. The bespoke
`SpecMsgArchive` is the opposite: **node-side, with the config in scope**, so gating `prune_horizon` on
`--blocks-pruning archive` is a small local change.

**Refinement of the earlier offchain-indexing lean:** offchain-indexing is fine as a *populate-on-execution*
mechanism, but for **retention / archive-tiering it's a poor fit** (persists regardless of mode; archive-logic
must live in the runtime, which lacks the config). So for the archive tier:

- **via retention** → the **bespoke store** is easier (node-side, has the config);
- **via re-derivation** (option 2) → **store-agnostic and cleanest**: an archive node re-executes retained block
  bodies to regenerate payloads on demand, so the tier falls out of existing block retention regardless of store.

Net: this is a point **for** lexnv's bespoke-store choice on the archive-tier axis — reversing the direction of
my #12593 offchain-indexing argument *for retention specifically*.

## #12535 routing: separated `SpecMsgRouter` vs. routing through `XcmpQueue` — separated is cleaner

Question: is #12535's design (a separate `SpecMsgRouter` placed **before** `XcmpQueue` in the router tuple) the
right shape, or should HRMP + spec-msg both route *through* `XcmpQueue` (as `ron/speculative-messaging-poc` did
for penpal)?

**Deciding fact — `XcmpQueue` is intrinsically HRMP.** Its `Config::ChannelInfo: GetChannelInfo`
(`xcmp-queue/lib.rs:122`) drives the whole send decision — `get_channel_status` → `ChannelStatus::{Closed, Full,
Ready(max_size…)}` (`:1108–1121`) — and is bound to **`ParachainSystem`** (`type ChannelInfo = ParachainSystem`,
penpal:668 / asset-hub-westend:1091), i.e. the **relay-derived HRMP channel status/watermark** (legacy HRMP
model). So `XcmpQueue`'s routing logic *is* the HRMP channel model, by construction — not a generic sibling
transport.

**Why that makes "route through `XcmpQueue`" a poor fit.** A spec-msg channel's state lives in
`pallet-spec-msg`, not in the relay HRMP state `ChannelInfo` exposes. So routing spec-msg through `XcmpQueue`
would mean either **overloading its HRMP-specific model** with foreign semantics, or a **wrapper** that just
delegates HRMP→`XcmpQueue` + spec-msg→`pallet-spec-msg` — which is the separated approach in disguise, only less
composable. (This retracts the "demux wrapper is a clean middle ground" idea from earlier — `XcmpQueue` can't be
the unified decision point *because* it's HRMP-only, so the wrapper loses its one advantage.)

**⇒ Separated `SpecMsgRouter` (#12535) is cleaner.** Each transport keeps its own channel model: `XcmpQueue`
reads HRMP `ChannelInfo` and sends HRMP; `SpecMsgRouter` sends via `pallet-spec-msg` and reads HRMP `ChannelInfo`
**only** to yield precedence ("HRMP wins while a channel exists") — exactly what the lexnv impl does
(`SpecMsgRouter<T, ChannelInfo, …>`). `XcmpQueue` stays untouched; spec-msg is self-contained and composable
with other routers.

**The one cost:** the **tuple-order invariant** — `SpecMsgRouter` must precede `XcmpQueue` (which accepts *any*
sibling, so it grabs everything if it's first), and a reorder silently disables spec-msg routing. Worth
documenting + guarding with a test, but a small price versus overloading an HRMP-specific pallet.

**Verdict:** #12535's separated-router design makes sense and is the right call; don't route spec-msg through
`XcmpQueue` (it's HRMP-coupled via `ChannelInfo`→`ParachainSystem`).

## #12593 revisited — issue-body assessment, store preference, and archive recovery

**Is the #12593 issue body correct?** Directionally yes, with two mismatches to reality:

- ✅ dedicated **Speculation Store** + populate from `outbound_messages` after import — correct, and what lexnv
  built (`SpecMsgArchive`).
- ✅ "messages must outlive the pruning window" — correct rationale.
- ⚠️ the **`--speculation-window` CLI flag is *not* implemented** — lexnv hardcodes a 25 h `const`, no
  `size`/`hours`/`disabled` knob.
- ⚠️ **retention model oversimplified** — a single window doesn't capture the actual two-axis scheme (payloads
  by watermark, leaf hashes by horizon) or the channel-payload-recomputation nuance. The issue's `size(10MiB)`
  ≈ backpressure-bounded tail, `hours(24)` ≈ time horizon — presented as interchangeable knobs, which they
  aren't.
- ⚠️ **"only archive nodes can provide" is aspirational** — no archive-node mode exists (all prune at 25 h).

**Do we still prefer the dedicated Speculation Store?** **Yes — reversed from my earlier offchain-indexing
lean.** Offchain-indexing ignores `--blocks-pruning`/`--state-pruning` (persists unbounded, archive-awareness
must live in the runtime which lacks the config); the bespoke store is node-side, bounded, and archive-aware-able.
So the issue's Speculation Store is the right call. (Offchain-indexing is fine only as a *populate* mechanism.)

**"Recover from archive nodes" if over-pruning happens — today you can't.** It's blocked by exactly the three
drafted findings, all of which must land:

1. **Archive-node retention** (issue #3) — configurable horizon / gate on `--blocks-pruning`/`--state-pruning
   archive`, or re-derivation on a state-archive node. Without it, archive nodes don't exist (all prune at 25 h).
2. **Archive-node discovery** (issue #2) — the receiver must *find* archive nodes serving the source; today's
   static `PeerRegistry` can't, and discovery must surface archive nodes, not just live collators.
3. **Channel-payload retention** (issue #1) — for channels, keeping the **payloads** is what enables recovery
   (recomputation regenerates leaf hashes); `prune_horizon` currently drops them as "unprovable dead weight."

**Hard boundary even with all three:** recovery requires the receiver to **lift its old consumption to a
*current* in-window `StreamsRoot`** — needs recent proof material *and* the **sender still live** (a recent root
in the relay window to bind to). If the **sender chain is dead**, there's no in-window root → the channel is
genuinely unrecoverable, archive nodes or not. Archive-node recovery covers **stalled-receiver** cases (sender
alive), **not dead-sender** cases.

⇒ "archive-node recovery" is the design's fallback but **entirely unbuilt** — it's the union of drafted issues
#1 + #2 + #3, plus the intrinsic "sender must be live" limit. Until those land, over-pruning past 25 h is
unrecoverable from the normal network.

## Consolidated upstream issue — ready to file (draft)

*Copy-pasteable single issue folding all three findings. Not yet filed. Frames them as deployment-completeness
follow-ups to #12699, none safety.*

---

**Title:** spec-msg PoC (#12699): retention & peer-discovery follow-ups for deployment-completeness

The MVP end-to-end flow in #12699 is solid and covers #12531's steps. A few follow-ups remain before it's
deployment-complete, grouped into two themes. **None are safety issues** — fetched data is always re-derived and
verified against a trusted `StreamsRoot` anchor regardless of which peer served it; these are completeness /
recoverability gaps.

### 1. Retention: hardcoded 25 h horizon over-prunes channels and isn't operator-tunable

**Current:** `SERVING_HORIZON` is a hardcoded 25 h `const` (`client/spec-msg/src/archive.rs:87`);
`prune_horizon` (`archive.rs:474–485`) drops leaf hashes *and* above-watermark payloads at 25 h; the worker runs
it unconditionally (`worker.rs:170–181`); no config knob; the client reads none of `--blocks-pruning` /
`--state-pruning`.

Two problems:

- **(a) Over-prunes channel payloads.** Channels verify by *recomputation* (`leaf = hash(payload)`,
  `mmr.rs` `MmrInclusionProof` doc), so a late receiver only needs the **payloads** — it re-hashes them and
  extends its own frontier; the sender's stored leaf hashes for the consumed range are never needed. But
  `prune_horizon` drops above-watermark payloads at 25 h as "unprovable dead weight" — a justification that
  holds for proof-based (register/event) reads but **not for channels**. Result: a channel receiver stalled
  > 25 h can't catch up even though recomputation would allow it. *The payload is the recovery unit for
  channels, not the leaf hash.*
- **(b) Not operator-tunable / no archive mode.** 25 h is fixed; there's no way to run a longer-retention node,
  and the intended "only archive nodes can serve back messages" fallback maps to nothing (every node prunes at
  25 h).

**Suggested fix:** make `--speculation-window` a real config (**time *and* size**, default 25 h), and
**decouple channel payload retention from the leaf-hash horizon** (retain payloads for the window; don't drop
them as "unprovable"). Two-axis model: payloads pruned by the confirmation **watermark** below, retained for the
window above (backpressure-bounds it); leaf hashes by the window. Sized large, **the Speculation Store *is* the
archive** — it's self-contained (own aux DB, populated at import, serves without touching block bodies/state),
so **no node archive mode is required**.

### 2. Peer discovery: static registry, no dynamic (DHT) discovery

**Current:** peer sourcing is a static `PeerRegistry` (`client/spec-msg/src/exchange.rs`) manually populated from
node config (`omni-node/…/spec_msg.rs:143–148`); relay-chain DHT / authority discovery is architected behind the
`SourcePeers` trait but not built (the PR notes this).

**Problem:** the flow works only on a **manually-configured peer set** — a receiver can't self-discover a
counterpart parachain's collators, so this is a deployment blocker (peers would have to be hardcoded, doesn't
scale, breaks on churn).

**Also — archive-fetch peer selection (no wire change).** The wire protocol is already archive-ready:
`MessagesRequest { stream, start, under, max_bytes }` (`wire.rs:54`) fetches from an old `start` verifiable
under a current in-window `under` root, chunked/resumable. So deep-history recovery needs **no request/response
format change** — only that discovery **surface which peers are archive nodes** (retain deep history), and the
fetcher **fall back** to them on a `below-serving-horizon` error (+ page the range).

**Suggested fix:** a `SourcePeers` impl backed by relay-chain authority discovery / DHT (behind the existing
trait seam); surface archive-node retention capability; add fetcher archive-fallback + paging.

### Note

Retention (1) and discovery (2) together are what "recover from archive nodes after over-pruning" requires — a
large-window node to hold the data *and* discovery to find it. One intrinsic limit remains regardless: recovery
needs the **sender still live** (an in-window `StreamsRoot` to lift old consumption to); a dead-sender channel
is unrecoverable by design.

---

## Constant comparison — window `W` vs. requires cap (ours vs. lexnv)

Two easily-confused constants; only one differs.

| constant | meaning | ours | lexnv |
| --- | --- | --- | --- |
| **provides window `W`** | per-sender ring size (recent `StreamsRoot`s kept) | `MAX_PROVIDES_WINDOW_SIZE = 128` (on `rk-spec-msg-relay`) | `RECENT_PROVIDES_WINDOW = 128` |
| **requires cap** | # distinct source paras a *single candidate* requires-from in one block | `MAX_SOURCES_PER_BLOCK = 128` | `MAX_COMMITMENT_ENTRIES = 256` |

**Window `W` = 128 in both — no divergence.** Sized to cover authoring→backing→inclusion incl. elastic-scaling
bursts (~13 min at 6 s sender blocks, ~64 s at 500 ms), ample slack. Keep it (design wants it
governance-adjustable eventually; `const` fine for MVP).

**Requires cap — lean 128 (ours), not 256:**

- It bounds how many distinct sources *one* receiver candidate requires-from in *one* block — a candidate
  consuming from >128 different paras in a single block is already wildly unrealistic, so 128 is generous
  headroom; 256 is headroom-on-headroom that won't be hit at the candidate level.
- It's a **worst-case cost driver**: receipt growth (`cap × 36 B` → ~4.6 KB vs 256's ~9.2 KB) and the relay
  requires-match work per candidate. We benchmarked the match at 128 (`enter_backed_candidates_variable` wired
  to a full 128-entry set); **256 doubles** that fixed worst-case charge on every backed candidate for no
  functional gain.
- Symmetry with `W = 128` (independent concepts, but tidy).

lexnv's 256 is defensible (sizes to "require from every para" + future para-count growth) but that ceiling
isn't hit per-candidate and costs 2× worst-case. **Not a correctness issue — a bound-sizing call.** Align on one
value when #12349's sub-issue is finalized; 256 is acceptable if matching lexnv reduces friction, just note the
2× worst-case cost. (Also recall the earlier tag-byte difference: ours `0x2–0x6` vs lexnv `0x1–0x6` + `EMPTY_TAG`.)

## Relay-match wire points — identical in both impls (only the callee differs)

Confirmed the integration surface into `inclusion`/`paras_inherent` is the **same** in both impls; the
dedicated-pallet-vs-embedded choice is only *where the storage + three fns live*, not *where they're called from*.

| Wire point (call site) | lexnv (dedicated `spec_msg` pallet) | ours (methods on `inclusion::Pallet`) |
| --- | --- | --- |
| **record provides** — in `enact_candidate` | `inclusion/mod.rs:921` → `spec_msg::…::note_provides` | `inclusion/mod.rs:949` → `Self::record_provides` |
| **check requires** — in `sanitize` | `paras_inherent:1049` → `spec_msg::…::check_requires` | `paras_inherent:1219` → `inclusion::…::requires_satisfied` |
| **clear/evict** — at the freeze transition | `paras_inherent:449` → `spec_msg::…::evict_after_revert` | `paras_inherent:450` → `inclusion::…::clear_provides` |

Same three call sites (`enact_candidate` in inclusion; `sanitize` + freeze-transition in paras_inherent) — line
numbers even line up. The only difference: lexnv's sites call **into a separate `spec_msg::Pallet`** (storage +
fns live there); ours call **methods on `inclusion::Pallet`** (storage + fns embedded in inclusion).

**Implication for the deferred dedicated-pallet option:** adopting it later is a **pure mechanical relocation** —
move `RecentProvides` + the three fns out of `inclusion` into a new `spec_msg` pallet, and change the three call
sites from `Self::`/`inclusion::…` to `spec_msg::…`. No wire-point change, low risk — which is exactly why it's
safe to defer (and it buys a natural home for a future `W`-as-config knob). See the relay-match borrow analysis
above ("worth borrowing" = the structured requires error; "skip for now" = the dedicated pallet).

## #12707 (node-side umbrella) review — separation sound, retention spec under-specified

#12707 = "spec-msg/node: Implement the client side" — the **node-side** umbrella, split into 5 work streams
(each with a PoC ref).

**Separation — makes sense.** Clean, dependency-ordered decomposition:

| # | stream | component | #12531 step |
| --- | --- | --- | --- |
| 1 | #12593 | DB store / archive (serve + prune) | 3 (serve on p2p) |
| 2 | #12595 | request-response + **DHT discovery** + peer pool | 6 (fetch transport) |
| 3 | #12583 + fetcher | relay monitor + Fetcher + inherent provider | 5, 6, 7 (receiver path) |
| 4 | lift assembly | `assemble_lifts` + `lift_assembler` + **V3 collation** | 7 + collator emission |
| 5 | enable | wire into `polkadot-parachain` | integration |

Store → networking+discovery → receiver → sender/collator-lift → wiring. Correctly scoped **node-side only**
(runtime emission / relay-match / XCM router are separate); lift-assembly + V3 collation correctly node-side;
"idle on non-participating parachains" is the right optional-feature property. Positives vs. earlier findings:
**DHT discovery is explicitly in scope (#12595)** — the discovery gap is *planned*, not overlooked. (Minor:
peer pool appears in both #12595 and stream 3 — clarify ownership.)

**Respects v0.5 — mostly, but #12593's retention is under-specified.** Described as "historic MMR nodes,
persist up to 25 h, prune below" — thinner than the design's actual model. Three gaps (= our three drafted
findings, which belong here now):

1. **Two-axis, not one** — the design prunes **payloads by the confirmation *watermark*** (flow-control) and
   **leaf hashes / MMR nodes by the 25 h *horizon***; the issue only names the horizon axis.
2. **Channel payloads are the recovery unit** — channels verify by *recomputation*, so a late receiver needs
   the payloads; "prune below 25 h" over-prunes them (drafted issue #1).
3. **Window should be configurable, not hardcoded 25 h** — sized large the store *is* the archive
   (self-contained, no node-archive-mode), the way to realize "archive nodes serve" (drafted issue #3).

Secondary: **#12595 should surface archive-node *capability*** (which peers retain deep history) so beyond-25 h
fetch routes correctly — wire needs no change (already `start` + `under` root + `max_bytes`).

**Net:** the components/separation are right and node-side-scoped correctly; the enrichment needed is
**#12593's retention spec** (two-axis watermark/horizon + channel-payload-recomputation + configurable
store-as-archive) and **#12595's archive-capability advertisement**. ⇒ feed the drafted retention findings into
**#12593** and the discovery finding into **#12595** (their proper homes now that the node side is split this
way), rather than a standalone PoC issue.

### What "the design's actual retention model" means (the three phrases unpacked)

All three rest on one distinction — **payloads vs. leaf hashes** — so build from there.

**Foundation: two kinds of material, two purposes.**

- **Payloads** = the message *content* (XCM bytes). Needed to **consume** (execute) the message.
- **Leaf hashes** = `hash(payload)` = MMR **proof material**. Needed to build **extension/lift proofs** (bind a
  consumption to a committed root). *Payloads are not needed for a proof.*

The two *materials* are real — but the retention **rule is keyed on the *stream type*, not the material**, and
each rule prunes *both* materials together.

**1. Per-stream-type single rule (NOT a per-material two-axis split).**

> **Correction:** an earlier framing here (and lexnv's PoC) said "payloads by watermark, leaf hashes by horizon"
> uniformly. That's **lexnv's implementation, an over-complication — not the design.** The design keys the rule
> on stream type:

- **Channels → confirmation *watermark*.** Retain everything **above W** (payloads *and* leaf hashes, together);
  prune below. The design says exactly this — *"the sender retains everything above the confirmation
  watermark"* — and that sentence is about *proof/leaf* material. Leaf hashes below W are never needed (a lift
  only extends *forward* from the receiver's own frontier), so **one watermark rule prunes both**; the retained
  tail is bounded by backpressure.
- **Events / broadcast → time *horizon* (~25 h).** No watermark exists, so the horizon is the *only* rule —
  again pruning **both** materials.

So it's **one prune function parameterized by stream type** (watermark for channels, horizon for events), each
pruning payloads + leaf hashes together — *not* a uniform payloads-by-watermark / leaf-hashes-by-horizon split.
lexnv's uniform "leaf hashes by horizon for all streams" is exactly what causes **both** defects: channel
leaf-hashes over-*retained* (kept 25 h below W) **and** channel payloads over-*pruned* (point 2).

**Caveat — can't just *skip* leaf-hash pruning** ("they're small"): 32 B per message *forever* is unbounded.
Prune them with the *same* rule as payloads (per stream type), not a separate axis — bounded by backpressure
(channels) / the horizon (events).

**2. Channel-payload-recomputation.** For **channels**, consumption **verifies by recomputation, not proofs**:
`leaf = hash(payload)`, so a late receiver fetches the **payloads**, re-hashes, and extends its own frontier —
it *never* needs the sender's stored *leaf hashes* for the consumed range. ⇒ **the payload is the recovery unit
for channels, not the leaf hash.** So channel payloads must *not* be over-pruned; the PoC's `prune_horizon`
dropping above-watermark channel payloads at 25 h as "unprovable dead weight" forecloses > 25 h catch-up that
recomputation *would* allow.

**3. Configurable window / store-as-archive.** The serving window should be a **config knob (time *and* size)**,
not a hardcoded 25 h `const`. Sized large, the **Speculation Store *is* the archive** — self-contained (own DB,
populated at import, serves without touching block bodies/state), so a large `--speculation-window` (e.g. 30 d /
1 GB) serves deep history **regardless of the node's block/state pruning** (no `--blocks-pruning archive`
needed). Simplest realization of "archive nodes can serve back messages."

**So #12593 should say** (instead of "keep MMR nodes up to 25 h, prune below") — **one prune keyed by stream
type, each covering both payloads and leaf hashes:**

- **channels** → **watermark**-driven: retain everything above the confirmation watermark (both payloads *and*
  leaf hashes), prune below; the tail is backpressure-bounded. Channel payloads are the recovery unit
  (recomputation) — not dropped as "unprovable";
- **events / broadcast** → **horizon**-driven (no watermark exists): retain within the serving window, both
  materials;
- the horizon window is a **config** (default 25 h, sizable, *time or size*); a large one makes the **store the
  archive** (no node-archive-mode);
- ⇒ **not** a uniform payloads-by-watermark / leaf-hashes-by-horizon two-axis split (that's lexnv's
  over-complication and the source of the channel over-retain/over-prune defects).

(See the fuller treatment in the retention sections above: "archive.rs retention vs. our flow-control view",
"channels reliable only within ~25 h", the drafted issues #1/#3, and the "store-as-archive" fold-in.)

## Event/register exchange & pruning — and a stalled-head defect in the PoC

**How register/ack event streams exchange.** An Ack/register stream is *just an outbound stream on the
publisher's side* — lossy, latest-wins, no resume state. For an `A→B` channel:

- **B publishes** `Register { up_to: MessagePosition, grant: WindowGrant, closed: bool }` on B's
  `Ack{recipient: A}` stream (`channel.rs`). `up_to` = B's cumulative consumption watermark of A's data,
  `grant` = credit beyond it, `closed` = receiver teardown. It's a normal outbound stream, so it folds into
  **B's `StreamsRoot`** at end-of-block (`commit_streams_root`) — provable under B's committed root.
- **A reads** B's register as an **event/head read** (not a range read): `at: None` → `position = count-1`,
  served by `SpecMsgArchive::serve_event` (`archive.rs:556`) returning `EventResponse { payload, inclusion,
  tree_proof }`. A verifies the head by **inclusion proof under B's committed StreamsRoot** (`verify_head`),
  *not* recomputation — lossy consumer.
- **Monotonic latest-wins**: pallet ignores registers whose `up_to`/`version` regress (`lib.rs:82-83`, err at
  `849`). A stores the accepted register in `InChannelState`; **A does not re-fetch** each block — only on a
  fresher publish. `ConsumedStream` never carries `Ack` (no resume state — always want the head).
- **The register's `up_to` drives A's channel-data pruning**: `confirm(up_to)` (`lib.rs:355`) releases A's
  outbound channel payloads/leaves below the confirmed watermark. So the event stream is the flow-control
  backchannel that both grants credit *and* authorizes A's own pruning.

**How they prune.** Event streams have **no watermark** → only the **horizon** governs them (`prune_horizon`,
`archive.rs:442`, ~25 h `SERVING_HORIZON`). Drop boundaries older than cutoff (keep newest, `len() > 1`), then
advance each stream's floor to `oldest_retained_boundary.count(stream)`, deleting leaf hashes + payloads below
it (`474-484`). Channel-data streams get an additional watermark floor (`prune_payloads`); event streams are
horizon-only.

### Latent gap: a fully-drained-then-quiet register head can age out under a still-servable root

The pruning mechanism (`prune_horizon`): `new_floor = oldest.count(&id)` (`465`) is the stream's **leaf count**
at the oldest retained boundary, and `payload_floor = payload_floor.max(new_floor)` (`484`). For a stream that
**stops producing leaves** while its parachain keeps producing blocks, the leaf count freezes at `P` while
boundaries advance; once every >25 h boundary is dropped `oldest.count == P`, so `new_floor = P` and the loop
at `474` deletes the **head** at `P-1` (leaf hash *and* payload). Then `serve_event` for the head
(`position = P-1`) hits `position < payload_floor` → **`PayloadsPruned`** (`567`) while `serves_root(root)` is
still **true** — a broken `serves_root ⇒ serve_event(head)` invariant. Channel-data streams are shielded (their
`payload_floor` also tracks the lagging watermark); event/register streams have no watermark, so the horizon
can reach the head.

**But the PoC already mostly mitigates this with `RegisterPublishAge` (`lib.rs:607`).** The register is *not*
re-emitted every block — it publishes on acceptance, on ~¼-window consumption progress, or on an age backstop.
Both republish paths **gate on unreported progress**:

- synchronous (`1542`): `age >= RegisterPublishAge && messages_since > 0`;
- `on_initialize` age sweep (`898-918`), the real backstop: `age >= RegisterPublishAge` **and**
  `InboundFrontier.leaf_count > state.published.up_to.0` (`917-918`) — the receiver consumed past its last
  reported watermark.

> **This sweep is the receiver-side republish — the *producer* end of the register-read flow.** It iterates
> `InChannels` (receiver-role state), so it runs in the data-**receiver** B's runtime and republishes **B's own**
> register (a fresh leaf on B's outbound `Ack{recipient:A}` stream). It publishes the **watermark scalar**
> `up_to = InboundFrontier.leaf_count` (+ `grant`/`closed`), not the frontier itself — A never sees B's peaks.
> The gate `InboundFrontier.leaf_count > published.up_to` = "unreported consumption progress." **Why B bothers**
> (`900-903`): so the **sender** A can *reclaim credit and prune its archive* — B's `up_to` drives A's
> `OutChannels[B].register.up_to` → A's `prune_payloads`. So this is B pushing its frontier-derived watermark
> out; A pulls it in via the head-read flow. That both republish paths gate on unreported progress is exactly
> why a fully-drained-then-reported-then-quiet channel (`InboundFrontier == published.up_to`) stops republishing
> — the freeze condition below.

With `RegisterPublishAge = 10 min` (asset-hub, `lib.rs:1128`) vs `SERVING_HORIZON = 25 h` (`archive.rs:87`),
**any channel with a lagging watermark re-publishes ~150× under the horizon → the head never freezes.** The
freeze is reachable **only** in one narrow state: the receiver has **fully drained the channel and published a
register saying so** (`published.up_to == InboundFrontier.leaf_count`), then both paras go quiet — now neither
guard fires, the head is frozen at its accurate final value, and after 25 h the horizon prunes it.

**Severity: latent invariant break, no honest-path break.** Even in the drained-quiescent state the impact is
thin: the only reader of B's register is A (the sender), which reads it to reclaim credit / prune, then caches
it in A's own `OutChannels` state (recovered via A's *own* sync). A never re-fetches that final register from B.
So no honest steady-state flow breaks. What remains is the invariant: a future consumer that head-reads a
register under a *live* root without a local cache — an indexer, a monitor, a liftability path re-deriving from
current roots — would see `serves_root` true but `serve_event(head)` fail.

**Open question for #12593:** given the `RegisterPublishAge` heartbeat + A-side caching, is a lossy-head
carve-out still worth it, or is caching considered sufficient?
1. **Lossy-head carve-out** — `prune_horizon` always retains the last leaf's payload + a minimal inclusion path
   for event/register streams, even below the floor. Restores `serves_root ⇒ serve_event(head)` unconditionally.
2. **Document caching as the contract** — register head-reads are bootstrap-only and otherwise A-side-cached;
   accept that a drained-quiescent register isn't independently servable past the horizon.

⇒ **fold into #12593** alongside the retention findings above.

## `cumulus/client/spec-msg/src` review — the E2E node crate (lexnv branch)

Full read of the client crate (11 modules, ~5.3 k lines) on `lexnv/spec-msg-poc-mvp`. **Verdict: high-quality
and faithful to v0.5 — well beyond typical PoC quality** (thorough module docs, strong tests on the tricky
fork/reconciliation paths). It is the off-chain half around the on-chain `StreamsRoot`: payloads travel
off-chain, only the hash is on-chain.

### What it does (module map)

**Sender side**
- `archive.rs` (`SpecMsgArchive`) — aux-KV store keyed `(stream, position)` (payloads + leaf hashes) + per-block
  frontier *boundaries* + a `root → block` index. Serves `serve_messages` (chunked ranges) and `serve_event`
  (single/head reads), each proven under exactly the named `StreamsRoot`. Retention: `prune_payloads`
  (watermark) + `prune_horizon` (25 h). Root recomputed over **all** streams' frontiers (`import_block_at`);
  zero-leaf streams never enter `self.streams` ⇒ structural empty-stream omission. Frontier is the persistent
  accumulator — pruning deletes leaf hashes/payloads but never the frontier, so roots stay correct post-prune.
- `worker.rs` (`run_spec_msg_archiver`) — follows best blocks, extracts sends via `SpecMsgApi::outbound_messages`,
  imports, then retention (channel payloads below each peer's `out_channels()` register watermark, then horizon).
- `protocol.rs` / `exchange.rs` — `/spec-msg/exchange/1` req-resp (chain-agnostic name: receiver dials *sender*
  peers) + requester transport with per-source peer sets + bad-peer eviction.

**Receiver side**
- `monitor.rs` (`run_relay_provides_monitor`) — watches relay imports, reads each consumed source's
  `RecentProvides` ring, offers each newly-included root once (+ pending-availability prefetch hints).
- `fetch.rs` (`run_spec_msg_fetcher`) — per included root, fetches consumed channel streams (chunked, resumable)
  + ack register head reads, verifies each against the root, pools them. Bounded in-root retry with backoff.
- `verify.rs` — trust-free: hash payloads → append to frontier → walk extension + tree proofs → compare to the
  named root. Nothing declared, everything derived.
- `pool.rs` (`SpecMsgPool`) — verified channel *ledgers* (contiguous run + binding to newest root) + register
  head reads; non-destructive hand-out discipline for fork safety.
- `authoring.rs` — builds the `specmsg0` inherent + assembles POV `RequiresLift`s and the synthesized `Requires`
  UMP signal from built blocks' `consumption_record()`s (`build_requires` run node-side ⇒ byte-identity with
  the `validate_block` wrapper).
- `nodes.rs` — global-position MMR leaf-hash view for extension/inclusion/`frontier_at` proofs.

### Consistency with v0.5 — strong

Faithfully implements the core tenets: one `StreamsRoot` commits all streams / payloads off-chain; trust-free
verification against a named root (`start_peaks`/`base`/`leaf_version` are untrusted hints that only fail the
end comparison); inclusion-tier anchor = newest included `Provides` root (`monitor`); POV-carried lift with
runtime-stores-frontiers / node-generates-material (`authoring` + node-side `build_requires`); resubmission =
pure re-derivation for unchanged blocks (`regenerated_lifts` test); multi-block bundling with stitched chains
(`assemble_from_records` + `chain_endpoint`); blake2 (`SpecHasher`) + MMR proofs. MVP-scoping matches the
design's phasing (req-resp only, no DA/live-push/notification, speculative-tier digests deferred, inclusion
tier only).

### Divergences & concerns

*Self-documented MVP gaps (consistent, not yet built):*
1. **Static peer discovery** — `PeerRegistry` (zombienet static); relay-DHT authority-discovery stubbed behind
   the `SourcePeers` trait. → #12595.
2. **No archive rebuild-from-peers / archive-node serving mode** — a node pruned below fork/origin idles;
   recovery is re-sync-with-execution. → #12593.
3. **Advance proofs / gap chains** — `assemble_from_records` errors `Gap`; register-read-once avoids own-authoring
   gaps, cross-collator gaps not liftable yet.
4. **Pending hints computed but ignored** — monitor emits `Pending` the fetcher drops; harmless, but wasted
   relay reads per block.

*Real concerns:*
5. **Retention two-axis** — `worker` prunes channel payloads by watermark (keeps leaf hashes), `prune_horizon`
   prunes leaf hashes for all streams. Exactly the model critiqued above (channel leaf-hash over-retain + the
   stalled-register-head defect). Already captured for #12593.
6. **Receiver-pool finalized retention unbounded except by chunking** — `pool.prune_channel` retains below-cursor
   payloads for fork safety, flags "retention against *finalized* consumption is future work." Fine at MVP
   volumes, a memory concern at scale.
7. **Wall-clock horizon** (`now_secs()`) — per-node non-deterministic retention timing. Acceptable (local serving
   policy, not consensus); worth a comment.

*Integration note vs. our branch (not a bug):* `monitor::read_recent_provides` decodes the ring as
`Vec<(StreamsRoot, RelayBlockNumber)>` — lexnv's **block-tagged** ring; ours (`rk-spec-msg-relay`) is a **bare**
`BoundedVec<StreamsRoot>` (clear-on-freeze). Crucially `note_ring` **ignores the block number entirely**
(`for (root, _) in ring`) — the client never needs the tag, which independently validates our bare-ring choice;
pairing this crate with our relay pallet only needs the decode changed to `Vec<StreamsRoot>`.

### Function-by-function walkthrough

Data flow: **sender** archives sends and serves them → **receiver** monitors the relay for included roots,
fetches + verifies under them, pools the result, builds the messaging inherent + POV lifts.

**`archive.rs` — sender-side store + serving.** Aux-DB-backed. State: per-stream (`StreamState`), per-block
(`Boundary`), and the `root_index`.
- Types: `SERVING_HORIZON` (25 h); `MAX_SERVED_PAYLOAD_BYTES` (4 MiB server cap); `ArchiveError`
  (mutation/load); `ServeError` (refusals — detail-free to peers, logged locally); `StreamState { frontier,
  floor, payload_floor }` (live frontier / horizon-floor frontier whose peaks tile pruned leaves / watermark);
  `Boundary { hash, number, archived_at, root, counts }` (+ `count` binary-search); `Meta`; `mod keys` (BE
  positions); `SpecMsgArchive { aux, streams, boundaries, root_index }`.
- `load` — reconstruct from aux + rebuild root index. `tip`/`contains_block` — newest boundary / rewind anchor.
  `serves_root` — root resolvable. `import_block`/`_at` — append path: child-of-tip check, store payload+leaf,
  advance frontier, recompute `StreamsRoot` over **all** streams, write boundary + root_index; empty-stream
  omission (stream enters `self.streams` only on a non-empty send). `rewind_to` — reorg: drop boundaries above
  ancestor, truncate frontiers (recompute before deleting), drop not-yet-born streams. `prune_payloads` —
  watermark prune, **keeps leaf hashes**. `prune_horizon` — drop old boundaries, advance floor to leaf count at
  oldest retained boundary, delete leaf hashes **and** payloads below (the stalled-head defect's mechanism).
  `serve_messages` — resolve `under`→boundary, cap at count, serve payloads (always ≥1) + `start_peaks` +
  extension + tree proof; `max_bytes=0` = pure lift material. `serve_event` — one leaf (`at` or head) +
  inclusion + tree proof. `tree_proof_at` — recomputed entry set, sanity-checked vs. the boundary's stored root.
  `boundary_for`/`nodes_for`/`payload`/`meta`/`rebuild_root_index`; `AuxLeaves` (aux `LeafHashes`); `now_secs`
  (wall clock); `read_aux`/`write_aux`.

**`nodes.rs` — on-demand historic MMR** (reused by `pool.rs`). `LeafHashes` trait; `HistoricNodes { leaves,
floor_leaf_count, floor_peaks, cache }`: `new` (map floor peaks to positions), `node` (recursive: floor peak /
retained leaf / merge; below-floor → `None`), `frontier_at`/`root_at`, `extension` (empty / new-peaks / ancestry
proof), `inclusion` (`mmr_lib` proof), `MMRStoreReadOps` adapter, `pos_to_leaf_index` (binary-search inverse).

**`worker.rs` — archiver loop.** `MAX_CATCHUP_BLOCKS` (20480); `WorkerError` (`Disconnected`, `TooFarBehind`);
`run_spec_msg_archiver` (best-block notifications); `archive_best_block` — **version gate**, walk back to tip or
spec-msg origin, `rewind_to` common ancestor on reorg, import `outbound_messages()`, then retention
(`prune_payloads` per channel from `out_channels()` watermark, then `prune_horizon(now−25h)`).

**`protocol.rs` — `/spec-msg/exchange/1`.** Constants (`PROTOCOL_NAME` chain-agnostic; 256 B req / 8 MiB resp;
15 s timeout; 64-queue → refusal). `spec_msg_protocol_config`; `SpecMsgRequestHandler { new, run, handle_request
}` (decode → serve → encode, else detail-free `Err(())`).

**`exchange.rs` — requester transport.** `ExchangeError` (`Network` doesn't discard the peer; `MalformedResponse`
/`Verify` do); `SourcePeers` trait (per **source chain**); `PeerRegistry` (MVP static; `report_bad` removes);
`ExchangeNetwork` trait + `Arc<NetworkRequest>` impl (`TryConnect`); `exchange_once` (encode/send/`decode_all`).

**`verify.rs` — trust-free verification.** `VerifyError` (any ⇒ discard response + peer); `VerifiedMessages`/
`VerifiedEvent`; `verify_messages_response` (base check; frontier from `own` or trust-free `start_peaks`; hash
payloads; extension→stream root; tree→`StreamsRoot`; compare `under`); `verify_event_response` (`verify_head`
proves head-ness — a stale leaf as head yields a different root).

**`monitor.rs` — receiver relay monitor.** `SourceProvides`/`RelayProvidesEvent::{Included,Pending}`;
`SEEN_ROOTS_BOUND` (512, eviction only dupes an offer); `SeenRoots`; `SourceState`; `ProvidesTracker`:
`retain_sources`, `note_ring` (diff ring; first-sight offers only newest; **ignores block number**),
`note_pending`; `pending_provides` (pure `ump_signals` parse); `read_recent_provides` (well-known key, decodes
block-tagged pairs); `run_relay_provides_monitor` (startup tip once, then per-import); `process_relay_block`
(skip while syncing; version-gate; sources = `consumed_streams` ∪ `out_channels` peers; ring diff →`Included`,
pending commitments →`Pending`).

**`fetch.rs` — fetch pipeline.** Constants (512 KiB chunk, 4096 chunk cap, 4 retries, 2→16 s backoff);
`retry_delay`; `FetchError`; `fetch_source` (channels then registers best-effort, `complete_round`);
`fetch_channel_stream` (prune to cursor, resume, chunked loop); `request_messages` (rotate peers; empty-chunk-
claiming-backlog = misbehavior); `fetch_register`/`request_event`; `run_spec_msg_fetcher`; `PendingRetry`
(`generation`-tagged); `run_fetch_rounds` (`select_biased!` timers vs. events; fresh `Included` supersedes retry;
`Pending` ignored; schedule tagged backoff on retryable errors); `RoundError` + `retryable` (transport/chunk-
bound retry; api/pool/no-peers don't); `fetch_included` (resolve from own runtime, version-gate, `retain_sources`).

**`pool.rs` — verified pool.** `RETAINED_REGISTER_READS` (4); `InherentBudget` (256 KiB / 8 streams);
`PoolError`/`LiftMaterialError` (loud); `ChannelBinding`; `ChannelLedger` (+ `nodes`, `LedgerLeaves`);
`RegisterRead`; `RegisterReads { reads, fresh, handed }` + `reconcile_handed` (monotonic `up_to`/`version`/close
vs. parent view; `grant` advisory); `SourcePool`/`SpecMsgPool`: `resume`, `note_chunk` (exact continuation +
rebind), `note_register` (newest-wins, bounded), `complete_round`/`target`, `retain_sources`, `prune_channel`
(retains below-cursor payloads for fork safety; finalized retention = future work), `build_inherent`
(contiguous continuation within budget, target-bound only, register hand-once), `channel_lift` (extension over
retained leaves or stored server-side), `register_lift` (empty extension + tree proof), `pooled_payloads`.

**`authoring.rs` — inherent + lifts.** `inherent_data_at` (version-gate; cursors + ack registers with parent
view; `build_inherent`; the result **is** an `InherentDataProvider`); `AssembleError` (loud); `assemble_lifts`/
`assemble_collation` (read `consumption_record()`s; `build_requires` node-side ⇒ byte-identical `Requires`);
`assemble_from_records` (merge bundle order, lift each stream, per-source root convergence, canonical
`LiftsBySource`); `chain_endpoint` (interval chain or `Gap`); `lift_assembler` (closure; failures log + yield
nothing → candidate fails validation if it consumed anything, regenerates next round).

**`lib.rs` — glue.** Module decls + re-exports, `LOG_TARGET`, the sender→receiver architecture doc + MVP scope,
and `test_support` (in-memory `AuxStore`, `TestBlock`, `import_blocks`, `MockExchange` with
Honest/Poison/Refuse/RefuseFirst behaviors).

**Cross-cutting threads:** (1) nothing trusted by connection — every response verifies against a request-named
root; (2) derive, don't declare — the archive recomputes every root, so divergence surfaces as an unknown root,
never a bad proof; (3) non-destructive fork discipline — channel hand-outs and register reads reconcile against
parent state, not on hand-out; (4) loud lift failures — a consuming block without lifts is invalid, so assembly
never silently degrades. The one behavioral wart is the retention/stalled-head interaction above.

### Worked example — what the archive stores and why (the three state kinds)

Parachain **2000** with a **bidirectional** pair to **2001**: it *sends* data on `Channel{2001,0,0}` and, on the
reverse channel where 2001 sends to it, *acks* on `Ack{2001,…}`. Block 1 appends 2 messages to `Channel{2001}`
(`P0`,`P1`); block 2 appends `P2` and publishes register `R0` on `Ack{2001}`. Aux DB (keys abbreviated; real
ones prefix `spec_msg_archive/` + `StreamId` bytes + BE position):

> **On terminology & direction.** "Register" = the `Register { version, up_to, grant, closed }` *message*
> published as an **Ack-stream leaf** — the flow-control/ack content, lossy latest-wins; **not** a one-shot
> "register a channel" op. The *first* register doubles as acceptance (Opening→Open); later ones are recurring
> watermark/credit updates. Ack `recipient` names who the ack is *addressed to* (the data sender), so for a
> **single** channel A→B the data (`Channel` in A's archive) and its register (`Ack` in B's archive) live in
> **different** archives; both appearing in one archive (here 2000's) means a bidirectional pair.
>
> **`R0` is *not* a reply to `P0`.** (a) A register is **cumulative** flow-control, not a per-message ack:
> `up_to` is a watermark ("consumed everything below `up_to`") that acks a whole *range* at once, lossy
> latest-wins — no `P0→R0` pairing. (b) Direction: `Ack{2001}` in 2000's archive acks the data 2000 *receives
> from* 2001 (reverse channel), whereas `P0/P1/P2` are data 2000 *sends to* 2001 — different channels. The ack
> of `P0` is a future register **2001** publishes on **its** `Ack{2000}` stream (`up_to ≥ 1`), which 2000 reads
> to drive watermark-pruning of `P0`.

**1. Per-stream — payloads, leaf hashes, live frontier** (`why`: content to serve / proof material / accumulator)
```
payload/Channel2001/{0,1,2} → P0,P1,P2         # the message content serve_messages hands over
payload/Ack2001/0           → R0               # SCALE-encoded Register
leaf/Channel2001/{0,1,2}    → blake2(0x00‖Pi)  # 32 B proof hashes, KEPT after payloads pruned
leaf/Ack2001/0              → blake2(0x00‖R0)
stream/Channel2001 → { frontier:{leaf_count:3, peaks:[…]}, floor:{…}, payload_floor:0 }
stream/Ack2001     → { frontier:{leaf_count:1, peaks:[…]}, floor:{…}, payload_floor:0 }
```
- **payloads** = *what* is delivered; without them nothing to serve.
- **leaf hashes** = *proof* material, retained even after watermark-pruning payloads — the archive rebuilds every
  MMR node on demand (`nodes.rs`) from these, so a pruned-payload stream still serves pure lift material.
- **frontier** = the running MMR accumulator: `leaf_count` is the next append position, `peaks` give the
  stream's current root — needed to keep appending and to compute the block `StreamsRoot`.

*Why `floor` **and** `payload_floor` — two prune floors for content vs. proof material, different rules/depths:*
- **`payload_floor`** — a bare position; below it the **payload bytes** are gone. **Watermark**-driven
  (`prune_payloads` → peer's confirmation watermark). Confirmed-consumed content is dead weight.
- **`floor`** — a full `MmrFrontier` (leaf_count **+ peaks**); below `floor.leaf_count` the **leaf hashes** are
  gone. **Horizon**-driven (`prune_horizon`, 25 h). Its peaks *tile* the pruned prefix — the compressed stand-in
  that lets the archive still generate MMR nodes/proofs over the retained tail (seeds `HistoricNodes::new`).

Invariant `payload_floor ≥ floor.leaf_count` (deleting a leaf hash deletes its payload too). Concrete slice,
head = 100, watermark 60, horizon floor 30:
```
position:  0 ───────── 30 ───────── 60 ───────── 100 (head)
leaf hashes:  ✗ pruned │  ✓ present │  ✓ present │
payloads:     ✗ pruned │  ✗ pruned  │  ✓ present │
```
- `0..30` → nothing (`BelowHorizon`); `30..60` → hashes present, payloads gone: serve **proof/lift material**
  but content → `PayloadsPruned`; `60..100` → full serve. The middle band `[floor, payload_floor)` is where the
  archive can *prove* a message under a committed root without holding its *bytes* — exactly a lagging
  receiver's lift after the payloads were consumed but before the proof material aged out.

Shapes differ for a reason: `payload_floor` is a `u64` (payloads are independent blobs — have the bytes or
not); `floor` must be a frontier because MMR proofs over the tail need the peaks of everything below to hash
against — the peaks are the O(log n) summary of the pruned prefix. This is the "two-axis" retention the note
critiques above; these two fields are what implement it.

**2. Per-block boundary — the root→state snapshot** (`why`: requests name a root, not a block)
```
boundary/1 → { hash:0xB1, number:1, archived_at:…, root:SR1, counts:[(Channel2001,2)] }
boundary/2 → { hash:0xB2, number:2, archived_at:…, root:SR2, counts:[(Channel2001,3),(Ack2001,1)] }
```
A request says "serve `Channel2001` from 0 **under `SR2`**." The boundary's `counts` give every stream's leaf
count as of that block (caps the served range at 3 / 1) and the tree proof is built over exactly that entry set
(recomputed + checked against stored `root` ⇒ corrupt archive refuses, never lies). `hash` = reorg rewind
anchor; `archived_at` = 25 h horizon clock. Note `SR1=f(Channel=2)` vs `SR2=f(Channel=3,Ack=1)` — the root
commits **all** streams, hence boundary 2 lists both.

**3. root_index — the lookup** (in-memory, rebuilt from boundaries; `why`: O(log n) named-root → boundary)
```
SR1 → 1 ; SR2 → 2
```
Requests name roots, so resolving `under` without this would scan every boundary. Idle blocks repeat the parent
root; the index keeps the newest bearer (retained longest). Plus `meta → { streams:[…], boundaries:(1,2) }` so
`load()` reconstructs everything from aux on restart via exact-key reads.

**Through-line:** a receiver asks *"give me this stream's messages, proven under this exact root."* Payloads
answer *what*, leaf hashes *prove* it, the boundary maps *this root → that historical state*, the root_index
makes the lookup fast — exactly the four pieces a root-keyed, trust-free serve needs.

### The two consumption flows — register read (watermark) vs. channel read (frontier)

Both are "read a source stream under an included root, verify, apply on-chain, lift for consensus." They are the
two halves that chain together: B consuming A's data advances B's frontier → B publishes `up_to` → A reads that
register → A's watermark advances → A prunes. Roles below: A→B channel (A sends, B receives; B publishes the
register, A reads it).

**Register read → A's watermark advances** (reader = data **sender** A):
1. **Trigger** — A's `monitor` sees B's `StreamsRoot` in B's `RecentProvides` ring → `Included(B, root)`.
2. **Fetch** — `fetch_register`: `EventRequest{ stream: Ack{recipient:A}, under: root, at: None }`; B's archive
   answers `serve_event` → `EventResponse{ payload: R0, inclusion, tree_proof }` (the *head* leaf).
3. **Verify (inclusion proof)** — `verify_event_response`: hash `R0` → `verify_head` (proves head-ness, so a
   stale register can't pass) → tree proof → `StreamsRoot`, compare to `root`. No recomputation.
4. **Pool** — `pool.note_register` (newest-wins `RegisterRead`).
5. **Block** — `build_inherent` hands the read into A's next block (`register_reads`), once, to one live block.
6. **Runtime applies** — A's pallet decodes `R0`, enforces monotonicity (rejects regressing `up_to`/`version`),
   sets `OutChannels[B].register.up_to = R0.up_to`. *That on-chain scalar is the watermark.*
7. **Prune** — `worker.rs` reads `out_channels()` → `prune_payloads(Channel{recipient:B}, up_to)` (advances
   `payload_floor`).

**Channel read → B's frontier advances** (reader = data **receiver** B — the mirror):
1. **Trigger** — B's `monitor` sees A's root in A's ring → `Included(A, root)`.
2. **Fetch** — `fetch_channel_stream`: `MessagesRequest{ stream: Channel{recipient:B}, start: cursor, under:
   root, max_bytes }`; A's archive `serve_messages` → payloads `P_cursor..count` + `start_peaks` + extension +
   tree proof. **Chunked, resumable, ordered** (a range).
3. **Verify (recomputation)** — `verify_messages_response`: take B's **own** frontier at `start`, cross-check
   `start_peaks`, **hash each payload and append** (`append_leaf(hash_leaf(P))`), extension → stream root →
   tree proof → `StreamsRoot`, compare to `root`. B *rebuilds* the MMR from the bytes.
4. **Pool** — `pool.note_chunk` (contiguous `ChannelLedger`; `verified.end` = new resume frontier).
5. **Block** — `build_inherent` hands the contiguous continuation from the cursor (`messages`), within budget.
6. **Runtime applies** — B's pallet consumes payloads **in order** (skips illegal), hashing each onto
   `InboundFrontier[(A, stream)]`; `leaf_count` moves cursor → cursor+n. Recorded as an `Interval`.
7. **Enables** — B's advanced `InboundFrontier.leaf_count` *is* the `up_to` B publishes in its own register back
   to A — feeding the register flow above.

**Shared skeleton:** same trigger (`monitor`, included root), transport (`/spec-msg/exchange`, peer rotation),
trust-free verification against the *named* root, apply path (pool → `build_inherent` → runtime →
`consumption_record`), and trust boundary (`channel_lift`/`register_lift` → `build_requires` → `Requires` UMP →
relay matches vs. the source's `RecentProvides`; can't advance without *proving* a read of committed data).

**Differences:**

| | **P0 — channel data (frontier)** | **R0 — register (watermark)** |
|---|---|---|
| Reader / role | data **receiver** B; advances B's **inbound** consumption | data **sender** A; advances A's record of peer consumption |
| Request | `MessagesRequest` — a **range**, chunked/resumable | `EventRequest{at:None}` — a **single head** leaf |
| Verify | **recomputation**: hash payloads, append to own frontier | **inclusion proof** (`verify_head`); no recomputation |
| Completeness | **lossless, ordered, contiguous** — no gaps | **lossy, latest-wins** — skip to newest |
| "Advance" | grow an **MMR accumulator** (frontier) by appending | move a **monotone scalar** (`up_to`) |
| Lift | extension over the consumed range (or bare tree proof if caught up) | always empty extension + bare tree proof (head *is* state) |
| Drives | B's own register `up_to` (→ the register flow) | A's `prune_payloads` |

**Essence:** channel reads are content you re-hash into a growing frontier; register reads are a scalar you
snapshot from the head — one lossless/ordered/recomputed, the other lossy/latest/proof-only. B's frontier-advance
feeds A's watermark-advance, closing the loop that lets A prune what B has confirmed.

#### Worked data example — the P0 flow, values through every call

Setup: **A = 2000** (sender), **B = 2001** (receiver), stream `Channel{recipient:2001,domain:0,num:0}` = `C`.
A has sent `P0,P1,P2` (head = 3); B has consumed nothing (`cursor = 0`). MMR values used throughout:
```
L0 = hash_leaf(0x00, P0)   L1 = hash_leaf(0x00, P1)   L2 = hash_leaf(0x00, P2)
N01    = merge(L0, L1)                    # inner node over leaves 0,1
SRoot3 = merge(N01, L2)                   # C's stream root at leaf_count 3  (peaks [N01, L2])
SR     = tree_root{ C → SRoot3 }          # A's StreamsRoot (keyed trie; one stream here)
```
Frontier notation `{leaf_count, peaks}`; empty = `{0, []}`.

**1. Trigger** — `monitor` reads `RecentProvides[2000] = [SR]`:
```
RelayProvidesEvent::Included( SourceProvides { source: 2000, root: SR, relay_block: 0xR1 } )
```
**2. Fetch** — `fetch_channel_stream` → A's `serve_messages`:
```
MessagesRequest  { stream: C, start: 0, under: SR, max_bytes: 524288 }
MessagesResponse { base: 0, leaf_version: 0x00, payloads: [P0,P1,P2],
                   start_peaks: [],        # frontier_at(0).peaks
                   extension:   EMPTY,     # served_to(3)==count(3) → caught up
                   tree_proof:  ⟨C ↪ SR⟩ }
```
**3. Verify** — `verify_messages_response(req, resp, own={0,[]})`:
```
base 0==start 0 ✓ ; own {0,[]} matches start_peaks [] ✓
append L0→{1,[L0]}  L1→{2,[N01]}  L2→{3,[N01,L2]}
extension EMPTY ⇒ root = merge(N01,L2) = SRoot3 ; tree_proof.verify(C,SRoot3)=SR ; SR==under ✓
⇒ VerifiedMessages { end: {3,[N01,L2]}, head: 3 }
```
**4. Pool** — `pool.note_chunk(...)` + `complete_round(2000, SR)`:
```
ChannelLedger { base:{0,[]}, end:{3,[N01,L2]}, payloads:[P0,P1,P2], leaves:[L0,L1,L2],
                binding: Some(ChannelBinding { root:SR, head:3, extension:EMPTY, tree_proof:⟨C↪SR⟩ }) }
target[2000] = SR
```
**5. Into a block** — `build_inherent([(2000,C,0)], [], budget)`; cursor 0 ∈ [0,3], binding.root==target:
```
SpecMsgInherentData { messages: [ (2000, C, [P0,P1,P2]) ], register_reads: [] }
```
**6. Runtime applies** — B consumes in order onto `InboundFrontier[(2000,C)]`:
```
{0,[]} --P0--> {1,[L0]} --P1--> {2,[N01]} --P2--> {3,[N01,L2]}     # leaf_count 0 → 3
consumption_record: [ (2000, { C: Interval { start:<root@0>, end:{3,[N01,L2]} } }) ]
```
**6b. Lift + Requires** — `channel_lift(2000,C,endpoint=3)`; `head(3)≤end(3)` ⇒ `extension(3,3)=EMPTY`:
```
RequiresLift { advances:[], extension:EMPTY, tree_proof:⟨C↪SR⟩ }
build_requires ⇒ RequiresSet {(2000, SR)} ⇒ UMPSignal::Requires({(2000,SR)})
```
Relay matches `(2000,SR)` vs `RecentProvides[2000]=[SR]` ✓ — B advanced only by *proving* it read committed data.

> **Where 6b runs — node-generates / PVF-verifies / relay-matches** (three contexts, not "in the block"):
> - **Node-side (collator, native) GENERATES the lift.** `assemble_lifts`/`channel_lift`/`register_lift`
>   (`authoring.rs`) pull `extension`+`tree_proof` from the verified pool — *not* the runtime, *not* the PVF. The
>   runtime stores only **frontiers** (enough to *verify* a lift, never to *generate* one — generation needs the
>   off-chain leaf hashes/MMR nodes), which is *why* assembly is necessarily node-side. The lifts travel in the
>   **POV** (`ParachainBlockData::V3`).
> - **Runtime (`execute_block`, in-wasm) does NEITHER** — it only consumes messages, advances frontiers, and
>   writes the `consumption_record` (the intervals). No lift gen, no `Requires` emission.
> - **PVF (`validate_block` wrapper, in-wasm during validation) VERIFIES + EMITS.** Post-execution it reads
>   `consumption_record()`, takes the POV lifts, runs `build_requires` (advancing each endpoint to a current
>   in-window root via extension+tree proof), **verifies** them, and appends the `Requires` UMP signal to the
>   candidate's commitments — failing on `LiftError` ([[spec-msg-lift-validate-block-hook]]).
> - **`build_requires` runs in *two* places that must agree byte-for-byte:** node-side (`assemble_collation`) so
>   the collator can *declare* the signal in commitments, and PVF-side to *enforce* — a mismatch is rejected at
>   backing.
> - **Relay (`paras_inherent`/`inclusion`) MATCHES** the resulting `Requires` against the source's
>   `RecentProvides` — the third checkpoint.
>
> So: generation is untrusted node work; the PVF re-derives + verifies; the relay matches. (My earlier "same
> block" label was loose — the lift is assembled by the collator *around* block production, not inside
> `execute_block`.) Same split applies to the R0 register 6b below.

**7. Enables** — `InboundFrontier.leaf_count=3` becomes B's published `up_to`:
```
B publishes on Ack{recipient:2000}: Register { version:0, up_to:3, grant, closed:false }
 → A reads it → OutChannels[2001].register.up_to = 3
 → worker: prune_payloads(Channel{recipient:2001}, 3) → payload_floor = 3
 → P0,P1,P2 payload bytes deleted (leaf hashes kept to 25h horizon)
```

**Partial/chunked variant** (budget fits only `P0,P1`): step 2 returns `payloads:[P0,P1]`, `served_to:2`, a
**non-empty** `extension` proving `{2,[N01]} → SRoot3`; step 3 yields `end:{2,[N01]}, head:3`; step 5 hands
`[P0,P1]`, ledger stays pooled; next chunk resumes `start:2, start_peaks:[N01]`. The lift then carries a
**non-empty** `extension(2,3)` — the partial-consumption case.

#### Worked data example — the R0 register flow, values through every call

The continuation: B=2001 just consumed `P0..P2`, advanced its frontier to 3, and published `up_to:3`. Now
**A = 2000** (data sender) reads that register. A's *source* is **2001**; the stream is B's ack stream
`Ack{recipient:2000,domain:0,num:0}` = `K` (published by B, lives in B's archive).

**Values** (B has published one register, R0, at position 0 on `K`):
```
R0     = SCALE(Register { version:0, up_to:3, grant, closed:false })
LR0    = hash_leaf(0x00, R0)              # the one ack-stream leaf
KRoot1 = root({1,[LR0]})                  # K's stream root at leaf_count 1 (single peak)
SR_B   = tree_root{ K → KRoot1 }          # B's StreamsRoot (its outbound side)
```
Relay: `RecentProvides[2001] = [SR_B]` (B's candidate committed `Provides(SR_B)`, included).

**1. Trigger** — A's `monitor` tracks 2001 as a source (A's `out_channels` has peer 2001):
```
RelayProvidesEvent::Included( SourceProvides { source: 2001, root: SR_B, relay_block: 0xR2 } )
```
**2. Fetch** — `fetch_register` → B's `serve_event` (single **head** read):
```
EventRequest  { stream: K, under: SR_B, at: None }
EventResponse { payload: R0, inclusion: {mmr_size:1, items:[]}, tree_proof: ⟨K ↪ SR_B⟩ }
```
**3. Verify — inclusion proof (no recomputation)** — `verify_event_response`:
```
leaf = hash_leaf(0x00, R0) = LR0
at==None ⇒ verify_head(LR0) → (position 0, frontier {1,[LR0]})     # proof PROVES head-ness
root = frontier.root() = KRoot1 ; tree_proof.verify(K,KRoot1)=SR_B ; SR_B==under ✓
⇒ VerifiedEvent { position: 0, frontier: Some({1,[LR0]}) }
```
**4. Pool** — `pool.note_register(2001, K, ...)`, keyed by read-context leaf_count = 1:
```
RegisterRead { root:SR_B, payload:R0, inclusion:{mmr_size:1,items:[]}, frontier:{1,[LR0]}, tree_proof:⟨K↪SR_B⟩ }
registers[K].reads = { 1 → RegisterRead{…} } ; registers[K].fresh = Some(1) ; target[2001] = SR_B
```
**5. Into a block** — `build_inherent([], [(2001, K, parent_view)], budget)`; `fresh=1`, `target==read.root`:
```
SpecMsgInherentData { messages:[], register_reads:[ (2001, K, R0, {mmr_size:1,items:[]}) ] }   # (src,stream,payload,incl)
registers[K].fresh = None ; registers[K].handed = Some(1)
```
**6. Runtime applies — watermark advances on-chain.** A decodes `R0`, checks monotonicity vs `OutChannels[2001].register` (was `up_to:0`): `3≥0` ✓, then:
```
OutChannels[channel(peer:2001,domain:0,num:0)].register = Register { version:0, up_to:3, grant, closed:false }
consumption_record: [ (2001, { K: read_context(1) }) ]     # end frontier {1,[LR0]}
```
**6b. Lift + Requires** — `register_lift(2001, K, context=1)`; head read's frontier *is* the state ⇒ **always** empty extension:
```
RequiresLift { advances:[], extension:EMPTY, tree_proof:⟨K↪SR_B⟩ }
build_requires ⇒ RequiresSet {(2001, SR_B)} ⇒ UMPSignal::Requires({(2001, SR_B)})
```
Relay matches `(2001, SR_B)` vs `RecentProvides[2001]=[SR_B]` ✓ — A advanced its watermark only by *proving* it read B's committed register.
**7. Enables — pruning** (closes the loop the P0 flow pointed at):
```
worker: out_channels() → OutChannels[2001].register.up_to = 3
 → prune_payloads(Channel{recipient:2001,domain:0,num:0}, 3) → payload_floor = 3
 → A's sent P0,P1,P2 payload bytes deleted (leaf hashes kept to 25h horizon)
```

**Side-by-side (the concrete contrasts):**

| step | P0 (channel) | R0 (register) |
|---|---|---|
| 2 request | `MessagesRequest{start:0, max_bytes}` (range) | `EventRequest{at:None}` (head) |
| 2 response | `payloads:[P0,P1,P2]`, `start_peaks`, `extension`, `tree_proof` | `payload:R0`, `inclusion`, `tree_proof` |
| 3 verify | append `L0,L1,L2`→`{3,…}`, extension→root | `verify_head(LR0)`→`{1,[LR0]}`, no re-hash of history |
| 5 inherent | `messages:[(2000,C,[P0,P1,P2])]` | `register_reads:[(2001,K,R0,incl)]` |
| 6 apply | `InboundFrontier` 0→3 (append) | `OutChannels.register.up_to = 3` (scalar set) |
| 6b lift | `extension` over consumed range (or EMPTY) | **always** EMPTY extension + tree proof |
| 7 drives | B's own `up_to` → the register flow | A's `prune_payloads` |

#### Advancing a non-empty register across multiple ack messages (`up_to 3 → 6`)

The key: the ack stream is **lossy latest-wins**, so advancing across *multiple* ack messages is still **one head
read** — A reads only the newest register and **skips the intermediate ones** (never reads `R1`); it jumps
`up_to 3 → 6` in a single fetch. (Contrast: channel data must read *every* `P3,P4,P5` in order.)

Continuing: A sent `P3,P4,P5` (C head 6); B consumed them (frontier 3→6) and published **two** more registers
as its policy fired — `R1(up_to:4)` then `R2(up_to:6)`. `K` now has 3 leaves:
```
R1=SCALE(Register{up_to:4})  R2=SCALE(Register{up_to:6})   LR0,LR1,LR2 = hash_leaf(0x00, R·)
NR01 = merge(LR0,LR1) ; KRoot3 = merge(NR01, LR2)          # K's root at leaf_count 3
SR_B' = tree_root{ K → KRoot3 } ; RecentProvides[2001] = [SR_B, SR_B']
```
1. **Trigger** — `note_ring` diffs the ring, offers only the new `Included(2001, SR_B', 0xR3)`.
2. **Fetch** — one head read; `serve_event`: `count(K)=3`, `position=2` → **`R2`** (R1 at pos 1 never requested):
   `EventResponse { payload: R2, inclusion: {mmr_size:4, items:[NR01]}, tree_proof: ⟨K↪SR_B'⟩ }`.
3. **Verify** — `verify_head(LR2) → (2, {3,[NR01,LR2]})`, root `KRoot3`, tree→`SR_B'`==under ✓.
4. **Pool** — new context leaf_count = 3; old retained (bounded 4):
   `reads = { 1→R0read(up_to:3), 3→R2read(up_to:6) }` — **R1 absent, never fetched**; `fresh=Some(3)`.
5. **Block** — `reconcile_handed`: parent `up_to:3 ≥ R0's 3` → R0 **landed**, cleared; hand fresh:
   `register_reads:[(2001,K,R2,{mmr_size:4,items:[NR01]})]` ; `handed=Some(3)`.
6. **Apply — monotonic** — decode `R2(up_to:6)` vs stored `3`: `6≥3` ✓ → `OutChannels[2001].register.up_to: 3→6`;
   `consumption_record: [(2001, {K: read_context(3)})]`.
6b. **Lift** — `register_lift(context=3)` → `RequiresLift{[], EMPTY, ⟨K↪SR_B'⟩}` ⇒ `Requires({(2001,SR_B')})`,
   matched vs `RecentProvides[2001] ∋ SR_B'` ✓.
7. **Prune jumps** — `prune_payloads(C, 6) → payload_floor 3→6`; `P3,P4,P5` deleted.

| | value |
|---|---|
| Ack leaves B produced | 2 (`R1`,`R2`) |
| Leaves A **fetched** | **1** (head `R2`) |
| `R1(up_to:4)` | **skipped** — lossy stream keeps only the head; redundant cadence |
| Read context advance | `1 → 3` (stream grew by 2) though 1 leaf read |
| Watermark advance | `3 → 6` in one hop |

Two safety properties: (a) **no staleness** — `verify_head` pins the head under B's *current* root `SR_B'`, so an
old register verifies to a different root and is discarded; (b) **no regression** — runtime monotonicity drops
any `up_to ≤` the stored one, so reordered delivery can't lower the watermark. ⇒ the register flow is idempotent
and gap-free **without ordered fetching** — the exact opposite of the channel flow's contiguous in-order reads.

## Proposed retention model — count boundaries + single-floor watermark, no fixed time

Culmination of the retention thread (ack-is-head-not-dispute-window; time is a proxy for the ring; ring depth ×
block interval ≈ minutes ≪ 25 h). Proposal: **drop fixed-time retention entirely**, keep the last N boundaries
(256/512, margin over the ~128 ring), store payload + leaf hash together and prune them together, one floor, no
24 h / 10 MiB config. Verdict: **works, with two refinements; a real simplification of the retention layer, a
modest one for the crate.**

### The unified rule

```
floor(stream) = max( watermark(stream), leaf_count_at_window_floor(stream) )
boundaries    = keep last N (256/512), drop oldest        # count-based, ring-aligned; no wall clock
prune(stream) = delete payload AND leaf hash below floor  # one floor, both materials together

# leaf_count_at_window_floor = the STREAM's leaf count recorded at the oldest
# RETAINED boundary (the block ~N behind the head) — a leaf POSITION that lags
# the head, NOT the number N. Both floor inputs are leaf positions.
```
- **Healthy channel** → `watermark` dominates (receiver consumes within the boundary window, cursor ahead of
  the rolling floor).
- **Ack / event** → no watermark → `leaf_count_at_window_floor` governs (head-based; carve-out below).

**Don't misread the second term as `N`.** With N=512 and the chain at block 10000, the oldest kept boundary is
block 9488; `leaf_count_at_window_floor` = the stream's leaf count *as of block 9488*, say **40** — not 512. So
for watermark 90: `floor = max(90, 40) = 90` → prune below 90, keep `[90, head]`. **Watermark drives, no
over-pruning.** The second term only *wins* when the stream's leaf count 512 blocks ago already exceeded the
watermark — i.e. a receiver stalled **>N blocks** (e.g. watermark 30 frozen while the stream reached 100 long
ago → `floor = max(30, 100) = 100`, reaping the whole `[30,100)` tail). That reaping is safe because **N ≫ ring
depth (~128)**: anything still liftable has its root in the last ~128 blocks, always *above* the leaf count from
512 blocks back, so the window-floor term can only ever touch data whose roots have already left the ring
(unliftable → dead), never data a receiver could still lift.

Removes `prune_horizon` as a separate thing, `archived_at`/`now_secs`/`SERVING_HORIZON`, the config, and the
`payload_floor` vs `floor.leaf_count` split. Retention becomes **deterministic** (no wall clock → reproducible,
better for tests).

### Refinement 1 — "all watermark" needs the window floor too

Pure watermark **can't reap a stalled channel**: a frozen watermark would hold the backpressure-capped backlog
`[W, head]` forever (the 25 h horizon used to auto-reap it). The **window-floor term** (`leaf_count_at_window_floor`)
replaces that job — once the stalled stream's roots roll out of the last-N window, that term overtakes the frozen
watermark and reaps the tail. **Safe despite being unconsumed:** roots outside the window have left the relay's
`RecentProvides` ring, so the receiver can no longer produce a matching `Requires` for that data — it's
**unliftable, hence dead**. So `max(watermark, leaf_count_at_window_floor)` is right: healthy → watermark;
stalled → the window floor reaps the useless tail. Both inputs are leaf positions — no time survives.

### Refinement 2 — the lossy-head carve-out still stands

Switching time→count does **not** remove the stalled-head problem: a stalled ack head can still be reached by
the `leaf_count_at_window_floor` term. So the `is_lossy()` carve-out (pin the floor at `head-1` for
`Ack`/`Broadcast`/`Private`) is **still needed**, just count-triggered. Same fix.

### What it genuinely removes (the win)

wall-clock coupling (`archived_at`, `now_secs`, `SERVING_HORIZON`); the 24 h / 10 MiB config; one of the two
floors; `prune_horizon` folded into a single `prune(stream, below)` over both materials; the entire two-axis
mental model the note critiques. The trickiest, most-argued retention code — gone.

### Honest scope — retention a lot, the crate modestly

Untouched because orthogonal to the retention axis: the **floor frontier + `HistoricNodes`** (pruning *any*
prefix still needs it to serve proofs over the tail); **boundaries + `root_index` + `boundary_for` +
`tree_proof_at`** (root-keyed serving, now count-retained); `serve_messages`/`serve_event`/`rewind`/`import`
(hit one floor instead of two); the entire receiver side (fetch/verify/pool/authoring). So retention drops from
"two floors + two prune fns + wall clock + config + time/lossy-head interaction" to "one floor =
max(watermark, boundary-count) + one prune fn" — ~15–20 % of `archive.rs`, a small slice of the crate. The
weight is in trust-free root-keyed serving, not the pruning policy, so the crate won't *feel* dramatically
smaller.

### One deliberate behavior change

Merging the floors means **below-watermark lift material is no longer served** (today `serve_messages(max_bytes=0)`
serves extension proofs in the `[horizon_floor, watermark)` band — `pruning_watermark_then_horizon` encodes it).
The note already argues nobody needs it (consumption is always *above* the watermark; over-retention), so
dropping it is intended — but it's a real policy change, and a couple of tests would be rewritten.

**Bottom line:** works with `floor = max(watermark, boundary-count)` + the retained lossy-head carve-out; removes
the messiest retention machinery and the config; makes retention deterministic. It just won't shrink the crate a
lot, since the serving/proof engine is unchanged.

## `ChannelLedger` + `channel_lift` — worked data

Ground run: source **A=2000** sends `P0…P5` on `C = Channel{recipient:2001}`; committed head = 6 under root
`SR`. Receiver **B** fetches + pools. MMR values:
```
L0..L5 = hash_leaf(0x00, Pi)
N01=merge(L0,L1)  N23=merge(L2,L3)  N45=merge(L4,L5)  N0123=merge(N01,N23)
frontier@4 = {4,[N0123]}   SRoot4 = N0123
frontier@6 = {6,[N0123,N45]}   SRoot6 = merge(N0123,N45)   SR = tree_root{ C → SRoot6 }
```

### `ChannelLedger` — one stream's verified pooled run

```rust
struct ChannelLedger {
    base:     MmrFrontier,        // frontier at the first retained payload
    end:      MmrFrontier,        // frontier after the last retained payload (fetch resume cursor)
    payloads: VecDeque<Vec<u8>>,  // payloads at positions base.leaf_count .. end.leaf_count
    leaves:   VecDeque<Hash>,     // their leaf hashes — KEPT even after payloads handed off (lifts need hashes)
    binding:  Option<ChannelBinding>,
}
struct ChannelBinding {
    root:       StreamsRoot,        // included root the run verified under
    head:       u64,                // stream's proven leaf count under `root`
    extension:  MMRExtensionProof,  // SERVER-provided: run's `end` → `head` (empty if caught up)
    tree_proof: TreeInclusionProof, // C's entry proof under `root`
}
```
A contiguous run `[base, end)` + everything to lift it. `base`/`end` are full frontiers (verification and lift
generation extend *from* them). `leaves` kept even when payloads are handed to the inherent, because
`channel_lift` generates extensions from *hashes*, not payloads. `binding` re-binds the whole run under the
newest included root each fetch round.

**Scenario A — full fetch (run reaches head):**
```
ChannelLedger { base:{0,[]}, end:{6,[N0123,N45]}, payloads:[P0..P5], leaves:[L0..L5],
                binding: Some({ root:SR, head:6, extension:EMPTY, tree_proof:⟨C↪SR⟩ }) }
```
**Scenario B — partial fetch, 4 of 6 (mid-backlog):**
```
ChannelLedger { base:{0,[]}, end:{4,[N0123]}, payloads:[P0..P3], leaves:[L0..L3],
                binding: Some({ root:SR, head:6, extension:ext(4→6), tree_proof:⟨C↪SR⟩ }) }
```
B has leaves only for `0..4` — no hashes for `4..6` (never fetched), hence the binding carries the server's
`ext(4→6)`.

### `channel_lift(source, stream, endpoint)` — bridge a consumed endpoint to a current root

`endpoint` = how far into the stream this block consumed (`Interval.end.leaf_count`). Two branches:
```rust
let extension = if binding.head <= ledger.end_position() {
    // (1) run reaches head — generate over retained leaf hashes
    if endpoint < base_position || endpoint > binding.head { return NotCovered }
    ledger.nodes().extension(endpoint, binding.head)?
} else if endpoint == ledger.end_position() {
    // (2) mid-backlog — only the run's end is liftable, via the server extension
    binding.extension.clone()
} else { return NotCovered };
Ok((RequiresLift { advances: vec![], extension, tree_proof: binding.tree_proof.clone() }, binding.root))
```

**Invariant: `ledger.end ≤ binding.head` always** — so branch (1)'s `binding.head <= end_position` is a
**defensive `==`** (caught up), never a strict `<`. `end` and `binding` are set **atomically** in `note_chunk`
from the same verified chunk, and `verify_messages_response` derives `head ≥ end.leaf_count` (empty extension ⇒
`head == end`; else the extension bridges `end → head` ⇒ `head > end`). You can't fetch past the head (serving
caps at the stream's count under the root; `verify` derives `head` as that cap), and bindings only move forward
(fetch under the newest root; append-only ⇒ `head` only grows; the `ledger.end == start` contiguity check
rejects any chunk that would desync `end` from an older root). So `end > binding.head` is **unreachable** — not
over-consumption, not an outdated-root binding, just a fourth state the `<=` folds harmlessly into branch (1).
Tightening it to `== ` would behave identically.

**Call on A, partial consumption `endpoint=4`** → case (1) (`head 6 ≤ end 6`), `4 ∈ [0,6]`, generate locally:
```
ledger.nodes().extension(4→6) = MMRExtensionProof { leaf_count:6, connecting_nodes:[N45] }
RequiresLift { advances:[], extension:ext(4→6), tree_proof:⟨C↪SR⟩ }  →  root = SR
```
Meaning: "consumed C up to 4; here's the proof `frontier@4 {4,[N0123]}` extends to `SRoot6` under `SR`." The
`validate_block` wrapper applies it to the block's `Interval.end=frontier@4` → `SRoot6` → tree_proof → `SR` ⇒
`Requires({(2000,SR)})`. The extension is the **unconsumed tail** (4→6) that lets mid-backlog consumption name a
current committed root. Caught-up (`endpoint=6`) → `extension(6,6)=EMPTY`, the bare-tree-proof hot path.

**Call on B, `endpoint=4`** → case (2) (`head 6 ≤ end 4` false; `endpoint 4 == end 4`) → server extension:
```
extension = binding.extension = ext(4→6)   # from the fetch response, NOT generated locally
RequiresLift { advances:[], extension:ext(4→6), tree_proof:⟨C↪SR⟩ }  →  root = SR
```
B *can't* generate `extension(4→6)` (no hashes for `4..6`), but the sender's `serve_messages` carried it. So
only `endpoint==end` is liftable here; a smaller `endpoint=2` on a mid-backlog run → **`NotCovered`** (needs
hashes `2..6`, B has only `2..4`) — the loud "fetch more, then regenerate" signal.

| | A: run reaches head | B: mid-backlog |
|---|---|---|
| Ledger covers | `[base, head]` fully | `[base, end]`, `end < head` |
| Liftable endpoints | **any** in `[base, head]` | **only** `endpoint == end` |
| Extension source | generated locally from `leaves` | stored **server** `binding.extension` |
| `endpoint < end < head` | n/a | `NotCovered` (needs unfetched hashes) |

Through-line: `ChannelLedger` = payloads + leaf hashes + root binding; `channel_lift` turns "consumed up to X"
into a POV lift **bridging X to a current committed root** — locally when the run reaches the head (any partial
consumption liftable), or via the server extension when mid-backlog (only the endpoint). `advances:[]` always
empty in the MVP (no gap-chain advance proofs).

### Why the pool holds more than a block consumes (partial consumption is routine)

Branch (1)'s local generation (`endpoint < end`) isn't an edge case — it fires on most blocks, because **fetch
and consumption are decoupled and run at different granularities; the pool is a buffer, not a mirror of one
block**:

- **`fetch_channel_stream` fills the ledger to the *head*** — chunks through the *entire* backlog under the
  included root (`end` → `head`), triggered by a relay inclusion event, in bulk.
- **`build_inherent` drains only a *budget-limited* slice per block** — `InherentBudget` (default 256 KiB / 8
  streams). Leftover stays pooled for the next block.

So `pool ≥ consumed-per-block` whenever the backlog exceeds one block's budget — i.e. exactly the catch-up case.
Concrete: 100-message backlog (backpressure allows up to the grant window, ~10 MiB):
```
fetch  → ledger.end = 100 = head           # whole backlog pooled at once
block N   consumes [0,20]   → endpoint=20   # channel_lift(20): branch (1), endpoint 20 < end 100
block N+1 consumes [20,40]  → endpoint=40   # extension(20,100) generated LOCALLY each block
...
```
Every block is a partial consumption below the run's end, so branch (1) is load-bearing throughout the drain.

Why not just fetch one block's worth? (a) **decoupled triggers** — fetch fires on relay inclusion, authoring on
the collator's slot; the fetcher makes all verified material ready and lets authoring drain it; (b) **bulk
efficiency** — fetch the backlog once (chunked), consume steadily, vs. re-fetch per block; (c) **fork safety** —
`prune_channel` keeps material even *below* the cursor, since an unfinalized consuming ancestor may reorg and a
sibling fork must re-consume from a lower point. So the pool is intentionally ⊇ what any single block consumed.
"Pool == consumed" would hold only if the whole backlog fit one block's budget with no forks; in general the
pool is a standing buffer drained a budget-slice per block — which is *why* `channel_lift` must handle
`endpoint < end`.

### Limitation — huge backlog: fetch resumes, consumption is all-or-nothing (branch (2) is a dormant streaming hook)

When does branch (2) (`endpoint == end < head`, server extension) actually fire? **Essentially never in the
MVP** — and the reason exposes a real limitation for oversized backlogs.

**MVP channels — can't arise.** A channel's backlog is backpressure-capped (grant window, ~10 MiB); one round
fetches up to `MAX_CHUNKS_PER_ROUND (4096) × FETCH_CHUNK_BYTES (512 KiB) ≈ 2 GiB`. So ~10 MiB ≪ 2 GiB — a
channel backlog always fits one round → every completed round has `end == head` → branch (1). (Broadcast has no
backpressure but isn't range-fetched in the MVP, so moot there too.) `build_inherent` also hands out **only
target-bound** material, and `target` is set only when a round **completes** (reaches head), so consumed runs
are always `end == head`.

**If a backlog *did* exceed one round** (backpressure disabled, absurd grant, or post-MVP event ranges):
- **Fetch side — supported.** `fetch_channel_stream` is chunked + **resumable**: the chunk bound returns
  `ChunkBound` (retryable), the retry resumes from the pooled `end` (`pool.resume`) and fetches the next batch;
  fresh included roots reset the budget and resume from `end`. Forward progress across rounds/triggers. ✓
- **Consumption side — NOT supported.** `build_inherent` withholds non-target-bound (not-fully-fetched) runs, so
  a block **can't consume any of it until the whole backlog reaches the head**. No fetch-a-chunk-consume-it-
  fetch-more. The backlog is caught up in **bulk**, consuming nothing until complete. Two hard limits make that
  unfit for a *huge* backlog: (1) the pool is **in-memory** (`VecDeque<Vec<u8>>` + `VecDeque<Hash>`) → multi-GiB
  → OOM; (2) **all-or-nothing** per round → no partial progress.

**So branch (2) is the lift-side hook for streaming consumption** (consume the fetched `end` before the whole
backlog arrives), but its consumption-side counterpart (`build_inherent` handing out mid-fetch material) **isn't
wired**. The feature is half-built: lift math present, inherent provider won't feed it → branch (2) dormant.

**Bottom line:** MVP relies on backpressure to keep backlogs below one round (fetch-all-then-drain, branch (2)
dormant — not a bug). For a genuinely huge backlog the **fetch scales** (resumable) but **consumption doesn't**
(all-or-nothing + in-memory) — streaming consumption is a **known missing piece**, not supported by the current
code.

## #12350 (sender pallet) — implemented (StreamId-keyed); frontier is cumulative peaks, decoupled from pruning

Checked #12350 (`pallet-spec-messaging` sender part) against the branch (`cumulus/pallets/spec-messaging/src/lib.rs`).
**Implemented, advanced from the issue's `ParaId` sketch to the v0.5 `StreamId` + channel model:**

| #12350 | branch | note |
|---|---|---|
| `OutboundFrontier: StorageMap<ParaId, MmrFrontier>` | `StorageMap<StreamId, MmrFrontier, ValueQuery>` (L616) | keyed by **`StreamId`** (Channel/Ack/Broadcast/Private), a superset of `ParaId` |
| `OutboundMessages: StorageMap<(ParaId,u64),…>` | `OutboundMessages`, **drained each block** (L889) | this block's sends only, transient |
| `append_messages(dest, SpecMsgKind)` | `append_to_stream` + `SpecMsgKind` | same role |
| `SpecMsgDestinations: StorageMap<ParaId,()>` | evolved → channel model (`OutChannels`/`InChannels`, `consumed_streams()`) | flat destination set became the channel/consumed-stream config |
| — | `TreeNodes`/`TreeRoot`/`BlockStreamsRoot` (L637-651) | commitment tree → `StreamsRoot` (#12351) |

**`OutboundFrontier` is cumulative, frontier-only, and pruning-safe** — confirmed:
- **Cumulative accumulator** (L889-894): at the block boundary, `OutboundMessages::drain()` folds each send into the
  *persistent* `OutboundFrontier` via `append_leaf`, stored back — grows monotonically across blocks
  (comment: "the stored frontiers reflect everything sent up to and including the previous block"). Never reset.
- **Peaks only** — value type `MmrFrontier = { leaf_count, peaks }` = `O(log n)` peaks, not the leaves/messages.
  Messages live in the transient `OutboundMessages` (drained every block). On-chain per-stream state is `O(log n)`.
- **Decoupled from pruning** — what gets pruned (payloads + leaf hashes) lives **off-chain** in the client
  `SpecMsgArchive`; the on-chain frontier holds only cumulative peaks (nothing historical to prune), and the
  `StreamsRoot` derives from `frontier.root()` (bag the peaks) with **no historical leaves**. So off-chain
  watermark/horizon pruning is invisible to the frontier and the committed root. On-chain accumulator vs.
  off-chain retention are fully separate — exactly the issue's "stores only the frontier; messages do not live here."

## #12583 (receiver `Provides` monitor) — implemented; proposed redesign: runtime API + event, drop well-known key

**Status: implemented** — the issue links `cumulus/client/spec-msg/src/monitor.rs` as its own PoC. Current
workflow: `run_relay_provides_monitor` subscribes to the relay `import_notification_stream`; processes the tip
once at startup; per imported block (skip if major-syncing, version-gate) computes consumed sources
(`consumed_streams()` keys ∪ `out_channels()` peers), and per source reads `RecentProvides[source]` via the
**well-known key** `spec_msg_recent_provides(source)`, diffs it (`ProvidesTracker`/`SeenRoots`) → emits
`RelayProvidesEvent::Included` per newly-included root; also parses `candidates_pending_availability` →
`Pending` prefetch hints. `read_recent_provides` doubles as the authoring-target read.

### eskimor's comment (#12583#issuecomment-4992808664): "provides root in events?"

We **don't** have it today — the relay recorder `spec_msg.rs::note_provides` only does
`RecentProvides::mutate(...ring.push(root, now))`; the pallet `Config` has no `RuntimeEvent`, no
`#[pallet::event]`. Emitting the enacted provides root as a relay event makes sense.

### Refined design (agreed): runtime API + event-primary, no well-known key, newest-root-suffices

**The well-known key buys no trustlessness here.** Well-known keys exist for *untrusting* readers pulling a
value via a storage proof (light clients, bridges, the PVF's validation data). The monitor is a collator
reading **its own trusted relay** — proof property unused. Checked the other consumers: matching
(`check_requires`) is **on-chain relay** (direct storage, not the key); the PVF doesn't read `RecentProvides`
(parachain *synthesizes* Requires, relay matches); the parachain runtime doesn't read it. **Only the node
monitor reads the key** → a **relay runtime API** replaces it cleanly (and the monitor *already* calls a relay
runtime API — `candidates_pending_availability` — so it's the same infra). Bonus: kills the fragile
`Vec::decode(get_storage_by_key(...))` storage-layout coupling ("layout pinned by a test").

**Event-primary + periodic runtime-API reconcile** (push for latency, pull for recovery/bootstrap):
- **Event = primary trigger** — fires on the newly-enacted provides root; low-latency, no polling.
- **`recent_provides(source)` API (periodic) = reconcile + bootstrap** — poll the latest root, diff vs the
  last processed; if different, catch up. Replaces the startup ring-read.

**"Latest (newest) root" is sufficient — the node needs nothing more.** Authoring targets the newest; fetching
under the newest covers *all* history (streams append-only ⇒ newest leaf count subsumes older roots); matching
is relay-side against the on-chain ring. So the **ring stays purely on-chain** (for `check_requires`), the node
tracks a single `last_root` per source, and the whole off-chain ring fetch + `ProvidesTracker`/`SeenRoots`
diffing **goes away** — the newest-vs-last diff *is* the "new work?" check. Naturally gap-tolerant: miss ten
provides, catching up to the newest still covers all ten.

**Corrections to earlier caveats:**
- **Poll cadence is NOT bounded by the ring window** — hourly is fine. The node always targets the *newest*
  root, which is by definition the freshest ring entry → never aged out → correctness is independent of poll
  cadence. Busy source → events drive it (poll irrelevant); quiet source → ring is frozen (advances by root
  *count* 128, not wall-clock), so the last root stays matchable **indefinitely**. The poll only bounds
  *latency* for the "node down during a source's final event, then source quiet" case — a liveness knob, not
  correctness.
- **`Pending` is not needed — drop it.** The MVP fetcher already ignores it
  (`run_fetch_rounds`: `Pending(_) => continue`) — dead weight today. It was a post-MVP prefetch optimization;
  if wanted later it needs a *backed-candidate* signal (`CandidateBacked`-with-root / commitments parse), not
  the enacted-`Provides` event. Remove the `Pending` variant + the `candidates_pending_availability` parse.

**Changes:** (a) relay `spec_msg.rs` — add `RuntimeEvent` + `Event::Provides { source, root }` + `deposit_event`
in `note_provides`; add runtime API `recent_provides(source) -> Option<StreamsRoot>`; drop the well-known key.
(b) monitor — watch `System::Events` for `Event::Provides` (primary) + periodic `recent_provides` reconcile;
remove ring-read + `ProvidesTracker` diffing + the `Pending` path. (c) authoring — take the target from
`recent_provides` / tracked `last_root`. Net: strictly leaner (no off-chain ring, no diffing, no layout
coupling, no Pending) and more robust (event + reconcile); the ring lives only where needed — on-chain for
matching.

## StreamsRoot scope + emission cadence — all streams, but only on active blocks

**One `StreamsRoot` commits *all* the source's streams** — every `Channel{recipient}` to *every* receiver para,
plus `Ack`/`Broadcast`/`Private` — in a single hash (root of the persistent commitment tree `TreeRoot`/`TreeNodes`;
`commit_streams_root` folds touched streams into it and roots over all).

**But it is NOT emitted every block.** `commit_streams_root` (`lib.rs:1554-1588`) returns `None` on **idle blocks**:
```rust
let mut touched = false;
for (stream, messages) in OutboundMessages::<T>::iter() { ...; touched = true; }
if !touched { return None; }   // idle: no fold, no digest, no Provides, ring NOT pushed
```
So a block that appended to **no** stream emits **no `Provides` UMP signal, no header digest, and does not push
the relay ring** — "an unchanged root is never re-emitted." Nuance: the trigger is *any stream touched*, not XCM
specifically — publishing an `Ack` register or a channel signal (`OpenChannel`/`CloseChannel`) also counts; "idle"
= nothing sent on any stream.

**Implication:** the relay ring advances **per active (message-bearing) block, not per parachain block** — the
throughput-dependence behind the ring-window discussion. A **quiet source's ring is frozen** (no sends → no
Provides → last root stays matchable indefinitely, which is why the #12583 reconcile-poll cadence needn't beat
any wall-clock window); a busy source pushes ~every block. So: all streams in one root (✓), committed/pushed only
when the source actually sends (not every block).

# E2E workflow (MVP branch) — full loop with code links + example data

> **Moved.** The 12-stage worked loop *and* its Stage 9 deep-dive (POV lift → `Requires` + UMP-signal transport
> safety) — code links + example data, refs verified against `lexnv/spec-msg-poc-mvp`, feature-gate framing
> reconciled to release-first — now live in
> [speculative-messaging-impl-design.md](../../content/post/speculative-messaging-impl-design.md)
> ("End-to-end walkthrough" + "Stage 9 deep-dive").

## Post-sync delta (branch @ 0fe8c0b1c83, 07-23) — node-side hardening only, no design change

Re-reviewed after an upstream rebase of `lexnv/spec-msg-poc-mvp`. The 8 new commits (07-21→07-23) are **all
node-side (off-chain) robustness/observability** — **none** touch primitives, the pallet STF, the relay side
(`spec_msg.rs`/`paras_inherent`/`inclusion`), the `validate_block` wrapper, or `UMPSignal`/v9. So the wire
protocol, on-chain STF, relay matching, and PVF hook are unchanged; earlier reviews + notes stand.

Themes (client crate `cumulus/client/spec-msg/src/` + node wiring):
1. **Fetch-round in-flight tracking + grace window** (`12ea383e182`, `aea5354b7aa`) — mark a round in-flight at
   *offer receipt* not round entry; give in-flight rounds a bounded grace window at inherent build so
   `build_inherent` doesn't withhold target-bound material mid-round. Timing/liveness refinement of the
   target-binding.
2. **Never-written-stream handling** (`98428366e9e`, `c5621467e50`) — a consumed stream the source hasn't
   written yet (channel opened / register not yet published) returns a refusal; these stop it retrying or
   **poisoning the whole round** (other streams still complete). The empty-stream / best-effort edge.
3. **Register hand-out fork-reconciliation** (`e1d06cb8cbb`) — extends `reconcile_handed` to keep hand-outs
   reconcilable across *abandoned* branches.
4. **Observability + lint** (`c8923f42be9` logs; `0fe8c0b1c83` clippy). Plus two general upstream fixes
   (`ca42dad5ae7` zombienet helper, `0f3f19aa70f` collator discovery start-order) — not spec-msg design.

**Resolves an earlier open question:** `aea5354b7aa` edits `cumulus/polkadot-omni-node/lib/src/nodes/aura.rs` —
the `specmsg0` inherent **is** wired into the omni-node aura collator (I'd only grepped
`cumulus/client/consensus/aura/src/` before). So the #12594 collator-side wiring is done (in the omni-node node
layer, not the aura crate).

### How the omni-node `spec_msg_inherent` is used after `inherent_data_at`

In `cumulus/polkadot-omni-node/lib/src/nodes/aura.rs` (slot-based / lookahead collators), the
`create_inherent_data_providers` closure builds:

```text
(storage_proof providers, SpecMsgInherentData)  // from inherent_data_at(pool, parent, InherentBudget)
```

`SpecMsgInherentData` implements `sp_inherents::InherentDataProvider` (`cumulus-primitives-spec-messaging::inherent`):

- **non-empty** → `put_data(INHERENT_IDENTIFIER = "specmsg0", self)` into the authoring `InherentData`
- **empty** (no pool / nothing to consume) → puts **nothing**; the block simply carries no spec-msg inherent

Flow into the authored block:

1. Aura collator (`cumulus_client_consensus_aura::collator`) calls
   `create_inherent_data_providers(parent).create_inherent_data()` → `other_inherent_data` (already includes
   `specmsg0` when present).
2. That bag is merged with parachain inherent data and passed to the proposer as
   `ProposeArgs.inherent_data`.
3. Runtime `pallet_spec_messaging::ProvideInherent::create_inherent` reads `specmsg0` and, if non-empty,
   emits `Call::enact_messages { data }` — the mandatory inherent extrinsic that runs
   `consume_channel_item` / `consume_register_read` (Stage 8 above).

One-liner: **pool → `inherent_data_at` → `InherentData["specmsg0"]` → proposer → `Call::enact_messages`.**

## DHT discovery: source genesis via local governance now; relay-lookup is a relay-side proposal

**Current (implemented, `ron/spec-msg-dht-discovery`):** the receiver B resolves a source A's `/paranode`
bootnodes over the relay DHT, which needs A's **genesis hash**. That comes from B's own **local governance**
call `set_source_genesis(A, genesis, fork)` → `SourceGenesis` storage → `SpecMsgApi::source_discovery_info()`
runtime API → the discovery worker (merged with the `--spec-msg-source-genesis` CLI override). This breaks the
chicken-egg (B can't learn A's reachability *from* A — that needs already reaching A), and is dynamic /
channel-lifecycle-driven (governance sets it when standing up a source).

**Why not fetch it from the relay?** Verified the relay does **not** expose a para's genesis post-onboarding
(`polkadot/runtime/parachains/src/paras/mod.rs`): `UpcomingParasGenesis` (which holds `genesis_head`) is
`take`n at onboarding (`:1574`) and applied via `initialize_para_now`, then gone; only `Heads` (current head,
overwritten each block, `:819`) and `CurrentCodeHash` (`:829`) survive. No `ParachainHost` API exposes genesis.
So B genuinely can't derive A's genesis from the relay today — hence the local call.

**Plan B (relay-side proposal — not done, capture for the relay team):** make the relay retain + expose para
genesis, then B needs no local config:
1. In `initialize_para_now` (the common onboarding path for both root-scheduled and genesis-built paras) also
   write a new `ParaGenesisHead: StorageMap<ParaId, HeadData>` — one `HeadData` per para, bounded, permanent.
2. Expose it via a `ParachainHost` runtime API, e.g. `para_genesis_head(ParaId) -> Option<HeadData>`.
3. B queries it and hashes it — `hash(genesis_head)` = the genesis block hash = exactly the `/paranode` genesis
   hash — so the discovery worker resolves genesis from on-chain relay state; the local `set_source_genesis`
   call can be dropped.

**Tradeoff:** clean (drops per-source config, both the source set and its reachability come from chain state),
but it's a **Polkadot relay runtime change** — cross-team, permanent relay state, benchmarks, relay
governance/release — and adds a relay-API dependency to the discovery path. Generally useful beyond spec-msg
("look up a para's genesis"), so worth raising with the relay team; not required for the MVP, where the local
governance call is the self-contained choice.

## bootnodes `discovered_tx`: mixing another para's peer into B's network is safe (and needed)

In `cumulus/client/bootnodes/src/discovery.rs::handle_response`, after streaming the resolved node to the
cross-para caller (`discovered_tx`, `:384-386`), it still runs `self.parachain_network.add_known_address(A_peer,
addr)` (`:388-391`) — i.e. it puts *another* parachain A's peer/address into B's own parachain network. Is that a
problem? **No — and it's load-bearing for our use, not a leftover.**

1. **No identity collision.** A `PeerId` is derived from the node's libp2p key, not the chain — globally unique.
   A's node ID can never clash with a B peer; the address book (keyed by `PeerId`) is unambiguous. "Mixing" is
   just a distinct extra entry.
2. **It's what makes A dialable for `/spec-msg/exchange`.** In our wiring `self.parachain_network` is **B's own**
   parachain network (`BootnodeSourceDiscovery` is constructed with `network.clone()`, the handle the exchange
   protocol is registered on). The fetch loop dials A via `NetworkRequest::request(A_peer, "/spec-msg/exchange",
   …)`, which takes a `PeerId` and relies on the **address book** for the multiaddr. So this line supplies the
   address; `discovered_tx` supplies the `PeerId` for the `PeerRegistry`. The design *depends* on it (otherwise
   spec-msg would have to re-add the address).
3. **Address book only, not a peerset.** `add_known_address` is a dialing hint, not membership in any
   notification peerset (block-announce, gossip, `/genesis-B/sync`). So B never initiates its own genesis-scoped
   protocols toward A — only the `/spec-msg/exchange` request A actually serves. No handshake failures / no
   reputation churn from B's protocols.

Residuals (negligible): a few extra address-book entries per source (bounded by A's advertised bootnode count);
a transient A entry in B's own Kademlia routing table would fail B's `/genesis-B/kad` queries and get evicted.
**Review check:** always pass **B's** parachain network as `parachain_network` here (the spec-msg wiring does),
so the address lands where the exchange dials from.

### Why the `PeerRegistry` isn't redundant with `add_known_address`

The two lines in `handle_response` do different jobs — they're complementary indices used *together*, not
duplicates:

| | keyed by | answers | filled at |
|---|---|---|---|
| Network **address book** (`add_known_address`) | `PeerId → Multiaddr` | *"how do I reach peer X?"* | `:388-391` |
| **`PeerRegistry`** (`SourcePeers`, `exchange.rs`) | `ParaId → {PeerId}` | *"which peers serve **source A**, which misbehaved?"* | `:384-386` via `discovered_tx` → discovery worker |

- The address book has **no para association** — it only knows an address for a peer id. It can't tell the fetch
  loop which of B's many known peers serve source A's `/spec-msg/exchange` (the exchange protocol is generic /
  not genesis-scoped, so the network tracks no per-source membership for it). The `PeerRegistry` is that index.
- A `/spec-msg/exchange` request uses **both**: `PeerRegistry::peers(source)` picks *who*, the address book
  resolves that peer to *where* to dial. Drop the registry → no way to know whom to dial for A.
- **`report_bad`** lives only in the registry — per-source, verification-driven eviction of a peer that served a
  response failing verification; the address book has no equivalent (distinct from the network's generic peer
  scoring).

So `add_known_address` makes a peer *dialable* (transport); the `discovered_tx` → `PeerRegistry` records *which
source that peer serves* + the try-list + bad-peer eviction (application). Neither subsumes the other — the
`discovered_tx` stream is exactly how spec-msg learns the `ParaId → PeerId` association that `add_known_address`
(seeing only `PeerId → addr`) can't provide.

## #12346 scope audit — 5 work streams vs. `rk-spec-msg-primitives`

Reviewed the parent primitives issue (#12346) against my branch (commits `0dda7fc..6d2647d`). It divides the
`cumulus-primitives-spec-messaging` scope into 5 work streams. **4 of 5 are fully addressed; WS4 (network wire
messages) is only partial.**

| # | Work stream | Status | Evidence in branch |
|---|---|---|---|
| 1 | #12700 StreamID + MMRs (leaf preimage, merge, frontier, inclusion proofs) | Done | `StreamId` (`stream.rs:42`), `SpecMerge` (`mmr.rs`), `leaf_hash`+`LEAF_VERSION` (`message.rs:66`, `lib.rs:92`), `MmrFrontier`/`MmrRoot`, `MMRExtensionProof`+`.verify()` (`lift.rs:104,129`), inclusion via `mmr_lib` `gen_proof`/`calculate_root` |
| 2 | #12701 Commitment trie keyed by StreamID + consumption record + stream intervals + channel core | Done | `streams_root()` + `gen_stream_proof`/`StreamProof`/`verify_stream_membership` (`streams_root.rs:143,177,242`); `ConsumptionRecord` (`lift.rs:182`), `Interval` (`lift.rs:170`); channel core in `flow_control.rs` |
| 3 | #12702 Lift primitives (requires lift, stitching, lift errors) | Done | `RequiresLift` (`lift.rs:191`), `stitch` (`lift.rs:232`), `LiftError` (`lift.rs:205`), `build_requires`/`build_requires_entry` (`lift.rs:290,261`) |
| 4 | Network wire messages (message + **event** + **exchange** req-resp) | **Partial** | Only the fetch protocol: `MessagesRequest`/`MessagesResponse`+`verify` (`message.rs:96,115,144`). **`EventRequest`/`EventResponse` and `ExchangeRequest`/`ExchangeResponse` absent** — no `wire.rs`; `message.rs:31` defers the event read-path "with the event-stream subsystem" |
| 5 | Channel lifecycle (`SpecMsgKind`, `SpecMsgSignal`, `WindowGrant`, `Register`) | Done | all four in `flow_control.rs:58,85,119,146` (commit `341754c5181`) |

### The WS4 gap

#12346's WS4 lists **three** wire protocols; the branch has **one** (Messages/fetch). Missing:

- **Event req-resp** (`EventRequest`/`EventResponse`) — receiver-side event-stream read path. The `message.rs:31`
  comment already earmarks this "with the event-stream subsystem", i.e. a deliberate deferral to the client
  subsystem PR rather than the primitives crate.
- **Exchange req-resp** (`ExchangeRequest`/`ExchangeResponse`) — the channel-open handshake exchange
  (`/spec-msg/exchange`).

Open question to resolve before closing #12346: are Event + Exchange req-resp intentionally scoped to a later
client-subsystem PR (in which case WS4's checkbox should be split/annotated), or are they in-scope for the
primitives crate and simply not yet landed? If the former, note the deferral on #12346 and move the two protocols
under the wire/DHT-discovery follow-up; if the latter, scaffold `EventRequest/Response` + `ExchangeRequest/Response`
alongside `MessagesRequest/Response` (own `wire.rs` mirroring lexnv's PoC layout).

## Primitives consistency: `rk-spec-msg-primitives` vs `lexnv/spec-msg-poc-mvp`

Cross-checked the four DONE work streams (WS1/2/3/5) type-by-type against lexnv's PoC crate. Different file
layout (mine: `stream/mmr/streams_root/lift/message/flow_control`; lexnv: `stream_id/mmr/tree/record+lift/
wire/channel`) but the **type shapes and invariants align on both sides**. The divergence is purely in **three
pinned low-level constants** — so the two impls are structurally the same design yet **not byte-compatible**;
at most one matches the design doc's canonical values.

### Aligned (identical or semantically equal)

- **WS1 StreamId** — 4 variants, `STREAM_ID_LEN=8`, kind-byte + big-endian order-preserving encoding, reserved
  kinds `0x03..=0x7F` rejected, `Private` gated to `kind >= 0x80`.
- **WS1 MMR structure** — `SpecMerge` 3-role tagging, leaf preimage `TAG ++ version ++ payload`, peaks-frontier
  + bagging matching `mmr_lib::get_root`, forward extension/ancestry proof.
- **WS2 commitment tree tags** — AGREE: `TREE/STREAMS_LEAF_TAG=0x5`, `_INNER_TAG=0x6`.
- **WS2 record** — `Interval { start: MmrRoot, end: MmrFrontier }`, `ConsumptionRecord` — identical shape +
  forward-chain invariant.
- **WS3 lift** — `RequiresLift { … tree_proof }`, `LiftError` set, `stitch`, `build_requires` — identical
  semantics (positional lift↔`StreamId`-sorted-record matching, `tree_proof` binds the record key).
- **WS5 channel** — `SpecMsgKind`, `SpecMsgSignal` (`OpenChannel` frozen at variant 0), `WindowGrant`,
  `Register` — byte-identical encoding (same test vectors). (lexnv also carries a `ChannelId` in `channel.rs`
  keying the runtime-API channel views — a runtime-API key, not one of #12346's enumerated WS5 types.)

### Divergent constants (reconcile before the branches converge)

1. **MMR domain-tag bytes offset by one role.** lexnv `{LEAF,INNER,PEAK,EMPTY}={0x1,0x2,0x3,0x4}`; mine
   `{EMPTY(reserved,unused),LEAF,INNER,PEAK}={0x1,0x2,0x3,0x4}`. Same range, different roles → the two impls
   compute **different message-stream MMR roots** → different `StreamsRoot` (even though the tree tags at
   0x5/0x6 agree). My `lib.rs` comment ("`EMPTY_TAG = 0x1` slot intentionally left unused rather than
   renumbering") reads like a deliberate renumber on my side.
2. **Empty-MMR root.** lexnv hashes empty with `EMPTY_TAG=0x4` → concrete root; mine returns `Option::None`
   (0x1 reserved, unused). Edge-case semantic mismatch.
3. **Consensus engine id.** `SPMS_ENGINE_ID`: lexnv `b"SPMS"` vs mine `b"spmf"` → the `StreamsRoot`-carrying
   digest is tagged differently.

Open item: which set matches the design doc's canonical `LEAF/INNER/PEAK/EMPTY` tag bytes + engine id? They
can't both; whichever branch we merge into needs one canonical set or senders/receivers won't agree on a root.
(Design-doc check pending — see below once resolved.)

### Design-doc resolution (canonical values)

Checked `speculative-messaging-design.md` (§Leaf Hashing and Domain Separation) and
`speculative-messaging-impl-design.md` (§1 TODO). Outcome: **the design pins neither the MMR tag byte
values nor the engine id — so neither branch is "wrong", and there is no canonical set to conform to; the
requirement is only that we pick ONE set for the merged crate.**

1. **MMR tag bytes — NOT pinned.** The design mandates *distinctness* only: "Distinct tags
   (`LEAF_TAG`/`INNER_TAG`/`PEAK_TAG`) for leaves, inner nodes and peak bagging" — domain separation to kill
   the RFC-6962 §2.1 / CVE-2012-2459 leaf-vs-inner ambiguity. The doc cites RFC 6962's `0x00`/`0x01` as the
   *origin technique*, not spec-msg's assignment. Both branches satisfy the actual requirement (all MMR tags
   mutually distinct, and distinct from the tree tags `0x5`/`0x6`, which the two branches already agree on).
   → The `{0x1,0x2,0x3,0x4}` offset is a free choice, not a conformance bug. Since the impl-design doc tracks
   **my** branch as the "✅ done" reference implementation, my numbering (`LEAF=0x2/INNER=0x3/PEAK=0x4`, `0x1`
   reserved) is the natural canonical pick for the merge; lexnv's is the older PoC value.

2. **Empty-MMR root — my `Option::None` is the design-aligned choice.** The `StreamsRoot` trie is "keyed trie
   over **active** streams", and an active stream has ≥1 leaf, so an empty stream never contributes a tree
   entry → no empty-MMR root is ever needed. lexnv's `EMPTY_TAG=0x4` concrete empty root is defensive but
   never exercised on the commit path. Reserving `0x1` unused (mine) is consistent with frontier-only /
   active-streams-only state.

3. **Engine id — explicitly TBD.** design-doc line ~2585: "engine id value **TBD**"; impl-design §1 TODO:
   "Confirm inferred bits with the design owner (… `SPMS_ENGINE_ID` value)". Neither `b"SPMS"` nor `b"spmf"`
   is canonical — an open item to settle with the design owner before either sender ships a digest.

**Net:** the two branches implement the *same design*; the three divergences are all un-pinned free values,
not design violations. Action is to choose one canonical set at merge (my branch's tags are the reference the
impl-design doc already tracks) and to close the `SPMS_ENGINE_ID` TBD with the design owner.

> Side note: the impl-design doc's §2 still describes the `paras_inherent` feature gate
> (`speculative_enabled` / `FeatureIndex::SpeculativeMessaging = 5` / "feature-off → drop") — now **stale**,
> since we removed the node-feature bit and the gate on both `rk-spec-msg-primitives` and `rk-spec-msg-relay`
> (release-first). The impl-design doc should be updated to drop that gate description.

## MMR-layer primitives reconciliation — DONE (vs lexnv/spec-msg-poc-mvp)

The MMR/tree primitives in `rk-spec-msg-primitives` now align with the PoC branch, so proofs are
wire-compatible across the two. Landed on `rk-spec-msg-primitives`:

- **Domain tags** (commit `d656de2871e`) — MMR `LEAF/INNER/PEAK` renumbered `0x2/0x3/0x4 → 0x1/0x2/0x3`
  (matching poc-mvp). No `EMPTY_TAG`: empty streams are never committed to a `StreamsRoot` (an empty
  MMR simply has no root), and the marker `OpenChannel` leaf means opened channels are never empty —
  so `EMPTY_TAG` is dead weight. The `0x1` slot (formerly reserved for the removed EMPTY_TAG) is
  reclaimed; commitment-tree tags stay `0x5/0x6`; `0x4` is now free. `SpecMerge`/`leaf_hash` produce
  byte-identical roots to poc-mvp. Frozen MMR-root vector re-pinned (`9aadc77e… → 2cfe88aa…`).
- **`MmrInclusionProof`** — identical struct + `verify_head`/`verify_leaf` logic; my branch keeps an
  extra `verify_leaf` item-count bound (`MAX_INCLUSION_PROOF_ITEMS → ItemLimitExceeded`) the PoC lacks
  (defense-in-depth). Better on my side; nothing to change.
- **`MMRExtensionProof`** (commit `d656de2871e`) — adopted the PoC's `leaf_count` field (the `mmr_lib`
  node size is *derived* via `leaf_index_to_mmr_size`, so an out-of-range size can't be smuggled in) +
  `verify` shape (frontier consistency, strictly-forward, extend-from-empty branch), while keeping my
  `MAX_EXTENSION_CONNECTING_NODES` ceiling the PoC lacks. Roots unchanged.
- **`StreamsRoot` / `TreeStep`** (commit `47c3400b7aa`) — dropped the redundant `TreeStep.target_right`
  (derived from the key at verify), so a step now SCALE-encodes byte-identically to the PoC's
  `(u8, Hash)`. `StreamsRoot` unchanged (tag never entered the hash).

### Remaining delta (cosmetic)
Error-type naming: `ProofError` (mine) vs `MmrError` (PoC), same variants. `ProofError` is the better
pick — it avoids the `mmr_lib::Error as MmrError` collision in the crate and names "proof verification
failure" precisely. Plus my response-level `VerifyError` (per-reason: Proof/TreeProof/RootMismatch/
UnexpectedBase/ExceedsBudget/VariantMismatch/PayloadTooLarge/MalformedResponse) has **no PoC
equivalent** — it's what the fetch subsystem needs for peer-scoring vs retry. To converge: PoC renames
`MmrError → ProofError` and gains `VerifyError`; nothing on my side changes.

### Net
StreamId, channel/flow-control types, `StreamsRoot`/`TreeStep`, `MmrInclusionProof`, MMR domain tags,
and `MMRExtensionProof` are all consistent (byte-identical roots + wire-compatible proofs). Only the
error-type name differs, and mine is the one to standardize on.
