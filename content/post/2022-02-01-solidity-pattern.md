---
author: Ron
catalog: true
date: 2022-02-01
tags:
- BlockChain
- Ethereum
- Solidity
title: Solidity patterns
---

## Solidity design-pattern notes

Core Solidity patterns for gas, security, and DX.

### 1. Reentrancy protection

**Problem:** An external call transfers control. An attacker can re-enter before the original call finishes and drain more than allowed.

**Checks-Effects-Interactions (CEI):**
- **Checks:** validate inputs and initial state.
- **Effects:** update all state *before* any external call.
- **Interactions:** external calls / transfers last.

**Reentrancy guards / mutex:** a bool flag (e.g. `nonReentrant`) locks on entry and unlocks on exit; re-entry while locked reverts.

### 2. Packing storage

**Problem:** Reading/writing EVM storage slots (32 bytes) is expensive.

- **Auto packing:** declare small types next to each other (`uint8`, `bool`, `bytes16`); the compiler packs them into one slot.
- **Colocation:** put variables that are often read/written together so EIP-2929 “warm” access discounts apply.
- **Smaller types:** e.g. `uint40` for timestamps instead of `uint256` when that fits.

### 3. Permit2

**Problem:** Classic `approve` UX is poor (one approval tx per protocol) and risky (users tend to infinite-approve).

- **Offline signed approval:** user grants a one-time allowance to the Permit2 contract.
- **Shared across protocols:** later, EIP-712 signatures authorize spends; Permit2-integrated protocols share that allowance.
- **Security:** signatures expire; Permit2 is small and usually easier to audit.

### 4. Delegatecall access control (`onlyDelegateCall` / `noDelegateCall`)

**Problem:** In proxy setups the logic contract is separate; unrestricted sensitive functions can be called directly with bad outcomes.

- **`onlyDelegateCall`:** store deploy address as `immutable`; require `address(this) != DEPLOYED_ADDRESS` so the function only runs via the proxy’s `delegatecall`.
- **`noDelegateCall`:** forbid `delegatecall` into the function (e.g. Uniswap V3-style — stop proxies/clones from reusing logic).

### 5. Separate allowance targets

**Problem:** Protocols upgrade often. If users approve a mutable logic contract, upgrades need re-approval and logic bugs can drain approved funds.

- **Separation of duties:** deploy a minimal, stable allowance-target contract; users approve only that.
- **Dynamic control:** business contracts request pulls through it; governance can toggle which business contracts may access.

### 6. Read-only delegatecall

**Problem:** `delegatecall` can mutate state and cannot be used directly in `view`.

Approaches:
- **Wrap in `staticcall`:** `staticcall` a helper on self; the EVM forces read-only even if the helper uses `delegatecall` underneath.
- **Execute then revert:** run `delegatecall`, then `revert` to undo state changes and recover the return value from the revert payload.

### 7. “Stack too deep” workarounds

**Problem:** The EVM stack only exposes the top 16 slots directly; too many locals/args → compile error.

- **IR pipeline (`--via-ir`):** compiler spills some stack vars to memory.
- **Block scopes:** `{ ... }` shortens variable lifetimes.
- **Memory structs:** pack many vars into `struct memory`; stack keeps one pointer.
- **Off-chain compute:** do heavy work off-chain; verify on-chain.

---

## Assembly tricks (Part 1)

## Source

From Dragonfly’s patterns (`assembly-tricks-1`):  
https://github.com/dragonfly-xyz/useful-solidity-patterns/tree/main/patterns/assembly-tricks-1

Goal: capture the **essence** of these short assembly tricks (why they save gas / which limits they dodge), **when they apply**, and **pitfalls** — so they can be reused safely in production.

---

## Pattern 1: Bubble up reverts (raw revert data)

### Problem

Low-level `call` / `delegatecall` / `staticcall` or `try/catch` give you `bytes memory revertBytes`. A common mistake:

```solidity
revert(string(revertBytes));
```

That re-encodes raw revert data as `Error(string)`, dropping the original type/selector (and breaking custom-error payloads).

### Pattern

In assembly, `revert(ptr, len)` with the **raw** bytes:

```solidity
assembly { revert(add(revertBytes, 0x20), mload(revertBytes)) }
```

