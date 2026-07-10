---
author: Ron
date: 2026-07-11T03:00:00+08:00
tags:
- blockchain
- ethereum
- solidity
- randomness
title: "Notes: PREVRANDAO and on-chain randomness (why reading the past is better)"
---

[Markus Waas — Solidity Deep Dive: New Opcode 'Prevrandao'](https://soliditydeveloper.com/prevrandao) explains where Merge-era `PREVRANDAO` (EIP-4399) comes from, how it can be biased, and three designs for using it in dApps. This note focuses on: **why being able to read a past block’s prevrandao is better than the other two approaches.**

<!--more-->

## 1. Background: why PoS needs randomness

After the Merge, blocks are proposed by validators staking 32 ETH. A fixed round-robin proposer schedule would enable:

- **DoS**: attackers know the next proposers in advance
- **Selfish registration / bribery**: grab favorable slots or buy specific validators
- **Double-spend planning**: easier to arrange a controlled sequence of blocks

So the protocol uses **RANDAO** for unpredictable shuffling.

## 2. How RANDAO works

In each epoch (32 slots), a proposer BLS-signs the **epoch number**, hashes the signature, and **XOR**s it into the current RANDAO:

```text
new_randao = hash(bls_sign(epoch)) XOR previous_randao
```

Properties:

- **Hash** → roughly uniform output
- **XOR** → a single honest contribution scrambles the whole value
- Signing the epoch (not the slot) → reduces extra leverage of the last revealer on later epochs

### Biasability (last revealer)

An attacker cannot set the random value arbitrarily, but can **choose whether to propose/reveal**:

- Skip the slot → RANDAO is not updated for that slot
- Control the last \(k\) validators of an epoch → about \(2^k\) possible final values (1 bit of influence each)
- Cost: mainly forgoing ~**0.044 ETH** block reward

Good enough for **protocol security**; weak for **high-stakes dApp lotteries**. The long-term fix is a **VDF** (so the last revealer cannot know the final output before deciding to reveal) — not shipped yet.

## 3. EIP-4399: `PREVRANDAO`

After the Paris upgrade:

- Opcode `PREVRANDAO` returns the **last updated RANDAO** (the current block’s new mix is not known during execution)
- Old `DIFFICULTY` was reused for the same value (backward compatibility)
- Solidity ≥ 0.8.18: `block.prevrandao`; earlier versions: `block.difficulty`

**Key limit: today you can only read the “current” prevrandao — not look up a historical value by block number.**

## 4. Using current PREVRANDAO in a game: two ways

Past randomness is already public → you must **commit to a future** value. EIP-4399 suggests waiting at least ~**4 epochs** (≈ 128 blocks), and avoiding early slots in an epoch (smaller bribery window).

### Way 1: `require(block.number >= n)`

```text
Tx1: lock n = block.number + 128 and the stake
Tx2: settle in any later block, using “whatever” block.prevrandao is then
```

| | |
|--|--|
| **Pros** | Still playable if you miss block `n` |
| **Cons** | Validators can **censor/delay Tx2** until a favorable later prevrandao → **extra bias** |

### Way 2: `require(block.number == n)`

```text
Tx1: lock exact block n
Tx2: must settle in block n, using that block’s prevrandao
```

| | |
|--|--|
| **Pros** | Cannot delay to shop for a better value → **no extra censorship bias** |
| **Cons** | Must hit **exact** block `n`; miss it and that round’s randomness is gone |

## 5. Why “read past PREVRANDAO(n)” is better

The article’s last design (not a real opcode API at the time):

```solidity
// Speculative future API
uint256 randomNumber = block.prevrandao(blockNumberToBeUsed);
```

Flow:

```text
Tx1: commit to “use prevrandao of future block n”
… wait until block n is produced …
Tx2: settle anytime after n, reading the historical prevrandao of block n
```

### Compared with Way 1 / Way 2

It keeps both upsides and drops both fatal downsides:

| Dimension | Way 1 (`>= n`) | Way 2 (`== n`) | **Past PREVRANDAO(n)** |
|-----------|----------------|----------------|------------------------|
| Miss target block | Still settle | **Round dead** | Still settle (read history) |
| Validator delays Tx2 to shop randomness | **Yes** (newer prevrandao) | No | **No** (bound to fixed block `n`) |
| Value unknown at commit time | Yes (but mutable at settle) | Yes | **Yes, and fixed to `n` at settle** |

In one line:

> **Way 1 trades anti-censorship-bias for availability; Way 2 trades availability for anti-bias; historical PREVRANDAO(n) gets both — commit to a future unknown value, then settle later using that fixed past value.**

“Better” means the **UX + anti-censorship-bias combo**, not removing RANDAO’s last-revealer bias. Validators can still choose reveal/skip at epoch end. The article’s long-term answer remains **VDFs**.

### vs reading current `block.prevrandao` with no future commit

If settlement just reads “current” prevrandao:

- A malicious contract can **simulate the outcome and revert if unfavorable**
- Or rely on the packer to pick a favorable block

Past PREVRANDAO(n) forces **commit-then-reveal**, which cuts the “see the result, then decide whether to execute” path for the honest flow.

## 6. Status and follow-ups

- `block.prevrandao(n)` in the article is a **speculative API**; track the [Ethereum Magicians / EIP-4399 thread](https://ethereum-magicians.org/t/eip-4399-supplant-difficulty-opcode-with-random/7368)
- In practice, similar capability often uses **RLP block headers + `blockhash` checks** to extract historical RANDAO (see later [RANDAO(n) discussion](https://ethereum-magicians.org/t/expanding-eip-4399-prevrandao-with-randao-n/19741))
- For high-value use cases, prefer **Chainlink VRF** (or similar); PREVRANDAO is closer to “good enough” protocol-grade randomness

## References

- [Solidity Deep Dive: New Opcode 'Prevrandao'](https://soliditydeveloper.com/prevrandao) (Markus Waas)
- [EIP-4399](https://eips.ethereum.org/EIPS/eip-4399)
- [Ethereum Magicians — EIP-4399 thread](https://ethereum-magicians.org/t/eip-4399-supplant-difficulty-opcode-with-random/7368)
