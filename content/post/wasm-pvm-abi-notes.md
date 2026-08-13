---
title: "WASM-PVM ABI Notes — Packed Pointer/Length Returns and Linear Memory"
author: Ron
date: 2026-08-12T00:00:00+08:00
tags:
- wasm
- pvm
- polkavm
- assemblyscript
- abi
---

# WASM-PVM ABI Notes — Packed Pointer/Length Returns and Linear Memory

Notes from reading [wasm-pvm](https://github.com/tomusdrw/wasm-pvm), which compiles WASM to
PolkaVM (PVM) bytecode. The interesting part is the entry-point ABI: how a guest program
receives arguments and returns results through linear memory, both in the hand-written WAT
hello-world and in AssemblyScript programs targeting it.

## The unified entry-point ABI

Every guest program exports one entry function:

```wat
(func (export "main") (param $args_ptr i32) (param $args_len i32) (result i64)
```

- **Input**: the runtime writes the argument bytes into linear memory and passes their
  location as `(args_ptr, args_len)`.
- **Output**: the function returns a single `i64` that packs **the result's address in the
  low 32 bits and its byte length in the high 32 bits**: `(len << 32) | ptr`.

The compiler unpacks this into PVM's SPI convention: register `r7` = result start address,
`r8` = end address. The single i64 is just the WASM-side representation of that two-register
contract.

## Decoding the hello-world return value

The hello-world WAT ends with:

```wat
(i32.store
  (i32.const 0)      ;; address: linear memory offset 0
  (i32.const 42))    ;; value: the result to write there
...
(i64.const 17179869184)  ;; packed ptr=0, len=4
```

`17179869184` in hex is `0x4_0000_0000`, i.e. `4 << 32`:

```
bits 63........32 | 31.........0
      0x00000004  |  0x00000000
      length = 4  |  pointer = 0
```

So the two lines work as a pair:

1. `i32.store` puts the answer *in memory* at address 0.
2. The returned i64 is a *descriptor* telling the runtime "my output is the 4 bytes starting
   at address 0."

If the result were instead a 13-byte string at address 1024, the return would be
`(13 << 32) | 1024` = `55834575872`. Same formula: `(len << 32) | ptr`.

## Why results go through memory at all

WASM function return values can only be scalars (i32/i64/f32/f64), never arbitrary data — so
any real output (a string, a struct, even a tagged result) has to travel through linear
memory, with the scalar return acting as a pointer to it. That's why even a hello-world that
produces a single i32 does the store-then-describe dance instead of returning the number
directly.

Why pack two values into one i64 rather than return a (ptr, len) pair? Multi-value returns
exist in WASM but toolchain support is spotty, so squeezing both 32-bit halves into one i64
is the pragmatic, widely-used workaround — and it maps cleanly onto PVM's two-register SPI
convention anyway.

## The same convention from AssemblyScript

A higher-level program targeting this ABI does the same thing with `heap.alloc` instead of a
hard-coded address. Example: build a linked list 10 → 20 → 30 → null in linear memory by
hand, sum it recursively, return 60.

```ts
let RESULT_HEAP: usize = 0;
let NODE_HEAP: usize = 0;

function writeResult(val: i32): i64 {
  store<i32>(RESULT_HEAP, val);
  return (RESULT_HEAP as i64) | ((4 as i64) << 32);  // (len << 32) | ptr
}

// Node structure: [value: i32, next: i32] (8 bytes)
function createNode(ptr: i32, val: i32, next: i32): void {
  store<i32>(ptr, val);
  store<i32>(ptr + 4, next);
}

function sumList(head: i32): i32 {
  if (head == 0) return 0;               // 0 acts as null
  const val = load<i32>(head);
  const next = load<i32>(head + 4);
  return val + sumList(next);
}

export function main(args_ptr: i32, args_len: i32): i64 {
  RESULT_HEAP = heap.alloc(256);
  NODE_HEAP = heap.alloc(32);

  createNode(NODE_HEAP, 10, NODE_HEAP + 8);
  createNode(NODE_HEAP + 8, 20, NODE_HEAP + 16);
  createNode(NODE_HEAP + 16, 30, 0);

  return writeResult(sumList(NODE_HEAP)); // 60
}
```

There are no structs or references here — "objects" are byte offsets into linear memory, and
`load`/`store` are the raw primitives. A node is a bare 8-byte record:

```
offset +0: value (i32, 4 bytes)
offset +4: next  (i32, 4 bytes) — address of the next node, or 0 for null

NODE_HEAP+0:  [ 10 | NODE_HEAP+8  ]
NODE_HEAP+8:  [ 20 | NODE_HEAP+16 ]
NODE_HEAP+16: [ 30 | 0            ]   ← 0 acts as null
```

`writeResult` is the hello-world return convention generalized: store the value at an
allocated address, return `(4 << 32) | RESULT_HEAP`. The only difference from the WAT example
is that the pointer is whatever `heap.alloc` returned instead of 0.

## Caveats worth remembering

- **`0` as null relies on the allocator** never handing out address 0 — true in practice
  since the heap starts after reserved/static memory, but it's an implicit assumption.
- **Type mixing**: `usize` pointers flowing through `i32` parameters works on wasm32 (same
  width) but strict AssemblyScript wants explicit casts.
- **Recursion vs loop**: the recursive sum is not tail-recursive (the `+` happens after the
  call returns), so a long list would grow the call stack; a `while (head != 0)` accumulator
  avoids that.
