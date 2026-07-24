---
title: "Polkadot Implementers' Guide — annotated map"
author: Ron
date: 2026-07-25T03:20:00+08:00
tags:
- polkadot
- parachain
- speculative-messaging
- guide
---

# Polkadot Implementers' Guide — annotated map

Source: `polkadot/roadmap/implementers-guide/src/SUMMARY.md` (the mdBook table of contents). This is a
reading map — what each area covers, how the pieces relate, and which parts matter most for the
speculative-messaging work (see [v0.5 alignment](speculative-messaging-v0.5-alignment.md)).

The guide is the canonical spec for the **parachains protocol**: how a parachain block (a *candidate*)
travels from a collator, through relay-chain backing / availability / approval / disputes, to inclusion and
finality. It's split into five layers: **protocol → runtime (on-chain STF) → runtime APIs → node
(off-chain subsystems) → types**.

## 1. Protocol overview — the "what" and "why"

- **Whence Parachains / Protocol Overview** — motivation and the end-to-end candidate lifecycle
  (*backed → available → approved → finalized*), the shared-security model, and the split between the
  relay-chain STF and the node subsystems.
- **Approval Process** — after inclusion, a random subset of validators re-validates each candidate
  (approval checking). Finality (GRANDPA) only advances over *approved* candidates. This is the layer that
  makes inclusion trustworthy without every validator checking every candidate.
- **Disputes Process / Dispute Flow** — if a candidate is claimed invalid, all validators vote; a
  concluded-invalid dispute forces a **revert** and slashing. This is the mechanism behind the
  "state-revert is guaranteed" property the spec-msg bare ring relies on.
- **Chain Selection and Finalization** — the fork-choice + GRANDPA rules: the node abandons branches
  containing disputed-invalid candidates; finalization is the irreversibility bar.
- **Validator Disabling** — how misbehaving validators are progressively disabled within a session.

## 2. Architecture overview

- **Messaging Overview** — UMP (para→relay), DMP (relay→para), HRMP (para→para via relay). The signal
  channel our `Provides`/`Requires` UMP signals ride on lives here; the same `UMP_SEPARATOR` mechanism that
  splits real messages from signals is described in this layer.
- **PVF Pre-checking** — how new parachain validation code (Wasm) is vetted before it can be used.

## 3. Runtime architecture — the on-chain STF (most relevant to our work)

The runtime pallets are where the relay chain enforces the protocol in-block. These are exactly the files
the spec-msg relay branch touches:

- **`Initializer`** — orders per-session init/finalize across the other pallets (the
  `initializer_on_new_session` fan-out we hook for offboarding cleanup).
- **`Configuration`** — `HostConfiguration`, node-feature bits (where `SpeculativeMessaging` /
  `CandidateReceiptV2` live), governance-tunable limits (`max_upward_message_size`, window sizing, etc.).
- **`Shared`** — cross-pallet shared state (current session, allowed relay parents).
- **`Disputes`** — imports dispute votes (`process_checked_multi_dispute_data`), concludes disputes, sets
  the freeze/revert marker. The *trigger* for the state-revert, not a redundant check.
- **`Paras`** — para lifecycle (onboarding/offboarding, code upgrades, head data). Offboarding here is the
  canonical event that *does* need explicit `RecentProvides` cleanup.
- **`Scheduler`** — assigns cores to paras (incl. elastic scaling / on-demand); sizing of our provides
  window `W` is driven by the authoring→backing pipeline depth this defines.
- **`Inclusion`** — backing checks, availability bitfields, `enact_candidate`. **Home of `RecentProvides`,
  `record_provides`, `requires_satisfied`.**
- **`ParaInherent`** — the `enter` inherent that drives one relay block's parachain processing
  (*disputes → bitfields/availability → backing*), `sanitize_backed_candidates` (where the `requires`
  match gates inclusion), weight limiting.
