---
title: "Hyperbridge ISMP storage proofs & Substrate child trie"
source: obsidian/01-Technology
---

# Hyperbridge ISMP storage proofs & Substrate child trie

**Blog (original, unchanged):** `yrong-blog/content/post/2023-04-11-hyperbridge-ismp-state-overlay-mmr.md` → `/post/2023-04-11-hyperbridge-ismp-state-overlay-mmr/`.

**Blog (addendum — state vs log, coprocessor GET flow, relayer queue):** `yrong-blog/content/post/2026-04-22-hyperbridge-ismp-addendum-state-vs-log-workflow.md` → `/post/2026-04-22-hyperbridge-ismp-addendum-state-vs-log-workflow/`.

Site base: `https://yrong.github.io/blog`.

**Summary:** For Substrate / Hyperbridge parachain flows, ISMP storage proofs are built and verified against Substrate’s **child trie** machinery: data lives under `ChildInfo::new_default("ISMP")`, the runtime updates the child trie root with `storage::child::root`, RPC uses `read_child_proof`, and the state machine verifies MPT proofs against the **child trie root** carried in the state commitment (overlay).

**Role split (same mental model as the blog “root map” post):** **trie proofs** answer “does this key exist in state, and with what pallet metadata?”; **MMR proofs** answer “is this message in the ordered log at this place?” — that is **state vs log**, not a clean rule that “Substrate = trie, Ethereum = MMR.”

**Repo:** `hyperbridge` (local clone paths like `modules/pallets/ismp/...`).

---

## Trie vs MMR: state vs log, not “Substrate vs Ethereum”

The useful split is:

- **Trie proofs (main trie + ISMP child trie):** prove **key existence / absence** in Substrate state — membership of commitment records, receipts, fee metadata, “not yet handled” timeout checks, etc.
- **MMR proofs:** prove **inclusion in an append-only message log** — the canonical ordered history of requests/responses for succinct batching and cheap on-chain verification.

**Not a hard platform rule:**

- Substrate integrators still frequently fetch **MMR proofs** (e.g. `mmr_queryProof`) when the *verifier on the other side* is an EVM host that checks `overlayRoot` via MMR multiproofs.
- EVM integrators still care about **receipt / commitment state** on the host contract, but for *message delivery* the handler’s common path is **MMR inclusion** against `overlayRoot` (for Hyperbridge coprocessor: the message MMR root).

So: **trie = state / index layer; MMR = log / history layer** — both can appear in both worlds, depending on what you’re proving *to*.

**Fetch proofs (what to ask for) depends on what the *verifier* checks** — MMR / log inclusion vs child-trie key — not on “am I on Substrate or EVM” alone.

---

## 1. Design — ISMP data in a child trie

From `modules/pallets/ismp/src/child_trie.rs`:

> pallet-ismp leverages a child trie to store outgoing/incoming requests and responses — child tries provide cheaper state proofs than the global state trie.

Reads/writes use Frame’s child storage API with default child trie id `"ISMP"` (`CHILD_TRIE_PREFIX`):

- `child::get` / `child::put` with `ChildInfo::new_default(CHILD_TRIE_PREFIX)`

---

## 2. Runtime — child trie root (`storage::child::root`)

In `on_finalize`, the pallet computes the child trie root and records it (consensus / light clients). See `modules/pallets/ismp/src/lib.rs`:

- `storage::child::root(&ChildInfo::new_default(CHILD_TRIE_PREFIX), state_version)`
- Stored as `ChildTrieRoot` and used in digest (`ConsensusDigest { child_trie_root, ... }`)

---

## 3. Proof RPC — `read_child_proof` + child root from state

`ismp_queryChildTrieProof` (`modules/pallets/ismp/rpc/src/lib.rs`):

- `ChildInfo::new_default(CHILD_TRIE_PREFIX)`
- `client.read_child_proof(at, &child_info, keys)`
- Child root read via `state.storage(child_info.prefixed_storage_key()...)`
- Proof material built with `sp_trie` (`LayoutV0`, `TrieDBBuilder`, recorder)

