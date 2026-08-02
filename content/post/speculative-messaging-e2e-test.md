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

The end-to-end test covering the whole spec-messaging workflow lives on `lexnv/spec-msg-poc-mvp`; the
**DHT-discovery variant** (no static peers — the version this runbook now describes) is on the stacked
[`ron/spec-msg-dht-discovery`](https://github.com/paritytech/polkadot-sdk/pull/12736):

- **File:** `polkadot/zombienet-sdk-tests/tests/messaging/spec_msg_penpal.rs`
- **Test fn:** `spec_msg_penpal_xcm_delivery` — `#[tokio::test(flavor = "multi_thread")]`
- **What it is:** the HRMP→spec-msg cutover test. Spawns a **rococo-local relay + two penpal parachains**
  (real collators + real network, native zombienet), so it exercises the *full* stack: sender pallet →
  MMR/`StreamsRoot` + `SPMS` digest → relay `RecentProvides` matching → **off-chain p2p fetch over the real
  transport** → messaging inherent → XCM router → register/ack round-trip → HRMP interop.

## Workflow (the runbook the test walks)

> **How to check these.** The test's own `log::info!` markers are **not captured** (no logger is installed in
> the test process), so don't rely on seeing them. Verify each step from the **collators' node logs**
> (`-lspec-msg=trace`, which the runner mirrors to `…/logs/penpal-{a,b}.log`) plus the harness pass line
> `test result: ok. 1 passed`. On *failure* the failing step's `anyhow!` message **does** surface in
> `test.out` (the test returns `Err`), which localizes the break. Steps with no clean node-log signal (HRMP
> drain, watermark exactness, exactly-once tally) are **harness-gated** — the pass line is their proof.

**0. Discovery config** — before step 1 the test sudo-calls `set_source_genesis(source, (genesis, None))` for
each direction (`spec_msg_penpal.rs:633-634`).
   **✅ Accept** (node log): `Discovered spec-msg source peers source=<id> count≥1`, `Found parachain bootnode
   providers on the relay chain: [PeerId(…)]`, `Serving paranode addresses request from PeerId(…)` on the
   source side, and **zero** `/paranode doesn't exist`. If `count` stays `0`, nothing downstream can work —
   stop and debug discovery here.

1. **Baseline** — HRMP channels open both ways; XCM A→B delivers over HRMP.
   **✅ Accept** (node log): both collators advance blocks — `Archived own block number=N` climbing on
   penpal-a **and** penpal-b. `assert_para_throughput` + the baseline HRMP send are harness-gated (a failure
   bails before the handshake).
2. **Handshake** — `open_channel` + `accept_open_channel` both directions via sudo (A→B open-first, B→A
   accept-first — either order works). Wait for phase `Open` on both senders: the peer accepted, **published
   its initial register on the ack stream, and the sender read it back through the inherent** — a full
   round-trip over the real transport, observable on-chain (the cutover gate). Only the `OpenChannel` signal
   leaf touches the wire; the router still prefers the open HRMP channel.
   **✅ Accept** (node log): the register round-trip lands — `Register read verified and stored source=<id>
   stream=Ack { recipient: … }` on **both** penpals (this *is* the on-chain `Open` gate; discovery + fetch must
   both work for it to appear). On-chain the wire carries only the handshake leaf (`frontier.leaf_count == 1`).
   Failure ⇒ `test.out` shows `did not reach phase Open in time`.
3. **Cutover** — set `HrmpClosing` on both sides (new traffic diverts, the pipe drains), verify the drain,
   close the HRMP channels relay-side.
   **✅ Accept:** **harness-gated** — no direct node-log signal for the HRMP drain (`wait_for_hrmp_drain` +
   `force_clean_hrmp`); it's also implied by step 4 delivering over spec-msg at all. Failure ⇒ `test.out` shows
   the drain timeout.