- **`DMP` / `HRMP`** — downward / horizontal message queues; the cleanup patterns here (per-outgoing-para
  removal) are the template we followed for offboarding.
- **`Session Info`** — per-session validator/group metadata.

## 4. Runtime APIs — how the node reads relay state

Read-only entry points the node calls into the runtime: `validators`, `validator-groups`,
`availability-cores`, `persisted-validation-data`, `session-index`, `validation-code`,
`candidate-pending-availability`, `candidate-events`, `disputes-info`, `candidates-included`,
`pvf-prechecking`. Relevant when wiring any node-side spec-msg logic that needs to observe provides/requires
or pending availability.

## 5. Node architecture — off-chain subsystems

The client-side subsystems, coordinated by the **Overseer**. Grouped by pipeline stage:

- **Collators** — `collation-generation`, `collator-protocol`: produce candidates and hand them to backers.
  The future spec-msg *emission / fetch* work (still ⬜) lands around here + prospective-parachains.
- **Backing** — `candidate-backing`, `prospective-parachains` (async-backing fork tracking),
  `statement-distribution`: validators back candidates against a relay parent.
- **Availability** — `availability-distribution`, `availability-recovery`, `bitfield-distribution`,
  `bitfield-signing`: erasure-code the PoV and prove it's retrievable.
- **Approval** — `approval-voting`, `approval-distribution`: post-inclusion re-validation.
- **Disputes** — `dispute-coordinator`, `dispute-distribution`: raise/track disputes off-chain (feeds the
  `Disputes` pallet).
- **Utility** — `availability-store`, `candidate-validation` (+ `pvf-host-and-workers`), `provisioner`
  (assembles the `ParaInherent` data), `network-bridge`, `gossip-support`, `peer-set-manager`,
  `runtime-api`, `chain-api`, `chain-selection`, `pvf-prechecker`.

## 6. Data structures and types

The wire/consensus types: `candidate` (descriptor + commitments — where `CommittedCandidateReceiptV2`,
UMP signals, and our `StreamsRoot`/`RequiresSet` live), `backing`, `availability`, `overseer-protocol`,
`runtime`, `messages`, `network`, `approval`, `disputes`, `pvf-prechecking`. Plus a `Glossary` and
`Further Reading`.

## Reading path for spec-messaging

For the relay-side matching work specifically, the high-value chapters are:

1. **Disputes Process + Chain Selection and Finalization** — grounds the "revert unwinds `RecentProvides`"
   and "final only when the inclusion relay block is GRANDPA-finalized" reasoning.
2. **`Inclusion` + `ParaInherent` pallets** — the exact STF path our code lives in.
3. **Messaging Overview + types/candidate** — the UMP-signal channel and the candidate commitments that
   carry `Provides`/`Requires`.
4. **Scheduler** — for sizing the provides window against the async-backing / elastic-scaling pipeline.

> Note: `SUMMARY.md` is only the ToC. Contents shift as async backing / elastic scaling / core-time land, so
> treat individual chapters as *directional* and confirm specifics against the current pallet code.

## Candidate lifecycle diagram

Compact path, with the guide's **canonical state names** (protocol-overview.md, lines 109–117) in bold:

Candidate → Seconded → Backable → **Backed** → **Pending availability** → **Included** *(backed + available)* →
**Accepted** *(backed + available + undisputed)* → *Approved* → *Finalized*.

Note on scope: protocol-overview.md's own enumeration **stops at "Accepted"** and treats Approval as a
separate pipeline (Approved / rejected); it does **not** cover GRANDPA finalization. The *Approved →
Finalized* tail below is sourced from the **Chain Selection and Finalization** chapter, not protocol-overview.
A dispute branch can revert everything up until finalization.

