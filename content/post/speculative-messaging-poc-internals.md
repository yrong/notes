---
title: "Speculative Messaging — PoC Internals (code analysis)"
author: Ron
date: 2026-07-30T00:00:00+08:00
tags:
- polkadot
- parachain
- speculative-messaging
- code-analysis
---

# Speculative Messaging — PoC Internals (code analysis)

Code-analysis deep-dives on the `spec-msg` PoC (`lexnv/spec-msg-poc-mvp`), organized by the
[#12531](https://github.com/paritytech/polkadot-sdk/issues/12531) work streams. These are the "how the code
works" Q&A findings — split out of the [v0.5 alignment note](speculative-messaging-v0.5-alignment.md)
(reconciliation + proposals) and complementing the linear [Implementation Design](speculative-messaging-impl-design.md)
(component reference). Findings surfaced here are summarized in impl-design §8. Deep-dives labeled "Stage N"
expand the [Implementation Design](speculative-messaging-impl-design.md) end-to-end walkthrough's stages.

## #12346 — primitives (`cumulus-primitives-spec-messaging`)

The stateless `streams_root(entries)` recompute (no persisted tree) is analyzed alongside the pallet's
persisted trie under **#12708 → Commitment tree storage** (below).

### Proof shapes — `MmrInclusionProof` vs `MMRExtensionProof`

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

## #12349 — relay (`runtime/parachains::spec_msg`)

### Relay-ring deep-dive — Stages 3 & 10: `RecentProvides` window match

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
  +128 pushes SR falls off the tail        (128 of *A's Provides pushes*, not relay blocks — idle A-blocks
                                            push nothing; matters only if B never got backed → rebuild vs SR_current)
```

**Dispute revert.** On a revert, `paras_inherent` calls `evict_after_revert` (`:216`) to roll the affected
sender rings back to the revert height — the PoC evicts explicitly rather than trusting state-revert alone.

## #12707 — node/client (`cumulus-client-spec-msg`)

### The relay `Provides` monitor (`monitor.rs` / `run_relay_provides_monitor`) — the fetch trigger (Stage 4)

The receiver's entry point: it watches imported relay blocks and turns "a source's inclusion frontier
moved" into fetch triggers, feeding the pool downstream. Confirmed matching the design.

**Loop (`:257`).** Subscribes to `import_notification_stream()`; processes the relay **tip once up front**
(`:284`) so a restarted collator doesn't wait a block to learn the current frontier; then one
`process_relay_block` per import. A **major-syncing gate** (`:352`) skips historical rings, and a
`has_api::<SpecMsgApi>` gate (`:358`) makes a non-spec-msg runtime a no-op.

**Source set.** Not just `consumed_streams()` — it's `consumed_streams()` **∪ `out_channels()` peers**
(`:365–371`): register-only outbound peers count, because an outbound handshake completes by reading the
peer's ack register under the peer's *included* root even if no inbound channel consumes that peer.

**Two-tier trigger** (`RelayProvidesEvent`):
- **`Included(source, root, relay_block)`** — the root newly appeared in `RecentProvides[source]` (the
  ring, read via `read_recent_provides`, `:378`). This is the inclusion-tier **trust anchor**: fetch,
  verify, consume, author under it. `note_ring` (`:167`) diffs the ring against a bounded `SeenRoots`
  set and emits each new root **exactly once, oldest first**. **Bootstrap** (first sight of a source)
  offers only the *newest* ring entry — the rest predate the monitor and, streams being append-only, the
  newest covers the history; the older ones just seed dedup. Pushes `pool.note_pending_offer` *before*
  the send (`:394`) for the issue-10 late-offer grace window.
- **`Pending(source, root, relay_block)`** — a **pending-availability prefetch hint** (see below).

**Fork-safety** is dedup-by-root across branches; a re-org to a fork without the enactment retracts nothing
(the root just isn't in that branch's state, which the fetch pipeline re-verifies against anyway). Dedup
memory is bounded (`SEEN_ROOTS_BOUND = 512`); eviction only ever causes a harmless duplicate offer, never a
miss.

#### Pending-availability prefetch hints — what `Pending` buys

A source candidate goes **backed → pending availability → included**. Its `Provides(StreamsRoot)` lands in
`RecentProvides` only at **inclusion** (availability-confirmed, hard to revert) — the trust anchor. Between
backing and inclusion sits the **availability period** (a few relay blocks).

The hint closes that gap: the monitor also reads the source's `candidates_pending_availability` (`:403`),
pulls the committed root out of the backed-but-not-yet-included candidate (`pending_provides`, `:217`), and
offers it as `Pending`. The fetcher can then **start downloading + verifying early**, overlapping the fetch
with the availability period — a pure latency win.

Crucially it is a **hint, never a trigger**: consumption and authoring key off `Included` roots
**exclusively**. A backed candidate can still fail to include (dispute, timeout, re-org), so the receiver
never consumes/authors on a pending root. If it *does* include, the monitor re-emits it as `Included` (the
real trigger) — by then the fetch may already be done. If it never includes, the prefetch was wasted
bandwidth, no correctness impact (fetches are root-keyed/idempotent, re-verified against relay state before
use). `note_pending` (`:195`) returns `None` if the root was already offered as `Included` (a real trigger
happened — don't hint it), and once included a root can't regress to a hint (test
`pending_roots_hint_once_and_still_trigger_on_inclusion`, `:521`).

### The fetch pipeline (`fetch.rs` / `run_spec_msg_fetcher`) — rounds & retry classification

Each `Included(source, root)` runs one **round** for that source under that root (`run_fetch_rounds`,
`:506`): per consumed channel stream, chunked + resumable `MessagesRequest`s (512 KiB, resume from
`base + received` until `end.leaf_count >= head`) each MMR-verified against **exactly `root`**; per outbound
channel, the peer's ack-register head read (`EventRequest{ at: None, under: root }`); all landed in the pool,
then `complete_round` sets `target(source) = root` (the lift target). The in-flight marker is set at **trigger
receipt**, before the round future even exists (`begin_round`, `:540`), because the proposer's inherent
snapshot can fire ~1–5 ms after the offer — authoring's grace window (`wait_for_in_flight_rounds`) must find
something to await.

**Retry model.** A failed round retries **under the same root** with bounded exponential backoff
(2→4→8→16 s, `MAX_ROUND_RETRIES = 4`), because a quiet sender offers no next root — without in-root retry a
single transient failure would stall the source indefinitely. A fresh included root **supersedes** the
scheduled retry and **resets** the budget; a completed round clears it.

**`retryable()` (`:602`) — the classification and *why*.** Retry only when re-running the identical round
under the same root can plausibly move forward:

| error | retry? | use case / why |
|---|---|---|
| `Exchange(_)` (transient) | ✅ | flaky peer / rotate to another / the bad-peer set shrinks — backoff lets the network recover |
| `ChunkBound` | ✅ | backlog > 4096 chunks/round; the retry **resumes** where it stopped — productive by construction |
| `Api` | ❌ | the local *"what do I consume?"* read (`consumed_streams`/`out_channels`) failed — mid-reorg or state at `best_hash` unavailable. Same root re-reads the same broken state; the **next block's trigger** reads a fresh `best_hash`. Not a network failure at all. |
| `Pool` | ❌ | a *verified* chunk was rejected by `note_chunk` — a deterministic local bug (base/gap mismatch). Re-fetch yields the identical chunk + identical rejection; non-retryable avoids a retry storm on a bug. |
| `NoPeers` | ❌ | the `PeerRegistry` is empty (cold start, all banned, no `--spec-msg-serve` collators). Peers come from the **discovery worker on its own cadence** — backoff conjures none. Recovery = (discovery populates) × (next root re-triggers). Also **marks no target** and clears the in-flight marker, so authoring never blocks on a peerless source (`:983`, `:1247`). |

The deferral is safe by the retry's own logic: an *active* source re-triggers with healed state / found peers
on its next included root; a *quiet* source has no new data to fetch, so there is no stall to bridge.

**Never-written tolerance** (distinct from the above): a consumed stream with `cursor == 0` and no pooled run
may simply never have been written (the accept-before-open handshake window); the archive can't prove an empty
stream under any root, so the server refuses. That refusal is tolerated outright — the round still pools the
register read, marks the target, and returns `Ok` **without** scheduling a retry (an in-root retry could never
serve what no root proves; recovery rides the next included root carrying the first send). Tests `:883`,
`:1097`.

### The verified pool (`pool.rs` / `SpecMsgPool`) — ledgers, bindings, fork-safe hand-out

The fork-safe staging area between `verify` (what's been *proved*) and `build_inherent` + lift assembly (what
a block *consumes* and how it proves that to the relay). Two kinds of held state.

**Channel ledger — what for.** Per consumed channel stream, the consumer's record of **verified inbound
messages it has proved from one source and is ready to consume + re-prove**. Like an account ledger: a
contiguous run of entries reconciled against a statement — here the sender's **included `StreamsRoot`**.
```rust
struct ChannelLedger { base, end: MmrFrontier, payloads: VecDeque<Vec<u8>>, leaves: VecDeque<Hash>,
                       binding: Option<ChannelBinding> }
struct ChannelBinding { root: StreamsRoot, head: u64, extension: MMRExtensionProof, tree_proof }
```
`base..end` is the run; `leaves` kept even after payloads are handed out (lift needs hashes, not bytes). The
**binding** is what makes the run *liftable* — it ties `[base,end)` to a currently-included root via the
extension `end→head` + the stream's tree proof.

**Flow (S sends `p0..p7`; included root `R1`@count5 → `R2`@count8; consumer R):**
1. *Round 1* — fetch `[0..5)` under `R1`; `verify` proves it's S's prefix → `note_chunk` creates the ledger:
   `base@0 end@5 payloads=[p0..p4] binding{R1, head5, ext=identity}`.
2. *Author block N* (R's on-chain cursor = 0) — `build_inherent`: cursor∈[base,end] ✓, `binding.root==target` ✓
   → **clone** `[p0..p4]` into the inherent (ledger untouched). Runtime consumes → `InboundFrontier=5`;
   `validate_block` lifts endpoint 5→`R1` via the binding; relay checks `R1∈RecentProvides`.
3. *Round 2* — S→8 (`R2`); fetch `[5..8)` resuming from `end@5`; verify **appends** onto frontier@5 →
   `note_chunk` extends the ledger and the newest binding **re-binds the whole run**:
   `base@0 end@8 payloads=[p0..p7] binding{R2, head8}` — `[0..8)` now liftable under `R2` (append-only prefix).
   *Staleness = regeneration, not invalidation*: an old-root run is still a valid prefix under every newer
   root, so the next round just re-binds it.
4. *Author N+1* (cursor 5) — take `[p5..p7]` → consume → lift 8→`R2`.

**Non-destructive hand-out = fork safety.** `build_inherent` **clones** and never removes; the **cursor**
(read from the *authoring parent's* on-chain `InboundFrontier`) is the sole truth for "already consumed." So
two candidates on different parents (both cursor 0) each get `[p0..p4]`; whichever branch loses simply never
applied its consumption — no corruption, because the run was never destroyed. Guardrails: `cursor > end` ⇒
another collator consumed material this node never pooled → drop + re-fetch trust-free (pool.rs:791);
`binding.root != target` ⇒ withhold a block rather than emit an unliftable record (pool.rs:801).

**Always binds to the *latest* target — and two limits, two extensions.** `pool.target` is the newest
included root the monitor saw for the source; consumption always binds to *it*, never a stale root — the
`binding.root != target` withhold (pool.rs:801) enforces this: a run still bound to an older `R1` after the
target advanced to `R2` is held for a block until the next round re-binds it (else the lift would be against a
root that may have left `RecentProvides` → unliftable). So the example's round-1 bind to `R1` is only the
*live-receiver* timeline (`R1` **was** the latest then); a receiver catching up when S is already at `R2`
targets `R2` from the start. Two *independent* capacity limits then decide the endpoints — and `head` is
always the stream's count **under the target root**, not your endpoint:

| limit | bounds | proof it shapes |
|---|---|---|
| **fetch** (response size) | `ledger.end` (how much pooled) | `binding.extension = ledger.end → head`; pool `[0..5)` under `R2`(head 8) ⇒ `binding{R2, head 8, ext 5→8}` |
| **inherent** budget (`build_inherent`) | cursor `take` (how much a block consumes) | ledger holds `[0..8)` (`binding.ext = 8→8` identity), block consumes `[0..5)` ⇒ **`lift.extension = 5→8`** |

_What "mid-backlog" means._ **backlog** = `head − ledger.end` — messages the sender committed (under the
target root) that the receiver hasn't fetched yet. **Mid-backlog** = the receiver has pooled *some* of the
stream but not all the way to the head:

```
positions:  0 ——— pooled [0..40) ———| ——— not yet fetched ——— | 100
            base                 ledger.end                   head
     Case A (caught up): ledger.end == head   ·   Case B (mid-backlog): ledger.end < head
```

The **lift** extension (`consumption endpoint → target head`) is what a block actually emits, distinct from
`binding.extension` (the one fetched `ledger.end → head`). `channel_lift` (pool.rs:860) picks it in **two
cases**, and the split is the real subtlety:

- **Case A — fetch caught up (`ledger.end ≥ head`).** The ledger holds all leaves to the head, so the lift
  extension is **generated fresh from the retained `leaves`** for *whatever* endpoint the block consumed —
  `nodes().extension(endpoint, head)`, any endpoint in `[base, head]`. _E.g._ ledger `[0..8)`,
  `binding.extension = 8→8` (identity); block consumes `[0..5)` → `lift.extension = 5→8` from leaves `[5..8)`.
  **Differs from `binding.extension`.** (This is *why* leaves are kept after payloads are handed out.)
- **Case B — mid-backlog, fetch incomplete (`ledger.end < head`).** The ledger has no leaves past `end`, so
  the **only** liftable point is `endpoint == end`, reusing the fetched `binding.extension`. _E.g._ ledger
  `[0..5)`, `binding.extension = 5→8`; block consumes the whole `[0..5)` → `lift.extension = binding.extension
  = 5→8`. **Coincides.** A partial `[0..3)` → `NotCovered`.

So: they **coincide in Case B at `endpoint == end`** (lift *is* binding); they **diverge in Case A**
(regenerated per endpoint). And the load-bearing consequence: **whether a partial-prefix consumption is
liftable depends on whether the fetch reached the head** — caught-up ⇒ any prefix liftable (the "partial
consumption fully supported" case); mid-backlog ⇒ only the full pooled run.

**A capacity-limited fetch still binds to the target, not to a root matching the fetch count.** The binding
root is whatever you *request `under`* (= `pool.target`), never a function of how many payloads came back. If S
is at 8/`R2` and you fetch only `[0..5)` (payload budget), the archive serves under `R2`: caps at count 8,
fills payloads to budget, then `extension(served_to=5, count=8)` — so the response is `payloads[0..5) +
extension(5→8) + tree_proof@R2`, and the extension (hashes, O(log n)) is **always** included regardless of the
payload budget. Ledger: `end@5, binding{R2, head 8, ext 5→8}` — **no `R1`**; `5` is just `ledger.end`, `head`
is 8. So it's consumable + liftable under `R2` immediately, and the per-chunk payload budget just **splits catch-up
into chunks *within* a round** — the fetch loop auto-resumes to `[5..8)` under `R2` in the *same* round,
spilling to the next round only if the per-round chunk cap is exhausted. (A *round* is one fetch cycle
triggered by a relay import and keyed by an included root — the source's lift target; distinct from block /
candidate production, which drains the pool via `build_inherent`.) `R1` only enters if the **monitor is lagging** (target
still `R1` when fetching) → `binding{R1, head 5}`; when the target then advances to `R2`, the withhold
(pool.rs:801) holds that ledger until a re-fetch re-binds it — so a stale-root prefix is never *consumed* once
a newer target is known.

**Second kind — register head reads.** Symmetrically, as a *sender*, the node reads its receivers' registers
(watermark+grant) off the Ack stream: pooled as `RegisterRead{ root, payload:Register, inclusion, frontier,
tree_proof }`, keyed by read-context leaf count, **newest-wins**. Handed to at most one block (`fresh→handed`);
`reconcile_handed` returns it to handable if that block didn't land, checked against the parent's applied
register view — same fork discipline, explicit marker because only the latest head read matters (vs. a
channel's contiguous run). This is what drives Tier-1 watermark pruning (`out_channels()` → `prune_payloads`).

**Why `reconcile_handed` isn't stateless (explored + abandoned 2026-08-02).** The problem it solves: a
receiver applies a source's ack watermark (`up_to`) on its *own speculative chain* (the collator authors
ahead of backing), and the source may go **quiet** — once it has published the watermark there is no new root
to re-trigger a fetch. If the block that applied the read reorgs away, the surviving branch is missing the
watermark and, with no re-trigger, R's send window to S never advances: a **silent flow-control deadlock**
(the run-3 stall — A#125 carried the read, A#126 built on it, both died at a session boundary, the re-author
went out empty). So R must *retain* the verified read and **re-deliver it to whichever fork survives**,
reconciled against the parent's applied view (`up_to`/`version`/close-latch monotonic; `grant` advisory,
excluded) without double-applying on the branch that did land. A stateless recompute — "hand the newest
target-matching read the parent hasn't reflected, each block, no markers" — **passes all four fork-redelivery
tests** (`dropped_/hand_outs_reflected_/refreshed_/superseded_register…` in authoring.rs): that half of the
logic *is* cacheless. It fails on the **second, irreducible** job of the `handed` marker: an *undecodable*
ack leaf (buggy/malicious source; runtime rejects it `BadRegister`) must be handed **at most once** then
abandoned, "instead of re-handing it to every block forever" (`inherent_hands_the_contiguous_continuation_
within_budget:598`) — a re-include-and-reject-every-block DoS otherwise. "Already handed once" can't be
derived from `reads` + parent, so a stateless version either re-hands a BadRegister forever or never hands
the placeholder reads the fetch-mechanic tests rely on. Conclusion: the `handed` marker earns its ~30 lines —
it is a hand-a-BadRegister-at-most-once guard, not incidental bookkeeping.

**Budget-bounded inherent — a too-large pool drains over blocks.** `build_inherent` never seals the whole
pool; `inherent_data_at` (authoring.rs) passes an `InherentBudget{ max_bytes, max_streams }` (MVP default
`256 KiB / 8`), "bounded so an honest provider never hits the runtime's per-block caps (issue 06); the
leftover backlog stays pooled for the next block — partial consumption is a lift case, fully supported."
`max_bytes` caps total payload bytes (payloads + lifts + inclusion proofs all ride PoV); `max_streams` must
stay below the runtime's `MaxTouchedStreams`. Two nested caps: **per stream**, take payloads from the cursor
while they fit `bytes_left`, stop at the first that doesn't (pool.rs:806); **across streams**, stop once
`messages+register_reads ≥ max_streams` (pool.rs:785).

Because the hand-out is **non-destructive** and the cursor comes from the *on-chain* `InboundFrontier` after
this block consumes, the next block resumes where this one stopped — a too-big backlog drains one budget-slice
per block. _E.g. stream `[0..100)`, ~4 KiB payloads, 256 KiB budget → block N takes `[0..64)` (`frontier→64`,
lift 64→head), N+1 takes `[64..100)`._ And it's not a degraded path: a prefix `[cursor..cursor+take)` still
emits a valid `Requires` — the **lift** extension bridges the *consumption endpoint* → target head regardless
of how much drained (the `binding.extension` vs `lift.extension` split above).

The backlog can't grow unbounded anyway — **flow control caps it end-to-end**: the receiver drains at
≤ `max_bytes`/block → its watermark lags → the sender's window grant fills → the sender throttles. So the pool
holds ~one grant-window of backlog and bleeds it at budget/block; it never has to fit "all of it" in one
block. (**Config invariant:** `max_bytes ≥ MaxMsgLen`, else a single oversized payload `take==0`s every block
and starves — comfortably true at the 256 KiB default.)

**⚠️ Traced — partial take × Case-B is real & unguarded (liveness, not safety).** `build_inherent` takes a
byte-budget-limited *prefix* and does **not** check the Case-A/B split. Path confirmed: `endpoint = cursor +
take` flows via `consumption_record()` → `assemble_from_records` → `channel_lift(endpoint)` (authoring.rs:298);
in Case B, `endpoint < end` → `NotCovered` → `AssembleError` → **collation fails** (graceful/logged, not a
crash, never an invalid candidate). No size guard exists: `FETCH_CHUNK_BYTES = 512 KiB`, `MAX_CHUNKS_PER_ROUND
= 4096` (Case-B run up to **~2 GiB**) vs inherent `max_bytes = 256 KiB` — even *one* chunk exceeds the budget,
so a Case-B run > 256 KiB forces a partial take.
- **Reachability:** Case B = the round didn't reach `head` (chunk loop stops only on the 4096-chunk cap, i.e.
  a **> ~2 GiB single-stream backlog**, or a **stalled/incomplete round**). Steady-state caught-up receivers
  are Case A (partial fully supported). So this is a **deep-backlog / stalled-fetch edge**, not the hot path.
- **Impact:** liveness/efficiency, not safety. A Case-B stream > 256 KiB **can't be consumed until the fetch
  reaches `head`** (→ Case A) — deep backlog is "fetch-all-to-head then drain," never pipelined — and
  `build_inherent` *wastes a collation attempt* each block (a doomed partial) rather than skipping the stream.
  Self-resolves once caught up.
- **Fix:** in Case B (`ledger.end < head`), go all-or-nothing — take `[cursor..end)` only if the whole run
  fits `bytes_left` (→ `endpoint == end`, liftable via `binding.extension`), else **withhold** the stream
  (`continue`, like the stale-`binding.root` guard at pool.rs:801). **Candidate PoC finding.**

**Drain granularity: per block, bundled into a candidate.** The `256 KiB` budget is **per block**
(`build_inherent` runs once per block), but a collator "**chains proposals ahead of backing**" (pool.rs:238) —
so a candidate/collation is a **bundle of blocks**. `assemble_collation(blocks: &[Block])` reads each block's
`consumption_record()`, merges "in bundle order" into per-stream interval chains, and emits **one
`RequiresLift` per stream at the chain endpoint** (`chain_endpoint`), declared in `ParachainBlockData::V3`.
The lift axis is the **`(source, stream)`**, not the block/candidate/bundle: a stream consumed in blocks N
*and* N+1 gets **one** lift at the chain endpoint (not one per block); a bundle touching K streams emits **K**
lifts (grouped by source as `LiftsBySource`, ≤ `MaxTouchedStreams`). So a candidate carries a *set* of lifts —
one per consumed `(source, stream)` — never "a lift per candidate" or "per bundle".
Within one collation, several blocks each drain a `256 KiB` slice — the pool read **non-destructively per
block**, cursor advancing block-to-block — and the whole bundle's consumption of a stream collapses to a
single lift. _E.g._ pool `[0..100)`: block N drains `[0..64)`, N+1 (cursor now 64) drains `[64..100)`, one
lift at endpoint 100. So "drained over multiple blocks" and "drained in one candidate" aren't in tension — a
candidate *is* multiple blocks here (by bundling, not because a candidate = one block). Two bounds keep it
from being *guaranteed* single-candidate: **bundle size is bounded** (drain/collation ≈ `256 KiB ×
blocks_in_bundle`; a bigger backlog spans multiple collations over successive relay parents), and a **Case-B
stream drains none** until the fetch reaches `head` (→ Case A), bundling or not.

### Two-tier prune (as-built) — how it works today, both sides

The prune lives on the **sender** (its own-sends archive, `client/spec-msg/archive.rs`); one of the two
tiers is **driven by the receiver**. For a channel **S → R**: S archives the Channel stream (per position
a payload ~KB **and** a leaf hash 32 B, plus per-block boundaries), serves R over `/spec-msg/exchange`, and
runs both prunes. R only *fetches* + publishes a watermark. (Symmetric: R is the sender on the **Ack stream**
carrying those watermarks back, pruned the same way — roles swapped.)

**Two floors → three bands.** `payload_floor` (watermark-driven, fast, moved by R) and `floor`/horizon
(wall-clock 25 h, S alone) advance up the position axis, with `floor ≤ payload_floor`:

```
position →  0 ....... floor ....... payload_floor ....... count(head)
            |  BAND A   |   BAND B      |      BAND C         |
 leaf hash:    gone        present          present
 payload:      gone        gone             present
 serve:     BelowHorizon  lift OK,        fully serveable
                          payload=PayloadsPruned
```

- **A** (below horizon): reaped → any request `BelowHorizon`.
- **B** (below the watermark, kept to 25 h): payload gone, **hash kept** → a payload request →
  `PayloadsPruned`, a lift over it *could* serve. But note **who its consumer is**: a receiver's
  `InboundFrontier` is monotonic on-chain (endpoint **always ≥ its own watermark**) and lifts extend
  *forward* from the endpoint, so **nothing ever lifts from below the watermark**. Band B has **no reachable
  consumer** — it's a conservative "serve any boundary within 25 h" guarantee that no client exercises. This
  is exactly the band the [retention merge plan](speculative-messaging-v0.5-alignment.md) drops (`floor =
  max(watermark, …) ≥ watermark` collapses it). ⚠️ *This is the crux of why the two-tier split doesn't earn
  its keep on 1:1 channels.*
- **C** (unconfirmed tail, ≥ watermark): both present → fully serveable, **and the only band lifts actually
  read** (endpoint → newer root extends across it).

**Tier 1 (watermark, receiver-driven):**
`R pallet consume → InboundFrontier.leaf_count = W → publish_register{up_to:W} on Ack ──R→S──▶
S pallet → OutChannels[ch].register.up_to = W → S node out_channels() (worker.rs:179) →
prune_payloads(stream, W)` → `payload_floor ← W`, drop payloads `[old, W)`, **keep leaf hashes**.
_Example:_ R confirms through pos 4 (`up_to=5`) → payloads `[5..8)`, hashes `[0..8)`, `payload_floor=5`;
payload@2 → `PayloadsPruned`. The retained hashes `[0..5)` sit below R's own endpoint (≥ 5), so R never
lifts across them — that's the unused Band B in miniature.

**Tier 2 (horizon, sender wall-clock):**
`S node prune_horizon(now − 25h)` (worker.rs:191) → drop boundaries > 25 h old (newest always kept) →
`floor ← oldest-retained boundary's leaf count`, delete leaf hashes (+ any payloads) below it, retain the
boundary frontier at `floor`. _Example, next day: `count=120`, `watermark=100` (`payload_floor=100`),
boundary 25 h ago recorded 60 → `floor=60`._ Retained: hashes `[60..120)` + `frontier@60`. The **real** lift
is a receiver at its own endpoint@100 binding forward — `100 → root@120`, over band-C hashes `[100..120)`;
that's what has to keep working. The horizon-kept band `[60..100)` is below every consumer's endpoint (Band
B) — retained but unused. So Tier 2's genuine job is keeping `frontier@60` + the tail so appends and
tail-proofs tile from a floor, **not** serving below-watermark lifts (which nobody issues).

**Receiver retains nothing to prune here** — R consumes (processes + discards payloads), keeping only its
`InboundFrontier` (O(log n) peaks). Its whole role in this channel's retention is emitting the watermark that
moves S's `payload_floor`.

**Landed on top of as-built:** the **lossy-head carve-out** is now implemented standalone (branch
`rk-spec-msg-horizon-head-carveout-mvp`, `86eee1892f0`): `prune_horizon` pins `floor = min(floor, head−1)`
for `Ack`/`Broadcast`/`Private`, so a stalled stream's head stays serveable (out of Band A) instead of being
reaped. Independent of the [retention merge plan](speculative-messaging-v0.5-alignment.md) (the same guard
moves onto the unified floor if/when that lands).

### Verification deep-dive — Stages 5–7: trust-free response checking

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
`{root: SR, head, extension, tree_proof}` — the material the lift assembler turns into the POV lift (Stage 9)
without re-fetching (reused verbatim when the run stops short of the head, regenerated from the retained
leaves once caught up).

### Authoring (`authoring.rs`) — two phases: the `specmsg0` inherent vs the POV lifts + `Requires`

`authoring.rs` does two distinct things at different times off different inputs (confirmed matching the code):

**Phase 1 — the inherent (`inherent_data_at`, at the authoring parent).** Snapshots the pool via
`build_inherent(cursors, registers, budget)` into a `SpecMsgInherentData`, put under
`INHERENT_IDENTIFIER = *b"specmsg0"` (primitives/…/inherent.rs:35). Input is the runtime's **resume cursors**
(`consumed_streams()`) — the *intended* continuation of each pooled run, bounded by `InherentBudget`
(256 KiB / 8). It *is* an `InherentDataProvider`: an empty pool provides nothing → the block carries no
spec-msg inherent. Grace-window-gated (`ROUND_GRACE_WINDOW` = 250 ms) so a round completing just behind the
proposer's snapshot isn't missed.

**Phase 2 — the POV lifts + `Requires` signal (`assemble_collation`, after the blocks exist).** Reads each
built block's `consumption_record()` runtime API → `records`; `assemble_from_records` produces `LiftsBySource`
(one `RequiresLift` per touched stream, proof material from the pool's verified runs via
`channel_lift`/`register_lift`); `build_requires(records, lifts)` synthesizes the `RequiresSet`, encoded as
`UMPSignal::Requires`. Lifts ride the POV (`ParachainBlockData::V3`); the `Requires` set rides as the appended
UMP signal. Running the wrapper's *own* `build_requires` here — over the assembler's records + lifts — is what
guarantees the emitted `Requires` matches what `validate_block` re-derives in-wasm (else rejected at backing).
Resubmission is free: lifts are pure functions of public data (`consumption_record` + pool), so re-assembling
against the current pool regenerates them for the unchanged blocks.

**The distinction:** the inherent is *what the block will consume* (from **cursors**, before the block); the
lifts + `Requires` are *proof of what it actually consumed* (from **`consumption_record()`**, after). Both
lift kinds — the POV `RequiresLift`s and the UMP `Requires` set — come from the same `consumption_record()`
reads.

**Node wiring (`polkadot-omni-node/lib/src/nodes/aura.rs`, slot-based collator).** Both halves hang off the
same `SpecMsgDeps { pool, lift_assembler }`, wired in two different spots:

- *Phase 1 — inherent.* Inside the `create_inherent_data_providers` closure, `inherent_data_at(para_id,
  client, pool, parent, InherentBudget::default())` builds the `specmsg0` inherent from the pool at `parent`
  (`None` pool → empty `Default`), returned as `Ok((storage_proof, spec_msg_inherent))` (`:774`) — the tuple
  *is* the block's `InherentDataProvider`s (a tuple of providers is itself one). Fed into `SlotBasedParams` →
  `launch_slot_based_collator`. On each authored block the collator calls the closure for the current
  `parent`, and `spec_msg_inherent.provide_inherent_data` inserts the data under `*b"specmsg0"`; the block
  then carries the inherent extrinsic and the **runtime's inherent handler consumes** the payloads + register
  reads, advancing the on-chain frontiers. Empty provider ⇒ no `specmsg0` inherent that block.
- *Phase 2 — lifts.* Wired separately onto the collator **service**, not the inherent path:
  `collator_service.with_spec_msg_lift_assembler(deps.lift_assembler.clone())` (`:732`). When it collates a
  block that consumed anything, the assembler attaches the POV lifts + synthesized `Requires` and emits
  `ParachainBlockData::V3`.

So from `aura.rs` both halves are visible: the **inherent** (what to consume) via the closure's
`spec_msg_inherent` at `:774`, and the **lifts/`Requires`** (proof of what was consumed) via
`with_spec_msg_lift_assembler` at `:732`.

### Client-side timing deep-dive — the fetcher↔proposer grace window (Stages 4–8)

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

## #12708 — parachain pallet (`cumulus-pallet-spec-messaging`)

### The inherent lifecycle — off-chain data → on-chain consumption (`enact_messages`)

How the fetch pipeline's verified, off-chain material becomes committed on-chain state, via the standard
Substrate inherent machinery (three stages, two in-wasm):

**A — node produces the data.** `inherent_data_at` snapshots the verified pool into a `SpecMsgInherentData`
(the `InherentDataProvider`), grace-window-gated.

**B — authoring folds it into the block:**
1. The collator's `create_inherent_data_providers(parent)` returns `(storage_proof, spec_msg_inherent)`
   (aura.rs:774).
2. The proposer builds `InherentData`: `SpecMsgInherentData::provide_inherent_data` does
   `put_data(*b"specmsg0", self)` when non-empty (inherent.rs:87) — the verified data lands under the
   `specmsg0` key. Empty ⇒ nothing put.
3. The proposer calls `BlockBuilder::inherent_extrinsics(inherent_data)` **in-wasm**, which calls every
   pallet's `ProvideInherent::create_inherent`. Spec-msg's (lib.rs:1311): `get_data::<SpecMsgInherentData>
   (specmsg0)`, non-empty → `Some(Call::enact_messages { data })` → wrapped as an **unsigned, `Mandatory`-
   class** inherent extrinsic and placed in the block.
4. Dispatch: `enact_messages` (lib.rs:961) — `ensure_none(origin)`, then per channel payload
   `consume_channel_item` (append / advance the `InboundFrontier`), per register read `consume_register_read`
   (apply the watermark/grant), emitting `ItemRejected` for bad items. **This is the off-chain→on-chain
   moment.** It returns `Ok` even on rejected items — a bad item is an event, never a block failure (it must
   not be, the call being `Mandatory`).

**C — validation re-executes, never re-fetches.** `data` rides *inside* the block as the `enact_messages`
extrinsic argument; on import (`execute_block`) and inside the PVF (`validate_block`) the runtime re-dispatches
it deterministically. The provider/`create_inherent` path runs only at authoring; once the call is in the
block it is a plain extrinsic on re-execution.

**The trust nuance — where soundness actually lives.** `ProvideInherent` implements only `create_inherent` +
`is_inherent`, **not `check_inherent`** — there is *no* author-equivalence check that could reject the block on
inherent content. At the runtime level the inherent is *trusted input*; soundness lives in the **lift /
`Requires`** path: authoring Phase 2 emits `Requires` (UMP) + POV `RequiresLift`s from `consumption_record()`,
and `validate_block` re-derives `Requires` in-wasm, which the relay's `paras_inherent` matches against the
source's `RecentProvides` ring — proving everything consumed was genuinely provided under an *included* source
root. So `enact_messages` **applies** the consumption; the `Requires`/lift check is what makes it **sound**. A
fabricated inherent yields a `Requires` matching no provided root → rejected at backing — which is why the
inherent can be `Mandatory`-but-content-unchecked.

**Substrate plumbing — why the closure returns a *tuple*.** `sp_inherents::InherentDataProvider`
(client_side.rs:100) carries `#[impl_trait_for_tuples::impl_for_tuples(30)]`, so any tuple of providers is
*itself* one provider — its `provide_inherent_data` runs each element in order. That is how
`create_inherent_data_providers` returns *one* value yet supplies *several* inherents:
`(storage_proof, spec_msg_inherent)` means "run these two writers." `InherentData` is just a
`BTreeMap<InherentIdentifier ([u8;8]), Vec<u8>>` (lib.rs:210) — providers **write** (`put_data(id, …)`),
pallets **read** (`get_data(id)`), and the provider's key equals the pallet's `INHERENT_IDENTIFIER`
(`*b"specmsg0"`), the only coupling between "node wrote it" and "pallet finds it." Flow: collator awaits the
closure → tuple → `create_inherent_data()` (client_side.rs:104) folds each element into a fresh `InherentData`
→ proposer → `BlockBuilder::inherent_extrinsics` → each pallet's `create_inherent` pulls *its own* key. So the
tuple is write-side composition (N providers → one map), the pallets are read-side fan-out (each indexes its
key). The cumulus slot-based collator merges this closure's *extra* providers (storage proof + spec-msg) with
the framework's parachain-system (`ParachainInherentData`) + timestamp inherents one level up.

### Commitment tree storage — MVP's persisted trie vs the primitives' stateless recompute

**Design mandates only the *root*, not how it's stored.** The design doc's only relevant section is titled
"Parachain Runtime State (**Internal**)" and sketches `OutgoingMessageState { per_destination: BTreeMap<ParaId,
MMR>, current_root: Hash }` — "hold the accumulators, commit a `current_root`." No on-chain tree layout, no
stream lifecycle, no "eternal," no cleanup semantics. So maintaining `current_root` is an **implementation
choice**, and the repo already has *both* strategies for the same keyed Patricia trie:

| | `rk-spec-msg-primitives` — **stateless** | `lexnv/spec-msg-poc-mvp` pallet — **persisted** |
|---|---|---|
| tree | `streams_root(entries)` recomputes from scratch | `TreeNodes`/`TreeRoot` storage |
| per block | O(S) rebuild from the active-stream set | O(k·log S) incremental path update |
| state kept | **none** | N−1 inner nodes, **eternal / never-deleted** |
| growth / cleanup | nothing to grow or delete | unbounded; no delete path |
| active-set policy | **caller's choice** (agnostic — drop a closed stream and it's gone) | "streams eternal" baked in |