4. **Deliver over spec-msg** (both directions) — the sender's stream frontier advances, its header carries
   the `SPMS` digest, the relay's `RecentProvides` ring gains the sender's root, and the receiver executes
   the message under the `SpecMsg(source)` origin (Sibling-identical), asserted via `MessageQueue.Processed`.
   The receiver's register round-trips back: the sender's channel view shows the advanced watermark (credit
   refresh + archive-prune signal).
   **✅ Accept** (node log): `Fetched chunk source=<id> stream=Channel { recipient: …, domain: 0, num: 0 }`,
   `Archived own block … streams=1 leaves=1 root=Some(StreamsRoot(…))` (frontier advanced + committed), and
   `Inherent handed to the block messages=<n> …` (delivered via the inherent) — both directions. The
   `SpecMsg(source)` `MessageQueue.Processed` and the exact watermark are harness-gated; failure ⇒ `test.out`
   shows `outbound frontier … did not reach N leaves` or `register watermark … did not reach 3`.
5. **Rollback** — re-open HRMP one direction and clear the flag; the router reverts to HRMP.
   **✅ Accept:** **harness-gated** — `frontier.leaf_count == 3` (no new spec-msg leaf) and the send reverts to
   HRMP (`Processed` under the **sibling** origin). Failure ⇒ `test.out` shows the leaf-count mismatch.
6. **Unroutable** — a sibling with neither transport rejects the send.
   **✅ Accept:** **harness-gated** — the send to a sibling with neither transport is rejected.

Delivery is **exactly-once** throughout: the final sweep tallies every `MessageQueue.Processed` event by
origin against the number of sends.
**✅ Final accept:** the harness prints `test result: ok. 1 passed` (exit 0) — the single authoritative gate,
subsuming the exactly-once tally (`count_processed → spec_on_b == 2`) and every on-chain assert above. The
node-log signals in steps 0/2/4 are how you *watch progress* and localize a failure; this line is what
confirms the whole run.

## How to run

**Gating (from the code):** `mod messaging` is `#[cfg(feature = "zombie-ci")]`; the `subxt` macro reads
`metadata-files/penpal-local.scale`, which is **not committed** — `build.rs` generates it (its `CHAINS`
list includes `penpal`) only under `--features zombie-metadata`. So **both features are required**. Native
provider needs the binaries on `$PATH`.

**Automated:** `polkadot/zombienet-sdk-tests/scripts/run_spec_msg_e2e.sh` runs all three steps below and
checks every accept rule — it builds, asserts the binaries are fresh, clears + regenerates metadata, runs the
test with `TMPDIR` pinned, mirrors the node logs out (native provider deletes them on exit), then **ticks each
milestone live** as its log evidence first appears (`discovery → Open → fetch → deliver → harness pass`, with a
~30s heartbeat), and finally prints a per-rule pass/fail summary — exiting non-zero if any rule or the harness
fails. The manual steps below are what it automates, for piecemeal runs.

```bash
polkadot/zombienet-sdk-tests/scripts/run_spec_msg_e2e.sh              # full run: build + regen + test
polkadot/zombienet-sdk-tests/scripts/run_spec_msg_e2e.sh --skip-build # reuse existing binaries + *.scale
```
Use **`--skip-build`** (or `SKIP_BUILD=1`) to skip the slow node/collator rebuilds and metadata regen when no
spec source changed — it reuses `target/release` and the existing `*.scale` (asserting they *exist* rather than
are fresh) and goes straight to the test. Other knobs: `FRESH_MIN`, `DISCOVERY_TIMEOUT`, `TICK`, `RUN_TIMEOUT`.

**1. Build the spec-msg-capable binaries (from this branch) + put on `PATH`:**
```bash
cargo build --release -p polkadot                  # polkadot + execute/prepare workers
cargo build --release -p polkadot-parachain-bin    # the polkadot-parachain collator
export PATH="$PWD/target/release:$PATH"
```
(Needs the wasm toolchain — `build.rs` builds `penpal-runtime.wasm` to generate the metadata.)