---

## 4. Verification — proof vs **child trie root** (`overlay_root`)

`SubstrateStateMachine` (`modules/ismp/state-machines/substrate/src/lib.rs`):

- Documents: *Assumes requests are stored in a child trie.*
- Membership verification uses `state.overlay_root` (child trie root) unless coprocessor special-case — error text: *"Child trie root is not available for provided state commitment"*
- Verifies with `sp_trie::StorageProof` + `TrieDBBuilder::<LayoutV0<...>>` against that root (standard Substrate trie layout).

---

## Scope note

- **EVM chains** use Ethereum-style **contract storage** proofs where the state machine verifies Solidity-side storage; that is a different layout than Substrate’s **Patricia + `LayoutV0`**. For *Hyperbridge message delivery* to an EVM host, the common path is still **MMR multiproof** vs `StateCommitment.overlayRoot` (message MMR on Hyperbridge coprocessor), not “EVM = never MMR / only trie.”
- The **child trie** story applies to **Substrate ISMP pallet storage** (commitments/receipts) and related paths (e.g. Substrate-EVM may combine main trie + contract child tries — see `modules/ismp/state-machines/evm/src/substrate_evm.rs`).

---

## Code references (line-anchored)

### `child_trie.rs` — module intent

```text
modules/pallets/ismp/src/child_trie.rs (lines ~16–20, 129–136)
```

### `lib.rs` — `storage::child::root` in `on_finalize`

```text
modules/pallets/ismp/src/lib.rs (lines ~256–266)
```

### RPC — `query_child_trie_proof`

```text
modules/pallets/ismp/rpc/src/lib.rs (lines ~284–318)
```

### State machine — overlay = child trie root, verification

```text
modules/ismp/state-machines/substrate/src/lib.rs (lines ~96–137, 155–190)
```

---

## 5. Writing to the child trie (low-level)

All ISMP child-trie values go through `frame_support::storage::child::put` with `ChildInfo::new_default(CHILD_TRIE_PREFIX)` (`b"ISMP"`). Pallet helpers in `modules/pallets/ismp/src/child_trie.rs` wrap this (`RequestCommitments::insert`, `ResponseCommitments::insert`, `RequestReceipts::insert`, `ResponseReceipts::insert`, `StateCommitments::insert`).

**Main call paths**

| What | Where it’s written | Trigger |
|------|-------------------|---------|
| Outgoing request metadata + fee | `RequestCommitments` | `dispatch_request` (`impls.rs`) after `OffchainDB::push(Leaf::Request)`; also `fund_message`, relayer `claimed` updates, timeouts / `store_request_commitment` |
| Outgoing response metadata + fee | `ResponseCommitments` | `dispatch_response`; same style of updates |
| Incoming request receipt (relayer) | `RequestReceipts` | `store_request_receipt` from `handlers/request.rs` after proof + before module `on_accept` |
| Incoming response receipt | `ResponseReceipts` | `store_response_receipt` from `handlers/response.rs` (`ResponseReceipt`: response hash + relayer — `utils.rs`) |
| Remote state commitments | `StateCommitments` | `store_state_machine_commitment` (e.g. `handlers/consensus.rs`) |

`pallet-hyperbridge` uses the **same** `CHILD_TRIE_PREFIX` for payment keys (`RequestPayments` / `ResponsePayments`) — same physical child trie, different key prefixes.

Removals use `child::kill` via `*::remove` on the same types (`host.rs` delete paths).

Root in the digest is computed in `on_finalize` **after** these extrinsic-time writes.

---

## 6. Source vs destination — child trie vs offchain MMR

**Dispatching chain (source of the POST request or POST response)** — model you described:

- **Child trie:** `RequestCommitments` / `ResponseCommitments` hold `RequestMetadata`: **MMR/offchain pointer** (`LeafIndexAndPos`), **fee** (`FeeMetadata`), **`claimed`**, etc. — **not** the full POST body.
- **Offchain MMR:** `T::OffchainDB::push(Leaf::Request(request))` or `push(Leaf::Response(response))` stores the **full encoded** request/response as the leaf. This only appears in `dispatch_request` / `dispatch_response` (`impls.rs`).

**Receiving chain (destination of request, or requester receiving response)** — **different** shape:

- **Not** the same “metadata + MMR leaf index for this chain” pattern for that message.
- **Incoming request:** child trie gets **`RequestReceipts`** — **relayer id bytes** only (`store_request_receipt` in `host.rs`). Raw request is in the **delivering ISMP message** / extrinsic and passed to `on_accept`; it is **not** pushed via local `dispatch_request`.
- **Incoming response:** child trie gets **`ResponseReceipt`** — **response hash (`H256`) + relayer** (`utils.rs`), not MMR metadata on this chain. Full response bodies for **outgoing** responses still live on the **responder’s** offchain MMR.

**Short mnemonic**

- **Yes:** on the chain that **dispatches**, child trie ≈ commitment + **MMR pointer + fees**; **full** payload in **offchain MMR**.
- **No:** on the **receiver**, child trie ≈ **receipts** (relayer / response hash), not “our leaf index + body in our MMR” for that message.

---

## 7. Raw request in the delivering message → `on_accept`

### Payload: `RequestMessage`

Delivery uses `Message::Request(RequestMessage)`. The struct carries **full** `PostRequest` values (including `body`), plus membership `proof` and `signer` — not only a commitment.

- **File:** `modules/ismp/core/src/messaging.rs` — `RequestMessage { requests: Vec<PostRequest>, proof: Proof, signer: Vec<u8> }`
- **File:** `modules/ismp/core/src/router.rs` — `PostRequest` fields: `source`, `dest`, `nonce`, `from`, `to`, `timeout_timestamp`, **`body`** (opaque app payload)

The relayer / submitter **includes the scale-encoded `PostRequest`s** inside `Vec<Message>` in the extrinsic. The destination does **not** load `body` from its own child trie or MMR for this step.

### Pallet entry

- **`handle_unsigned`** (`modules/pallets/ismp/src/lib.rs`) → **`execute`** (`impls.rs`) → **`handle_incoming_message`** for each `Message`.

### Dispatch

- **`handle_incoming_message`** (`modules/ismp/core/src/handlers.rs`): `Message::Request(req) => request::handle(host, req)`.

### `request::handle` (`modules/ismp/core/src/handlers/request.rs`)

1. Validate proof height / state machine (challenge period, etc.).
2. **`verify_membership`** — proves the requests are committed on the **source** at `msg.proof.height`. Uses `msg.requests` (as `Request::Post`) so the **same** structs must match the source commitment.
3. For each `request` in `msg.requests`:
   - `router.module_for_id(request.to)` → destination `IsmpModule`
   - **`store_request_receipt`** (relayer id in child trie — reentrancy guard)
   - **`cb.on_accept(request.clone())`** — full `PostRequest` including **`body`**
   - On module error: **`delete_request_receipt`** so the request can time out

### Module trait

- **`IsmpModule::on_accept(&self, request: PostRequest)`** — `modules/ismp/core/src/module.rs`

### Mnemonic

- **Source:** commitment + MMR metadata on-chain; full leaf offchain.
- **Destination:** proof checks that the **supplied** `PostRequest` batch matches source state; **`on_accept`** runs on that **in-memory / extrinsic-supplied** struct.

---

## 8. `verify_membership` and `msg.proof.height`

**Yes:** `verify_membership` checks that the **`PostRequest` values in the message** are **members** of the **source** state trie at the **height** given in the proof.

**Mechanism (conceptual):**

1. `msg.proof` includes `height: StateMachineHeight` (which state machine + block height).
2. `host.state_machine_commitment(msg.proof.height)?` loads the **`StateCommitment` already stored on the host** for that height (from an earlier consensus update) — trusted trie root(s), not a live RPC to the source.
3. `state_machine.verify_membership(..., state, &msg.proof)` uses that commitment and the encoded proof to show the **commitment-derived keys** for those requests exist in that state.