Same logical trie ("Primitives reconciliation … DONE" — roots agree), two builders.

**Stateless (primitives, `streams_root.rs`).** Pure function of the entry set — no `StorageMap`, no
`NodeKey`/`InnerNode`, no `insert`/`remove`:
```
streams_root(entries) = node_hash(sort_by_key(entries))
node_hash([leaf])     = hash_leaf(key, root)
node_hash(es)         = hash_inner(first_diverging_bit, node_hash(left), node_hash(right))
```
Doc says the root is over `(StreamId, root)` **"for every active stream"** — *active*, whatever the caller
passes; the primitive has no notion of eternal.

**Persisted (MVP pallet, `cumulus/pallets/spec-messaging`).** `TreeRoot: StorageValue<TreeChild>` (its `hash`
IS the `StreamsRoot`) + `TreeNodes: StorageMap<NodeKey, InnerNode>` (inner nodes only; leaves live in the
parent's `TreeChild`). `NodeKey{len, prefix[8]}` (`len==64` ⇒ leaf), child hashes stored **inline** so a path
walk collects exactly the proof siblings. `commit_streams_root()` → `upsert_tree_leaf` per touched stream:
O(log S) walk-down / splice / rehash-bottom-up, off-path untouched.

**No delete path — structurally monotonic.** No `remove`/`kill`/`drain` on the tree anywhere. Streams eternal
⇒ N distinct streams ⇒ exactly N−1 inner nodes; a new stream adds one (the divergence split, which
**re-parents** the existing subtree keeping its `NodeKey` — never orphans), a re-touch only overwrites hashes
in place. It's a rebuildable cache; nothing to GC. (The only per-block `on_initialize` kills are the transient
companions — `BlockStreamsRoot::kill()`, `ConsumptionOutbox::kill()`, `OutboundMessages::drain()` — **not** the
tree.)

