---
title: "Bundler in ERC-4337 & Hyperbridge"
source: obsidian/01-Technology
---

# Bundler in ERC-4337 & Hyperbridge

## Quick Definition

A **bundler** is an **ERC-4337 Account Abstraction service** that:
1. **Receives UserOperations** from users/applications
2. **Bundles them together** and submits to the blockchain
3. **Pays for gas** on behalf of users
4. **Gets reimbursed** from the user's account

In Hyperbridge's context, the bundler is the **intermediary transaction operator** that executes the intent settlement transaction without requiring the user to hold ETH.

---

## Why Use a Bundler?

### Without Bundler (Traditional):
```
User must:
1. Have ETH for gas upfront
2. Sign raw transaction with private key
3. Submit to blockchain directly
4. Wait for inclusion
5. Pay gas directly
```

### With Bundler (ERC-4337):
```
User can:
1. Sign a UserOperation (not a tx)
2. Send to bundler (no gas upfront)
3. Bundler pays gas, gets reimbursed from account
4. Multiple ops batched together
5. No private key exposure to dApp
6. Abstracting away gas complexity
```

---

## How It Works

### Traditional Transaction Flow
```
User Account
    ↓ (sends ETH + signs)
Blockchain (executes tx)
```

### With Bundler (ERC-4337 / Account Abstraction)
```
User Client
    ↓ (signs UserOperation, sends to bundler)
Bundler Service
    ↓ (submits to EntryPoint)
Blockchain (executes via EntryPoint)
```

---

## Bundler HTTP Interface

Bundlers expose standard RPC methods as HTTP endpoints.

**Code Reference:** `CryptoUtils.ts:sendBundler()`

```typescript
async sendBundler<T>(method: BundlerMethod, params: unknown[] = []): Promise<T> {
  if (!this.ctx.bundlerUrl) {
    throw new Error("Bundler URL not configured")
  }

  // Standard JSON-RPC call to bundler
  const response = await fetch(this.ctx.bundlerUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,      // e.g., "eth_sendUserOperation"
      params       // e.g., [signedUserOp, entryPointAddress]
    }),
  })

  // Parse response
  const data = await response.json()
  if (data.error) throw new Error(data.error.message)
  return data.result
}
```

---

## Bundler RPC Methods

**Code Reference:** `types.ts` (BundlerMethod enum)

```typescript
const BundlerMethod = {
  // Submit a UserOperation to bundler mempool
  ETH_SEND_USER_OPERATION: "eth_sendUserOperation",
  
  // Retrieve receipt for submitted UserOperation by hash
  ETH_GET_USER_OPERATION_RECEIPT: "eth_getUserOperationReceipt",
  
  // Estimate gas limits (callGasLimit, verificationGasLimit, preVerificationGas)
  ETH_ESTIMATE_USER_OPERATION_GAS: "eth_estimateUserOperationGas",
  
  // Provider-specific (Pimlico): Get recommended gas prices for UserOps
  PIMLICO_GET_USER_OPERATION_GAS_PRICE: "pimlico_getUserOperationGasPrice",
}
```

---

## How Hyperbridge Uses Bundler

### Configuration

**Code Reference:** `evm.ts` (EvmChain initialization)

```typescript
static async create(rpcUrl: string, bundlerUrl?: string): Promise<EvmChain> {
  // Chain initialized with optional bundlerUrl
}

// Example usage:
const chain = await EvmChain.create(
  "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
  "https://api.pimlico.io/v2/1/rpc?apikey=YOUR_KEY"  // ← Bundler URL
)
```

### In Intent Gateway Workflow

**Code Reference:** `BidManager.ts:233-236`

