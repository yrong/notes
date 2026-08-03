---
title: "The Modern AI Stack in 2026 — Notes & a Learning Path"
author: Ron
date: 2026-08-03T00:00:00+08:00
tags:
- ai
- llm
- rag
- agents
- learning
---

# The Modern AI Stack in 2026 — Notes & a Learning Path

Notes prompted by a [LinkedIn post](https://www.linkedin.com/posts/usman-shahbaz71_the-modern-ai-stack-in-2026-everyone-wants-share-7486257712645877760-7N7m/)
that lays out a seven-layer "modern AI stack." The layering is a fine orientation map, but the picture is
really the 2023–2024 RAG-era stack with a 2026 label. Below: what the post says, where it falls short, and a
better incremental learning path.

## The post's seven layers

1. **LLMs (the brain)** — GPT-4o, Claude, Gemini, Llama, Qwen, DeepSeek, Mistral, Phi. Pick by priority:
   reasoning, speed, cost, coding.
2. **AI frameworks (the orchestrator)** — LangChain, LlamaIndex, Haystack, TxtAI. Wire LLMs into workflows,
   agents, and RAG pipelines.
3. **Vector databases (long-term memory)** — Pinecone, Chroma, Qdrant, Milvus, Weaviate, OpenSearch,
   Postgres + pgvector. Store embeddings for semantic search.
4. **Data extraction** — Crawl4AI, FireCrawl, Docling, LlamaParse, MegaParser, ScrapeGraphAI. Clean,
   structured input.
5. **Open LLM access** — Ollama, Hugging Face, Groq, Together AI. Local dev and self-hosting.
6. **Embedding models** — OpenAI, Voyage AI, Google, Cohere, Nomic, SBERT. Text → vectors.
7. **Evaluation** — Ragas, TruLens, Giskard. Measure reliability before production.

Core argument: knowing all seven layers is what separates "AI engineers" from "AI enthusiasts."

## Where it feels dated or incomplete for 2026

- **No agent layer.** The biggest shift since that stack was canonical. Missing: tool use / function calling,
  MCP as the interoperability standard, agent runtimes and harnesses, computer-use style workflows. In 2026
  that's arguably the center of the stack, not an optional extra.
- **GPT-4o as a flagship** is a tell that the content is recycled from ~2024.
- **Vector DB + RAG as "long-term memory" is now only one pattern.** Much production work has moved toward
  agentic search, hybrid retrieval, and context engineering rather than embed-everything pipelines.
- **No observability / guardrails layer.** Tracing and evals-in-production (LangSmith, Langfuse, …) are more
  essential than one-off pre-launch eval tools.
- **Nothing on serving / inference infra** (vLLM, TGI) or fine-tuning — which matter the moment you actually
  self-host the open models it recommends.

Missing eighth and ninth layers, in short: **agents + MCP** and **observability**.

## A better learning path: build incrementally

Rather than learning all layers at once, build a working system and add one layer at a time. Each step
solves a pain the previous step created — that motivation-by-friction sticks far better than memorizing tool
categories, and the ordering follows the natural dependency chain.

**LLM → structured outputs → a tiny eval harness → retrieval → monitoring → (later) agents & tool use**

- **LLM** — a bare API call. Feel it hallucinate.
- **Structured outputs** — make the model return typed/JSON output you can act on.
- **Tiny eval harness (moved early, on purpose)** — a dozen example inputs with expected outputs in a script
  is enough. Without it, every later step is you guessing whether a change helped. Grow it alongside
  everything after it; it doesn't need to be Ragas/TruLens to start.
- **Retrieval** — add a vector DB because the bare LLM got facts wrong. Now you understand *why* retrieval
  exists.
- **Monitoring** — trace and measure once you have a pipeline worth watching.
- **Agents & tool use (dedicated later step)** — a different mental model: the LLM deciding *what to do*, not
  just *what to say*. Worth its own step once retrieval feels comfortable; adding it upfront overloads the
  early stages.

The one gap this path shares with the original post is agents — so it's called out explicitly as the final,
deliberate step rather than left out.