**⚠️ The unbounded growth is an MVP-strategy cost, not a protocol property.** `TreeNodes` grows with
*distinct streams ever touched* — closed/idle channels keep their node forever. The design doesn't require
this; two fixes without touching the protocol: (a) **stateless recompute** (the primitives already do it —
O(S)/block, zero persistent tree), or (b) keep the persisted trie but **evict** closed + fully-confirmed +
horizon-aged leaves (safe once the stream's roots have left `RecentProvides` — same "aged ⇒ unliftable ⇒ dead"
reasoning as retention). MVP just took the simplest path. **Candidate MVP PoC issue if channel churn is
expected — not a design gap.**

#### Stateless pallet integration (imagined) — how a no-tree pallet would wire the primitive

Two facts make this small: the pallet **must** keep `OutboundFrontier: StorageMap<StreamId, MmrFrontier>`
either way (needed to append + derive each stream root), and the **node already recomputes `StreamsRoot`
itself** (archive: "recomputes every root itself — never takes one from the runtime"), so proof generation is
*already* stateless. `TreeNodes`/`TreeRoot` exist **only** to produce the on-chain root digest cheaply — that
is the entire integration surface.

Drop the persisted trie; keep a flat **root cache** (the entry set the primitive consumes):
```rust
StreamRoots: StorageValue<BoundedVec<(StreamId, Hash), MaxStreams>>;   // sorted by StreamId

fn commit_streams_root() -> Option<StreamsRoot> {
    let mut roots = StreamRoots::get();
    let mut touched = false;
    for (stream, messages) in OutboundMessages::iter() {
        let mut f = OutboundFrontier::get(&stream);
        for p in &messages { f.append_leaf(hash_leaf::<SpecHasher>(LEAF_VERSION, p)); }
        OutboundFrontier::insert(&stream, &f);
        upsert(&mut roots, stream, f.root());                 // binary-search set/insert, O(log S)
        touched = true;
    }
    if !touched { return None; }
    StreamRoots::put(&roots);
    let root = streams_root(roots.iter().copied().collect())?; // ← the primitive, unchanged
    deposit_digest(root);
    Some(root)
}
```

