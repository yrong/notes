---
title: "Hyperbridge Intent Gateway - Complete Architecture Guide"
source: obsidian/01-Technology
---

# Hyperbridge Intent Gateway - Complete Architecture Guide

## Overview

The IntentGateway protocol enables intent-based token swaps across EVM chains connected by Hyperbridge. Users escrow tokens and declare desired outputs; solvers compete to fill orders and claim the escrowed inputs.

Each order is **auctioned** to competing solvers. Solvers bid by signing `UserOperation`s which are gas-abstracted meta-transactions and posting them to the Hyperbridge blockchain. The user reviews all bids and selects the `UserOperation` that gives them the most assets, then executes it on-chain.

---

## High-Level Actors

| Actor | Role |
|-------|------|
| **User** | Places orders by escrowing input tokens. Receives output tokens from the solver. Selects the best bid from competing solvers. |
| **Solver** (filler) | Bids on orders by signing `UserOperation`s and posting them to Hyperbridge. Provides output tokens to the user and claims escrowed inputs. |
| **Hyperbridge** | Hosts the order auction, delivers cross-chain settlement messages via ISMP, and governs parameter updates. |
| **Relayer** | Submits cross-chain proofs for settlement messages and storage queries. |

---

## Current Solver Selection Implementation

### Overview

The current auction-based model uses EIP-712 signatures and transient storage for atomic execution.

**Flow:**
1. User places order with session key (temporary keypair)
2. Solvers submit bids off-chain to Hyperbridge coprocessor
3. User reviews bids and selects best one
4. User signs `SolverSelection` with session key
5. Bundler submits to ERC-4337 EntryPoint
6. EntryPoint executes atomically: `select()` → `fillOrder()`

### Two-Signature System

#### Signature 1: Solver's Signature (Bidding Phase)

**Who signs:** Solver's private key  
**Code Reference:** `BidManager.ts:95-98`

```typescript
// Solver constructs message: keccak256(userOpHash || order.id || sessionKey)
const messageHash = keccak256(concat([userOpHash, order.id, sessionKey]))

// Solver signs with their private key
const solverAccount = privateKeyToAccount(solverPrivateKey)
const solverSignature = await solverAccount.signMessage({ 
  message: { raw: messageHash } 
})

// Format: commitment (32 bytes) + solver signature (65 bytes)
const signature = concat([order.id, solverSignature])
```

**What it commits to:**
- `userOpHash`: The ERC-4337 UserOperation hash
- `order.id`: The order commitment
- `sessionKey`: The user's session key

**Used for:** Proving the solver is willing to execute this specific fill with this specific session key.

---

#### Signature 2: User's Session Key Signature (Selection Phase)

**Who signs:** User's session key private key (temp keypair created when placing order)  
**Code Reference:** `CryptoUtils.ts:105-124` and `BidManager.ts:177-182`

```typescript
// EIP-712 typed data
const structHash = keccak256(
  encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "address" }],
    [SELECT_SOLVER_TYPEHASH, commitment, solverAddress],  // ← solverAddress is SELECTED solver
  ),
)

// Compute digest
const domainSeparator = getDomainSeparator("IntentGateway", "2", chainId, gatewayAddress)
const digest = keccak256(concat(["0x1901", domainSeparator, structHash]))

// User (session key) signs
const sessionSignature = await sessionKeyAccount.sign({ hash: digest })
```

**What it commits to:**
- `commitment`: The order ID
- `solverAddress`: The **selected/winning solver** address

**Used for:** User authorization - "I (user) approve this specific solver to fill this order"

---

### The 162-Byte Signature Format

**Code Reference:** `BidManager.ts:216-224`

```typescript
// Final signature appends both:
// [solver's signature (97 bytes)] + [session signature (65 bytes)] = 162 bytes total
const finalSignature = concat([
  selectedBid.bid.userOp.signature,    // commitment (32) + solverSig (65) = 97 bytes
  sessionSignature,                     // sessionSig (65 bytes)
])

const signedUserOp = {
  ...selectedBid.bid.userOp,
  signature: finalSignature,  // 162 bytes total
}
```

