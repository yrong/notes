---
author: Ron
date: 2024-06-13T01:15:00+08:00
tags:
- blockchain
- ethereum
- solidity
- foundry
- testing
title: "Notes: Foundry invariant testing"
---

Study notes on [Foundry — Invariant Testing](https://www.getfoundry.sh/guides/invariant-testing). Invariant tests ask: **what must always stay true**, no matter the call sequence? Forge fuzzes random sequences and checks those properties after calls.

<!--more-->

## TL;DR

- Name tests `invariant_*`; `targetContract(...)` (or a **handler**) so Forge knows what to call.
- Prefer **handlers** + `bound()` + multi-actor pranks over raw contract fuzzing.
- **Ghost variables** mirror off-chain cumulative state to assert conservation / solvency.
- Tune `[invariant]` in `foundry.toml`; v1.7+ adds `check_interval`, time/block delays, and **optimization mode** (`returns int256`).

## 1. What it is

Unit tests check one scenario. Invariant tests check **global properties** across many random sequences:

```text
for each run:
  for each call (up to depth):
    pick a targeted function + fuzzed args
    execute
    assert all invariant_* still hold
```

Run:

```bash
forge test --match-contract VaultInvariantTest
```

## 2. Minimal example

```solidity
contract VaultInvariantTest is Test {
    Vault vault;

    function setUp() public {
        vault = new Vault();
        targetContract(address(vault));
    }

    function invariant_SolvencyCheck() public view {
        assertGe(address(vault).balance, vault.totalDeposits());
    }
}
```

Anything named `invariant_*` is an invariant. Without a handler, Forge calls public/external functions on the target with unconstrained fuzz inputs — often noisy.

## 3. Handler pattern (the default shape)

Handlers sit between the fuzzer and the SUT:

| Job | How |
|-----|-----|
| Constrain inputs | `bound(amount, min, max)` |
| Multi-user | actor pool + `vm.startPrank` |
| Skip dead ends | early `return` (e.g. zero balance) |
| Track ghosts | accumulate off-chain sums |

Target the **handler**, not the vault:

```solidity
handler = new VaultHandler(vault);
targetContract(address(handler));
```

Typical handler actions: `deposit` / `withdraw` with `useActor(actorSeed)`, bounded amounts, and `ghost_depositSum` / `ghost_withdrawSum`.

Then assert conservation:

```solidity
assertEq(
    address(vault).balance,
    handler.ghost_depositSum() - handler.ghost_withdrawSum()
);
```

**Why `bound` not `vm.assume`:** assume rejects samples and wastes fuzz budget; bound remaps into a valid range.

## 4. Ghost variables

Ghosts hold state the chain doesn’t store but you need for the property:

- Totals: `ghost_mintedSum`, `ghost_burnedSum`
- Per-address deltas: `mapping(address => int256) ghost_balanceDeltas`

Example check: `totalSupply() == ghost_mintedSum - ghost_burnedSum`.

## 5. Config (`foundry.toml`)

```toml
[invariant]
runs = 256              # sequences
depth = 100             # calls per sequence
fail_on_revert = false  # handler reverts ≠ invariant fail
shrink_run_limit = 5000 # shrink failing sequences
```

### Foundry ≥ 1.7 campaigns

| Knob | Meaning |
|------|---------|
| `check_interval = N` | Check every `N` calls (`0` = only last; `1` = every call). Faster deep runs; can **miss** break-then-heal bugs. |
| `max_time_delay` / `max_block_delay` | Fuzz `warp` / `roll` gaps between calls (vesting, TWAP, cooldowns). |
| Optimization mode | `invariant_*` returns `int256` → maximize that value (worst slippage, max imbalance). Fix `seed` for reproducibility. |

## 6. Narrowing the call surface

```solidity
// only these
targetSelector(FuzzSelector({
    addr: address(handler),
    selectors: selectors // deposit, withdraw, ...
}));

// or exclude debug helpers
excludeSelector(FuzzSelector({
    addr: address(handler),
    selectors: toSelectors(VaultHandler.debugFunction.selector)
}));
```

## 7. Coverage & multi-contract

- Count calls in the handler (`mapping(bytes4 => uint256) calls`) and log via `invariant_CallSummary` → `handler.callSummary()`.
- One **SystemHandler** can drive vault + token + oracle and assert cross-contract solvency (e.g. staked value ≥ liabilities after price updates).

## 8. Common invariants

| Kind | Idea |
|------|------|
| Conservation | inputs − outputs = on-chain balance / supply |
| Solvency | assets cover liabilities |
| Monotonicity | some value only grows or only shrinks |
| Bounds | stay in range |
| Access control | unauthorized paths revert / no-op |
| State consistency | related fields stay in sync |

## 9. Debugging

```bash
forge test --match-test invariant_Solvency -vvvv
```

Forge prints the failing call sequence (and can shrink it). Reproduce from that trace.

## 10. Best practices

1. Always prefer a **handler** over naked `targetContract(sut)`.
2. Ghosts for anything you can’t read cheaply on-chain.
3. `bound()` over `assume()`; multiple actors.
4. Start with solvency/conservation; add time/oracle later.
5. Log call counts so “unused” selectors don’t silently weaken the campaign.

## Source

- [Foundry Guide: Invariant Testing](https://www.getfoundry.sh/guides/invariant-testing)