```text
                       COLLATOR
              builds candidate (PoV) against
                    relay_parent  R_p
                          |
==========================|=============================================
 ON-CHAIN  (relay STF, driven by ParaInherent `enter`)
                          v
  (1) BACKING      backing group signs validity_votes
                   guide term: Seconded -> Backable -> BACKED
                   threshold: guide says "majority of the assigned group";
                   runtime enforces the minimum_backing_votes floor (~2)
                   -- small-group, NOT a set-wide fraction
                          |
                          v   noted in relay block R_inc
                   ...  PENDING AVAILABILITY  ...
                          |
  (2) AVAILABILITY  validators sign bitfields ("I hold my erasure chunk")
                    threshold: > 2/3 supermajority of the validator set
                          |
                          v   guide term: INCLUDED (backed + available)
                              -> enact_candidate:
                                 - RecentProvides write (spec-msg)
                                 - UMP/HRMP queued, head data updated
                              (undisputed => guide's terminal state ACCEPTED)
==========================|=============================================
 OFF-CHAIN  (node subsystems)
                          v
  (3) APPROVAL      VRF-assigned tranche checkers re-validate the PoV
                    threshold: needed_approvals (fixed ~30)
                              + 1 extra checker per NO-SHOW (escalate)
                          |
              +-----------+-----------------------+
         all approve                        checker finds INVALID
              |                                    |
              v                                    v
          APPROVED                        (4) DISPUTE  (on-chain)
              |                           all validators vote
              |                           threshold: > 2/3
              |                                    |
              |                              concluded-invalid
              |                                    v
              |                            REVERT + SLASH
              |                            R_inc abandoned ->
              |                            RecentProvides write unwound
              v
  (5) GRANDPA finalizes R_inc     [Chain Selection & Finalization chapter,
      threshold: > 2/3             not protocol-overview.md]
      (only finalizes approved, undisputed candidates)
                          |
                          v
        *** FINALIZED -- irreversible ***
   parachain block + its asset XCM are now truly valid;
   no dispute can revert a finalized block
```

Legend: `(1)(2)(4)(5)` are on-chain (signatures recorded via `ParaInherent` / `Disputes` / the finality
gadget); `(3)` approval is off-chain and only surfaces on-chain if it escalates into a dispute. The
`RecentProvides` write happens at `enact_candidate` (step 2) and stays revertible until step 5.

## Signed phases and their thresholds

A candidate is signed off at several distinct phases, each with a *different* threshold — and some are
on-chain while others are off-chain. Easy to conflate the 2/3 supermajorities (availability, disputes,
GRANDPA) with approval, which is **not** proportional.

| Phase | Who signs | Threshold | On-chain? |
| --- | --- | --- | --- |
| **Backing** | the core's backing group (~a handful) | guide: *"majority of the assigned group"*; runtime enforces the `minimum_backing_votes` floor (`min(group_len, minimum_backing_votes)`, default 2) — small-group, **not** a set-wide fraction | ✅ `validity_votes` via `ParaInherent` |
| **Availability** | full validator set, via **bitfields** | **> 2/3 supermajority** of the set have their chunk bit set | ✅ bitfields via `ParaInherent` |
| **Approval** | VRF-assigned approval checkers (tranches) | **`needed_approvals`** — a fixed small number (≈30 on Polkadot), **not** 2/3; **no-show escalation** pulls in later tranches | ❌ off-chain; gates GRANDPA finality; surfaces on-chain only if disputed |
| **Disputes** | *all* validators | **> 2/3 supermajority** on one side to conclude → revert + slash | ✅ dispute votes via `Disputes` pallet |
| **GRANDPA** | full validator set | **> 2/3 supermajority**; by rule only finalizes approved, undisputed candidates | ✅ (finality gadget) |

**Key distinctions:**

- **Backing** is a *small-group* majority (the assigned group), not a set-wide fraction. Its signatures are
  the `validity_votes` recorded on-chain.
- **Availability** is the phase where "> 2/3 sign the bitfield" — each bit attests *"I hold my
  erasure-coded chunk for this candidate."* The signature is on the **bitfield**, not on the erasure code
  itself.