---

## Bundler Execution

### What is a Bundler?

A **bundler** is an **ERC-4337 Account Abstraction service** that:
1. **Receives UserOperations** from users/applications
2. **Bundles them together** and submits to the blockchain
3. **Pays for gas** on behalf of users
4. **Gets reimbursed** from the user's account

In Hyperbridge's context, the bundler is the intermediary that executes the intent settlement transaction.

---

### Who Calls the ERC-4337 EntryPoint?

**Answer:** The **bundler service** calls the EntryPoint, NOT the user directly.

### Execution Flow

**Step 1: User reviews bids off-chain (no on-chain action)**

```
1. User sees OrderPlaced event on Hyperbridge
2. Solvers submit bids (UserOperations) to Hyperbridge coprocessor
3. User client receives and displays all bids
4. User picks best bid
```

**Step 2: User client signs session selection (off-chain)**

```typescript
// Code: BidManager.ts:177-182
// User's client code (in browser or app) does:
const sessionSignature = await crypto.signSolverSelection(
  commitment,
  selectedSolverAddress,
  domainSeparator,
  sessionKeyPrivateKey  // ← From user's local storage
)
```

**Step 3: User's client sends signed UserOp to bundler**

**Code Reference:** `BidManager.ts:233-236`

```typescript
// User's client sends to bundler:
const bundlerResult = await crypto.sendBundler<HexString>(
  BundlerMethod.ETH_SEND_USER_OPERATION,
  [
    signedUserOp,           // ← The 162-byte signature
    entryPointAddress,      // ← ERC-4337 EntryPoint
  ]
)
```

**Step 4: Bundler receives UserOp and calls EntryPoint**

```
User's client
    ↓ (sends signedUserOp)
Bundler Service
    ↓ (calls eth_sendUserOperation)
ERC-4337 EntryPoint (on destination chain)
    ↓ (calls SolverAccount.validateUserOp)
SolverAccount.validateUserOp()
    ├─ Parses 162-byte signature
    │  ├─ commitment (32 bytes)
    │  ├─ solverSignature (65 bytes)
    │  └─ sessionSignature (65 bytes)
    ├─ Calls gateway.select() [stores session key in tstore]
    ├─ Verifies solver signature
    └─ Returns SIG_VALIDATION_SUCCESS
    ↓
EntryPoint executes calldata
    ├─ gateway.select() [finalizes in tstore]
    └─ gateway.fillOrder() [reads from tstore, verifies match]
```

---

## Complete End-to-End Flow

