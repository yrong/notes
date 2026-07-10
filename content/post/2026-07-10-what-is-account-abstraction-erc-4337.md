---
author: Ron
date: 2026-07-10T13:00:00+08:00
tags:
- blockchain
- ethereum
- account-abstraction
- wallets
title: "Notes: Account Abstraction and ERC-4337"
---

[Alchemy’s overview](https://www.alchemy.com/overviews/what-is-account-abstraction) covers **ERC-4337**: smart contract wallets instead of EOAs, without consensus-layer changes — programmable verification, sponsored gas, batching, and more. This note summarizes the core concepts, flow, and follow-ons (ERC-6900 / EIP-7702).

<!--more-->

## 1. What is ERC-4337?

ERC-4337 is the base standard for Account Abstraction: users use a **smart contract account** as their primary account, with programmable verification, instead of an EOA bound to a single private-key signature.

- **Launch**: 2023-03-01 on mainnet (first EntryPoint deployment)
- **Key point**: runs above the chain — **no protocol hard fork**; works on any EVM chain
- **Scale (per the article)**: 40M+ smart accounts; ~20M deployed in 2024 alone; 100M+ UserOperations

Unlike earlier proposals that needed consensus changes (e.g. EIP-2938, EIP-3074), 4337 reaches the same goals with an **alternate mempool + Bundler ecosystem**, while keeping decentralization and censorship resistance.

## 2. Six core concepts

| Component | Role |
|-----------|------|
| **UserOperation** | Pseudo-transaction expressing user intent; alternate mempool; programmable auth |
| **Bundler** | Watches the UserOp mempool, packs ops into one normal tx to EntryPoint; holds an EOA |
| **EntryPoint** | Singleton contract: verify → execute UserOps, settle gas with the Bundler |
| **Paymaster** | Who pays gas and in what (sponsor / ERC-20 / custom policy) |
| **Sender** | The smart contract account initiating the op |
| **Aggregator** | Aggregates signatures to cut calldata cost |

### 2.1 UserOperation vs a normal transaction

- Extra fields (EntryPoint / Bundler / Aggregator, etc.)
- Sent to an **alternate mempool**, packed by Bundlers
- Auth logic is defined by the account contract, not fixed ECDSA

### 2.2 Bundler: the only role that still needs an EOA

On-chain txs must still be started by an EOA. Bundlers use their own EOA to submit a batch of UserOps to EntryPoint and take a cut of gas. For users, **no EOA is required**.

### 2.3 EntryPoint: verify and execute

1. **Verify**: call the account’s custom logic; check the account (or Paymaster) can cover max gas
2. **Execute**: call the account with the calldata; charge the account and reimburse the Bundler

### 2.4 Paymaster: flexible gas policy

- App-sponsored gas (gasless onboarding)
- Pay gas in USDC or other ERC-20s
- Custom app policies

### 2.5 Aggregator: signature aggregation

Combine signatures from many UserOps into one verification step to save calldata.

## 3. Typical flow

```text
User / wallet
  → build UserOperation
  → submit to UserOp mempool
Bundler
  → pack multiple UserOps
  → call EntryPoint with an EOA tx
EntryPoint
  → verify (account + optional Paymaster)
  → execute calldata
  → settle gas (account or Paymaster → Bundler)
```

## 4. Real-world use cases

- **Gasless onboarding**: apps sponsor a new user’s first interactions
- **Gaming / social**: fewer repeated signatures
- **Social recovery**: trusted contacts help recover the account
- **Batch transactions**: multiple steps in one UserOp
- **Session keys**: automate recurring ops within scoped permissions
- **Stablecoin fees**: pay gas in USDC, etc.

## 5. Ecosystem evolution

### ERC-6900: modular smart accounts

Plugin / execution / validation-hook standard pushed by Alchemy, Circle, and others — a more opinionated modular framework. For some cases (off-chain module toggles, signature aggregators, etc.) developers prefer leaner alternatives.

### EIP-7702: temporary smart features for existing EOAs

Shipped with Pectra (May 2025): EOAs can temporarily run contract code — batching, sponsored gas, etc. — **without deploying a new smart-wallet address**.

- **Complementary to 4337**, not a replacement
- Can reuse existing Bundler / Paymaster infrastructure
- Ambire, Trust Wallet, and others already support it

## 6. Getting started

- **Apps**: pick a smart-account implementation → connect a Bundler → optionally configure a Paymaster
- **Wallets**: implement a standards-compliant account (especially `validateUserOp`) and integrate EntryPoint
- Live on mainnet and L2s including Arbitrum, Optimism, Base, and Polygon

## References

- [What is ERC-4337? (Alchemy)](https://www.alchemy.com/overviews/what-is-account-abstraction)