- **Approval** is **optimistic and off-chain**: assigned checkers re-validate the PoV and broadcast signed
  approval votes; a candidate is *approved* at a **fixed** `needed_approvals` count (independent of set
  size), with tranche/no-show escalation. It gates **GRANDPA finality** but is not written to the chain in
  the happy path — it only appears on-chain if a **dispute** is raised.
- The three genuine **2/3 supermajorities** are **availability, disputes, and GRANDPA finality** — approval
  and backing are *not* among them.

This ties back to the spec-msg finality reasoning (see
[v0.5 alignment](speculative-messaging-v0.5-alignment.md)): inclusion needs availability (2/3) + backing,
but *irreversibility* needs the inclusion relay block to be **GRANDPA-finalized**, which in turn requires
the candidate to have cleared **approval** — so a merely-included candidate (and its `RecentProvides` write)
is still revertible by a dispute until then.

### Approval in detail — VRF tranches and no-show escalation

Approval checking is designed so that in the happy path only a *small* number of validators check each
candidate (cheap), but under withholding/censorship the checker set **expands automatically** until enough
honest checks land. The mechanism is VRF-assigned **tranches** plus **no-show** escalation.

**1. VRF assignments place validators into tranches.** From the relay block's VRF output, each validator
locally computes whether/when it's an assigned checker for a given candidate. Two criteria:

- **Modulo criterion → tranche 0.** A subset of validators are assigned to check *immediately* (tranche 0).
  The number of tranche-0 samples is a config knob (`relay_vrf_modulo_samples`), sized so tranche 0 alone
  roughly targets `needed_approvals`.
- **Delay criterion → a later tranche.** Every validator also derives a **delay tranche** in
  `0..n_delay_tranches` from VRF — the slot at which it *becomes* an expected checker if it's still needed.

Assignments are **self-determined and unpredictable** (VRF), so an adversary can't know in advance which
validators will check a given candidate — you'd have to corrupt a large fraction of the set to reliably
control the checkers.

**2. Tranches "go off" over time.** Tranche `t` activates ~`t` ticks after the candidate's block tick (a
tick is a small fixed duration). A validator only needs to reveal its assignment and start checking once
*its* tranche activates **and** the candidate isn't approved yet. If tranche 0 approves quickly, later
tranches never act — no wasted work.

**3. Approval target.** A candidate is **approved** once it has `needed_approvals` approving votes **and**
every no-show is covered (below). `needed_approvals` is a *fixed* config number (≈30 on Polkadot),
independent of set size — this is why approval is not a 2/3 proportional threshold.

**4. No-show detection.** A validator that has **revealed an assignment** (so it's expected to check) but
has **not produced an approval vote** within `no_show_slots` ticks is a **no-show** — it may be offline,
censored, slow, or deliberately withholding.

**5. Escalation.** Each no-show is **covered** by activating one additional checker from the next tranche.
So the *effective* required-checker set grows dynamically: `needed_approvals` + (one extra assigned checker
per outstanding no-show). Escalation continues — pulling in later tranches — until either:

- enough approvals arrive to hit `needed_approvals` with all no-shows covered → **approved** (GRANDPA may
  finalize), or
- an assigned checker finds the candidate **invalid** → it raises a **dispute** (→ the 2/3 dispute path,
  revert + slash).

**Why it matters for finality/liveness.** The `RequiredTranches` computation (in `approval-voting`) turns
the current approvals + no-shows into "how many tranches must we wait for." GRANDPA's approval voting rule
won't finalize a block whose candidates aren't approved, so persistent no-shows *delay* finality (liveness
pressure) rather than allowing an unchecked candidate through (safety). The key config knobs — all in
`HostConfiguration` — are `needed_approvals`, `relay_vrf_modulo_samples`, `n_delay_tranches`,
`zeroth_delay_tranche_width`, and `no_show_slots` (approximate defaults; confirm against
`configuration` at the target runtime version).