**✅ Accept:** all four binaries exist and were *just* rebuilt (mtime minutes old, not a stale artifact):
```bash
for b in polkadot polkadot-execute-worker polkadot-prepare-worker polkadot-parachain; do
  find target/release/$b -maxdepth 0 -newermt '-15 min' -print || echo "MISSING/STALE: $b"
done
target/release/polkadot --version && target/release/polkadot-parachain --version
```
Every binary must print (fresh mtime) and both `--version` calls must run.

**2. Clear any stale relay metadata (one-time, easy to miss):**
```bash
rm -f polkadot/zombienet-sdk-tests/metadata-files/rococo-local.scale
```
`build.rs` regenerates a `*.scale` file **only when it is absent** (`try_exists() == true` ⇒ skip) — it
never refreshes an existing one. The `subxt` macros compile a static interface against both
`rococo-local.scale` (relay) *and* `penpal-local.scale` (penpal). A checkout that already carries an older
`rococo-local.scale` predating this branch's relay changes (the new spec-msg pallets / `paras_inherent`
shape) will keep that stale file, and the test fails at runtime with
`Metadata error: The generated code is not compatible with the node` — after spawning the nodes, ~4 min in,
so it looks like a logic failure but is not. Deleting the file forces regeneration from this branch's rococo
runtime. (`penpal-local.scale` likewise — and the DHT branch adds `set_source_genesis` +
`source_discovery_info` to penpal, so a stale copy fails at compile with `no variant set_source_genesis`.
Regenerating it needs a **fresh penpal wasm first**: `build.rs` reuses the cached wbuild wasm, so rebuild
`polkadot-parachain-bin`, *then* `rm penpal-local.scale`.)

**✅ Accept:** the stale files are gone *before* the build, and regenerated fresh *after* it —
```bash
ls -l polkadot/zombienet-sdk-tests/metadata-files/*.scale 2>/dev/null   # before: rococo-local.scale absent
# …after the step-3 build:
find polkadot/zombienet-sdk-tests/metadata-files -name '*.scale' -newermt '-15 min'  # both re-gen'd this build
```
If you edited a runtime, confirm each `*.scale` mtime is newer than that edit — otherwise it's stale.

**3. Run the single E2E test (native provider; missing metadata regenerated on build):**
```bash
ZOMBIE_PROVIDER=native \
cargo test --release -p polkadot-zombienet-sdk-tests \
  --features "zombie-metadata,zombie-ci" \
  spec_msg_penpal_xcm_delivery -- --nocapture
```

**✅ Accept:** two gates — discovery (early, from the node logs) and overall (the harness result).
```bash
# discovery — run per penpal log (see log-keeping note below); LOG=$TMPDIR/…/penpal-a.log
grep -c 'Discovered spec-msg source peers .* count=[1-9]' "$LOG"   # ≥ 1
grep -c "/paranode doesn't exist"                          "$LOG"  # == 0
grep -c 'Found parachain bootnode providers on the relay'  "$LOG"  # ≥ 1
```
Overall: exit code `0` and the harness prints `test result: ok. 1 passed; 0 failed`. Per-step progress is the
`SPEC-MSG-PHASE t+…` markers in `test.out` (the test's `log::info!` is **not** captured — a linked crate grabs
the global logger — so the markers go straight to stderr); a bail surfaces as the matching `anyhow!` message
(e.g. `did not reach phase Open in time`) telling you which step failed. See **Timing** below for a run's
per-step breakdown.

Optional:
- Keeping node logs (**native** provider): it writes chain files + logs under `$TMPDIR` and **deletes them on
  exit**, and does *not* honor `ZOMBIENET_SDK_BASE_DIR` — set `TMPDIR=/my/dir` and copy the logs out *while the
  test runs* (grab them before it drops). Needed for the discovery health check below.
