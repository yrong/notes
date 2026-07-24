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
[Off-Chain Block Verification](offchain-block-verification-design.md). This document tracks the *component
breakdown and implementation status*; the canonical design is the source of truth for behaviour. (The linked
design docs land in `docs/` when their PRs merge.)

Tracking issues: [#12346](https://github.com/paritytech/polkadot-sdk/issues/12346) (primitives),
[#12347](https://github.com/paritytech/polkadot-sdk/issues/12347) (expose `Provides`/`Requires`),
[#12349](https://github.com/paritytech/polkadot-sdk/issues/12349) (relay changes),
[#12350](https://github.com/paritytech/polkadot-sdk/issues/12350) (retention).

## Model in one paragraph

Each sender parachain accumulates outgoing messages per **stream** (keyed by a structured 8-byte `StreamId` —
`Channel` / `Ack` / `Broadcast` / `Private`) into a per-stream MMR, and commits every stream's root into a
single **`StreamsRoot`** (a keyed Patricia trie over `(StreamId, stream root)`), emitted as a
`Provides(StreamsRoot)` UMP signal. Blocks never emit `Requires`; the messaging inherent records a
**`ConsumptionRecord`** (per touched stream, the MMR interval consumed), and the `validate_block` wrapper
**synthesizes** `Requires(RequiresSet = {(source ParaId, StreamsRoot)})` from the record plus POV-carried
**lifts** (`RequiresLift`: `stitch` the intervals → MMR `extension` to the current stream root → `tree_proof`
up to the `StreamsRoot`). The relay keeps a bounded per-sender ring of recent `StreamsRoot`s and admits a
candidate only if every `Requires` root is present in the referenced source's ring. Message payloads flow
**collator-to-collator off-chain**; the relay sees only the two commitments. `StreamId` is bound *into* the
`StreamsRoot` but never revealed to the relay (relay state is `ParaId`-keyed and fixed-size).

## Status matrix

| Component | Status | Location |
|---|---|---|
| Parachain-side primitives | ✅ done | `cumulus-primitives-spec-messaging` |
| Relay-visible primitives | ✅ done | `polkadot-primitives::v9` |
| UMP-signal types + extraction | ✅ done | `polkadot-primitives::v9` |
| Feature gating | ➖ n/a | release-first — no feature bit (see §8) |
| Flow-control *type* primitives | ✅ done | `cumulus-primitives-spec-messaging::flow_control` |
| Relay matching (inclusion tier) | ✅ done | `runtime/parachains` (inclusion + paras_inherent) |
| Sender pallet (outbox) | ⬜ todo | `pallet-speculative-outbox` (tbd) |
| Receiver pallet (inbox / consumption record) | ⬜ todo | `pallet-speculative-inbox` (tbd) |
| PVF requires-lift synthesis | ⬜ todo | `cumulus/.../validate_block` |
| UMP-signal emission | ⬜ todo | `cumulus-pallet-parachain-system` |
| Off-chain fetch + collator | ⬜ todo | new subsystem |
| Flow-control pallet logic | ⬜ todo | messaging pallet |
| Relay: virtual window + enactment deps | ⬜ deferred | super-chains (future work) |

Legend: ✅ implemented · 🚧 partial · ⬜ not started / deferred.

---

## 1. Primitives — ✅ done

`cumulus-primitives-spec-messaging` (`no_std`), consumed by collators, the PVF, and the sender/receiver
pallets:

- **`stream`** — `StreamId` with a frozen 8-byte big-endian canonical encoding (encoding *is* the trie-key
  derivation), reserved-kind rejection, frozen test vectors.
- **`mmr`** — domain-tagged `SpecMerge` (blake2 via `SpecHasher`), peaks-only `Mmr` accumulator matching
  `mmr-lib`; inclusion + ancestry proofs from `mmr-lib`. Frozen root vector.
- **`streams_root`** — the keyed Patricia trie over `(StreamId, stream root)` → `StreamsRoot`;
  `gen_stream_proof` / `streams_root_from_proof` / `verify_stream_membership`; frozen root vector.
- **`lift`** — `RequiresLift`, `ConsumptionRecord`, `MMRExtensionProof`, `MmrInclusionProof`
  (single-leaf head/positional proof), `MmrFrontier`, `MmrRoot`, `Interval`; `stitch` +
  `build_requires` / `build_requires_entry` (the PVF-side synthesizer).
- **`message`** — `SpecHasher`, `leaf_hash`, `MessagePosition`,
  `MAX_SPECULATIVE_MESSAGE_LEN`, and the three off-chain protocols: fetch
  (`MessagesRequest`/`MessagesResponse` + `verify_messages_response`), lossy event/register read
  (`EventRequest`/`EventResponse` + `verify_event_response`, via `MmrInclusionProof::verify_head`),
  and the `/spec-msg/exchange` envelope (`ExchangeRequest`/`ExchangeResponse`, frozen variant
  indices) multiplexing the two.
- **`flow_control`** — wire types only: `SpecMsgKind` / `SpecMsgSignal` (channel-stream leaf payload),
  `Register` / `WindowGrant` (ack-stream payload); frozen-core encoding vectors.

Relay-visible types live in **`polkadot-primitives::v9`** (so the relay decodes them without a
`polkadot → cumulus` edge): `StreamsRoot`, `RequiresSet` (canonical sorted `(ParaId, StreamsRoot)` set,
`MAX_SOURCES_PER_BLOCK = 128`), `UMPSignal::Provides|Requires`, `CandidateUMPSignals`, `MAX_UMP_SIGNALS = 4`.
(No `FeatureIndex::SpeculativeMessaging` — release-first, the node-feature bit was removed; see §8.)
`cumulus-primitives-core` re-exports the parachain-side set and declares the `SpeculativeOutboxApi` /
`SpeculativeInboxApi` runtime-API shapes.

**TODO (primitives):**
- [ ] PoV composition/perf harness beyond the current `pov_cost_report` (optional).
- [ ] Confirm inferred bits with the design owner (fetch API signatures, `MMRExtensionProof` node encoding —
      it carries `(u64 position, Hash)` = 40 B/node vs the doc's hash-only 32 B; `SPMS_ENGINE_ID` value).

## 2. Relay chain — ✅ inclusion-tier match done

Implemented in `polkadot/runtime/parachains`:

- **`inclusion`** — `RecentProvides: StorageMap<ParaId, BoundedVec<StreamsRoot, ConstU32<128>>>` (bare ring,
  no block tag); `record_provides` (pushed at `enact_candidate` from `ump_signals().provides()`),
  `requires_satisfied` / `provides_contains` (membership match).
- **`paras_inherent`** — `check_speculative_messaging` in `sanitize_backed_candidates`: **unconditional**
  (release-first, no feature gate) — drop a candidate whose `Requires` are not in the source's provides
  window; a candidate carrying no `Requires` (all legacy candidates, and `Provides`-only ones) short-circuits
  and is kept. No `speculative_enabled` / `node_features` read.
- Dispute reverts need **no** explicit eviction — `RecentProvides` is rolled back by the node's state-revert
  like any other storage (the earlier `#12349` block-tag + `evict_provides_after` were dropped as redundant;
  see the reply drafted for that issue).

**TODO (relay):**
- [ ] **Weights** — benchmark + charge `requires_satisfied` (≤128 reads/candidate) and `record_provides`
      (read+write/enacted candidate); currently unmetered (`TODO(weights)` markers in code).
- [ ] **Offboarding cleanup** — prune `RecentProvides[para]` on offboard (design: "prune as a whole");
      currently a bounded slow leak (`NOTE(offboarding)` marker).
- [ ] `provides_window(source)` runtime API for collators.
- [ ] `W` as a governance-adjustable `HostConfiguration` field (currently `const 128`).
- [ ] **Virtual window + atomic enactment dependencies** — *deferred to super chains*; only needed for the
      live / speculative tier (same-relay-block co-arrival), not the inclusion tier.

## 3. Sender pallet (outbox) — ⬜ todo

- [ ] Re-key outbound storage from `ParaId` to `StreamId`; one MMR per stream (persistent peaks-only
      frontier + retained payloads for lift-serving), grouped by source at read time.
- [ ] Compute the `StreamsRoot` per block (keyed trie over active streams) and deposit the header digest
      (`SPMS_ENGINE_ID`) + emit the `Provides` UMP signal.
- [ ] `send(recipient, domain, num, data)` in-runtime sender interface (a pallet trait, à la `SendXcm` — not
      an `sp_api` runtime API); wraps bytes as `SpecMsgKind::Data`, applies flow-control window.
- [ ] `SpeculativeOutboxApi` impl (`streams_root()`, `messages_response(req)`).

## 4. Receiver pallet (inbox) — ⬜ todo

- [ ] Messaging inherent processes fetched ingress; writes the transient `ConsumptionRecord` (per touched
      stream, `Interval { start, end }`), grouped by source, `StreamId`-sorted.
- [ ] `SpeculativeInboxApi::consumption_record()` (read in-wasm by the PVF wrapper).
- [ ] Ordered/no-skip STF rule (advance only through payloads, except gated skip-ahead).

## 5. PVF / `validate_block` — ⬜ todo

- [ ] Post-execution hook in the `validate_block` wrapper: read `consumption_record()` in-wasm, decode the
      POV-carried `RequiresLift`s from `ParachainBlockData`, run `build_requires`, emit the `Requires` UMP
      signal; fail the candidate on `LiftError`.
- [ ] Compatibility/rollout: `ParachainBlockData` lift field decoded only by the para's own PVF; gate on
      runtime `api_version` for the PoV format (no node-feature bit — see §8 release-first); PVF-decodes-first
      upgrade order; relay UMP support must ship before paras emit `Provides`/`Requires`.

## 6. Off-chain networking & collator — ⬜ todo

- [ ] Fetch subsystem: serve/consume `MessagesRequest`/`MessagesResponse`, verify with
      `verify_messages_response` against an authenticated `StreamsRoot`; live propagation (push) + fetch
      fallback; `max_bytes = 0` for payload-free lift material.
- [ ] Collator assembles the messaging inherent from verified ingress and produces the POV lifts.

## 7. Flow control — 🚧 types done, pallet logic todo

- [x] Wire types: `SpecMsgKind`, `SpecMsgSignal`, `Register`, `WindowGrant` (in `flow_control`).
- [ ] `ChannelId` storage keys, `OutChannels` / `InChannels`, the `Register` publish (accept extrinsic) +
      out-of-band read, watermark-driven pruning, advisory credit / backpressure, monotonic version
      announcements (min-of-two), channel open/close/upgrade.

## 8. Migration & rollout ordering — 🚧 partial

- [x] **Release-first — no feature bit.** The `FeatureIndex::SpeculativeMessaging` node-feature and the
      relay-side consumer gate were removed (on `rk-spec-msg-primitives` + `rk-spec-msg-relay`);
      `check_speculative_messaging` processes `Provides`/`Requires` **unconditionally** once the relay runtime
      ships UMP-signal support. Rollout safety now rests entirely on the deploy-before-emit ordering below.
- [ ] Emission gated by the parachain runtime opting in; enablement rollout — the relay runtime with UMP
      support (`MAX_UMP_SIGNALS = 4` + `Provides`/`Requires`) must be on ⅔+ validators *before* any parachain
      emits the new signals (else `TooManyUMPSignals` / `UmpSignalDecode` on old nodes). With the feature bit
      gone, this ordering is the sole migration safeguard — there is no on-chain toggle to hold candidates
      back, so the relay side must be released first.

## Related documents

- [Speculative Messaging design](speculative-messaging-design.md) — canonical v0.5 vision (local mirror; Quartz-ignored).
- [Low-Latency Parachains v2](https://github.com/paritytech/polkadot-sdk/pull/11413) — the foundation.
- [Off-Chain Block Verification](offchain-block-verification-design.md) — speculative/optimistic tiers (local mirror; Quartz-ignored).
- [Notes index](speculative-messaging-index.md) — start-here hub for this cluster.