```typescript
// User's client sends signed UserOp to bundler
const bundlerResult = await crypto.sendBundler<HexString>(
  BundlerMethod.ETH_SEND_USER_OPERATION,
  [
    signedUserOp,           // The signed UserOperation (162-byte signature)
    entryPointAddress,      // ERC-4337 EntryPoint contract address
  ]
)

// Returns userOpHash to user
const userOpHash = bundlerResult

// Later, user polls bundler for receipt
const receipt = await crypto.sendBundler(
  BundlerMethod.ETH_GET_USER_OPERATION_RECEIPT,
  [userOpHash]
)

// Gets transactionHash when included on-chain
const txnHash = receipt.receipt.transactionHash
```

---

## What Bundler Does On Receipt of UserOp

```
1. Receives HTTP request from user's client:
   POST /rpc
   {
     jsonrpc: "2.0",
     method: "eth_sendUserOperation",
     params: [signedUserOp, entryPointAddress]
   }

2. Validates the UserOperation:
   - Checks gas limits are reasonable
   - Simulates execution with eth_call
   - Verifies signature structure
   
3. Pools the UserOp (adds to mempool):
   - Bundler maintains a mempool of pending UserOps
   - May wait for more ops to batch together
   
4. Creates a bundled transaction:
   - Combines multiple UserOps
   - Calls EntryPoint.handleUserOps([userOp1, userOp2, ...])
   
5. Submits to blockchain:
   - Sends transaction to network nodes
   - Pays transaction fees from bundler account
   
6. Returns immediately:
   - Sends userOpHash back to user
   - (Transaction inclusion still pending)
   
7. Tracks inclusion:
   - Monitors for transaction confirmation
   - Stores receipt data
```

---

## EntryPoint Execution Flow

Once bundler submits to blockchain, EntryPoint takes over:

```
EntryPoint.handleUserOps([signedUserOp])
    ↓
For each UserOp:
    ├─ Call SolverAccount.validateUserOp()
    │  ├─ Parse 162-byte signature
    │  ├─ Recover session key from signature
    │  ├─ Verify signatures
    │  └─ Return SIG_VALIDATION_SUCCESS
    │
    ├─ Execute calldata:
    │  ├─ Call gateway.select()
    │  │  └─ Store solver & session key in tstore
    │  └─ Call gateway.fillOrder()
    │     ├─ Read from tstore
    │     ├─ Verify solver match
    │     ├─ Transfer output tokens
    │     └─ Dispatch settlement message
    │
    ├─ Collect payment:
    │  └─ Calculate gas used and transfer to bundler
    │
    └─ Clear transient storage
```

---

## Common Bundler Services

| Provider | Website | Notes |
|----------|---------|-------|
| **Pimlico** | https://pimlico.io | Most popular, supports 50+ chains, used by Hyperbridge |
| **Alchemy** | https://alchemy.com | Integrated with Alchemy RPC |
| **Stackup** | https://stackup.sh | Open-source option |
| **Self-hosted** | N/A | Run your own bundler |

### Using Pimlico in Hyperbridge Tests

**Code Reference:** `intentGateway.test.ts`

```typescript
function bundlerUrl(chainId: number): string | undefined {
  const apiKey = process.env.BUNDLER_API_KEY
  // Uses Pimlico's public bundler service
  return apiKey ? `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${apiKey}` : undefined
}
```

---

## Complete Bundler Flow in Intent Gateway