- `ZOMBIE_METADATA_BUILD_DEBUG=1` — `build.rs` prints which chain wasm it's resolving, if metadata gen fails.

## Timing — where a run's ~20 min goes

The test emits `SPEC-MSG-PHASE t+MmSSs | …` markers at every step boundary (straight to stderr, so they reach
`test.out`), and the runner prints a per-step timeline from them — **step duration = gap to the next marker**.
One representative `--skip-build` run (Apple silicon, native provider, cold network):

| Elapsed | Duration | Step |
|---|---|---|
| t+0m40s | **3m25s** | 1. baseline: waiting for parachains to produce blocks |
| t+4m05s | 1m13s | 0. discovery config: `set_source_genesis` both directions |
| t+5m18s | **2m40s** | 1. baseline: force-open HRMP + deliver XCM over HRMP |
| t+7m58s | **3m24s** | 2. handshake: open/accept → waiting for `Open` |
| t+11m22s | 1m00s | 2. handshake: both channels **Open** (register round-trip done) |
| t+12m22s | 1m37s | 3. cutover: HrmpClosing → drain → close |
| t+13m59s | 1m00s | 4. deliver A→B #1 |
| t+14m59s | 1m00s | 4. deliver B→A |
| t+15m59s | 1m00s | 4. deliver A→B #2 (ordered) |
| t+16m59s | 0m18s | 4. flow-control: register watermark = 3 |
| t+17m17s | **2m07s** | 5. rollback: re-open HRMP, verify revert |
| t+19m24s | 0m40s | 6. unroutable check |
| t+20m04s | ~0s | 7. exactly-once tally (genesis→tip) → done |

**Where it concentrates** — four steps are ~11.5 of the 20 min:
1. **Baseline block production — 3m25s.** `assert_para_throughput` waits for the collators to start producing
   and get blocks included on a cold relay.
2. **Handshake open/accept → `Open` — 3m24s.** Absorbs the **cold-DHT discovery convergence** (the self-return
   delay, see the discovery section) *plus* the register round-trip that gates `Open`.
3. **Baseline HRMP exchange — 2m40s** and **rollback — 2m07s**: each a relay-mediated, finality-gated delivery.

Everything else is tidy: **each spec-msg delivery is ~1m00s** (remarkably uniform across all three), the
watermark round-trip is ~18s, and the tally is effectively instant. The test self-reports one message's
spec-msg latency **~60s vs HRMP baseline ~52s** — comparable.

**Why:** it's all consensus/finality-bound, not I/O or CPU. Each step waits on *finalized* (relay-mediated)
parachain blocks, done strictly serially across ~5–6 round-trips at ~6s block time. The two cold-start costs
(block-production ramp, DHT convergence) vanish on a warm relay; the round-trip costs are inherent. `--skip-build`
can't shorten any of this — it only skips the *build* (~4 min in a full run), not the test.

*(Numbers are one run; they drift with machine + network. The `SPEC-MSG-PHASE` timeline prints on every run.)*

## Notes
- One heavy multi-node test (real relay + 2 collators, full runbook) — minutes, not seconds.
- Peers are **discovered dynamically over the relay DHT** (RFC-0008 `/paranode`), not wired statically: the
  test sudo-calls `set_source_genesis(source, (genesis, None))` for each direction before the handshake, and
  each collator resolves the other's peers within ~1 block ([#12736](https://github.com/paritytech/polkadot-sdk/pull/12736)).
  The old `--spec-msg-source-peer` / `--spec-msg-source-genesis` flags are gone. **Discovery health check** (in
  the node logs, run with `-lspec-msg=trace,bootnodes=trace`): `Discovered spec-msg source peers … count=1` and
  **zero** `/paranode doesn't exist` errors.
- This is the "E2E HRMP replacement test" (#12596) and the flow lexnv stress-tested (source of the
  empty-stream / cursor-0 findings).
