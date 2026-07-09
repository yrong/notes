---
author: Ron
catalog: true
date: 2022-05-10
tags:
- BlockChain
- Polkadot
title: Polkadot validate_block, PVF, and relay validators
---

Companion to [Polkadot HRMP protocol (implementation guide)]({{< relref "2022-05-09-polkadot-hrmp-protocol.md" >}}).

## What `implementation.rs` is

**`cumulus/pallets/parachain-system/src/validate_block/implementation.rs`** implements **`validate_block`**: take the PoV’s **storage proof**, build a sparse in-memory trie, **override** `sp_io::storage` (and related) host functions so validation runs **inside the Wasm** instead of calling the node’s DB, **execute the parachain block**, then return **`ValidationResult`** — head data, `horizontal_messages`, `hrmp_watermark`, upward messages, processed downward message count, optional new validation code.

The helper **`run_with_externalities_and_recorder`** wraps Substrate **`Externalities`** (`Ext` over proof + **`OverlayedChanges`**) so pallet storage reads/writes during `execute_verified_block` and the follow-up reads for the result see consistent state. That is **production PVF** behavior, not limited to tests.

## How `validate_block` works (step by step)

The relay validator runs this **with no parachain database** — its only inputs are the block(s) and a **storage proof** (the exact slice of state the block touches). The flow:

1. **Decode** `ParachainBlockData` from the PoV → the block(s) + the compact `proof` (and, for the `V2` variant, spec-messaging `late_block_proofs`).
2. **Security checks.** `verify_blocks_form_chain` ties the first block onto the trusted `parent_head` and chains the rest; `validate_validation_data` asserts the `set_validation_data` inherent produced a `ValidationData` matching the relay-supplied `relay_parent_number` / `relay_parent_storage_root` / `parent_head`.
3. **Build the sparse in-memory DB** from the proof and pin it to the parent state root (deep dive below).
4. **Override the storage host functions** so all state access stays inside the Wasm (deep dive below).
5. **Execute** each block against that in-memory backend, then read the outputs (`upward_messages`, `horizontal_messages`, `hrmp_watermark`, `head_data`, `new_validation_code`) into a **`ValidationResult`**. `execute_verified_block` recomputes the post-state root and asserts it equals the block header’s `state_root` — a mismatch **panics** → candidate invalid.

For a **multi-block PoV** (elastic scaling) the loop drains each block’s writes into `db` so the next block sees them — state is chained across blocks within the one PoV.

### Step 3 — the sparse in-memory database

```rust
let mut db = match proof.to_memory_db(Some(parent_header.state_root())) {
    Ok((db, _)) => db,
    Err(_) => panic!("Compact proof decoding failure."),
};
```

- The **storage proof** is a *compact Merkle proof*: the minimal set of Patricia-Merkle trie nodes needed to **read** every key the block reads and to **recompute the root** after every key it writes. The collator produced it by executing the block on a full node with a node recorder.
- `to_memory_db` decodes it into a `MemoryDB` holding **only those nodes** — hence *sparse*: a thin slice of state, not the whole trie.
- Passing `Some(parent_header.state_root())` is the crux: a compact proof elides hashes recomputable during a root-down traversal, so decoding **requires** the root and in doing so **verifies** the nodes hash together into exactly that root. `parent_header` comes from the relay-trusted `parent_head`, so this is the **anchor of trust**: *relay-known parent head → its `state_root` → the proof must reconstruct precisely that trie*.
- This is also what makes cheating impossible: during execution, a read of any key whose node **wasn’t** in the proof triggers a missing-node error → the whole validation aborts. The collator is forced to include exactly the state the block touches — it cannot forge or hide a read.

### Step 4 — overriding the storage host functions

```rust
let _guard = (
    sp_io::storage::host_get.replace_implementation(host_storage_get),
    sp_io::storage::host_set.replace_implementation(host_storage_set),
    sp_io::storage::host_root.replace_implementation(host_storage_root),
    // … read, exists, clear, clear_prefix, append, next_key, transactions,
    //    all child-storage variants, offchain_index, proof_size, transaction_index
);
```

- **Normally**, `sp_io::storage::get(key)` is a *host function*: on a full node the client implements it by reaching into the on-disk state backend. The Wasm "calls out to the host."
- **In the PVF there is no host state** — only the sparse proof. So `validate_block` swaps those host functions for local ones (`host_storage_get`, …) via **`replace_implementation`**. The `_guard` is the RAII handle set holding the overrides; they’re installed **first** and restored when it drops at function exit.
- Each override routes through the externalities — e.g. `host_storage_get` → `with_externalities(|ext| ext.storage(key))` — reading/writing the **`Ext` over the in-memory `db`** instead of a database. That is what "stay inside the Wasm" means: one self-contained run, all storage served from and checked against the proof.
- A few overrides are deliberately **inert** because they aren’t consensus state: `host_offchain_index_set/clear` are **no-ops** (which is exactly why offchain-indexed data is free of PoV cost), `transaction_index` is a no-op, and `storage_proof_size` is redirected to the size **recorder** so the runtime can meter PoV size during execution.

**In one line:** step 3 rebuilds the exact state slice the block needs and cryptographically pins it to the relay-trusted parent root; step 4 rewires every storage call to that in-memory slice — so a **stateless** relay validator can deterministically re-execute the block and confirm its final root, messages, and head data.

## PVF entry point

Parachain runtimes register validation with **`cumulus_pallet_parachain_system::register_validate_block!`**. In **`no_std`** builds, the proc-macro in **`cumulus/pallets/parachain-system/proc-macro/src/lib.rs`** emits a **`#[no_mangle] unsafe fn validate_block(...)`** that forwards into this pallet’s validate-block implementation. That symbol is part of the **parachain validation Wasm** registered on the relay chain — the **PVF**.

So **`implementation.rs` is compiled into the parachain PVF**, not into the Polkadot relay runtime (`frame_executive`).

## Relay validators vs relay on-chain runtime

| Accurate | Misleading |
|----------|--------------|
| **Relay validators** load the parachain’s PVF and run it in a **sandboxed VM** (Wasm / PolkaVM) as part of **candidate validation**. | This code **runs on-chain** as a relay-chain pallet in a relay block. |

PVF execution is **validator node work**, **off-chain** with respect to relay state transitions — but it is **mandatory** for security and is what backs **committed** parachain progress.

## One-liner

**`validate_block` in `implementation.rs` is the core logic inside the parachain PVF; relay validators execute that Wasm when validating candidates; it is not relay-chain runtime logic, but it is how the relay chain checks parachain blocks.**