**Eviction falls out for free** — the growth problem dissolves because shrinking is a `Vec` removal, not trie
surgery: on close + drain + horizon-age, `roots.retain(|(id,_)| *id != closed)`. No "streams eternal" baked
in; the active set *is* the cache's contents.

**Trade-off is cost, not correctness** (identical root either way) — and it's dominated by **PoV**:

| | stateless cache | persisted trie (MVP) |
|---|---|---|
| compute / block | O(S) recompute | O(k·log S) path rehash |
| **PoV / block** | **O(S)** — whole `StreamRoots` value in/out | **O(k·log S)** — only touched paths |
| storage | bounded, evictable (`Vec::retain`) | eternal, only-grows |

The persisted trie's real payoff: a block touching `k` of `S` streams pulls only `O(k·log S)` nodes into PoV,
vs the flat cache dragging the whole `~40·S`-byte set every block. **At MVP scale (dozens of channels) noise —
prefer the stateless cache: ~30 lines, bounded, evictable. At thousands of streams, persist for the bounded
per-block PoV.** So it's a scale decision, decoupled from the protocol (which mandates only the root).

### Register republish — receiver→sender watermark + grant (flow-control backstop)

The **inbound (receiver) side** tells the sender how far it has consumed, so the sender can reclaim
flow-control credit and prune its retained-payload archive. What's republished is a `Register`, **not**
the frontier, and it rides back over the channel's **ack_stream** (an outbound stream receiver→sender).

