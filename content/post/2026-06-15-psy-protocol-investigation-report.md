---
author: Ron
date: 2026-06-15T00:13:00+08:00
tags:
- bitcoin
- dogecoin
- zk-rollup
- cryptography
- bitvm
- psy-protocol
title: "Investigation report: Psy Protocol (full update)"
---

## Overview

Psy Protocol (formerly QED Protocol) is a trustless, horizontally scalable Layer-1 blockchain and ZK-Rollup network<sup>1, 2</sup>. Its mission is to break the “serial processing prison” of traditional chains by redefining how state is stored and where computation runs — targeting internet-scale throughput (TPS) for high-concurrency Web3 apps (order-book DEXes, fully on-chain games, AI agent economies) while inheriting security from PoW base layers such as Bitcoin and Dogecoin<sup>2, 4, 5</sup>.

<!--more-->

## 1. Breaking the scalability bind: ZK + PARTH

Traditional chains hit three walls: TPS vs decentralization/security tradeoffs, serial execution and race conditions under a global state, and liquidity fragmentation across many rollups. Psy combines zero-knowledge proofs (ZK) with **PARTH** (Parallel Ascending Recursive Tree Hierarchy) to address them<sup>10, 11</sup>.

* **Write separation:** Classic chains force every tx to queue on one global ledger. PARTH drops global state and gives each user a private local state tree (**UCON**)<sup>10</sup>. Interactions produce dedicated state slices (**CSTATE**). Because txs only update independent local trees, there is no global contention or read/write conflict — true unbounded concurrency.
* **Software-defined keys (SDKEY):** A user’s public key is not a plain derivation from a private key; it is the hash of a ZK logic circuit — native account abstraction and smart signatures at the base layer.

### Parallel token transfers under PARTH

On typical networks, balances live in a global map (`address => balance`). Concurrent txs create write hotspots and force serialization. PARTH does this instead:

1. Each user’s local state tree holds its own token balances.
2. Local state has two maps: `claimedFrom[sender]` (tokens claimed from a sender) and `sentTo[recipient]` (tokens sent to a recipient).
3. **Sender (Alice → Bob):** Alice decreases her balance and increases `sentTo[Bob]` **in her own tree** — an isolated local write, no locks, no waiting on concurrency.
4. **Receiver (Bob claims):** In a later block, Bob submits a Merkle proof of Alice’s state update, then updates **his** tree: bump `claimedFrom[Alice]` and his balance.

---

## 2. Pushing compute down: user-level vs miner-level

Psy’s paradigm shift: move conflict-prone **transaction execution** to user devices; leave highly parallel **math verification** to the miner network.

* **User-level hardware (client-side proving):** End users run contracts locally on a phone or browser extension (e.g. Psy Wallet) via `psy_vm` and the Goldilocks field (aligned with 64-bit CPU registers)<sup>6, 9</sup>. Near-zero cost and latency, plus native privacy (sensitive data never leaves the device). After execution they produce a ZK execution trace and an “encrypted state delta”<sup>10</sup>.
* **Miner-level hardware (Proof of Useful Work 2.0):** Miners no longer grind meaningless hashes. They use CPU/GPU/ASIC to ingest millions of user proofs, verify them mathematically, and aggregate them<sup>7, 11</sup>.

### Software-defined circuit (SDC) example

TypeScript contracts compile straight to software-defined circuits (SDC) — no CPU ISA simulation:

```typescript
import { Circuit, Field, Assert } from "@psy-protocol/sdk";

// Define the circuit with math constraints
export const TransferCircuit = Circuit((aliceBalance: Field, amount: Field) => {
    // Constraint: Alice must have enough balance
    const remainingBalance = aliceBalance.sub(amount);
    
    // Assert remaining balance >= 0
    Assert.greaterThanOrEqual(remainingBalance, Field(0));

    // Compiles to Plonky2 constraints over the Goldilocks field
    return remainingBalance;
});
```

Compile:

```bash
psy-compiler compile --input ./transfer.ts --output ./build/circuit.json
```

---

## 3. Tree recursion and the straggler problem

To sync millions of independent local proofs into the network, Psy uses **tree recursion**. Far from a bottleneck, it is how million-TPS scale becomes feasible.

### Logarithmic block time and TPS estimate

Miners merge proofs pairwise into a new proof that covers all prior work. Block time:

$$\text{Block Time}(u) = \log_2(u) * (k_r + k_{net})$$

* $k_r$ (recursive merge time): cost to merge two ZK proofs (~$250\text{ms}$).
* $k_{net}$ (proof network latency): ~$30\text{KB}$ proof packets between nodes (~$100\text{ms}$).

Time for $u$ concurrent users drops to $O(\log_2(u))$ — under ~10 seconds in theory. Overall TPS:

$$\text{TPS}(u) = \frac{t_{max} * u}{\text{Block Time}(u)} = \frac{3u}{0.9 + \log_2(u) * 0.35}$$

where $t_{max}$ is average txs per user (conservatively 3). Throughput scales roughly linearly with concurrent users $u$.

### Solving the straggler problem

In classic distributed systems, the slowest node caps the whole network. Under PoUW 2.0, aggregation is an open compute market: many miners can race the same aggregation branch; whoever finishes first with a valid parent ZK proof wins the reward. Throughput tracks total network capacity and the fastest nodes; slow miners are simply outcompeted — horizontal scalability without a straggler ceiling.

### User proving session (aggregation flow)