```
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 1: ORDER PLACEMENT                                         │
├──────────────────────────────────────────────────────────────────┤
│ User (on source chain):                                          │
│ 1. Generate temp keypair (session key)                           │
│ 2. Call gateway.placeOrder({ session: sessionKey.address, ... })│
│ → Order escrowed, OrderPlaced event emitted                      │
└──────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 2: SOLVER BIDDING                                          │
├──────────────────────────────────────────────────────────────────┤
│ Each Solver (independently):                                     │
│ 1. See OrderPlaced event on Hyperbridge                          │
│ 2. Calculate desired outputs                                     │
│ 3. Call prepareSubmitBid():                                      │
│                                                                  │
│    messageHash = keccak256(userOpHash || commitment || sessionKey)
│    solverSig = Solver.sign(messageHash)  ← SIGNATURE 1           │
│    sig = commitment || solverSig (97 bytes)                      │
│                                                                  │
│ 4. Create UserOp with this signature                             │
│ 5. Submit to Hyperbridge coprocessor (as bid)                    │
│                                                                  │
│ Result: Multiple UserOperations waiting on Hyperbridge           │
└──────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 3: USER SELECTION (Off-chain in user's client)             │
├──────────────────────────────────────────────────────────────────┤
│ User (on destination chain):                                     │
│ 1. Query Hyperbridge/Indexer for all bids                        │
│ 2. Sort/rank bids by profitability                               │
│ 3. Select best bid (e.g., Solver A)                              │
│ 4. Sign session selection:                                       │
│                                                                  │
│    structHash = keccak256(                                       │
│      SELECT_SOLVER_TYPEHASH ||                                   │
│      commitment ||                                               │
│      solverAAddress                                              │
│    )                                                             │
│    digest = keccak256("0x1901" || domainSep || structHash)       │
│    sessionSig = SessionKey.sign(digest) ← SIGNATURE 2            │
│                                                                  │
│ 5. Create finalSignature:                                        │
│    finalSig = selectedBid.signature || sessionSig (162 bytes)    │
│                                                                  │
│ 6. Create signedUserOp with finalSignature                       │
│ 7. Call bundler.eth_sendUserOperation(signedUserOp)              │
└──────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 4: BUNDLER EXECUTION                                       │
├──────────────────────────────────────────────────────────────────┤
│ Bundler Service (external mempool service):                      │
│ 1. Receives signedUserOp from user client                        │
│ 2. Validates UserOp (simulation check)                           │
│ 3. Calls eth_sendUserOperation(signedUserOp, entryPoint)         │
│    → Transaction sent to destination chain                       │
│                                                                  │
│ Transaction will:                                               │
│ - Include both signature 1 and signature 2 (162 bytes total)     │
│ - Be executed by EntryPoint (ERC-4337)                           │
└──────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 5: ON-CHAIN VALIDATION & EXECUTION                         │
├──────────────────────────────────────────────────────────────────┤
│ EntryPoint.executeUserOp(signedUserOp)                           │
│                                                                  │
│ 1. Calls SolverAccount.validateUserOp(signedUserOp)              │
│    ├─ Parse signature: commitment(32) || solverSig(65) ||        │
│    │                   sessionSig(65)                            │
│    ├─ Call gateway.select(SelectOptions)                         │
│    │  ├─ Recover session key from sessionSig                     │
│    │  ├─ Verify it matches order.session                         │
│    │  ├─ Store solver in tstore[commitment]                      │
│    │  ├─ Store session key in tstore[commitment+1]               │
│    │  └─ Return session key address                              │
│    ├─ Recover solver from solverSig                              │
│    ├─ Verify solver is the SolverAccount itself                  │
│    └─ Return SIG_VALIDATION_SUCCESS                              │
│                                                                  │
│ 2. EntryPoint executes calldata (if validation passed)           │
│    ├─ gateway.select(SelectOptions)  [redundant, already done]   │
│    └─ gateway.fillOrder(order, options)                          │
│       ├─ Check _params.solverSelection is enabled                │
│       ├─ Read solver from tstore[commitment]                     │
│       ├─ Read sessionKey from tstore[commitment+1]                │
│       ├─ Verify msg.sender == stored solver                      │
│       ├─ Verify order.session == stored sessionKey               │
│       ├─ Transfer output tokens to beneficiary                   │
│       └─ Dispatch RedeemEscrow message to source chain            │
│                                                                  │
│ 3. Transient storage cleared (tstore contents invalidated)       │
│    → Prevents replay attacks                                     │
└──────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 6: SETTLEMENT                                              │
├──────────────────────────────────────────────────────────────────┤
│ Source Chain (after cross-chain message arrives):                │
│ 1. RedeemEscrow message processed                                │
│ 2. Escrow released to solver                                     │
│ 3. OrderFilled event emitted                                     │
└──────────────────────────────────────────────────────────────────┘
```

---

## Bundler RPC Methods

**Code Reference:** `types.ts` (BundlerMethod enum)

```typescript
const BundlerMethod = {
  // Submit a UserOperation
  ETH_SEND_USER_OPERATION: "eth_sendUserOperation",
  
  // Check if UserOperation was included on-chain
  ETH_GET_USER_OPERATION_RECEIPT: "eth_getUserOperationReceipt",
  
  // Estimate gas for the UserOperation
  ETH_ESTIMATE_USER_OPERATION_GAS: "eth_estimateUserOperationGas",
  
  // Provider-specific (Pimlico): Get current gas prices
  PIMLICO_GET_USER_OPERATION_GAS_PRICE: "pimlico_getUserOperationGasPrice",
}
```

