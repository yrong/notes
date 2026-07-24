---
title: "Speculative messaging — notes index"
author: Ron
date: 2026-07-25T03:20:00+08:00
tags:
- polkadot
- parachain
- speculative-messaging
- index
---

Working notes and mirrors for **Speculative Messaging** (inclusion-tier MVP + v0.5 design alignment). Upstream designs are large and **not published** on the site (Quartz-ignored); short working notes below are.

<!--more-->

## Start here

| Note | What it is |
|------|------------|
| [Impl design (v0.5)](speculative-messaging-impl-design.md) | Component status matrix + TODOs |
| [Effort estimate (MVP)](speculative-messaging-effort-estimate.md) | ~70 eng-days to productionize inclusion-tier PoC |
| [E2E runbook](speculative-messaging-e2e-test.md) | `spec_msg_penpal` zombienet cutover test |
| [v0.5 alignment (condensed)](speculative-messaging-v0.5-alignment.md) | Foundation → v0.5 mapping |
| [Implementers' guide map](polkadot-implementers-guide-map.md) | Annotated reading map for the parachains guide |

## Design mirrors

Large upstream docs are **Quartz-ignored** (local/git only). The Super Chains sketch is short and **is published**.

| File | Status |
|------|--------|
| `post/speculative-messaging-design.md` | Local only — v0.5 ([PR #12659](https://github.com/paritytech/polkadot-sdk/pull/12659)) |
| `post/low-latency-v2-design.md` | Local only — ([PR #11413](https://github.com/paritytech/polkadot-sdk/pull/11413)) |
| `post/offchain-block-verification-design.md` | Local only |
| [Super Chains](super-chains-design.md) | Published sketch — same PR #12659 |

Full alignment working log (not a Quartz page): [`docs/working/speculative-messaging-v0.5-alignment.full.md`](../../docs/working/speculative-messaging-v0.5-alignment.full.md).

## Scope reminder

**MVP / estimate** = inclusion-tier only (relay ring match + off-chain payloads). Speculative / optimistic latency tiers (virtual window, enactment deps, off-chain block verification) are follow-up.