```mermaid
sequenceDiagram
    autonumber
    actor Alice
    actor Bob
    participant Miner as Network Miner
    participant L1 as Bitcoin L1

    Alice->>Alice: Execute tx locally; produce local End Cap proof
    Alice->>Alice: Generate ZK proof + encrypted state delta (CSTATE)
    Alice->>Miner: Submit local proof and state delta
    Note over Miner: Miners recursively aggregate millions of proofs in parallel
    Miner->>Miner: Produce a single Block Proof
    Miner->>L1: Publish block-proof commitment for settlement
    Bob->>Miner: Async state sync
    Miner->>Bob: Deliver updated state tree (UCON)
```

---

## 4. Architecture comparison

Psy’s design differs sharply from mainstream networks:

| Dimension | Psy Protocol | Solana | Polkadot | Zcash |
| :--- | :--- | :--- | :--- | :--- |
| **State model** | Write separation (PARTH) / per-user local trees (UCON) | Single global ledger | Heterogeneous multi-state (parachains) | Single global ledger |
| **Where compute runs** | Client-side (off-chain execution) | Validators on-chain | Parachain validators re-execute on-chain | Validators on-chain |
| **Parallel verification** | Miners parallel ZK recursive verify | Validator pipeline serial/concurrent execution | Subset of validators re-execute blocks | Full nodes verify globally |
| **ZK purpose** | Compress massive concurrent compute; scale throughput (privacy as byproduct) | No native ZK (mainly external rollup verify) | No native ZK (may appear via Ethereum bridges) | Shield sender/receiver/amounts for privacy |

---

## 5. Bitcoin L1 verification and cross-chain

Psy runs high-concurrency L2 work while inheriting Bitcoin’s security through novel mechanisms:

* **~1,000 UTXO sharded verification (BitVM):** A full ZK verifier script (~20MB) cannot fit in Bitcoin’s ~4MB block<sup>12, 13</sup>. The protocol splits the circuit across ~1,000 UTXOs. With Taproot (P2TR) and MAST, only the disputed or withdrawal branch is revealed — native ZK verification without a Bitcoin fork<sup>12</sup>.
* **Dogecoin expansion:** Working with Nexus on a Dogecoin zkVM, pushing an `OP_CHECKGROTH16VERIFY` opcode for native Groth16 verification, and open-sourcing trustless ZK bridge pieces such as `doge-on-solana`<sup>5, 14, 15, 16, 17</sup>.

### Cross-chain bridge sketch (Solana side)

Rust sketch: a Solana program verifying a Dogecoin block header via PoW hash vs target:

```rust
use anchor_lang::prelude::*;

declare_id!("DogeBridgeSolana1111111111111111111111111");

#[program]
pub mod doge_bridge {
    use super::*;

    pub fn verify_doge_block(ctx: Context<VerifyDogeBlock>, header: DogeHeader) -> Result<()> {
        // 1. Compute PoW hash and check difficulty
        let hash = header.calculate_hash();
        require!(hash <= header.target, BridgeError::InvalidProofOfWork);

        // 2. Update tip of Dogecoin state recorded on Solana
        let bridge_state = &mut ctx.accounts.bridge_state;
        bridge_state.tip_height = header.height;
        bridge_state.tip_hash = hash;

        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct DogeHeader {
    pub version: i32,
    pub prev_block_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub time: u32,
    pub bits: u32,
    pub nonce: u32,
    pub height: u64,
    pub target: [u8; 32],
}

#[derive(Accounts)]
pub struct VerifyDogeBlock<'info> {
    #[account(mut)]
    pub bridge_state: Account<'info, BridgeState>,
    pub signer: Signer<'info>,
}

#[account]
pub struct BridgeState {
    pub tip_height: u64,
    pub tip_hash: [u8; 32],
}

#[error_code]
pub enum BridgeError {
    #[msg("Proof of Work hash is invalid or doesn't meet the target difficulty.")]
    InvalidProofOfWork,
}
```

### Production bridge constraints

The sketch above is only a skeleton. A trustless Dogecoin bridge must also handle:

1. **Scrypt CU limits on Solana:** Dogecoin uses Scrypt. Computing it on Solana burns huge Compute Units and can exceed per-tx CU caps. Production designs compute Scrypt off-chain and prove it with ZK; the Solana program only verifies the proof.
2. **Forks and reorgs:** Keep a DAG of headers on-chain; unlock only after enough confirmations (e.g. 6).
3. **Compact `bits` target:** Difficulty is stored as a 32-bit compact `bits` field; the contract must expand it to a 256-bit unsigned integer before comparing to the hash.
4. **DigiShield retargeting:** Dogecoin adjusts difficulty per block. The contract must check timestamp gaps against history to validate `target` and reject forged low-difficulty headers.

---

## 6. Developer ecosystem and status

* **Languages:** `psy-compiler` targets Web2 developers — compile JavaScript, TypeScript, and Python directly to ZK circuit constraints, without classic VM opcodes.
* **Progress:** Core pieces (`psy-compiler`, `psy-prover`, `psy-sdk`) are open on GitHub. Public tutorials and the in-browser Dapen IDE are still “coming soon”; early adopters should read the repos directly.

---

## Core references

1. **QED Protocol Blog:** *ZK + PARTH: An Architecture for Building Horizontally Scalable Blockchains*
2. **BitVM architecture:** *BitVM 2: Permissionless Verification on Bitcoin*
3. **Psy Protocol GitHub:** [github.com/psyprotocol](https://github.com/psyprotocol)
4. **Press:** *CryptoBriefing / Business Wire (Dogecoin zkVM and funding coverage)*