**`publish_register`** (`cumulus/pallets/spec-messaging/src/lib.rs:1485`):
- `up_to = InboundFrontier(peer, stream).leaf_count` — the consumption **watermark**: a scalar position
  derived from the inbound frontier's leaf count, *not* the peaks-frontier itself.
- `Register { version, up_to, grant, closed }` — watermark **+** a `WindowGrant` (credit) + closed flag.
- `append_to_stream(ack_stream(channel), register.encode())` → outbound back to the sender.

**Sender uses it for**: reclaiming credit (the grant), and `confirm(up_to)` (`:351-360`) releases every
retained payload below the watermark (archive prune). Read-side is monotonic-safe: a register regressing
`up_to`/`version` is rejected (`:1849`).

**Two triggers**:
- Normal — the **¼-window** trigger (frequent, fires on consumption progress).
- Backstop — the **age sweep** in `on_initialize` (`:898-918`): inbound channels with unreported progress
  (`InboundFrontier.leaf_count > published.up_to`, `:917-918`) republish at latest every
  `RegisterPublishAge` blocks. Guards liveness for channels that stayed under the ¼-window trigger and then
  went quiet — without it the sender's credit/archive stall forever. `O(inbound channels)`/block, fine at
  MVP counts; a due-queue replaces it when channels multiply.

