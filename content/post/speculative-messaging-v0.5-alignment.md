---
title: "v0.5 alignment — foundation vs speculative-messaging-design"
author: Ron
date: 2026-07-25T03:20:00+08:00
tags:
- polkadot
- parachain
- speculative-messaging
---

# v0.5 alignment — foundation vs `speculative-messaging-design.md` v0.5

Working note on aligning `rk-spec-msg-*` (my primitives + relay branches) with the v0.5 design and
lexnv's `spec-msg-poc-mvp` E2E PoC. This is the reconciliation / decision log; for the **as-built PoC component
reference** (the end-to-end loop, deep-dives, sub-issue status) see
[Implementation Design](speculative-messaging-impl-design.md); for **code-analysis deep-dives** (how the PoC
works internally, by [#12531](https://github.com/paritytech/polkadot-sdk/issues/12531) work stream) see
[PoC Internals](speculative-messaging-poc-internals.md). Condensed; the full blow-by-blow (worked
examples, Q&A, superseded drafts) is at [`docs/working/speculative-messaging-v0.5-alignment.full.md`](../../docs/working/speculative-messaging-v0.5-alignment.full.md) (git-tracked working log, not published by Quartz).

## v0.5 in brief

Root-hash-only commitments return (reverting 0.3's flat sets): relay state is a fixed-size ring of recent
`StreamsRoot`s per sender; the structured `StreamId` replaces the plain destination `ParaId`; channels are
unidirectional with flow control via a lossy per-channel `Register`; lossy broadcast/private streams exist.
**Requires** is unified into one path: blocks emit no `Requires` and never see a `StreamsRoot` — they record
per touched stream an `Interval` (consumption start/end); the `validate_block` wrapper stitches intervals
across the bundle and synthesizes the candidate's entries via one POV-carried lift per stream. Authoring
targets the newest root at its tier; the relay window is pipeline slack. Fetch = root-keyed request pairs,
every response independently verifiable against a requester-named root. Lift-serving bounded ~25 h.

## Core mechanics (the design model)

- **The lift = `extension` + `tree_proof`.** A stream's consumption endpoint (an `MmrFrontier`) is bridged
  *forward* to the sender's **current** committed stream root by an `MMRExtensionProof`, then walked up to a
  `StreamsRoot` by a keyed-trie `tree_proof`. It binds to the *current* root (ring head), never the old
  boundary root — that's why it's "in the window by construction."
- **Where it runs.** `build_requires` synthesizes the candidate's `Requires` in the **PVF**
  (`validate_block` wrapper), not the STF — from the authoritative `ConsumptionRecord` (STF output) plus the
  untrusted POV-carried `RequiresLift`s. The block body carries no `Requires`; POV-carried so the
  resubmission/bundling cases work (the boundary root may never have been committed).
- **`StreamsRoot`.** A keyed binary Patricia trie over `(StreamId, current stream root)` for **every active
  stream**, committed once per block (header digest `SPMS_ENGINE_ID`; also in `paras::Heads`). Empty streams
  are omitted (an empty MMR has no root). One `Requires` entry per **source** — multiple streams from one
  sender collapse to that source's one `StreamsRoot`.
- **Channels.** A data stream `Channel{recipient,domain,num}` + an `Ack` register stream (lossy,
  latest-wins) carrying acceptance / advisory credit / watermark / close. `recipient` always names the
  **reader**. A channel's two halves live on **opposite chains**. Delivery is **receiver-pull**: B fills its
  own inherent from A's outbox; A never pushes.
- **`stitch` / intervals / advances.** A candidate can bundle several blocks; each contributes an `Interval`.
  `stitch` collapses the chain — consecutive intervals must chain (`next.start == prev.end.root()`) or a POV
  `advance` (extension) proves the gap is a forward extension. `advances` appear only when a fresher root was
  read mid-bundle. It's a soundness guard: a mispaired/forged chain can't fold to the committed root.
- **Trust boundary.** The record is authoritative (STF output — consumption can't be hidden); lifts are
  untrusted POV data, verified against the record's key + a committed root. Faked sender data can't reproduce
  a committed root (domain-tagged hashing); a mispaired lift can't verify (the `tree_proof` binds the key).

## Relay-side matching (#12349) — as built on `rk-spec-msg-relay`

- **One piece of state:** `RecentProvides: StorageMap<ParaId, BoundedVec<StreamsRoot, ConstU32<128>>>` — a
  bare per-sender ring. `record_provides` at `enact_candidate` (from `ump_signals().provides()`);
  `requires_satisfied` is membership against the window.
- **Two hooks:** `paras_inherent::check_speculative_messaging` in `sanitize_backed_candidates` (drop a
  candidate whose `Requires` aren't in the source's window); `inclusion` records `Provides` at enactment.
- **Reverts:** no explicit eviction — `RecentProvides` rolls back with the node's state-revert like any
  storage. **Exception:** the freeze + `force_unfreeze` path *does* need eviction (the earlier "fully
  redundant" claim was too strong).
- **Deliberate subset:** only the conservative **inclusion tier** is built; the speculative/optimistic tiers
  (the latency win, virtual-window + atomic enactment) are not. The feature-bit gate was removed
  (release-first) — processing is now unconditional; a candidate carrying no `Requires` short-circuits.

## Node / client (lexnv PoC) review

- **Module map** (`cumulus/client/spec-msg/src`): `archive` (sender store + serving), `authoring`
  (inherent/lift build), `exchange`/`fetch`/`protocol`/`pool`/`peers`/`nodes`, `monitor`, `verify`, `worker`.
- **Two consumption flows:** register read (watermark-driven, lossy head) vs channel read (frontier-driven,
  ordered). Don't conflate — they retain and lift differently.
- **`ChannelLedger` + `channel_lift`:** a verified contiguous pooled run `[base, end)` per stream, with
  `leaves` kept even after payloads are handed to the inherent (lifts generate extensions from hashes, not
  payloads) and a `binding` re-bound under the newest included root each round. The pool holds more than a
  block consumes (partial consumption is routine). Huge-backlog limit: fetch resumes, consumption is
  all-or-nothing (the streaming branch is a dormant hook).
- **#12593 `SpeculationStore`:** lexnv covers it with a dedicated store, not offchain-indexing.

## Retention — final model (supersedes the whole earlier thread)

**Two axes, don't conflate them.** The archiver has an *append/head* trigger (when a block's sends become
serveable — stays **best-block**; the only part that bears on delivery latency, and it is *not* touched) and
a *prune/tail* floor (how long stale data resides — pure retention, **zero latency impact**). This model
governs the **tail only**.

**Why the append trigger MUST stay best-block (not finalized).** Tempting to key `archive_best_block` off the
parachain's *finalized* head instead — it's reorg-free, so `rewind_to` disappears. But it breaks the feature,
and the reason is factual, not philosophical:

- A parachain has **no finality of its own**. `finalized_head_stream_worker` (`parachain_consensus.rs`)
  streams `finalized_heads` *from the relay chain* and calls `parachain.finalize_block(...)` — the parachain
  finalized head **is** the relay's GRANDPA-finalized head. So "archive finalized" ≡ "wait for relay
  finality"; there is no faster parachain-local finality to key off.
- `RecentProvides` is populated at **inclusion** (`record_provides` in `enact_candidate`), so a sender root is
  liftable — and receivers consume under it — throughout the **inclusion → relay-finality** window.
- The sender archive is the receiver's **fetch endpoint**; the append trigger *defines which roots are
  fetchable*. A finalized-only archive, by construction, lacks the included-but-unfinalized roots — exactly
  the liftable ones. A receiver fetching under liftable `R` gets `UnknownRoot` until `R` finalizes ⇒ it cannot
  consume `R` speculatively. That reintroduces the sender-side inclusion→finality wait the feature removes.

So finalized-archiving removes `rewind_to` precisely *by* dropping the ability to serve liftable roots — the
one thing the archive must serve. `rewind_to` is the price of best-block serving (tested, and bounded: reorgs
are shallow, the floor is the recent watermark, so a rewind never crosses it). **If the real goal is a
reorg-free durable store** (not latency): persist to aux only up to the **finalized prefix** (on-disk state
never reorgs, `rewind_to` never touches disk) and serve the short **unfinalized tail from the in-memory best
chain**, rebuilt trivially on reorg from blocks already in the client DB. Reorg handling then shrinks to
"recompute a tiny in-memory tail," and liftable-root serving is preserved.

**Finality rejected as the floor — and why that doesn't contradict the receiver-pool pruner (45b9d46).** The
receiver pool *does* prune on finality (Tier 1/Tier 2), the sender archive does *not*, and both are correct —
it is not a symmetry break, it's two different jobs. The one rule they share: **act on best-block, prune
conservatively.** Neither gates the *speculative* path (fetch / consume / serve) on finality; they diverge only
on what sets the *prune* floor, and that divergence is forced by structure:

| | receiver pool | sender archive |
|---|---|---|
| what it holds | payloads it consumed on **its own** competing branches | its best chain's sends, served to other chains |
| reorg model | retains across branches (a consuming ancestor may reorg away) | tracks **one** chain, `rewind_to`s on reorg — no cross-branch retention |
| prune floor | **finality** — the "no fork descends below here" line, so a consumed payload is truly dead (45b9d46's own words: *"No live fork descends below a finalized block, so trimmed payloads can never be handed again"*) | **watermark + credit / keep-latest** — resume-depth of a live receiver; finality is the wrong quantity (and wrong unit: provides-emissions, not blocks) |
| serves anyone? | **no** — local consumption state, fetched by nobody | **yes** — the receiver's fetch endpoint |

The clincher is the last row: the argument that pins the sender's *append* trigger to best-block ("must serve
liftable = unfinalized roots") **doesn't apply to the pool at all** — a local pool has no liftable roots to
fail to serve. So finality is right for the receiver (its retained thing is its own reorg horizon) and wrong
for the sender (whose retained thing is live-receiver resume depth, and whose append must serve unfinalized
liftable roots). The sender model was *derived by contrast* with the pool's finality-pruning, not against it.

**Retention needs no independent horizon — it falls out of the channel protocol.** The earlier drafts
(wall-clock 25 h horizon, then a count-based `window_floor` over the last N distinct roots) were both plugging
a hole the v0.5 flow-control already closes. The stream kinds split cleanly, and neither branch needs a ring:

- **Channel** (`stream_id.rs:82`: *"ordered, flow-controlled, guaranteed-delivery"*) → **`floor = watermark`**
  (`Register.up_to`, the peer's confirmed-consumption point). The unconfirmed span `[watermark..head]` is
  bounded **by the credit window itself**: the sender tracks outstanding credit to decide whether it may send
  (`WindowGrant { max_messages, max_bytes, .. }`), so `head ≤ up_to + window` by construction. A stall freezes
  `up_to`, the sender exhausts the window and **stops** (guaranteed-delivery ⇒ can't drop; flow-controlled ⇒
  can't exceed). Retention is capped by the negotiated window, no horizon.
- **Ack / Broadcast / Private** (`stream_id.rs:92,103`: *"lossy … latest-wins"*) → **`floor = head-1`** (keep
  only the latest). This isn't a carve-out bolted onto a horizon — keep-latest **is** the lossy-latest-wins
  contract. Bounded at one message.

So `floor(stream)` = `watermark` for Channels, `head-1` for lossy kinds. **No `window_floor`, no distinct-root
counting, no `RecentProvides`-ring coupling, no wall clock, no config.** The entire liftability/ring apparatus
drops out of retention — it belongs to the relay's `Requires`-match tolerance, a separate concern. Prune
payload **and** leaf hash together below the floor; deterministic → reproducible.

- **Why the horizon *looked* necessary.** The flow-control commit (`341754c5`) states window accounting is
  **"Deferred to the pallet"** — the PoC has no credit enforcement, so its sender retention really is
  unbounded, and the 25 h horizon (and my count-based `window_floor` replacement) was plugging exactly that.
  **The horizon is a stand-in for flow-control that isn't wired yet**, not a permanent mechanism; once the
  pallet's window accounting lands it is *deleted*, not replaced. → **ordering dependency** (see plan).
- **Consumption correctness is independent of all this.** Roots are cumulative (the head frontier is a
  superset of every earlier root's), so a receiver always fetches/consumes under the **head** and re-anchors
  to it if a staler root was pruned — a *retry, not a failure*. Aggressive tail-pruning never blocks
  consumption; it only costs an occasional re-anchor. So the floor can be as tight as the two rules above.
- **Two caveats, neither a reason to reintroduce `window_floor`:** (1) `WindowGrant` is documented
  *"advisory"* — the bound is self-enforced (a sender honoring its own window is bounded; one that over-sends
  only OOMs *itself*); a trivial per-channel "max outstanding" cap covers the defensive case, no ring. (2) A
  receiver that grants credit then vanishes pins `window`-worth until the channel **closes** (`Register.closed`)
  / times out — bounded, released by channel *lifecycle*, not retention windowing.
- One deliberate policy change: below-watermark lift material is no longer served (consumption is always above
  the watermark) — automatic from the single floor.
- **PoC defect to raise:** lexnv's `archive.rs` over-prunes channel **payloads** at the hardcoded 25 h horizon
  (a `const`, non-deterministic, not operator-tunable), foreclosing > 25 h catch-up that recomputation from
  frontier would allow. The real fix is flow-control-bounded retention, not a tunable horizon.

> _Moved to [PoC internals](speculative-messaging-poc-internals.md): the **two-tier prune (as-built)** deep-dive (#12707 node/client)._

### Implementation plan — retention = watermark (Channels) / keep-latest (lossy), delete the horizon

Delete the wall-clock horizon outright and let the floor fall out of the stream kind. No `window_floor`, no
distinct-root walk, no boundary ring, no `RecentProvides` reference in the archive.

1. **`StreamState` (archive.rs:141):** collapse `payload_floor: u64` + `floor: MmrFrontier` into one
   `floor: MmrFrontier`. Below `floor.leaf_count`, **both** payload and leaf hash are gone; the floor
   frontier's peaks still tile the pruned prefix for proofs (mechanism unchanged).
2. **Floor rule (per kind):**
   - `Channel` → `floor = watermark` = `Register.up_to` from the `out_channels()` register view (the existing
     `prune_payloads(below)` input, now driving **both** payload *and* leaf pruning).
   - `Ack`/`Broadcast`/`Private` → `floor = head-1` (keep-latest), independent of any register.
3. **Delete the horizon apparatus:** remove `prune_horizon`, `archived_at` (the `Boundary` field), `now_secs`,
   `SERVING_HORIZON`, `import_block_at`'s timestamp param, and the 24 h/10 MiB config.
4. **Boundary pruning follows the floor:** prune boundaries below the oldest retained leaf (`min` per-stream
   `floor`'s block) — a boundary only resolves roots serveable from retained leaves, so it prunes *with* the
   leaves at no extra rule. Channel span `[watermark-block .. head]` (credit-bounded); lossy kinds 1–2. No
   separate boundary ring.
5. **Merge the prune methods:** fold `prune_payloads` + `prune_horizon` into one `prune(stream, floor)` that
   drops payload+leaf together below `floor` and advances the floor frontier (`frontier_at`).
   `ServeError::PayloadsPruned`/`BelowHorizon` collapse into one `BelowFloor`.
6. **Worker (`worker.rs`):** drop the `prune_horizon(now − SERVING_HORIZON)` call + `SERVING_HORIZON` import;
   drive `prune` per Channel from the `out_channels()` register `up_to`, per lossy stream from `head-1`.

**Ordering dependency (do not land naked before flow-control).** The credit bound relies on pallet-side window
accounting, which commit `341754c5` marks *"Deferred to the pallet."* Removing the horizon *before* that lands
would drop the crude bound with nothing enforcing the window ⇒ a truly-stalled channel regrows unbounded.
Options: **(a)** land this refactor *with/after* the pallet window accounting; or **(b)** keep an interim
trivial per-channel *max-outstanding* cap (caveat 1 above) as the bound until credit is enforced — still no
ring, no distinct roots.

**Safety to assert + test:**
- **Watermark safety (Channels):** the floor never prunes unconsumed data — prune at `up_to`, re-serve
  `[up_to..head]`.
- **Credit bound (Channels):** with window accounting, `[watermark..head] ≤ granted window` even under a
  frozen `up_to` — a stalled-receiver test asserting retention *plateaus* at the window, not grows.
- **Keep-latest (lossy):** an idle `Broadcast` retains exactly its head; a below-head request fails
  `BelowFloor`.

**Win:** retention is a pure function of the channel protocol (credit + kind) — no wall clock, no ring, no
distinct-root counting, no horizon config. One floor, deterministic; the #12699 over-prune defect is *deleted*
rather than re-tuned, and the whole `window_floor`/liftability machinery (with its sparse-sender subtlety) is
gone.

> _Moved to [PoC internals](speculative-messaging-poc-internals.md): **commitment-tree storage** (#12708 parachain) and **the verified pool** (#12707 node/client)._

## DHT peer discovery (`ron/spec-msg-dht-discovery`) — implemented, E2E green ([PR #12736](https://github.com/paritytech/polkadot-sdk/pull/12736))

Cross-parachain peer discovery over the relay DHT, driven purely by on-chain `set_source_genesis` — no static
peer list, no restart. `spec_msg_penpal_xcm_delivery` passes end-to-end over discovered peers.

- **Reuse `cumulus/client/bootnodes`** (RFC-0008 `/paranode`), not a bespoke Kademlia — take the relay-side
  discovery (`get_providers` on the relay DHT + the `/paranode` request-response) via an added
  `discovered_tx` sink; keep the `add_known_address` injection (safe cross-para, makes the source dialable)
  and stream `(PeerId, addrs)` to a `PeerRegistry` (`ParaId → PeerIds` + `report_bad`).
- **Genesis is supplied up front, not discovered.** Governance `set_source_genesis(source, (genesis, fork_id))`
  on the receiver, exposed via `SpecMsgApi::source_discovery_info()`; `run_spec_msg_discovery` re-reads it each
  new best block and DHT-resolves only changed/peerless sources (5-min fallback), so a new source is picked up
  within ~1 block. `AcceptChannelOrigin`-gated, per source para, **not** wired into `accept_open_channel`
  (per-source vs per-channel cardinality argues for enforce-presence over merge).

**`/paranode` is keyed by the RELAY genesis, not each para's** — the crux, and it *corrects* the earlier
"circular / needs an RFC-0008 change" note above. `paranode_protocol_name(genesis, …)` is a formatter; every
*caller* passes the **relay** genesis: the server config (`relay-chain-inprocess-interface:409` =
`polkadot_builder.genesis_hash()`; `minimal-node:217`) and own-para discovery (`bootnodes/task.rs:124`). So
every collator on a relay registers/serves the *same* `/{relay_genesis}/paranode`. The **only** bug was the new
cross-para caller (`spec-msg/discovery.rs`) naming the request with the *source* para genesis — a protocol no
node registered → "protocol doesn't exist" → 0 peers. Fix = name it with the relay genesis (build-time-known —
a node is on a known relay); the *source* genesis is kept only to **verify** the response. No RFC-0008 change,
no genesis-agnostic protocol, no runtime registration (substrate has none — `add_request_response_protocol` is
build-time only, both libp2p and litep2p).

**The flow** — relay-network transport → parachain p2p info; `para_id` targets, `relay_genesis` names, source
genesis verifies:

1. `get_providers(epoch_key = f(source para_id, epoch))` on the **relay** DHT → the source collator's
   relay-side `PeerId` (`bootnodes/discovery.rs:180`, `handle_providers:243`).
2. `start_request(peer, /{relay_genesis}/paranode, source para_id payload)` over the **relay** network
   (`discovery.rs:231`). The source's advertisement handler replies with its **own parachain** `peer_id` +
   `addrs` (+ `genesis`), keyed off the request `para_id` (not the protocol name) — `advertisement.rs:399`.
3. Verify `response.genesis == source genesis` (`discovery.rs:322`) → return via `discovered_tx` (`:384`, the
   spec-msg seam) + `add_known_address` so the exchange transport dials for `/spec-msg/exchange` (`:388`).

**Two networks — why `/paranode` is needed at all.** The whole dance crosses from the *relay* libp2p network to
the *parachain* one; they have separate PeerIds and separate addresses.

- The provider record (`start_providing`, `advertisement.rs:250`) publishes only the collator's **relay-side**
  PeerId under `epoch_key = para_id ‖ epoch randomness` (`advertisement.rs:160`). It carries **no** parachain
  address — a relay provider record never can.
- `get_providers` returns that relay PeerId; its **relay** address is *already* resolvable, because Kademlia
  learned it while walking the DHT to find the key. So `start_request(… TryConnect)` (`discovery.rs:231`) dials
  it over the relay network with no extra lookup — `/paranode` is **not** for fetching the relay address.
- `/paranode` exists to obtain the collator's **parachain-side** `peer_id` + `addrs` — a different network the
  relay DHT knows nothing about, and precisely where `/spec-msg/exchange` lives. That response is the address
  you actually dial.

```
get_providers(epoch_key)  → relay PeerId       (relay addr already known → dialable)
      │ send /paranode  OVER the relay network  (this hop needs no extra address)
      ▼
/paranode response        → parachain peer_id + addrs   ← the address you needed
      ▼ dial for /spec-msg/exchange
```

**Two callers of the same `BootnodeDiscovery`** — the `discovered_tx: None` vs `Some` switch is what
distinguishes them:

| | `bootnodes/task.rs::bootnode_discovery` | `spec-msg/discovery.rs::discover` |
|---|---|---|
| Whose peers | **own** parachain | a **source/foreign** parachain |
| `para_id` / `parachain_genesis_hash` | own / own | source / **source's** (verify-only) |
| `paranode_protocol_name` | `/{relay_genesis}/paranode` | **same** (relay-keyed) |
| `discovered_tx` | **`None`** | **`Some(tx)`** → streamed to the `PeerRegistry` |
| Effect | **joins** its own para's p2p mesh (RFC-0008 bootstrap) | makes source peers dialable in the *receiver's* address book |

Same relay DHT + relay-genesis `/paranode`; only the targeted `para_id`/genesis and the `None`/`Some` sink
differ. **Terminology:** own = genuine *bootstrap* (the node **joins** its own mesh). Foreign is *not* bootstrap
— it's cross-para **peer discovery**: the receiver never joins the source's network, it just learns the source
peers' addresses and opens a **point-to-point `/spec-msg/exchange`** RPC to them (registered on the *receiver's*
parachain network; dialing is by multiaddr).

- **Relay `fork_id`** is part of the name too (`/{relay_genesis}/{fork_id}/paranode`); plumbed from the relay
  chain spec to match the server (`None` for every current relay).
- **Same-para (RFC-0008) discovery untouched** — `/paranode` name, server, own-para client, relay builders all
  unchanged. Cross-para is additive and spec-msg-scoped; a non-spec-msg node sees no change. The `/paranode`
  server already responds about *itself* to any caller whose request `para_id` matches, so no server change.
- **Works because collators are on the relay DHT** — inherent to collators (embedded in-process relay *or*
  external-RPC minimal node; both register `/paranode`). Prerequisite: the source has `embedded_dht_bootnode`
  on (default) so it advertises. MVP relies on the ~20 bootnode-advertised peers; expanding past them is a
  follow-up. Earlier thread: #12595.

**Deployment caveat — source reachability (no new requirement beyond RFC-0008).** libp2p is a global overlay,
not a shared subnet: peers dial *advertised multiaddrs*, so cross-para discovery is the *same* problem as a
parachain's own collators finding each other, keyed by a different `para_id`. The reachability burden falls
entirely on the **source** (the receiver dials outbound for both `/paranode` and `/spec-msg/exchange`, so a
NAT'd receiver is fine). A source must be inbound-reachable **twice**: on its **relay** identity (to receive
`/paranode` at all) and on its advertised **parachain** address (to accept `/spec-msg/exchange`). The
advertised set is reachability-filtered — `public_addresses` (`--public-addr`) → **global** listen/external
addresses → non-global **only if** `--advertise-non-global-ips` (default off) — `advertisement.rs:304-374`. So:

- **Rule:** a parachain that wants to be a spec-msg source must run **≥1 publicly-reachable collator
  advertising a global parachain address** (`--public-addr`, or a port-forwarded node that learns its external
  address via `identify`). This is exactly the practice that already puts a node in the chainspec `bootNodes`.
- **Private/VPN colocation** (paras in one operator's network): `--advertise-non-global-ips` shares the private
  addresses; reachable because both ends share the fabric.
- **Symmetric NAT, no forwarding:** genuinely unreachable — substrate leans on public addresses + `identify`,
  **not** reliable hole-punching (no DCUtR/relay-circuit path). Such a node can still collate but **cannot be a
  source**. No new constraint spec-msg imposes — identical to being a functional parachain/chainspec bootnode.

### Healthy peer set "beyond the ~20" — follow-up design (`cumulus-client-bootnodes` dig)

lexnv wants a client-side mechanism to *maintain a healthy set of SpecMsg-capable peers* beyond the ~20,
**before** MVP release (#12595). Dug into `cumulus-client-bootnodes` to find the right shape:

- **`BootnodeDiscovery` is a bootstrap-*once* finder, not a peer-set manager.** Module doc `discovery.rs:20-33`:
  find providers → `/paranode` each → inject → retry after 30s (`RETRY_DELAY`) only *if nothing found*; on
  success the own-para task parks on `pending()`. No liveness, refresh, or expansion. → the new mechanism is a
  **different lifecycle**, so it's a **new service**, not an extension of `BootnodeDiscovery` (matches lexnv's
  "new one" instinct, for a lifecycle reason).
- **The ~20 cap is inherent + not in the crate** — it's the relay DHT's Kademlia *K*,
  `DEFAULT_KADEMLIA_REPLICATION_FACTOR = 20` (`discovery.rs:103`). `get_providers(epoch_key)` walks toward the
  key and collects provider records from the ~20 *closest nodes to the key*, so ~20 is the effective ceiling a
  single query reliably surfaces — lexnv's "~20" is exact, not hand-wavy. Two refinements: (a) it's
  **`min(advertisers, ~20)`, not "all collators"** — a provider record exists only for collators running the
  RFC-0008 advertiser (`embedded_dht_bootnode` → `start_providing`), so the discoverable population = the
  parachain's *advertised bootnodes*, often a **handful (< 20)** for an MVP para; (b) the cap is **K-closeness,
  not a truncate-to-20** — 50 advertising collators would still only surface ~K per query (the walk terminates at
  the K closest), so you can't just "query harder." That structural K-bound is *the* reason a set beyond ~20
  needs a different mechanism (Tier 2 wire change or joining the source's DHT), not more DHT queries. Correctly
  scoped, though: `epoch_key = para_id ++ randomness`, so providers are all for *that* parachain — no cross-para
  mixing.
- **The `/paranode` wire can't carry a peer list yet** — `Response = { peer_id, addrs, genesis_hash, fork_id }`
  (`schema/response.proto`), `MAX_RESPONSE_SIZE = 16 KiB`.
- **Toolbox on `NetworkService`:** `get_providers`, `find_closest_peers` (FIND_NODE, already used narrowly at
  `discovery.rs:302` for address resolution), `get_value`/`store_record`, and **`network_state()`**
  (`traits.rs:339`) — a node *can* enumerate its own parachain peers.

**Two tiers** (a new service in `cumulus-client-bootnodes`, on master, spec-msg-independent, seeded via the
`discovered_tx` seam #12736 added):

- **Tier 1 — healthy-set management, no wire change.** Continuous manager: periodically re-seed via
  `BootnodeDiscovery`, **liveness-probe** each peer (pluggable capability callback — spec-msg injects a
  `/spec-msg/exchange` probe, core stays generic), prune dead/incapable, backfill to keep N healthy. Subsumes
  #12736's `PeerRegistry` + `report_bad`. For an MVP parachain with ≤~20 nodes this *is* "a healthy set".
- **Tier 2 — get *beyond* the closest-K (two routes, two problems).** The ceiling is structural (Kademlia
  closest-K + only `embedded_dht_bootnode` advertisers publish), so you can't query harder. But the **sharp
  failure** is worse than "set too small": `get_providers(epoch_key)` returns a bounded, roughly-deterministic
  subset that can **exclude the serving collators entirely** — e.g. 50 collators, only 10 serve SpecMsg, none in
  the returned ~20 → re-resolve hands back the same useless set → **starvation** (reactive `report_bad` just
  cycles the dead 20). Two complementary fixes:
  - **Route A (primary — the serving-subset-missed case) — capability-scoped provider key.** Root cause: *all*
    collators advertise under one key `epoch_key = hash(para_id ++ randomness)` (discovery.rs:155,
    advertisement.rs:160), so the serving subset is diluted in the 50-strong provider set. **Un-mix them:**
    serving collators *also* `start_providing(spec_msg_key)` where `spec_msg_key = hash(para_id ++ "spec-msg/v1"
    ++ randomness)` (a variant of `epoch_key`, gated by a serves-SpecMsg flag); the receiver
    `get_providers(spec_msg_key)` → the serving set **directly** (the ~K cap now bounds the *serving* set, which
    fits). **No `/paranode` proto change, no new trust surface** — the discoverer still genesis-verifies each
    provider, and a non-serving squatter is caught by `report_bad` (same trust model as base RFC-0008). Change =
    the key variant + advertiser opt-in (`advertisement.rs`, reuse the current/next epoch rotation) + a second
    `get_providers` in `source-discovery` → same `PeerRegistry` via `discovered_tx` (consumer unchanged). Still
    an **RFC-0008 extension** — but only a *namespace convention*, **not** a relay change: **validated no key
    whitelist** — `start_providing`/`get_providers` take any `RecordKey` (discovery.rs:500/518, service.rs:951)
    and the inbound handler (discovery.rs:941) never discriminates by key, so `spec_msg_key` travels the
    identical path as `epoch_key`. (Subtlety to spike, not a blocker: the relay sets `StoreInserts::FilterBoth`
    and the libp2p backend drops inbound `AddProvider` at discovery.rs:952, so provider resolution likely works
    via *self-provide* — key-agnostic, so whatever resolves `epoch_key` resolves `spec_msg_key`; confirm on a
    devnet.) So it's **client-side only** (advertiser: one extra `start_providing`; discoverer: one extra
    `get_providers`). Smaller + cleaner than PEX for this case, and directly targets the missed-subset failure.
  - **Route B — peer-exchange (PEX), for the ≫K-*serving* case.** When more than ~K collators serve SpecMsg and
    you want beyond 20: keep the DHT as the *seed* and add peer-*exchange* as the expansion — an optional
    `repeated bytes peers = 5` field on the `/paranode` `Response` (currently `{ peer_id, addrs, genesis_hash,
    fork_id }`, proto2), filled from `network_state()` with a **bounded, rate-limited** sample of the responder's
    live parachain peers (capped by `MAX_RESPONSE_SIZE = 16 KiB`); the manager fans out — dial → `/paranode` →
    verify genesis → repeat — into the **same `PeerRegistry`** via `discovered_tx`. Proto2-optional ⇒
    wire-backward-compatible, **but a heavier semantic RFC-0008 change**: `/paranode` goes from "ask a node for
    *itself*" to "a node vouches for *others*" — adding (a) **sybil/poisoning** (returned peers are untrusted
    candidates, gated by the existing genesis-verify); (b) **amplification/DoS** (⇒ rate-limit + sample cap);
    (c) a **privacy** disclosure of one's neighbours. Also indirect for the missed-subset case (fan out from
    dead peers, then probe). (Route C — join the source's own DHT — is heavier still: foreign-network membership
    + a second discovery stack.)

  **Order:** Route A is the primary fix (direct, small, no new trust surface) for your exact case (serving
  subset missed); Route B is a further scaling expansion only once serving-count itself ≫ K. Both are
  **deferrable** past MVP — an MVP para runs ≤~20 collators, so the DHT seed already *is* the whole set — but
  the missed-subset failure is the one that would actually *starve* a fetcher, so it's the one to build first
  when it bites (gate on the registry health metric).

**Capability stays generic** via the injected probe, so the crate never depends on spec-msg. **Plan:** sketch
the Tier-1 API/module layout on a new branch off latest master (`cumulus/client/bootnodes`), spec-msg consumes
it via `discovered_tx`/registry; Tier 2 is the RFC-0008 follow-up.

**Status (built + landed).** Foundation branch `ron/parachain-peer-set` (off master): the generic
`discovered_tx` seam on `BootnodeDiscovery` + a small shared `PeerRegistry`/`SourcePeers` — `set_peers`
(replace, skip-banned) / `peers` / `report_bad` with a ban **cooldown** (not permanent, so a transient/edge-case
verification failure can't starve the set). Unit-tested (4). Consolidation branch `ron/spec-msg-consume-peerset`
(off #12736): spec-msg **deletes its duplicate `PeerRegistry`/`SourcePeers`** and consumes the generic ones;
`report_bad` now cooldown-bans; 54 spec-msg tests green. (Its `peer_set.rs` copy still carries the removed
manager — reconcile when it rebases; see below.)

**Dropped — the Tier-1 health manager (`run_parachain_peer_set` + `CapabilityProbe` + `set_candidates`).** Built,
then removed as unused (YAGNI): both consumers take the trusted `set_peers` path, and the one concrete adoption
(spec-msg) was blocked/redundant anyway — (1) `/spec-msg/exchange` **refuses unservable requests at the transport
level** (`wire.rs:177-181`, no error variant), so a *stateless* capability probe can't tell "live but no data" from
"dead" and would drop live peers; (2) a *root-aware* probe would **duplicate the fetch pipeline's reactive health**
(`fetch.rs` already rotates on transport failure + `report_bad`s on verified-bad every round). So the foundation is
now just the seam + a ban-cooldown registry. If a consumer *without* a reactive fetch loop ever needs proactive
health, the manager is re-addable, with a `/spec-msg/exchange` `Ping` as the clean stateless-probe enabler.

### Discovery slice — plan of record (land the cross-para discovery *before* the MVP)

Ship the `set_source_genesis`-driven cross-parachain discovery as its own layer on master, stacked on the
peer-set foundation, so the MVP branch lands with **only** the messaging mechanics and consumes a discovery
layer already upstream. Verified against #12736: the discovery client's *only* messaging dependency is
`SpecMsgApi::source_discovery_info()`, and the pallet slice is tiny (`SourceGenesis` storage + `set_source_genesis`
call_index 9 + `AcceptChannelOrigin` + one event) — so it extracts cleanly.

**Separate crates** (not folded into the spec-msg crate/pallet — that would force a same-crate merge when the MVP
rebases; separate crates → the MVP just *depends* on them). Layering on top of `cumulus-client-bootnodes`:

- **`cumulus-primitives-source-discovery`** — its own `SourceDiscoveryApi { fn source_discovery_info() ->
  Vec<(ParaId, (genesis, Option<fork>))> }` (NOT a method on `SpecMsgApi`, which would recouple to the MVP).
- **`cumulus-pallet-source-discovery`** — `Config::SetSourceOrigin`, `SourceGenesis` StorageMap,
  `set_source_genesis(origin, source, info: Option<..>)` (governance), `SourceGenesisSet` event, mock+tests. The
  messaging pallet never uses source genesis — only the client does — so this leaves it entirely.
- **`cumulus-client-source-discovery`** — port of #12736's `discovery.rs` (`BootnodeSourceDiscovery`,
  `run_source_discovery`); deps = bootnodes foundation + the new API + relay interface + network; populates the
  foundation's `PeerRegistry`.

**No-op guarantee (free):** `run_source_discovery` is `has_api::<SourceDiscoveryApi>`-gated *and* reads
`source_discovery_info()`; empty ⇒ nothing happens. A runtime without the pallet/API, or with it but no
`set_source_genesis` configured, behaves **byte-identically to today** — governance-gated, opt-in.

**MVP then drops:** its `SourceGenesis`/`set_source_genesis` slice, its `discovery.rs`, and the
`source_discovery_info` method on `SpecMsgApi` — shrinking to just MMR/streams/fetch/verify/XCM, consuming the
`PeerRegistry` (unchanged post-consolidation).

**Build order:** (1) primitives API · (2) pallet + tests · (3) client (port/rename/decouple) · (4) runtime+node
wiring (penpal first) · (5) a **discovery-only E2E** (`set_source_genesis` → `Discovered … count≥1` → registry
populated; no fetch → much lighter than the full spec-msg E2E). Defaults: name `source-discovery`, standalone
pallet, penpal-only wiring first. Branch: `ron/source-discovery` off `ron/parachain-peer-set`.

**Status: built + E2E green.** All five steps landed on `ron/source-discovery`. The discovery-only E2E
(`source_discovery_penpal`, dynamic subxt calls — no static codegen) spawns rococo-local + two penpals, sets
source genesis both directions via sudo, and asserts each collator logs `Discovered source peers … count≥1`
with no `/paranode doesn't exist` — **passes** (both penpals resolved `count=1` ~3½ min after spawn). Test-only
gotcha found: `wait_log_line_count_with_timeout`'s 2nd arg is `is_glob`, **not** `is_regex` — a regex pattern
needs `false` (else it full-line-globs against timestamp-prefixed lines and never matches).

### Re-found: MVP consumes the discovery layer + consume E2E — green (`ron/spec-msg-on-source-discovery`)

The acceptance test for the extraction: re-found the MVP (`ron/spec-msg-consume-peerset`) **on top of** `ron/source-discovery` so it *consumes* the standalone layer instead of carrying its own copy. Squash-merge + dedup — dropped the MVP's embedded discovery (`client/spec-msg/discovery.rs`), the `SourceGenesis`/`set_source_genesis` slice in the spec-messaging pallet, and `SpecMsgApi::source_discovery_info`; the omni-node now creates **one** `Arc<PeerRegistry>` in `spec.rs`, the `run_source_discovery` worker fills it, and it's handed to the spec-msg fetcher. The hand-off type-checks because both sides are the *same* `cumulus_client_bootnodes::PeerRegistry` (payoff of the foundation consolidation). asset-hub-westend also impl'd `SpecMsgApi` → its stale `source_discovery_info` had to be dropped too (only surfaced in the full binary build, since `cargo check` uses the fake runtime API). **Validated:** compile (full `polkadot-parachain-bin`), 52 spec-msg + 4 bootnodes unit tests, penpal metadata regen with both pallets.

**Consume E2E (`spec_msg_consume`, dynamic) — the coverage nothing else gave.** `source_discovery_penpal` proves discovery→registry but never runs the *fetcher* (no channel/messages). This focused test opens a spec-msg channel A→B + accepts on B; the handshake crosses signals both ways, so completing it *requires* both fetchers to consume the discovered peers. Asserts, on **both** collators, `Discovered source peers count≥1` **and** a non-empty `Fetch round completed source=` (the empty round renders `… (nothing new) source=`, excluded). **Green**, with the handshake asymmetry visible in the logs: penpal-a fetched b's register (`register_reads=1`), penpal-b fetched a's `OpenChannel` signal (`streams=1 leaves=1 bytes=3`). So the full chain — discovery resolves peers → the fetcher reads the shared `PeerRegistry` → fetches from those peers — is proven at runtime. (The peer set + fetch are pure client plumbing over `/spec-msg/exchange`; the only runtime API in the loop is `SourceDiscoveryApi::source_discovery_info()`, the worker's *input*.)

**Why focused-dynamic, not the static `spec_msg_penpal`.** The MVP's static-codegen E2E can't run here: (1) **subxt version drift** — the `#[subxt]` macro is zombienet-sdk's 0.44 but the workspace `subxt` is 0.50, so codegen references a mismatched `ext::subxt_core` (a `subxt = "0.44"` pin fixes *compilation* but…); (2) **metadata-hash brittleness** — subxt's static compat check is a hash comparison that build.rs-extracted metadata can't reliably match the live node's, so it fails at connect *before any test logic* (same reason `source_discovery` went dynamic). Both are pre-existing MVP-test-infra issues, orthogonal to the extraction; porting its ~900 lines (mostly re-testing *unchanged* MVP messaging + event decoding) wasn't worth it. Also fixed en route: `PeerRegistry::peers()` was `HashSet`-ordered → made insertion-ordered (`Vec`), de-flaking two order-dependent `fetch.rs` tests (fix lives in the foundation, `e5d6dbb`, so it's in #12744 too).

### Liveness of discovered peers — no proactive monitor, three passive layers

Q: with no health manager (dropped above), can a peer be alive at publish then die, and we only learn at the
next epoch (~4 h on Polkadot)? **No** — epoch cadence governs DHT *key* rotation, not the liveness of the
consumer's peer set. Three passive layers keep it live:

1. **Discovery-time filter (point-in-time).** A peer enters the set only after a *successful* `/paranode`
   request-response (`discovery.rs` `request_bootnode`, dialed `IfDisconnected::TryConnect`; emitted via
   `discovered_tx` only on reply). So `count=1` = "one collator reachable + answered `/paranode` this round",
   not "one DHT entry" — offline collators never enter.
2. **Re-resolve every 2 min** (`DISCOVERY_REFRESH_INTERVAL = 120 s`), **not** per-epoch. Full `force` re-resolve
   on the next new-best once the interval elapsed; peerless sources retried *every block*. Each `set_peers` =
   **replace** → a peer that died post-discovery is dropped within ≤2 min (won't answer the new round).
3. **Reactive eviction (seconds).** The consumer's fetch failure → `report_bad` → ban for
   `DEFAULT_BAN_COOLDOWN = 300 s`; `set_peers` skips banned. A node dying *mid-use* is dropped on the first
   failure, not waited out for the refresh.

**Timer relationships (the real invariants, not a single chain).** Two independent bounds sandwich `REFRESH`;
`BAN` vs `REFRESH` is *not* one of them:
- `REFRESH ≪ EPOCH` — liveness self-heals far faster than the DHT provider record (120 s vs ~4 h Polkadot, ~120×).
  The important one.
- `block_time ≪ BAN` — when `report_bad` empties a source (*peerless* → re-resolved **every block**), the cooldown
  is what stops the just-failed peer being re-added next block (thrash). 300 s vs ~6–12 s block.
- `BAN` and `REFRESH` are **orthogonal** (misbehavior penalty vs liveness rebuild) — deliberately *unequal* (was
  300 = 300, a mild beat: re-admission needs *both* ban-expired *and* a refresh, so exclusion was a phase-dependent
  300–600 s). `REFRESH` lowered to 120 s; `BAN` **kept at 300 s** — and `report_bad` is verified below to fire only
  on *misbehavior*, so a longer penalty is correct, decreasing it would give byzantine peers more frequent re-entry.

**`report_bad` trigger — verified against `ron/spec-msg-consume-peerset:fetch.rs`.** Fires **only on misbehavior**:
`verify_messages/event_response` `Err` (bad proof), a valid-but-empty chunk claiming a non-empty backlog (dishonest
stall), a wrong response *variant*, or `MalformedResponse`. **Transport failures never `report_bad`** — the
catch-all arm just records the error, rotates to the next peer, and the peer **stays registered** (module doc
"transport failures merely rotate"; test `transport_failures_rotate_without_dropping_the_peer`; "A transport refusal
is not misbehavior"). So a ban is always a *deserved* byzantine/protocol penalty, never a liveness signal.

**Where the epoch *does* bite (harmless):** the DHT *provider record* is epoch-stale — `get_providers(epoch_key)`
keeps returning a dead collator's relay `PeerId` until the epoch rotates (offline node stops re-advertising the
next key) or Kademlia's provider-record TTL lapses (~4 h Polkadot). But layer 1 masks it: a dead `PeerId` yields
no `/paranode` reply → never reaches the set. Cost is a wasted dial per round, not a stale peer the consumer
would try to message.

**Caveat (churn, not staleness):** because `set_peers` is a full replace, a *transient* round that times out /
resolves nothing momentarily replaces the set with empty until the next block refills it (peerless → retried
every block). DHT hiccups → brief flaps, not stale peers.

**If *proactive* health (faster/richer than the passive re-resolve) is ever wanted** (lexnv's "healthy set beyond
the ~20"): that's exactly the
dropped Tier-1 manager — reintroduce a lightweight prober, with a `/spec-msg/exchange` `Ping` as the clean
stateless-probe enabler. See "Dropped — the Tier-1 health manager" above.

## Primitives reconciliation — `rk-spec-msg-primitives` vs lexnv PoC — DONE

Aligned (identical or semantically equal): **StreamId**, **channel/flow-control types**
(`SpecMsgKind`/`Signal`/`WindowGrant`/`Register`, frozen indices), **`StreamsRoot`** trie hashing.

MMR-layer reconciled (byte-identical roots + wire-compatible proofs):

- **Domain tags** — MMR `LEAF/INNER/PEAK` renumbered `0x2/0x3/0x4 → 0x1/0x2/0x3` (matching poc-mvp). **No
  `EMPTY_TAG`**: empty streams are never committed (an empty MMR has no root), reinforced by the marker
  `OpenChannel` leaf (below), so it's dead weight; `0x1` reclaimed, `0x4` free, commitment-tree tags stay
  `0x5/0x6`. Frozen MMR vector re-pinned. *(commit `d656de2871e`)*
- **`MmrInclusionProof`** — identical struct + `verify_head`/`verify_leaf`; mine keeps a `verify_leaf`
  item-count bound (`ItemLimitExceeded`) the PoC lacks.
- **`MMRExtensionProof`** — adopted the PoC's `leaf_count` field (mmr size *derived*, so an out-of-range size
  can't be smuggled in) + `verify` shape (frontier consistency, forward, extend-from-empty), keeping my
  `MAX_EXTENSION_CONNECTING_NODES` ceiling the PoC lacks. *(commit `d656de2871e`)*
- **`TreeStep`** — dropped the redundant `target_right` (derived from the key), so a step SCALE-encodes
  byte-identically to the PoC's `(u8, Hash)`; `StreamsRoot` unchanged. *(commit `47c3400b7aa`)*

**Remaining delta (cosmetic):** `ProofError`/`VerifyError` (mine) vs `MmrError` (PoC). `ProofError` is the
better pick (avoids the `mmr_lib::Error as MmrError` collision; names "proof-verification failure"). My
response-level `VerifyError` (Proof/TreeProof/RootMismatch/UnexpectedBase/ExceedsBudget/VariantMismatch/
PayloadTooLarge/MalformedResponse) has **no PoC equivalent** — it's what the fetch subsystem needs for
peer-scoring vs retry. Convergence: PoC renames `MmrError → ProofError` + gains `VerifyError`; nothing on my
side changes.

## Empty-stream / marker leaf (design-doc gap, PR #12659)

The `StreamsRoot` commitment is inclusion-only, so you can't prove a stream is *empty* — "empty", "peer
lagging", "peer withholding" are indistinguishable, and the PoC's "tolerate cursor 0" was an attack surface.
Fix = **marker leaf**: the sender commits `OpenChannel` as the channel stream's **leaf 0 at open** — already
done in the PoC (`open_channel → send_signal(OpenChannel) → append_to_stream`). So opened channels are never
empty; cursor 0 is always provable. The PoC's cursor-0 handling is now a **sound scoped deferral** (only
`Network` error at `cursor==0 && nothing pooled`, tolerated as retry, never consumed-as-empty), covering just
the accept-before-open window. Remaining: **document the invariant in the design** (lexnv's "needs
mentioning").

## Provides "who-changed" accelerator — Vec vs Bloom vs push (design note, PR #12659 networking thread)

**Problem (lexnv).** A single `StreamsRoot` loses v0.3's per-destination granularity: a receiver can't tell *from the root* whether **its** stream moved, so `run_relay_provides_monitor` fires a fetch on **every** root change — a sender with 20 channels writing to 2 this block makes all 20 consumers fetch, 18 to discover nothing. And `/spec-msg/exchange` is request-response (no long-lived substream), so cross-para connections drop on the ~5 s keep-alive → each discovery is a fresh **dial** (~11 KiB), ×cores under elastic scaling. **#12744 doesn't help here** — discovery resolves the *address* (relay-side `/paranode`), not a warm parachain-side connection; the dial cost stands, which sharpens the case for an accelerator. Fundamental limit: you *cannot* recover per-receiver relevance from one hash (caching your leaf's sibling path fails — other streams' changes perturb your path's siblings). So the who-changed signal must come from **chain, push, or a p2p query** — no free/local trick.

**Three flavours of one thing** — a *non-authoritative* accelerator; the `StreamsRoot` stays the only authority and each needs a **periodic fallback fetch**:

- **`Provides(StreamsRoot, Vec<ParaId>)`** — exact (0 FP), variable size `4·n`, worst case `MAX_COMMITMENT_ENTRIES·4 ≈ 1 KB`.
- **`Provides(StreamsRoot, BloomFilter)`** over changed `StreamId`s — **fixed** size, no false negatives (honest sender), some false positives; degrades gracefully (broadcast-y sender → FP→1 → "everyone fetches", which is correct).
- **Off-chain push** (`/spec-msg/notif` or unsolicited `MessageResponse`) — no on-chain bytes, no polling; sender pushes, receiver verifies by the usual fetch. Subsumes "keep the connection warm" (warming needs a persistent substream anyway → then pushing beats polling). **Earns its keep with LLv2 / atomic enactment**: it's proactive *pre-inclusion* propagation, and speculatively consuming not-yet-included messages is only safe once atomic enactment makes the sender/receiver pair enact all-or-nothing. In the inclusion-tier MVP, receiver-pull off relay state fits — so push is the **post-MVP endgame**.

**Bloom mechanics.** Notation: **`m`** = filter size in bits (`256` → 32 B here), **`k`** = number of hash functions = bits set/checked per element (`4` here), **`n`** = elements inserted = streams the sender wrote this block. `StreamId` is a sparse 8-byte key, so a hash-based Bloom (not a dense bitmap) is the form. Sender sets `h₁(s)…hₖ(s) mod m` per changed stream; receiver queries its own `StreamId`(s) — **all bits set** → "maybe" → fetch, **any unset** → "definitely not" → skip (no p2p). FP `≈ (1 − e^(−kn/m))^k`.

**Sizing recommendation: `m = 256 bits (32 B)`, `k = 4`** (symmetric with the root):

| `n` (streams written/block) | 1 | 2 | 4 | 8 | 16 | 32 | 64 | 256 |
|---|---|---|---|---|---|---|---|---|
| FP (wasted-fetch prob/idle rx) | ~6e-8 | ~1e-6 | ~1e-5 | ~0.02% | ~0.24% | ~2.4% | ~16% | ~93% |

Near-exact for the common case (lexnv's motivating fan-out is ~2/block), <2.5% for a busy sender, collapses to "everyone fetches" exactly when the sender touched everyone. Bump to **64 B / k=6** only if senders routinely fan out to >32/block (pushes <1% FP to `n≈64`).

**Hashing is consensus-critical** (the filter is in the committed `Provides` signal → re-executed → must be byte-identical → `m/k/BLOOM_TAG` are protocol-**frozen**, like the leaf tags / `MAX_COMMITMENT_ENTRIES`). One domain-tagged blake2 gives all `k` positions cheaply:
```
h = blake2_256(BLOOM_TAG ++ StreamId)   // 256 bits
positions = [h[0], h[1], h[2], h[3]]     // 4 bytes → 4 positions in 0..255 (k=4, m=256)
```

**On-chain cost.** Signal = `StreamsRoot(32) + filter(32)` = **64 B fixed**; per `RecentProvides` ring slot 64 B (+ block); ring depth `W` → `W·64 B`/sender. vs `Vec`: `32 + 4n` variable, ~1 KB worst case. So Bloom bounds the slot at **64 B vs ~1 KB** (~16× tighter) — the number that actually sizes the relay ring.

**Security (ties to the `is_empty`/unverified thread).** All three are **unverified hints**: consensus validates the runtime *ran*, **not** that the `Vec`/filter is consistent with the root's streams. A malicious sender can craft an **omission** (drop your ParaId / leave your filter bits unset → false negative) to make you skip — *not* a safety break (root is authoritative + it's self-harm), but the hint must mean "skip **sooner**", never "skip **forever**": the **fallback fetch stays** regardless of `m,k`. Over-listing → one wasted fetch (bounded, throttleable). Same posture as a p2p notif ("validate by fetching").

**Recommendation.** If one-to-many (a sender with many idle channels) is in MVP scope → add the accelerator now, reach for the **Bloom (32 B / k=4 / blake2-tagged)** — fixed cost, near-zero FP where it matters, graceful, 16× tighter worst case than `Vec`. If MVP is small-fan-out A→B → **defer** (amplification negligible), with **push** as the LLv2 endgame. Either way `StreamsRoot` + fallback fetch remain the guard.

> _Moved to [PoC internals](speculative-messaging-poc-internals.md): **register republish / flow-control backstop** (#12708 parachain)._

## Issue / finding status

- **#12346 primitives (5 WS):** WS1/2/3/5 done on my branch; **WS4 (wire messages)** is the gap — I added
  `Event`/`Exchange` req-resp + `MmrInclusionProof` (the fetch pair was there). Now complete.
- **#12583** receiver `Provides` monitor — implemented; agreed redesign: runtime API + event-primary, drop
  the well-known key, newest-root-suffices (eskimor's "provides root in events?").
- **#12535** SpecMsg XCM router — implemented (separated `SpecMsgRouter`, cleaner than routing through
  `XcmpQueue`); issue still open on GitHub.
- **#12531** umbrella MVP — PR #12699 covers 7 of 8 flow steps; **discovery** is the gap (addressed by the
  DHT branch above).
- **PoC issues to file (#12699):** (1) retention — hardcoded 25 h horizon over-prunes channels, not
  operator-tunable; (2) peer discovery — static registry, no dynamic DHT. (Consolidated draft in the full
  note.)
- **Code-review replies:** the "UMP trailing-garbage bypass" reclassified to Low; malformed `ump_signals()`
  → `return true` is safe; extension-proof node size **now 32 B** (was 40 B): `connecting_nodes:
  Vec<(u64,Hash)> → Vec<Hash>`, positions derived from `(old_leaf_count, new_leaf_count)` via
  `ancestry_positions` (cross-checked vs `gen_ancestry_proof`, sweep to 64 leaves). Done on
  `rk-spec-msg-primitives` (pushed) + MVP branch; reply on #12659 r3664785341. TODO: upstream the
  derivation into `paritytech/merkle-mountain-range` as store-free `ancestry_proof_positions`.
