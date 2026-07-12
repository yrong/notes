---
title: The Path of a Parachain Block — Code Mapping
source: https://medium.com/polkadot-network/the-path-of-a-parachain-block-47d05765d7a
sdk: /Users/yangrong/Projects/polkadot-sdk
created: 2026-03-28
updated: 2026-03-28
tags:
  - polkadot
  - parachain
  - polkadot-sdk
---

# The Path of a Parachain Block — Code Mapping

Reference article: [The Path of a Parachain Block](https://medium.com/polkadot-network/the-path-of-a-parachain-block-47d05765d7a) (Joe Petrowski, Polkadot Network, Feb 2020).

The article’s pipeline is still the right mental model: **collator produces work → assigned validators check PoV / state transition → compact receipt + erasure-coded data on the relay chain → availability + extra validity checks → GRANDPA finality.** The SDK implements a newer, more detailed protocol than the 2020 article (async backing, descriptor versions, approval voting, disputes, elastic scheduling).

---

## I. Match making (collators ↔ validators)

**Article:** BABE randomness assigns validators to parachains; collators connect and send blocks.

**Code:**

- Validators are organized into **backing groups** per para/core; interaction uses the **collator protocol** and **candidate backing** (`Seconded` / `Valid` statements).
- Entry point docs: `polkadot/node/core/backing/src/lib.rs` — `CandidateBackingSubsystem`, statement rules, group assignment, **asynchronous backing** and **depth** (Prospective Parachains).

Collator-side: **Cumulus** (collation tasks, PoV export in omni-node). Scheduling may involve **cores / claim queues** (elastic scaling, coretime), not only the simplified “shard rotation” from the article.

---

## II. Block preparation (PoV → compact receipt)

**Article:** Validator checks state transition; PoV = block + touched state; **candidate receipt** is the small relay-chain summary; **erasure coding** for availability.

**Code:**

1. **Validation** — PVF (Wasm) in `polkadot/node/core/candidate-validation`, using parachain validation code and `PoV`.
2. **`CandidateDescriptorV2`** — `polkadot/primitives/src/v9/mod.rs`: `para_id`, `pov_hash`, `erasure_root`, `para_head`, `validation_code_hash`, relay context, `persisted_validation_data_hash`, etc.
3. **`CommittedCandidateReceiptV2`** — descriptor + **`CandidateCommitments`** (outputs the relay chain checks): UMP/HRMP, `head_data`, code upgrade, DMP/HRMP watermarks.
4. **`PersistedValidationData`** — parent head, relay parent number/storage root, `max_pov_size`.

This matches “fixed-size summary + hashes,” extended with XCMP-related fields and explicit head data.

---

## III. Relay chain block construction

**Article:** Candidate receipts enter the queue; the block author picks candidates with valid parents and its own erasure chunk.

**Code:**

- **`polkadot/runtime/parachains/src/paras_inherent/`** — one **inherent** per relay block: backed candidates + **signed availability bitfields**.
- **`polkadot/runtime/parachains/src/inclusion/`** — candidates move **backable → backed → included**; availability rules.
- **`polkadot/node/core/provisioner`** — what the block author tries to include.

---

## IV. Finale (secondary checks, finality)

**Article:** Fishermen, secondary checks, threshold gossip, then GRANDPA.

**Code (evolved):**

- **Fishermen** as a dedicated role are largely replaced by **on-chain disputes** and participation with bonds — `polkadot/runtime/parachains` disputes handling, `polkadot/node/core/dispute-coordinator`.
- **Systematic post-inclusion checks** — **approval voting** (`polkadot/node/core/approval-voting`): assignments, tranches, approval votes.
- **Availability** — signed bitfields, **availability distribution**, **av-store** (erasure chunks).
- **Finality** — GRANDPA (client), coordinated with approval/dispute rules.

---

## Summary table

| Article section | SDK anchors |
|-----------------|-------------|
| Collators / connections | Cumulus; `polkadot/node/network/collator-protocol`; backing subsystem |
| PoV + validation | `candidate-validation`, PVF workers, `PoV` in `polkadot/node/primitives` |
| Candidate receipt | `CandidateDescriptorV2`, `CommittedCandidateReceiptV2`, `CandidateCommitments` → `polkadot/primitives/src/v9/mod.rs` |
| Erasure / availability | `erasure_root` on descriptor; `av-store`, availability distribution, bitfields → `paras_inherent` + `inclusion` |
| RC inclusion | `paras_inherent`, `inclusion` pallets |
| Post-inclusion validity | Approval voting; disputes |
| Finality | GRANDPA + approval/dispute gating |

---

## Key file paths (polkadot-sdk)

- `polkadot/node/core/backing/src/lib.rs` — candidate backing / statements
- `polkadot/node/core/candidate-validation/src/lib.rs` — PVF validation
- `polkadot/primitives/src/v9/mod.rs` — `CandidateDescriptorV2`, `CommittedCandidateReceiptV2`, `CandidateCommitments`, `PersistedValidationData`
- `polkadot/runtime/parachains/src/paras_inherent/mod.rs` — inherent, candidates + bitfields
- `polkadot/runtime/parachains/src/inclusion/mod.rs` — inclusion pipeline
- `polkadot/node/core/approval-voting/src/lib.rs` — approval checks
- `polkadot/node/core/dispute-coordinator/` — disputes

For a current protocol-accurate picture, pair this note with the **Polkadot implementer’s guide** under `polkadot/roadmap/implementers-guide/`.

---

## Steps: parachain block → relay chain inclusion

The protocol separates **backing** (candidate accepted with enough validator votes on-chain) from **inclusion / enactment** (candidate commitments applied: para head, UMP/HRMP, etc., after **availability**).

### 1. Off-chain: collator produces a candidate

1. The **collator** builds a parachain block and the **PoV** (proof-of-validity bundle validators execute).
2. **Backing validators** assigned to that para/core (scheduler / claim queue) fetch the collation via the **collator protocol**, then run **`candidate-validation`** (PVF / Wasm) to check the state transition.
3. Validators gossip **statements** (`Seconded`, then `Valid`) via **statement distribution**. Enough valid votes ⇒ candidate is **backable**.
4. The **backing** subsystem forms a **`BackedCandidate`**: receipt + validity attestations. The **PoV** is **erasure-coded**; validators store/gossip **chunks** (**availability distribution** / **availability store**).

Relay-chain parachain state is not updated yet.

### 2. Relay block author: parachains inherent

5. The **block author** (BABE) fills the mandatory **`paras_inherent`** data: **`ParachainsInherentData`** — **signed availability bitfields**, new **`backed_candidates`**, **disputes**, and **parent header** (`process_inherent_data` in `paras_inherent`).

### 3. On-chain: one `enter` call — bitfields/enact **then** new backing

Inside **`paras_inherent::enter` → `process_inherent_data`**, roughly:

6. **Scheduling context** — allowed relay parents / claim-queue view (`shared::new_block`, etc.).
7. **Disputes** — weight limits, import statements; **freeze** can halt parachain progress.
8. **Free disputed cores** — `free_disputed` for invalidated candidates.
9. **Bitfields** — sanitize, then **`inclusion::update_pending_availability_and_get_freed_cores`**: each bit means a validator has the erasure chunk for that core’s pending work. Enough votes ⇒ **available**.
10. For pending work that becomes available (respecting **async backing** order: predecessors enacted first), **`enact_candidate`** runs — **this is runtime “inclusion”**: UMP/HRMP/DMP, **`Paras::note_new_head`**, etc.
11. **Timeouts** — `free_timedout` when applicable.
12. **New `BackedCandidate`s** — `back_candidates` → **`inclusion::process_candidates`**: checks relay parents, persisted validation data, backing signatures, message limits → stored in **`PendingAvailability`** (**backed** but **not yet enacted**).

**Typical timeline**

- Relay block **R**: candidate appears as **`BackedCandidate`** → **pending availability**.
- Later relay blocks: **bitfields** until availability threshold is met.
- A later block: **`enact_candidate`** — parachain **head** updates.

### 4. Finality and extra checks (after enactment)

13. **GRANDPA** finalizes relay blocks; the parachain block is only final in the usual sense once the relay block that **enacted** it is finalized.
14. **Approval voting** — extra validity checks for **finality** gating; separate from `enact_candidate`.

### Checklist

| Step | Meaning |
|------|--------|
| Collate + PoV | Collator proposes work. |
| Validate + statements | Backers agree PoV is valid. |
| **Backed** in `enter` | Candidate in **`PendingAvailability`**. |
| Bitfields + threshold | Data **available**. |
| **`enact_candidate`** | Para state/head updated — **included** (pallet sense). |
| GRANDPA + approvals | **Finality** and safety nets. |

**Code anchors:** `polkadot/runtime/parachains/src/paras_inherent/mod.rs` (`process_inherent_data`, `enter`), `polkadot/runtime/parachains/src/inclusion/mod.rs` (`update_pending_availability_and_get_freed_cores`, `process_candidates`, `enact_candidate`).