---

## Key Implementation Details

### Transient Storage for Atomic Execution

**Code Reference:** `IntentsBase.sol:447-462`

Transient storage (`tstore`/`tload`) is used to store the authorized solver and session key, ensuring:
- **Atomicity:** Both can only be accessed within the same transaction
- **No replay attacks:** Transient storage is cleared after each transaction
- **No front-running:** MEV cannot snipe the authorization

```solidity
function _select(SelectOptions calldata options) internal returns (address) {
    bytes32 structHash = keccak256(abi.encode(
        SELECT_SOLVER_TYPEHASH, 
        options.commitment, 
        options.solver
    ));
    bytes32 digest = _hashTypedDataV4(structHash);
    address sessionKey = ECDSA.recover(digest, options.signature);

    bytes32 commitment = options.commitment;
    bytes32 solver = bytes32(uint256(uint160(options.solver)));
    bytes32 sessionKeyBytes = bytes32(uint256(uint160(sessionKey)));
    bytes32 sessionSlot = bytes32(uint256(commitment) + 1);
    assembly {
        tstore(commitment, solver)              // Store at slot: commitment
        tstore(sessionSlot, sessionKeyBytes)    // Store at slot: commitment + 1
    }

    return sessionKey;
}
```

### Fill Validation Against Transient Storage

**Code Reference:** `IntentGatewayV2.sol:346-357`

```solidity
if (_params.solverSelection) {
    bytes32 solver;
    bytes32 storedSessionKey;
    bytes32 sessionSlot = bytes32(uint256(commitment) + 1);
    
    assembly {
        solver := tload(commitment)              // Read transient storage
        storedSessionKey := tload(sessionSlot)   // Read transient storage
    }

    // Verify caller is the selected solver
    if (address(uint160(uint256(solver))) != msg.sender) 
        revert Unauthorized();
    
    // Verify session key matches order's session
    if (address(uint160(uint256(storedSessionKey))) != order.session) 
        revert Unauthorized();
}
```

---

## Security Properties

| Property | Mechanism | Code Reference |
|----------|-----------|-----------------|
| **Session key authority** | EIP-712 signature recovery | `IntentsBase.sol:450` |
| **Transient storage** | tstore/tload clears per tx | `IntentsBase.sol:456-458` |
| **Atomicity** | select() + fillOrder() same tx | `IntentGatewayV2.sol:346-357` |
| **No front-run** | Transient storage can't be sniped | `SolverAccount.sol:94-97` |
| **Solver verification** | msg.sender == stored solver | `IntentGatewayV2.sol:355` |

---

## Code References

| Component | File | Lines |
|-----------|------|-------|
| **Solver bid creation** | `BidManager.ts` | 58-103 |
| **Bid selection & session signing** | `BidManager.ts` | 129-224 |
| **Session signature generation** | `CryptoUtils.ts` | 105-124 |
| **Solver signature recovery** | `SolverAccount.sol` | 105-109 |
| **Solver selection storage** | `IntentsBase.sol` | 447-462 |
| **Fill validation** | `IntentGatewayV2.sol` | 346-357 |
| **Bundler communication** | `CryptoUtils.ts` | sendBundler() method |

---

## Comparison: Auction vs FCFS

### Current Model: Auction-Based

**Pros:**
- 🟢 Competitive bidding ensures good fill quality
- 🟢 Inherently MEV-resistant (selections not in mempool)
- 🟢 Safe cross-chain (ordered fills prevent race conditions)
- 🟢 Permissionless and decentralized

**Cons:**
- 🟡 More complex (users must select from bids)
- 🟡 Requires bundler infrastructure
- 🟡 Session key management overhead

### Alternative: First-Come-First-Served (FCFS)

**Pros:**
- 🟢 Simpler execution (no selection step)
- 🟢 Faster fills (immediate on destination chain)
- 🟢 Less infrastructure needed

