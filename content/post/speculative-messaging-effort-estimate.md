---
title: "Spec-Messaging MVP effort estimate (#12531)"
author: Ron
date: 2026-07-25T03:20:00+08:00
tags:
- polkadot
- parachain
- speculative-messaging
- planning
---

# Spec-Messaging MVP effort estimate (#12531)

**Scope: the inclusion-tier MVP only.** The speculative / optimistic tiers (virtual-window matching +
atomic enactment dependencies — the latency *win*) are **out of scope** here; that's a follow-up.

**Basis: effort to productionize the working PoC.** A running E2E zombienet PoC (`spec-msg-poc-mvp`)
already exists and my `rk-spec-msg-primitives` is done + reconciled — so each number is the effort to take
that prototype to **upstream-mergeable** quality: review cycles, weights/benchmarks, hardening (retention
revamp, discovery finish, defect fixes), upstream tests, and prdocs. Single all-in senior-eng-day figure per
item, at the conservative (upper) end.

## Primitives — #12346

| # | Item | Effort (d) |
|---|---|---|
| 1 | #12700 Stream ID + MMR primitives | 2 |
| 2 | #12701 Commitment trie + consumption/channel records | 2 |
| 3 | #12702 Requires lifts (stitch, build_requires, lift errors) | 2 |
| 4 | Network wire messages (Messages + Event + Exchange req-resp) | 1 |
| 5 | Channel lifecycle primitives (SpecMsgKind/Signal/WindowGrant/Register) | 1 |
| | **Subtotal** | **8** |

## Client / Node — #12707

| # | Item | Effort (d) |
|---|---|---|
| 6 | #12593 SpeculationStore (+ retention revamp to the count-boundary model) | 8 |
| 7 | #12595 p2p fetch layer (req-resp, peer pool) + DHT discovery finish | 6 |
| 8 | Receiver path: relay-monitor fetcher + peer pool + inherent provider | 8 |
| 9 | Lift assembly + V3 collation (validate_block hook, PoV lifts) | 5 |
| 10 | Enable the code path (wiring, omni-node, rollout gates) | 3 |
| | **Subtotal** | **30** |

## Pallets / Runtime — #12708

| # | Item | Effort (d) |
|---|---|---|
| 11 | #12350 sender/outbox pallet (StreamId-keyed MMR, StreamsRoot + digest + Provides) | 6 |
| 12 | #12591 Forward messages to XCM queue | 3 |
| 13 | #12535 SpecMsg router for XCM | 3 |
| 14 | #12592 SpecMsgApi runtime API | 3 |
| 15 | #12594 Propagate messages through the inherent (consumption record) | 4 |
| | **Subtotal** | **19** |

> The relay inclusion-tier match (`RecentProvides` / `check_speculative_messaging`) is on `rk-spec-msg-relay`
> and needs its own productionization (weights, tests) — folded into #15.

## E2E + Rollout — #12709

| # | Item | Effort (d) |
|---|---|---|
| 16 | #12596 E2E testing (HRMP replacement, zombienet) — to CI quality | 6 |
| 17 | Fuzzing hardening into CI (proof verify + decoders) | 4 |
| 18 | #12597 Monitoring metrics | 3 |
| | **Subtotal** | **13** |

## Rollup

- **Total: ~70 d**
- This is *productionization* of the inclusion-tier PoC, not a from-scratch build — the design + happy-path
  code exist, so the weight is in review, weights/benchmarks, hardening, tests, and prdocs.

## Highest-risk / most likely to overrun

1. **Productionization breadth** — bringing ~a dozen crates of PoC code to upstream quality (reviews,
   weights, cross-crate tests, prdocs) is the biggest slice; not one hard problem, just a lot of it, and the
   easiest to underestimate.
2. **#6 SpeculationStore + retention revamp** — the trickiest `archive.rs` code; touches serving/pruning.
3. **#11 sender pallet weights** — benchmarking the runtime extrinsics (unmetered in the PoC) is real work.
