---
title: "Spec-Messaging E2E test — spec_msg_penpal runbook"
author: Ron
date: 2026-07-25T03:20:00+08:00
tags:
- polkadot
- parachain
- speculative-messaging
- testing
---

# Spec-Messaging E2E test — `spec_msg_penpal` runbook

The end-to-end test covering the whole spec-messaging workflow lives on `lexnv/spec-msg-poc-mvp`:

- **File:** `polkadot/zombienet-sdk-tests/tests/messaging/spec_msg_penpal.rs`
- **Test fn:** `spec_msg_penpal_xcm_delivery` — `#[tokio::test(flavor = "multi_thread")]`
- **What it is:** the HRMP→spec-msg cutover test. Spawns a **rococo-local relay + two penpal parachains**
  (real collators + real network, native zombienet), so it exercises the *full* stack: sender pallet →
  MMR/`StreamsRoot` + `SPMS` digest → relay `RecentProvides` matching → **off-chain p2p fetch over the real
  transport** → messaging inherent → XCM router → register/ack round-trip → HRMP interop.

## Workflow (the runbook the test walks)

1. **Baseline** — HRMP channels open both ways; XCM A→B delivers over HRMP.
2. **Handshake** — `open_channel` + `accept_open_channel` both directions via sudo (A→B open-first, B→A
   accept-first — either order works). Wait for phase `Open` on both senders: the peer accepted, **published
   its initial register on the ack stream, and the sender read it back through the inherent** — a full
   round-trip over the real transport, observable on-chain (the cutover gate). Only the `OpenChannel` signal
   leaf touches the wire; the router still prefers the open HRMP channel.
3. **Cutover** — set `HrmpClosing` on both sides (new traffic diverts, the pipe drains), verify the drain,
   close the HRMP channels relay-side.
4. **Deliver over spec-msg** (both directions) — the sender's stream frontier advances, its header carries
   the `SPMS` digest, the relay's `RecentProvides` ring gains the sender's root, and the receiver executes
   the message under the `SpecMsg(source)` origin (Sibling-identical), asserted via `MessageQueue.Processed`.
   The receiver's register round-trips back: the sender's channel view shows the advanced watermark (credit
   refresh + archive-prune signal).
5. **Rollback** — re-open HRMP one direction and clear the flag; the router reverts to HRMP.
6. **Unroutable** — a sibling with neither transport rejects the send.

Delivery is **exactly-once** throughout: the final sweep tallies every `MessageQueue.Processed` event by
origin against the number of sends.

## How to run

**Gating (from the code):** `mod messaging` is `#[cfg(feature = "zombie-ci")]`; the `subxt` macro reads
`metadata-files/penpal-local.scale`, which is **not committed** — `build.rs` generates it (its `CHAINS`
list includes `penpal`) only under `--features zombie-metadata`. So **both features are required**. Native
provider needs the binaries on `$PATH`.

**1. Build the spec-msg-capable binaries (from this branch) + put on `PATH`:**
```bash
cargo build --release -p polkadot                  # polkadot + execute/prepare workers
cargo build --release -p polkadot-parachain-bin    # the polkadot-parachain collator (has --spec-msg-source-peer)
export PATH="$PWD/target/release:$PATH"
```
(Needs the wasm toolchain — `build.rs` builds `penpal-runtime.wasm` to generate the metadata.)

**2. Run the single E2E test (native provider; metadata generated automatically):**
```bash
ZOMBIE_PROVIDER=native \
cargo test --release -p polkadot-zombienet-sdk-tests \
  --features "zombie-metadata,zombie-ci" \
  spec_msg_penpal_xcm_delivery -- --nocapture
```

Optional:
- `ZOMBIENET_SDK_BASE_DIR=/my/dir` — keep chain files + node logs (handy for debugging fetch/relay steps).
- `ZOMBIE_METADATA_BUILD_DEBUG=1` — `build.rs` prints which chain wasm it's resolving, if metadata gen fails.

## Notes
- One heavy multi-node test (real relay + 2 collators, full runbook) — minutes, not seconds.
- Collators are wired via static `--spec-msg-source-peer` addresses; zombienet derives node keys from node
  names, so peer ids are known up front.
- This is the "E2E HRMP replacement test" (#12596) and the flow lexnv stress-tested (source of the
  empty-stream / cursor-0 findings).