### Sender deep-dive — Stages 0–2: sends → `StreamsRoot`

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
deep-dive under #12707 above).

**Marker leaf — an opened channel is never empty.** The `StreamsRoot` commitment is inclusion-only, so you
cannot prove a stream is *empty* — "empty", "peer lagging" and "peer withholding" would be indistinguishable (a
real attack surface). The fix is a marker leaf: `open_channel` (`lib.rs:1067`) commits `OpenChannel` as the
channel stream's **leaf 0** at open (`open_channel` → `send_signal` → `append_to_stream`). So an opened channel
always carries ≥ 1 leaf; **cursor 0 is always provable**, and the receiver can tell "nothing sent yet" (only the
`OpenChannel` leaf) from a stalled or withholding peer. The `OpenChannel` leaf is window-counted like any send.

### Lift deep-dive — Stage 9: POV lift → `Requires`, and UMP-signal transport safety

**`ConsumptionRecord` vs the pool — producer + trust.** The record is **runtime (STF) output**, *not*
pool-derived: the pool feeds the inherent (`build_inherent`), the runtime **consumes** it
(`consume_channel_item` / `consume_register_read`) and writes `ConsumptionOutbox` → `consumption_record()`. So
the record *reflects* what the pool handed out (via execution) but is authoritative **independent** of it — the
runtime stores only frontiers + this record, enough to *verify* a lift, never to *generate* one. At lift time
the two are **joined**: the **record** supplies the authoritative key + endpoint (`(source, stream)`,
`chain_endpoint`), the **pool** supplies the proof material (leaves + binding) via `channel_lift(endpoint)`.
Trust asymmetry — the **record leads** (trusted; consumption can't be hidden), the **pool must cover** it
(untrusted, verified): if the record names material the pool lacks — another collator's block (`cursor > end` →
drop + re-fetch) or a Case-B partial (`NotCovered`) — lift assembly fails. Direction: **pool → inherent →
runtime → record**, then **record + pool → lifts**.