So verification is against **“the source state we committed to at that height.”** The intended use is `proof.height` = the source height where those requests were committed. If height / state id were wrong, checks should fail (wrong trie or proxy / routing rules in `request::handle`).

---

## 9. “Trusted roots” vs consensus — `StateCommitment`

**`StateCommitment` commits to *state*, not to “consensus” in the GRANDPA/BABE sense.**

Fields (`modules/ismp/core/src/consensus.rs`):

- **`state_root`** — root of the **global state trie** at that height (Substrate header–style storage root).
- **`overlay_root`** (optional) — e.g. **ISMP child trie root** on Substrate, for membership proofs over commitments.

These are **storage / Merkle trie roots** used inside `verify_membership`, not a separate “consensus root” object.

**Role of consensus:** a **consensus client update** (relay proof, BEEFY, etc.) is what makes the host **trust** that `(state_machine, height)` reached that header; from the verified header the client **fills** `StateCommitment` (timestamp + those roots). So consensus **authorizes** the update; the **roots in `StateCommitment` are state (and optional overlay) roots** for trie checks.

---

## 10. `state_root` vs `overlay_root` vs `mmr_root` — mental model

**What each name refers to**

| Name | Meaning |
|------|--------|
| **`state_root`** | Root of the chain’s **main** Substrate state trie (`Header::state_root`). Commits to **all** pallets; child tries are included **under** this trie. |
| **`mmr_root`** | Root of the **ISMP MMR** after `pallet-mmr` finalizes the block — append-only accumulator over **message leaves** (bodies off-chain). Lives in **`ConsensusDigest`** in the header (`mmr_root` field), not as a standalone field on `StateCommitment`. |
| **`overlay_root` on `StateCommitment`** | The **ISMP overlay** slot in the consensus proof — **not** a third physical trie by itself. Its **meaning depends on which chain** produced the commitment (see packing below). |

**How `ConsensusDigest` relates:** each block, `on_finalize` deposits `ConsensusDigest { mmr_root, child_trie_root }` (field names in `modules/pallets/ismp/src/utils.rs`). **`child_trie_root`** = `storage::child::root` for prefix `b"ISMP"`; **`mmr_root`** = `OffchainDB::finalize()` from the MMR pallet.

**Packing into `StateCommitment`** (`modules/ismp/clients/parachain/client/src/consensus.rs`)

- **Normal parachain (not coprocessor):** `state_root` = header state root; `overlay_root` = **`child_trie_root`** from digest.
- **Hyperbridge as coprocessor:** `state_root` = **`child_trie_root`**; `overlay_root` = **`mmr_root`**. (So on Hyperbridge the MMR root is stored in **`overlay_root`**; child trie root is in **`state_root`**.)

**Verification paths** (`modules/ismp/state-machines/substrate/src/lib.rs`)

- **POST membership (Patricia, commitment keys in child trie):** `OverlayProof` only. Root selection: if verifying proofs **about** the coprocessor state machine → use **`state.state_root`** (which is the child trie root for that commitment); else → **`state.overlay_root`** (child trie root on other chains). This path does **not** use the MMR.
- **GET / arbitrary storage:** `StateProof` → trie root = **`state_root`**. `OverlayProof` in `verify_state_proof` → same overlay vs coprocessor root pick as above.
- **EVM batch delivery of POST messages:** Solidity verifies **MMR multiproofs** against **`overlayRoot`** on the stored commitment — for Hyperbridge that value **is** the **`mmr_root`**.

**Scenario cheat-sheet**

