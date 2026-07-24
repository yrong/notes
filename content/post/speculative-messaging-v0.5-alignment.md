---
title: "v0.5 alignment — foundation vs speculative-messaging-design"
author: Ron
date: 2026-07-25T03:20:00+08:00
tags:
- polkadot
- parachain
- speculative-messaging
---

# v0.5 alignment — foundation vs `speculative-messaging-design.md` v0.5

Working note on aligning `rk-spec-msg-*` (my primitives + relay branches) with the v0.5 design and
lexnv's `spec-msg-poc-mvp` E2E PoC. Condensed; the full blow-by-blow (worked examples, Q&A, superseded
drafts) is at [`docs/working/speculative-messaging-v0.5-alignment.full.md`](../../docs/working/speculative-messaging-v0.5-alignment.full.md) (git-tracked working log, not published by Quartz).

## v0.5 in brief

Root-hash-only commitments return (reverting 0.3's flat sets): relay state is a fixed-size ring of recent
`StreamsRoot`s per sender; the structured `StreamId` replaces the plain destination `ParaId`; channels are
unidirectional with flow control via a lossy per-channel `Register`; lossy broadcast/private streams exist.
**Requires** is unified into one path: blocks emit no `Requires` and never see a `StreamsRoot` — they record
per touched stream an `Interval` (consumption start/end); the `validate_block` wrapper stitches intervals
across the bundle and synthesizes the candidate's entries via one POV-carried lift per stream. Authoring
targets the newest root at its tier; the relay window is pipeline slack. Fetch = root-keyed request pairs,
every response independently verifiable against a requester-named root. Lift-serving bounded ~25 h.

## Core mechanics (the design model)

- **The lift = `extension` + `tree_proof`.** A stream's consumption endpoint (an `MmrFrontier`) is bridged
  *forward* to the sender's **current** committed stream root by an `MMRExtensionProof`, then walked up to a
  `StreamsRoot` by a keyed-trie `tree_proof`. It binds to the *current* root (ring head), never the old
  boundary root — that's why it's "in the window by construction."
- **Where it runs.** `build_requires` synthesizes the candidate's `Requires` in the **PVF**
  (`validate_block` wrapper), not the STF — from the authoritative `ConsumptionRecord` (STF output) plus the
  untrusted POV-carried `RequiresLift`s. The block body carries no `Requires`; POV-carried so the
  resubmission/bundling cases work (the boundary root may never have been committed).
- **`StreamsRoot`.** A keyed binary Patricia trie over `(StreamId, current stream root)` for **every active
  stream**, committed once per block (header digest `SPMS_ENGINE_ID`; also in `paras::Heads`). Empty streams
  are omitted (an empty MMR has no root). One `Requires` entry per **source** — multiple streams from one
  sender collapse to that source's one `StreamsRoot`.
- **Channels.** A data stream `Channel{recipient,domain,num}` + an `Ack` register stream (lossy,
  latest-wins) carrying acceptance / advisory credit / watermark / close. `recipient` always names the
  **reader**. A channel's two halves live on **opposite chains**. Delivery is **receiver-pull**: B fills its
  own inherent from A's outbox; A never pushes.
- **`stitch` / intervals / advances.** A candidate can bundle several blocks; each contributes an `Interval`.
  `stitch` collapses the chain — consecutive intervals must chain (`next.start == prev.end.root()`) or a POV
  `advance` (extension) proves the gap is a forward extension. `advances` appear only when a fresher root was
  read mid-bundle. It's a soundness guard: a mispaired/forged chain can't fold to the committed root.
- **Trust boundary.** The record is authoritative (STF output — consumption can't be hidden); lifts are
  untrusted POV data, verified against the record's key + a committed root. Faked sender data can't reproduce
  a committed root (domain-tagged hashing); a mispaired lift can't verify (the `tree_proof` binds the key).

## Relay-side matching (#12349) — as built on `rk-spec-msg-relay`

- **One piece of state:** `RecentProvides: StorageMap<ParaId, BoundedVec<StreamsRoot, ConstU32<128>>>` — a
  bare per-sender ring. `record_provides` at `enact_candidate` (from `ump_signals().provides()`);
  `requires_satisfied` is membership against the window.
- **Two hooks:** `paras_inherent::check_speculative_messaging` in `sanitize_backed_candidates` (drop a
  candidate whose `Requires` aren't in the source's window); `inclusion` records `Provides` at enactment.
- **Reverts:** no explicit eviction — `RecentProvides` rolls back with the node's state-revert like any
  storage. **Exception:** the freeze + `force_unfreeze` path *does* need eviction (the earlier "fully
  redundant" claim was too strong).
- **Deliberate subset:** only the conservative **inclusion tier** is built; the speculative/optimistic tiers
  (the latency win, virtual-window + atomic enactment) are not. The feature-bit gate was removed
  (release-first) — processing is now unconditional; a candidate carrying no `Requires` short-circuits.

## Node / client (lexnv PoC) review

- **Module map** (`cumulus/client/spec-msg/src`): `archive` (sender store + serving), `authoring`
  (inherent/lift build), `exchange`/`fetch`/`protocol`/`pool`/`peers`/`nodes`, `monitor`, `verify`, `worker`.
- **Two consumption flows:** register read (watermark-driven, lossy head) vs channel read (frontier-driven,
  ordered). Don't conflate — they retain and lift differently.
- **`ChannelLedger` + `channel_lift`:** a verified contiguous pooled run `[base, end)` per stream, with
  `leaves` kept even after payloads are handed to the inherent (lifts generate extensions from hashes, not
  payloads) and a `binding` re-bound under the newest included root each round. The pool holds more than a
  block consumes (partial consumption is routine). Huge-backlog limit: fetch resumes, consumption is
  all-or-nothing (the streaming branch is a dormant hook).
- **#12593 `SpeculationStore`:** lexnv covers it with a dedicated store, not offchain-indexing.

## Retention — final model (supersedes the whole earlier thread)

`floor(stream) = max( watermark(stream), leaf_count_at_window_floor(stream) )`, keep the **last N boundaries**
(256/512, margin over the ~128 ring), prune payload **and** leaf hash together below the floor. **No wall
clock, no config** (drops `prune_horizon`, `archived_at`/`now_secs`/`SERVING_HORIZON`, the 24 h/10 MiB
config, and the `payload_floor` vs `floor.leaf_count` split). Deterministic → reproducible.

- Healthy channel → `watermark` dominates (no over-pruning). The window-floor term only wins when a receiver
  stalled **> N blocks** — and reaping then is safe because N ≫ ring depth: roots that old have left
  `RecentProvides`, so the data is **unliftable, hence dead**.
- **Lossy-head carve-out still stands** (now count-triggered): pin `floor = head-1` for
  `Ack`/`Broadcast`/`Private` so a stalled head isn't reaped by the window-floor term.
- One deliberate policy change: below-watermark lift material is no longer served (nobody needs it —
  consumption is always above the watermark).
- **PoC defect to raise:** lexnv's `archive.rs` over-prunes channel **payloads** at the hardcoded 25 h
  horizon, foreclosing > 25 h catch-up that recomputation-from-frontier would otherwise allow; the horizon is
  a `const`, not operator-tunable.

## DHT peer discovery (`ron/spec-msg-dht-discovery`)

- **Reuse `cumulus/client/bootnodes`** (RFC-0008 `/paranode`), not a bespoke Kademlia — take the relay-side
  discovery (`get_providers` on the relay DHT + the `/paranode` request-response) via an added
  `discovered_tx` sink; keep the `add_known_address` injection (safe cross-para, makes the source dialable)
  and stream `(PeerId, addrs)` to a `PeerRegistry` (`ParaId → PeerIds` + `report_bad`).
- **Genesis is supplied up front, not discovered.** Governance `set_source_genesis(source, (genesis,
  fork_id))` on the receiver, exposed via `SpecMsgApi::source_discovery_info()`. It's a standalone
  `AcceptChannelOrigin`-gated call, per source para, **not** wired into `accept_open_channel` (could be, but
  the per-source vs per-channel cardinality argues for enforce-presence over merge).
- **Discover-from-response is impossible** with bootnodes as-is: the `/paranode` protocol name is
  `/{genesis}[/{fork_id}]/paranode` (the source's *own* genesis), so you need the genesis to send the request
  that would return it — circular. The response's `genesis_hash` is only used to *verify* against the
  supplied one. Would need a genesis-agnostic protocol (relay-genesis / para_id-keyed) = an RFC-0008 change.
  `fork_id` rides in the same governance tuple. Posted this on #12595.

## Primitives reconciliation — `rk-spec-msg-primitives` vs lexnv PoC — DONE

Aligned (identical or semantically equal): **StreamId**, **channel/flow-control types**
(`SpecMsgKind`/`Signal`/`WindowGrant`/`Register`, frozen indices), **`StreamsRoot`** trie hashing.

MMR-layer reconciled (byte-identical roots + wire-compatible proofs):

- **Domain tags** — MMR `LEAF/INNER/PEAK` renumbered `0x2/0x3/0x4 → 0x1/0x2/0x3` (matching poc-mvp). **No
  `EMPTY_TAG`**: empty streams are never committed (an empty MMR has no root), reinforced by the marker
  `OpenChannel` leaf (below), so it's dead weight; `0x1` reclaimed, `0x4` free, commitment-tree tags stay
  `0x5/0x6`. Frozen MMR vector re-pinned. *(commit `d656de2871e`)*
- **`MmrInclusionProof`** — identical struct + `verify_head`/`verify_leaf`; mine keeps a `verify_leaf`
  item-count bound (`ItemLimitExceeded`) the PoC lacks.
- **`MMRExtensionProof`** — adopted the PoC's `leaf_count` field (mmr size *derived*, so an out-of-range size
  can't be smuggled in) + `verify` shape (frontier consistency, forward, extend-from-empty), keeping my
  `MAX_EXTENSION_CONNECTING_NODES` ceiling the PoC lacks. *(commit `d656de2871e`)*
- **`TreeStep`** — dropped the redundant `target_right` (derived from the key), so a step SCALE-encodes
  byte-identically to the PoC's `(u8, Hash)`; `StreamsRoot` unchanged. *(commit `47c3400b7aa`)*

**Remaining delta (cosmetic):** `ProofError`/`VerifyError` (mine) vs `MmrError` (PoC). `ProofError` is the
better pick (avoids the `mmr_lib::Error as MmrError` collision; names "proof-verification failure"). My
response-level `VerifyError` (Proof/TreeProof/RootMismatch/UnexpectedBase/ExceedsBudget/VariantMismatch/
PayloadTooLarge/MalformedResponse) has **no PoC equivalent** — it's what the fetch subsystem needs for
peer-scoring vs retry. Convergence: PoC renames `MmrError → ProofError` + gains `VerifyError`; nothing on my
side changes.

## Empty-stream / marker leaf (design-doc gap, PR #12659)

The `StreamsRoot` commitment is inclusion-only, so you can't prove a stream is *empty* — "empty", "peer
lagging", "peer withholding" are indistinguishable, and the PoC's "tolerate cursor 0" was an attack surface.
Fix = **marker leaf**: the sender commits `OpenChannel` as the channel stream's **leaf 0 at open** — already
done in the PoC (`open_channel → send_signal(OpenChannel) → append_to_stream`). So opened channels are never
empty; cursor 0 is always provable. The PoC's cursor-0 handling is now a **sound scoped deferral** (only
`Network` error at `cursor==0 && nothing pooled`, tolerated as retry, never consumed-as-empty), covering just
the accept-before-open window. Remaining: **document the invariant in the design** (lexnv's "needs
mentioning").

## Issue / finding status

- **#12346 primitives (5 WS):** WS1/2/3/5 done on my branch; **WS4 (wire messages)** is the gap — I added
  `Event`/`Exchange` req-resp + `MmrInclusionProof` (the fetch pair was there). Now complete.
- **#12583** receiver `Provides` monitor — implemented; agreed redesign: runtime API + event-primary, drop
  the well-known key, newest-root-suffices (eskimor's "provides root in events?").
- **#12535** SpecMsg XCM router — implemented (separated `SpecMsgRouter`, cleaner than routing through
  `XcmpQueue`); issue still open on GitHub.
- **#12531** umbrella MVP — PR #12699 covers 7 of 8 flow steps; **discovery** is the gap (addressed by the
  DHT branch above).
- **PoC issues to file (#12699):** (1) retention — hardcoded 25 h horizon over-prunes channels, not
  operator-tunable; (2) peer discovery — static registry, no dynamic DHT. (Consolidated draft in the full
  note.)
- **Code-review replies:** the "UMP trailing-garbage bypass" reclassified to Low; malformed `ump_signals()`
  → `return true` is safe; extension-proof node size is 40 B (ours, `(u64,Hash)`) vs the design's 32 B.