### When to use

- You special-case some errors and want everything else to bubble unchanged.
- You need to preserve custom errors / Panic / `Error(string)` for upper layers to decode.

### Risks / limits

- Applies directly to `memory` `bytes` (catch bytes are usually in memory).
- Don’t mix raw bytes with a newly constructed error message — leaks / misreports.

---

## Pattern 2: Hash two words (cheaper keccak of two words)

### Problem

`keccak256(abi.encode(x, y))` allocates a new buffer via `abi.encode` — more gas.

### Pattern

Write both 32-byte words into scratch space `0x00..0x3f`, then keccak:

```solidity
bytes32 hash;
assembly {
    mstore(0x00, word1)
    mstore(0x20, word2)
    hash := keccak256(0x00, 0x40)
}
```

### When to use

- Merkle traversal / pair hashing / combining two 32-byte values.
- You know the payload is exactly two words (64 bytes).

### Risks / limits

- Fixed-width, fixed concatenation only. Different from `abi.encodePacked` or other layouts → different digests.
- Scratch space is usually free, but don’t overwrite `0x00..0x3f` if the same assembly block still needs those values.

---

## Pattern 3: Cast between compatible `memory` array types (zero-copy)

### Problem

Solidity won’t treat `address[]` as `IERC20[]` even when both are 32-byte slots in memory. Naively copying element-by-element wastes gas.

### Pattern

A `memory` dynamic array variable is a pointer — assign the pointer to another array type:

```solidity
address[] memory a = ...;
IERC20[] memory b;
assembly { b := a }
```

### When to use

- You are sure of **bit-level compatibility** (e.g. `address` vs `contract`/`interface` as 20-byte addresses in a word).
- You need to match a library’s input type to data you already have.

### Risks / limits (important)

- **`memory` only** — `calldata` pointer semantics differ; don’t do this there.
- Compatibility must be strict: `uint256[]` ↔ `bytes32[]` slots are fine; mismatched encoding/alignment is not.
- Type lies hurt auditability — wrap in an internal helper named `unsafe…`.

---

## Pattern 4: Cast between compatible `memory` structs (zero-copy)

Same idea for `memory` structs with compatible field layouts:

```solidity
Foo memory foo = ...;
Bar memory bar;
assembly { bar := foo }
```

### Risks / limits

- Safe only if field **count, order, and slot layout** match exactly.
- Hurts maintainability more than array casts — keep to local hot paths and document the layout assumption.

---

## Pattern 5: Shorten dynamic `memory` arrays in place

### Background

A dynamic `memory` array stores length at `mload(arr)`, then elements.

### Pattern

Overwrite length (usually only safe to **shorten**):

```solidity
uint256[] memory arr = new uint256[](100);
assembly { mstore(arr, 99) }
```

### When to use

- You preallocated long, then learned the real length is smaller.
- You want to avoid allocating/copying a new array.

### Risks / limits

- Shorten only; growing can read/write into other memory.
- Affects every holder of the same reference — ensure nothing still assumes the old length.

---

## Pattern 6: “Shorten” static arrays / slicing

Static arrays have no length prefix — you can’t `mstore` a new length. Reuse the pointer as a smaller view:

```solidity
uint256[10] memory arr;
uint256[9] memory shortArr;
assembly { shortArr := arr }
```

Or offset by `0x20` for a shared slice:

```solidity
uint256[10] memory arr;
uint256[8] memory slice;
assembly { slice := add(arr, 0x20) } // skip first element
```

### Risks / limits

- Declaring a static array still allocates; you mainly avoid element-wise copies.
- Offset slices are hard to read and easy to confuse with ownership/bounds — keep them in internal pure helpers.

---

## When these assembly tricks are worth it

- **Worth it:** hot loops, Merkle/hash-heavy paths, preserving raw revert data, bit-compatible type mismatch with a third-party API.
- **Avoid / be careful:** fuzzy boundaries, high maintenance cost, pointer games on `calldata`, unstable struct layouts across upgrades.

---

## Pattern: Code-as-storage (data in contract bytecode) — BigDataStoreV1

### What it does

Large blobs (images / base64 / JSON / proofs) make `SSTORE` very expensive. Code-as-storage:

- **Write:** deploy a “data contract” whose **runtime bytecode** *is* the data.
- **Read:** `EXTCODECOPY` from that address’s code into memory.

Simple header convention used here:

- `code(loc) = MAGIC(4 bytes) || VERSION(1 byte) || DATA(bytes)`

Readers check `MAGIC` / `VERSION` first so arbitrary contract bytecode isn’t treated as payload.

### BigDataStoreV1 (full code: readable `mstore8` version)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @dev Runtime code layout:
/// [0..3]  MAGIC   = 0xB10BDA7A
/// [4]     VERSION = 0x01
/// [5..]   DATA
contract BigDataStoreV1 {
    constructor(bytes memory data) {
        assembly {
            // size = data.length
            let size := mload(data)

            // Overwrite the bytes length word with zeroes (we'll use it as scratch for header)
            mstore(data, 0)

            // Write 5-byte header into the LAST 5 bytes of the (now zero) length word:
            // mem[data+27 .. data+31] = B1 0B DA 7A 01
            mstore8(add(data, 27), 0xB1)
            mstore8(add(data, 28), 0x0B)
            mstore8(add(data, 29), 0xDA)
            mstore8(add(data, 30), 0x7A)
            mstore8(add(data, 31), 0x01)

            // Return runtime bytecode:
            // - starts at data+27 (header position)
            // - length is size+5 (header + payload)
            //
            // After deployment, extcodecopy(loc, ...) can read:
            // MAGIC || VERSION || DATA
            return(add(data, 27), add(size, 5))
        }
    }
}
```

### Loading (read + validate) — CodeStoreV1

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

library CodeStoreV1 {
    bytes4 internal constant MAGIC = 0xB10BDA7A;
    uint8 internal constant VERSION = 0x01;

    function loadBytes(address loc) internal view returns (bytes memory out) {
        // 1) Read code length (not storage!)
        uint256 n;
        assembly { n := extcodesize(loc) }
        require(n >= 5, "CODESTORE_TOO_SMALL");

        // 2) Read first 5 bytes: MAGIC(4) + VERSION(1)
        bytes memory head = new bytes(5);
        assembly {
            // bytes memory layout: [len(32)][data...]
            extcodecopy(loc, add(head, 0x20), 0, 5)
        }

        // 3) Parse & validate header
        bytes4 gotMagic;
        uint8 gotVer;
        assembly {
            // mload(head+32) reads 32 bytes; first 5 bytes are our header
            gotMagic := mload(add(head, 0x20))           // first 4 bytes
            gotVer := byte(4, mload(add(head, 0x20)))    // 5th byte (index 4)
        }
        require(gotMagic == MAGIC, "BAD_MAGIC");
        require(gotVer == VERSION, "BAD_VERSION");

        // 4) Copy the payload bytes (skip 5-byte header)
        uint256 dataSize = n - 5;
        out = new bytes(dataSize);
        assembly {
            extcodecopy(loc, add(out, 0x20), 5, dataSize)
        }
    }

    function loadString(address loc) internal view returns (string memory) {
        return string(loadBytes(loc));
    }
}
```

### Line-by-line: what does `return(add(data, 27), size+5)` mean?

In a constructor, `assembly { return(ptr, len) }` is **not** a Solidity return value. It means:

- Hand memory `[ptr .. ptr+len-1]` to the EVM as the **new contract’s runtime bytecode**
- That becomes `loc.code` after deploy

So:

- `add(data, 27)`: start returning at `data+27` (where `MAGIC+VERSION` was written)
- `size+5`: header (5) + payload (`size`)

After deploy:

- `extcodesize(loc) == 5 + size`
- `extcodecopy(loc, ..., 0, 5)` → header
- `extcodecopy(loc, ..., 5, size)` → original data

### Line-by-line: why `extcodesize` / `extcodecopy`?

That is how code-as-storage **reads** (code region, not `SLOAD`):

- `extcodesize(loc)`: runtime code length (= data length + header)
- `extcodecopy(loc, dst, offset, size)`: copy `size` bytes from code at `offset` into memory `dst`

In `loadBytes` above:

- First copy 5 bytes and check `MAGIC` / `VERSION` (trust model)
- Then copy from offset 5 as the payload