```
┌─────────────────────────────────────────────────────────────┐
│ PHASE 1-3: Order Placement → Bid Selection (no bundler)     │
├─────────────────────────────────────────────────────────────┤
│ User creates order on source chain                          │
│ Solvers bid on Hyperbridge coprocessor                      │
│ User selects best bid off-chain                             │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 4: User Submits to Bundler                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ User's Client:                                              │
│ 1. Signs with session key                                   │
│ 2. Creates signedUserOp (162-byte signature)                │
│ 3. HTTP POST to bundler:                                    │
│                                                             │
│    POST https://api.pimlico.io/v2/42161/rpc                │
│    {                                                        │
│      "jsonrpc": "2.0",                                      │
│      "id": 1,                                               │
│      "method": "eth_sendUserOperation",                     │
│      "params": [signedUserOp, entryPointAddress]            │
│    }                                                        │
│                                                             │
│ Bundler Service:                                            │
│ 1. Receives request                                         │
│ 2. Validates UserOp structure                               │
│ 3. Simulates with eth_call                                  │
│ 4. Adds to mempool                                          │
│ 5. Returns userOpHash                                       │
│                                                             │
│ User receives:                                              │
│ {                                                           │
│   "result": "0x1234...",  // userOpHash                     │
│   "jsonrpc": "2.0",                                         │
│   "id": 1                                                   │
│ }                                                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 5: Bundler Submits & EntryPoint Executes              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ Bundler (seconds later):                                    │
│ 1. Batches UserOps together                                 │
│ 2. Submits transaction to blockchain:                       │
│    eth_sendRawTransaction({                                 │
│      to: entryPoint,                                        │
│      data: entryPoint.handleUserOps([userOp1, userOp2, ...])
│    })                                                       │
│ 3. Pays gas from bundler account                            │
│                                                             │
│ Blockchain (on destination chain):                          │
│ 1. EntryPoint receives bundled tx                           │
│ 2. For each UserOp:                                         │
│    ├─ Validates signature (162 bytes)                       │
│    ├─ Executes gateway.select() + gateway.fillOrder()       │
│    └─ Collects gas payment                                  │
│ 3. Confirms execution                                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 6: User Monitors for Receipt                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ User's Client (polls bundler):                              │
│ 1. HTTP POST to bundler:                                    │
│                                                             │
│    POST https://api.pimlico.io/v2/42161/rpc                │
│    {                                                        │
│      "jsonrpc": "2.0",                                      │
│      "id": 1,                                               │
│      "method": "eth_getUserOperationReceipt",               │
│      "params": [userOpHash]                                 │
│    }                                                        │
│                                                             │
│ 2. When included on-chain, receives:                        │
│    {                                                        │
│      "result": {                                            │
│        "receipt": {                                         │
│          "transactionHash": "0x5678...",                    │
│          "blockNumber": 123456,                             │
│          "gasUsed": 250000                                  │
│        },                                                   │
│        "userOpHash": "0x1234...",                           │
│        "actualGasCost": "0x1234...",                        │
│        "actualGasUsed": "0x3d090"                           │
│      }                                                      │
│    }                                                        │
│                                                             │
│ 3. Parses transactionHash and monitors for OrderFilled event
│                                                             │
└─────────────────────────────────────────────────────────────┘
                         ↓
┌─────────────────────────────────────────────────────────────┐
│ PHASE 7: Settlement (cross-chain)                           │
├─────────────────────────────────────────────────────────────┤
│ RedeemEscrow message arrives on source chain                │
│ → Escrow released to solver                                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Key Takeaway

The bundler is **NOT:**
- A solver (doesn't provide liquidity)
- A relayer (doesn't relay cross-chain messages)
- An exchange (doesn't take fees directly)

The bundler **IS:**
- An **intermediary transaction operator** that submits UserOperations on behalf of users
- A **service that abstracts gas payment** (user signs, bundler pays, bundler gets reimbursed)
- **Configured as an HTTP endpoint** that users point to

In Hyperbridge Intent Gateway, the bundler is the **mechanism that makes the atomic select + fillOrder transaction possible** without requiring the user to hold ETH and sign a raw transaction themselves.

---

## Integration Checklist

When integrating with Intent Gateway:

- [ ] Configure bundler URL for destination chain
- [ ] Ensure user has session key stored locally
- [ ] Sign UserOperation with solver's private key
- [ ] Sign SolverSelection with session key
- [ ] Submit signedUserOp to bundler via HTTP
- [ ] Monitor userOpHash for receipt
- [ ] Wait for OrderFilled event on-chain
- [ ] Verify escrow released to solver (cross-chain)
