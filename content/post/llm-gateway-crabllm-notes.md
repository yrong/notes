---
title: "LLM Gateways, Session Stickiness, and When You Actually Need One — Notes on Crabllm"
author: Ron
date: 2026-08-12T00:00:00+08:00
tags:
- ai
- llm
- gateway
- infrastructure
- prompt-caching
---

# LLM Gateways, Session Stickiness, and When You Actually Need One — Notes on Crabllm

Notes prompted by reviewing [crabllm](https://github.com/crabtalk/crabllm), a Rust LLM API
gateway that "sits between your application and LLM providers." Three questions worth working
through: how does such a gateway keep session/context sticky, why not just use a CLI agent like
claude-cli, and is a gateway really needed at all?

## What crabllm is

A stateless, OpenAI-compatible API gateway in Rust: your app speaks the OpenAI chat format to
it, and it translates/dispatches to upstream providers (OpenAI, Anthropic, Azure, Ollama,
anything OpenAI-compatible). Its pitch is essentially "LiteLLM but fast" — ~0.02ms P50
streaming overhead vs LiteLLM's ~593ms in their benchmark, 37MB memory footprint. Providers can
be added dynamically without restarts via a `crabctl` CLI. The codebase is modular crates:
`crabllm` (CLI/server startup), `crabllm-core` (config/types), `crabllm-provider` (registry +
HTTP dispatch), `crabllm-proxy` (Axum server + auth middleware).

Notably, the README mentions **no session, caching, or state mechanisms at all** — it is a pure
request/response proxy.

## How does session/context stickiness work?

The key realization: **LLM APIs are stateless by design**. There is no server-side session —
every request carries the *entire* conversation history in the `messages` array. So for
*correctness*, a gateway needs zero stickiness: any replica of the gateway, routing to any
provider, will produce a valid continuation as long as the client resends the full context.

Where stickiness *does* matter is **cost and latency, via prompt caching**:

- Providers like Anthropic cache the prefix of your prompt (prompt caching gives ~90%
  input-token discount on cache hits). But the cache lives **provider-side, keyed by
  account/prefix**. If turn 1 of a conversation goes to Anthropic and turn 2 gets routed to
  OpenAI — or even to a different Anthropic account/key — you pay full price to re-ingest the
  whole history.
- So serious gateways do **affinity routing**: consistent-hash on a user/session ID (or a
  header like `x-session-id`) so all turns of one conversation hit the same provider + same API
  key. For self-hosted backends (vLLM clusters), the fancier version is KV-cache-aware
  routing — route to the replica that already holds the KV cache for your prefix.
- Failover creates the same problem: if the primary provider goes down mid-conversation,
  retrying on the secondary works functionally but eats the cache penalty, and the two models
  may behave differently mid-conversation.

Crabllm, from what's documented, does none of this — routing appears to be per-request by
model/provider mapping. That's fine for stateless workloads, but it means a multi-turn app has
to pin its own provider choice if it wants cache hits.

## Why not just use claude-cli / agent CLIs?

They solve different problems for different consumers:

- **CLI tools (Claude Code, codex-style agent CLIs)** are *clients* — a human developer or an
  agent loop driving one conversation, with credentials on the local machine. The CLI itself
  holds the conversation state and calls one provider directly.
- **A gateway** serves *applications and teams*: dozens of services or tenants making
  programmatic calls. What it centralizes is the operational layer that a CLI can't give you:
  - one place to hold provider API keys (services get gateway-issued virtual keys instead of
    raw provider keys),
  - per-team rate limits, budgets, and cost attribution,
  - failover/retries and load-balancing across providers or accounts,
  - model routing ("gpt-4o" → actually Claude, swap providers without redeploying every
    service),
  - uniform logging/metrics for compliance and debugging.

You could even run a CLI agent *through* a gateway (e.g. pointing its base URL at one) — they
compose rather than compete.

## Is the gateway really needed?

Honest answer: **it depends entirely on scale**.

- **Solo dev / one app / one provider**: no. It's an extra network hop, an extra thing to
  deploy, and provider SDKs already handle retries. Calling Anthropic/OpenAI directly is
  simpler and you keep native features (prompt caching control, beta headers, provider-specific
  params) without worrying about what the gateway's translation layer supports.
- **Platform/infra team with many internal consumers**: yes, this is a real category — key
  custody, cost control, and provider abstraction genuinely hurt without one, which is why
  LiteLLM, Portkey, Kong AI Gateway, OpenRouter, and Cloudflare AI Gateway all exist.

Crabllm's specific angle is performance: LiteLLM (Python) adding half a second of proxy latency
per streaming request is a real complaint, and a Rust proxy at ~0.02ms overhead addresses it.
The trade-off is maturity — LiteLLM's moat is breadth (100+ providers, cost tracking, caching,
guardrails), and crabllm currently looks like a thin, fast core without that operational
feature set. So: real niche, but only compelling once you actually have gateway-shaped
problems.

## Caveat: translation layers are lossy

An "OpenAI-compatible" facade is a lowest-common-denominator. Anthropic-specific capabilities
(cache-control breakpoints, extended thinking params, etc.) often don't map cleanly, so heavy
users of one provider's features sometimes bypass the gateway for exactly the workloads where
caching and stickiness matter most — which loops back to the stickiness question: the
conversations that most need cache-affinity routing are the ones a generic gateway serves
worst.