| Scenario | Prove against | Roots |
|----------|----------------|-------|
| Substrate trie membership of commitments | Child trie | `OverlayProof`; root = `overlay_root` (normal) or `state_root` (target = Hyperbridge coprocessor — still **child trie**). |
| GET / read arbitrary key | Main trie | `StateProof` vs **`state_root`**. |
| Deliver POST batch to EVM | MMR | **`StateCommitment.overlayRoot`** = **`mmr_root`** for Hyperbridge; MMR multiproof. |
| “What commits the whole chain?” | — | **`state_root`**. Child trie + MMR are also committed under that economics; ISMP exposes **smaller** roots for proofs where possible. |

**One-line intuition:** **`state_root`** = whole chain; **child trie** = small trie for ISMP commitment/receipt keys; **`mmr_root`** = ordered message log for **succinct** batch proofs — on Hyperbridge exposed as **`overlay_root`** for MMR-speaking clients.

---

## 11. Why a child trie for request/response data

From `modules/pallets/ismp/src/child_trie.rs`: pallet-ismp stores outgoing/incoming request and response **metadata** under `ChildInfo::new_default("ISMP")` because **child tries yield cheaper Merkle–Patricia proofs than proving through the global state trie**.

**Benefits**

1. **Smaller proofs** — `OverlayProof` verification walks only the **ISMP subtree** (keys under the child trie root), not arbitrary long paths under **`state_root`** across all pallets.
2. **Clear separation** — one **`child_trie_root`** per block in `ConsensusDigest`; ISMP overlay vs full **`state_root`** is explicit (`SubstrateStateProof::OverlayProof` vs `StateProof`).
3. **Better for light clients / cross-chain verifiers** — `read_child_proof` style proofs target the child trie; verifying on a destination is less data / gas than full-state proofs for the same logical keys.

**Short version:** the child trie is a **dedicated, smaller trie** for ISMP commitment/receipt keys so **membership proofs are shorter and cheaper** than proving the same keys only via the **entire** runtime state trie.

---

## 12. Coprocessor vs non-coprocessor