#### The lift/`Requires` path (5 steps, 3 contexts)

1. **Consumption record (runtime output).** `consume_channel_item` (`lib.rs:1690`) / `consume_register_read`
   (`:1756`) write per-`(source,stream)` `Interval`s into transient `ConsumptionOutbox`, exposed by
   `consumption_record()`. Runtime stores **only frontiers** (`InboundFrontier`) + this record — enough to
   *verify* a lift, never to *generate* one.
2. **Lift generation (node-side).** `lift_assembler` → `assemble_collation` (`authoring.rs:234`) →
   `channel_lift`/`register_lift` (`pool.rs:860/905`) pulls extension-over-retained-leaf-hashes + tree proof
   from the pool; multi-block candidates `stitch` interval chains in bundle order (`chain_endpoint`) — a
   *bundle* is the candidate's **chained blocks** (collator "chains proposals ahead of backing"), so *bundle
   order* = block order N, N+1, …, and each block contributes one `ConsumptionRecord` merged into per-stream
   chains. Consecutive intervals must chain (`next.start == prev.end.root()`) or an `advances` extension proves
   the gap is a forward step (present only when a fresher root was read mid-bundle). A mispaired or forged
   chain can't fold to the committed root — the soundness guard.
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

**Two validation layers — PVF vs relay.** "Is the `Requires` valid?" is answered in *two* places: the PVF
guarantees the signal is **honestly derived**, the relay guarantees it's **currently admissible**.

| | checks | answers |
|---|---|---|
| **PVF** (`validate_block`) | lifts verify (extension + tree fold to a committed stream root) **+** `Requires` is the canonical derivation, **byte-identical** to the declared signal; panics on any lift failure or a block-emitted `Requires` | "the lifts are cryptographically sound and the signal is exactly what they produce" |
| **Relay** (`check_requires`, Stage 10) | every requires root ∈ the source's `RecentProvides` window | "the receiver depended on data the relay still vouches for" |

The PVF **cannot** judge staleness — no relay state in-wasm — so window membership is **relay-only**. Crypto +
honest-derivation = PVF; in-window admission = relay.

#### `UpwardMessages` + UMP signals — what it is and why it's safe

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

### Ack-stream deep-dive — Stages 0, 11–12: the register head read

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

### Flow-control deep-dive — Stages 11–12: credit / watermark / prune

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

## #12709 — testing / rollout

No code-analysis deep-dive; the end-to-end flow is in the [E2E test runbook](speculative-messaging-e2e-test.md).