**Cons:**
- 🔴 No economic competition = poor fill quality
- 🔴 MEV/front-running vulnerability
- 🔴 Cross-chain race conditions (multiple solvers can fill)
- 🔴 Enables solver cartels
- 🔴 No fill rate transparency

**With minimum acceptance criteria (user-set):**
- ✅ Prevents extreme low-ball fills
- ❌ Still allows slightly-below-market fills
- ❌ Doesn't prevent cartel coordination
- ❌ Requires users to accurately predict fair rates

**Verdict:** Auction model is superior for user outcomes, though hybrid approaches could balance simplicity with competition.

---

## Summary

The Intent Gateway uses a sophisticated auction + ERC-4337 architecture where:
1. **Solvers bid competitively** off-chain via UserOperations
2. **Users select winners** with session key signatures
3. **Bundlers execute atomically** through ERC-4337 EntryPoint
4. **Transient storage** ensures atomicity and prevents replay
5. **Cross-chain settlement** releases escrow to winner

This design prioritizes fill quality and security while abstracting away gas complexity through account abstraction.

Refined Phase Breakdown
Let me update the phase diagram with more precision:
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 1: ORDER PLACEMENT (Source Chain)                          │
├──────────────────────────────────────────────────────────────────┤
│ User places order with session key                               │
│ → Order escrowed, OrderPlaced event on source chain              │
└──────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 2: SOLVER BIDDING (Off-chain)                              │
├──────────────────────────────────────────────────────────────────┤
│ Solvers see OrderPlaced event on Hyperbridge                     │
│ Solvers submit UserOps to Hyperbridge coprocessor                │
│ User reviews bids off-chain                                      │
└──────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 3: USER SELECTION (Off-chain)                              │
├──────────────────────────────────────────────────────────────────┤
│ User signs SolverSelection with session key                      │
│ User creates signedUserOp with 162-byte signature                │
│ User's client prepares to submit to bundler                      │
│ NO BLOCKCHAIN INTERACTION YET                                    │
└──────────────────────────────────────────────────────────────────┘
                            ↓
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 4: BUNDLER SUBMISSION (HTTP Request)                       │
├──────────────────────────────────────────────────────────────────┤
│ User's client sends signedUserOp to bundler HTTP endpoint        │
│ Bundler validates and queues in mempool                          │
│ Bundler returns userOpHash immediately                           │
│ STILL NO BLOCKCHAIN INTERACTION                                  │
│ NO CROSS-CHAIN REQUEST YET                                       │
└──────────────────────────────────────────────────────────────────┘
                            ↓ (transaction propagates)
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 5: ON-CHAIN EXECUTION (Destination Chain)                  │
├──────────────────────────────────────────────────────────────────┤
│ EntryPoint.handleUserOps() called                                │
│ SolverAccount.validateUserOp() validates signature               │
│ gateway.select() stores solver & session key in tstore           │
│ gateway.fillOrder() executed:                                    │
│   ├─ Transfer output tokens to beneficiary                       │
│   ├─ Execute postdispatch calldata if present                    │
│   └─ **DISPATCH CROSS-CHAIN REQUEST** ← THIS IS WHERE!           │
│      dispatcher.dispatch(RedeemEscrow)                           │
│        Sends message back to SOURCE chain                        │
│        dispatcher.dispatch() Line 155/157                        │
│ Transient storage cleared                                        │
│ OrderFilled event emitted on destination chain                   │
└──────────────────────────────────────────────────────────────────┘
                            ↓ (cross-chain message propagates)
┌──────────────────────────────────────────────────────────────────┐
│ PHASE 6: SETTLEMENT (Source Chain)                               │
├──────────────────────────────────────────────────────────────────┤
│ RedeemEscrow message arrives on source chain                     │
│ Relayer submits proof via ISMP                                   │
│ onAccept() handler called                                        │
│ Escrow released to solver                                        │
│ EscrowReleased event emitted                                     │
└──────────────────────────────────────────────────────────────────┘
---