`pallet_ismp::Config::Coprocessor: Get<Option<StateMachine>>` names an optional **ISMP proxy** (typically **Hyperbridge**). Docs: [ISMP proxies / coprocessor](https://docs.hyperbridge.network/protocol/ismp/proxies).

| | **Non-coprocessor** (`None`) | **Coprocessor** (`Some(Hyperbridge, …)`) |
|--|------------------------------|----------------------------------------|
| **Meaning** | No single proxy configured on this host | This chain treats Hyperbridge as the party that performs **heavy** consensus/state verification and **aggregates** cross-chain traffic |
| **`StateCommitment` packing** (parachain client) | `state_root` = header root; `overlay_root` = **child trie** root | `state_root` = **child trie** root; `overlay_root` = **MMR** root (swap) |
| **Overlay trie proof root** (`SubstrateStateMachine`) | Use **`state.overlay_root`** for child trie | When proof targets the **coprocessor** id, use **`state.state_root`** (there = child trie root) |
| **Protocol / routing** | Incoming requests should have **`source`** matching the real origin unless another rule applies | Proxy semantics: consumer chains may receive traffic **via** Hyperbridge; `allowed_proxy()` = `Coprocessor::get()` (`host.rs`). Some pallets (e.g. `pallet-hyperbridge` host ops) require `request.source == Coprocessor::get()`. |

**One line:** **Non-coprocessor** = no designated proxy in config. **Coprocessor** = “we name Hyperbridge (or one proxy) so expensive verification can be centralized there and downstream verification uses **cheaper** proofs / routing.”

---

## 13. Why two “paths” for messages — child trie vs MMR

They are **not** two redundant checks of the **same** Merkle fact.

| Path | What it proves | Typical use |
|------|----------------|-------------|
| **Child trie (`OverlayProof`)** | The **runtime state** contains `RequestCommitments` / `ResponseCommitments` at the commitment key (metadata: fees, MMR index, etc.) — “**registered in pallet storage**.” | Substrate `verify_membership`, trie-based verifiers |
| **MMR (`mmr_root` / `overlay_root` on Hyperbridge)** | The commitment appears as a **leaf in the append-only message MMR** — “**in the relay / batch log**” used for delivery. | EVM `HandlerV1`: `MerkleMountainRange.VerifyProof` vs `overlayRoot` |

**Why both exist**

1. **Different structures, different jobs** — Trie = **state commitment** (replay protection, fee accounting). MMR = **ordered log** for **succinct batch** proofs to gas‑limited chains.
2. **Different *verifiers*, not a Substrate/EVM law** — pick **trie** when the check is “this **key** exists in **state** with this metadata”; pick **MMR** when the check is “this **message** is a **leaf** in the **ordered** log at this height” (e.g. `HandlerV1`). A Substrate relayer can still build **`mmr_queryProof`** to feed an EVM handler.
3. **Usually one proof per delivery** — the destination verifier expects **either** trie-style **or** MMR-style membership, not both for the same execution.

**Mnemonic:** trie proof = “**stored on chain** in ISMP state”; MMR proof = “**in the canonical message accumulator** for relay.” Same **commitment hash**, two commitments; pick the proof type that matches the **verifier’s** interface (see *Trie vs MMR: state vs log* at the top).

---

## 14. `LayoutV0` — trie layout vs Ethereum; how proofs are verified

**`LayoutV0<H>`** (`sp_trie`) is Substrate’s standard **Patricia trie layout** (v0 node encoding). The type parameter **`H`** is the **node hasher** (`Keccak256`, `BlakeTwo256`, …) and must match the chain that produced the proof. ISMP Substrate proofs document this in `modules/ismp/state-machines/substrate/src/lib.rs` (`SubstrateStateProof`).

**Not the same as Ethereum storage proofs.** Execution-layer Ethereum uses a different layout (e.g. RLP node codec, EIP-1186). This repo defines **`EIP1186Layout`** in `modules/trees/ethereum/src/lib.rs` — use that path for Ethereum trie verification, **`LayoutV0`** for Substrate overlay/state proofs.

**In-memory test tries** (`TrieDBMutBuilder::<LayoutV0<KeccakHasher>>::new` + `MemoryDB`) build a **Substrate-layout** trie in RAM — useful to mimic ISMP keys (e.g. `request_commitment_storage_key`) in simtests (`parachain/simtests/src/pallet_ismp.rs`). That is **not** FRAME `storage::child` itself, but the **same layout** as verification.

### Verifying a `LayoutV0` `StorageProof` (production pattern)

Canonical verification lives in **`SubstrateStateMachine`** (`modules/ismp/state-machines/substrate/src/lib.rs`):

1. Decode `SubstrateStateProof` (`OverlayProof` / `StateProof` + hasher).
2. Choose trie root (`overlay_root` / `state_root` / coprocessor rules — see §10).
3. **`StorageProof::new(...).into_memory_db::<H>()`** — rebuild partial trie DB from proof nodes.
4. **`TrieDBBuilder::<LayoutV0<H>>::new(&db, &root).build()`** — open trie at trusted root.
5. **`trie.get(&key)`** — membership succeeds iff value present (membership checks require `Some(value)`).

Same pattern for **`verify_membership`** (Keccak vs Blake2 branches) and **`verify_state_proof`**.

**Helper:** `read_proof_check` in the same file (lifted from `sp_state_machine::read_proof_check`) — `into_memory_db`, optional `db.contains(root, EMPTY_PREFIX)`, then `TrieDBBuilder::<LayoutV0<H>>::new(&db, root)` and per-key `get`. **`read_proof_check_for_parachain`** for parachain header proofs.

**Test reference:** `modules/pallets/testsuite/src/tests/child_trie_proof_check.rs` — `prove_child_read` → `into_memory_db` → `TrieDBBuilder::<LayoutV0<BlakeTwo256>>` / `read_proof_check` against child trie root.

**One-liner:** verification = **proof bytes → `MemoryDB` → `TrieDBBuilder::<LayoutV0<H>>(db, root)` → `get(key)`**, with **`H`** matching the source chain’s trie hasher.

---

## 15. EVM: `OptimismHost` vs `EvmHost` vs `HandlerV1` — where verification lives

**Repo paths:** `evm/src/hosts/Optimism.sol`, `evm/src/core/EvmHost.sol`, `evm/src/core/HandlerV1.sol`, `evm/src/consensus/*.sol`.

### `OptimismHost`

Thin wrapper: **`EvmHost` + `CHAIN_ID`** (e.g. mainnet `10`). **No** cryptographic verification in this file — only `constructor` and `chainId()`.

### `EvmHost`

**Storage + dispatch** for ISMP on EVM: commitments, receipts, `StateCommitment` maps, fee params, `dispatchIncoming` **only callable by the configured `handler`**. Commented explicitly: **all verification is delegated to `IHandler`** (`HostParams.handler`, typically **`HandlerV1`**).

### `HandlerV1` — actual checks

1. **`handleConsensus(IHost host, bytes proof)`** — calls **`IConsensus(host.consensusClient()).verifyConsensus(...)`**, then **`host.storeConsensusState`** and **`host.storeStateMachineCommitment`** for each `IntermediateState`. This is how **trusted roots** (incl. Hyperbridge / Polkadot path, depending on deployed consensus client) get onto the host.

2. **`handlePostRequests` / `handlePostResponses`** — challenge period, then **`MerkleMountainRange.VerifyProof`** against **`host.stateMachineCommitment(height).overlayRoot`** (MMR root) + dispatch via **`host.dispatchIncoming`**.

Consensus math lives in **`consensusClient`** contracts (e.g. BEEFY / `ConsensusRouter` → `BeefyV1`, `SP1Beefy`, etc. under `evm/src/consensus/`), **not** in `OptimismHost`.

### Message from Bifrost → Optimism (conceptual)

On Optimism you **do not** verify Bifrost parachain crypto inside `OptimismHost`. Typical path:

- **Bifrost → Hyperbridge** already used parachain / coprocessor verification **on Hyperbridge**.
- On Optimism, relayers **`handleConsensus`** to update **Hyperbridge-related** consensus / state commitments (per deployed client).
- Relayers **`handlePostRequests`** to prove the POST is in Hyperbridge’s **MMR** at `proof.height` (**`overlayRoot`**).

**Table**

| Component | Role |
|-----------|------|
| **`OptimismHost`** | Chain id + inherit `EvmHost`; no proofs |
| **`EvmHost`** | State; `dispatchIncoming` only after handler |
| **`HandlerV1`** | MMR verification, timeouts, duplicate checks; calls consensus client |
| **`consensusClient`** | `verifyConsensus` proofs (e.g. BEEFY / routed clients) |

---

## 16. `IConsensus` — interface and BEEFY implementations (EVM)

**Interface:** `sdk/packages/core/contracts/interfaces/IConsensus.sol`

- **`verifyConsensus(bytes trustedState, bytes proof) → (bytes newState, IntermediateState[] intermediates)`**
- Opaque encoding per client; handler only requires this ABI.

**Concrete contracts** (`evm/src/consensus/`)

| Contract | File | Role |
|----------|------|------|
| **`ConsensusRouter`** | `ConsensusRouter.sol` | Routes by **first byte** of `proof`: `0x00` → **BeefyV1** (naive), `0x01` → **SP1Beefy** (ZK), `0x02` → **BeefyV1FiatShamir**; strips byte and forwards. |
| **`BeefyV1`** | `BeefyV1.sol` | **BEEFY** client: `RelayChainProof` + `ParachainProof`; **`verifyMmrUpdateProof`** (relay signatures / authority set, MMR root update) then **`verifyParachainHeaderProof`** → **`IntermediateState[]`**. Docstring: verifies secp256k1 + authority merkle proofs for finalized **Hyperbridge** state. |
| **`SP1Beefy`** | `SP1Beefy.sol` | ZK-wrapped BEEFY verification. |
| **`BeefyV1FiatShamir`** | `BeefyV1FiatShamir.sol` | Fiat–Shamir–style BEEFY variant. |

**Deployed host:** `EvmHost` stores **`consensusClient`** from `HostParams`; **`HandlerV1.handleConsensus`** calls **`IConsensus(host.consensusClient()).verifyConsensus(...)`** — often **`ConsensusRouter`** so multiple proof types work.

**`BeefyV1` internal flow (summary)**

1. Decode **`BeefyConsensusState`** + proof as **`(RelayChainProof, ParachainProof)`**.
2. **`verifyMmrUpdateProof(trustedState, relay)`** → new consensus state + **`headsRoot`** (para heads root from relay path).
3. **`verifyParachainHeaderProof(headsRoot, parachain)`** → **`IntermediateState[]`** (per-parachain **`StateCommitment`** heights).

**Note:** This path attests **relay + parachain headers** for the **Hyperbridge** light-client model; a chain like **Bifrost** appears as one parachain among **`IntermediateState`s**, not as a separate `IConsensus` implementation on the EVM.

---

## 17. Two different MMRs — relay BEEFY vs Hyperbridge message MMR

Do **not** confuse these; they use the same **MMR verifier primitive** in Solidity but are **different trees** and **different purposes**.

### 1. Relay / BEEFY MMR (`BeefyV1.verifyMmrUpdateProof`)

- Part of **Polkadot relay** light-client / **BEEFY** story: relay blocks accumulate into a **relay MMR**; commitments are signed; **`RelayChainProof`** carries the update path the client checks (signatures / authority set, **MMR root** advancement).
- **Purpose:** **consensus / finality** — trust the relay snapshot so **para heads** (incl. Hyperbridge’s header) can be verified. It does **not** mean “this ISMP POST exists.”

### 2. Hyperbridge ISMP message MMR (`HandlerV1.handlePostRequests`)

- **`root`** = **`host.stateMachineCommitment(height).overlayRoot`** for the **Hyperbridge** state machine — i.e. the **`mmr_root`** from pallet-ismp’s **`ConsensusDigest`** (append-only **message** accumulator on Hyperbridge).
- **`MerkleMountainRange.VerifyProof(...)`** proves **request commitment hashes** are **leaves** in **that** MMR.
- **Purpose:** **message inclusion** for delivery — the POST is in Hyperbridge’s **message log** once the **state commitment** (from §16 / parachain path) is already trusted.

### Summary table

| | Relay BEEFY MMR | Hyperbridge message MMR |
|--|-----------------|-------------------------|
| **Where in code** | `BeefyV1`, `RelayChainProof` | `HandlerV1.handlePostRequests`, `overlayRoot` |
| **Role** | Finality + para heads | ISMP POST **membership** for relay |
| **Typical proof object** | Relay BEEFY / MMR update proof | `multiproof` + `leafCount` on `PostRequestMessage` |

**Order of operations on EVM:** update **trusted roots** via **`handleConsensus`** (incl. relay BEEFY path), then **`handlePostRequests`** proves messages against **Hyperbridge’s** message MMR.

---

*Captured from Cursor assistant session, 2025-03-21. Updated with writes + source/dest MMR model, 2026-03-21. Added §7 delivering message → `on_accept`, 2026-03-21. Added §8 `verify_membership` / proof height, 2026-03-21. Added §9 trusted roots vs consensus, 2026-03-21. Added §10 `state_root` / `overlay_root` / `mmr_root` mental model + scenarios, 2026-04-10. Added §11 child trie rationale, §12 coprocessor vs non-coprocessor, §13 trie vs MMR two paths, 2026-04-11. Added §14 `LayoutV0` vs Ethereum + verifying `StorageProof`, 2026-04-11. Added §15 EVM OptimismHost / EvmHost / HandlerV1 verification split, 2026-04-11. Added §16 `IConsensus` + BEEFY / ConsensusRouter, 2026-04-11. Added §17 two MMRs relay BEEFY vs Hyperbridge message MMR, 2026-04-11. Mirrored blog “state vs log” framing + fixed blog path to 2023-04-11 post, 2026-04-22.*
