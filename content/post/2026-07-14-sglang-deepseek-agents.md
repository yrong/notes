---
author: Ron
date: 2026-07-14T01:00:00+08:00
tags:
- ai
- agents
- sglang
- deepseek
- inference
title: "Notes: SGLang as the inference backend for DeepSeek agents"
---

SGLang is a strong fit as the **high-throughput inference backend** under DeepSeek (R1 / V3 / V4) when you build agents that loop on tools, planning, and reflection. This note covers serving, agent control flow, and a **RadixAttention** supplement from the [Inference.net complete guide](https://inference.net/content/sglang-complete-guide/#how-radixattention-works).

<!--more-->

## TL;DR

| Layer | Role |
|-------|------|
| **SGLang runtime** | Serve DeepSeek with MLA / DeepGEMM / RadixAttention; OpenAI `/v1` + native `@function` DSL |
| **DeepSeek** | Reasoning + tool calling (R1 think tags; V3/V4 parsers) |
| **Agent loop** | Python (or LangGraph/AutoGen) owns tools; SGLang accelerates shared prefixes & structured gen |

Official DeepSeek docs recommend SGLang for V3-family inference. Agent wins come from **prefix KV reuse** (multi-turn / tool history) and **constrained decoding** (stable JSON / tool calls), not from replacing your orchestrator.

## 1. Why this stack for agents

Agent workloads are hostile to naive serving:

- Many short generations with a **growing shared prefix** (system + history + tool results)
- Need **reliable structured outputs** for tool routing
- Optional **branching** (debate, self-consistency) that shares a long common stem

SGLang’s **RadixAttention** keeps KV in a radix tree and reuses longest common prefixes across requests / forks — often several× faster on multi-turn and tree-of-thought style work versus discarding cache each call ([LMSYS intro](https://www.lmsys.org/blog/2024-01-17-sglang/)).

DeepSeek-specific engine work (MLA throughput, DeepGEMM on Hopper/Blackwell, DP-Attention, MTP/EAGLE, tool-call & reasoning parsers) is documented in [SGLang DeepSeek V3 usage](https://github.com/sgl-project/sglang/blob/main/docs/basic_usage/deepseek_v3.md) and the [DeepSeek-V4 cookbook](https://docs.sglang.io/cookbook/autoregressive/DeepSeek/DeepSeek-V4).

## 2. Serve DeepSeek with SGLang

### Small / distill (local agent lab)

```bash
python -m sglang.launch_server \
  --model-path deepseek-ai/DeepSeek-R1-Distill-Qwen-32B \
  --port 8000
```

### Full V3 / R1 (production-shaped)

Prefer official FP8 weights; do **not** pass `--quantization fp8` on the official FP8 checkpoint. Example shape for tool calling (adjust `--tp` / hardware):

```bash
python3 -m sglang.launch_server \
  --model deepseek-ai/DeepSeek-V3-0324 \
  --tp 8 \
  --port 8000 \
  --host 0.0.0.0 \
  --tool-call-parser deepseekv3 \
  --chat-template ./examples/chat_template/tool_chat_template_deepseekv3.jinja
```

**DeepGEMM:** on by default for DeepSeek V3 on NVIDIA Hopper/Blackwell; disable with `SGLANG_ENABLE_JIT_DEEPGEMM=0`. Precompile kernels if first-run latency matters:

```bash
python3 -m sglang.compile_deep_gemm --model deepseek-ai/DeepSeek-V3 --tp 8 --trust-remote-code
```

**R1 / thinking:** use `--reasoning-parser deepseek-r1` (and V4’s `deepseek-v4` parser when on V4). Optional thinking budget via custom logit processor — see the same DeepSeek usage doc.

Hardware sizing tables (H200 / B200 / MI300X / multi-node, INT8/AWQ/…) live in that doc; full Pro-class models need multi-GPU / multi-node.

## 3. Two ways to program agents

### A. Native SGLang control flow (`@function`, `gen`, `fork`)

Declarative generation inside Python: append prompts, `gen(...)` with constraints, branch with `fork`, keep ordinary `if`/`for` for tools. Good when you want compiler/interpreter-style graphs and prefix sharing inside one program ([SGLang blog](https://www.lmsys.org/blog/2024-01-17-sglang/)).

Sketch (tool route → execute → answer). Check current API for `response_format` / JSON schema kwargs — names move across versions; the pattern is **constrained gen → parse → local tool → gen again**:

```python
import json
import sglang as sgl
from sglang import function, gen
from pydantic import BaseModel, Field


class ToolCallSchema(BaseModel):
    tool_name: str = Field(
        description="One of: fetch_database, web_search, none"
    )
    query_argument: str = Field(description="Argument for the tool")


def fetch_database(query: str) -> str:
    return f"[db] sales for '{query}' grew 150% in 2026"


def web_search(query: str) -> str:
    return f"[web] trends for '{query}': SGLang + DeepSeek agents"


@function
def deepseek_agent(s, user_question: str):
    s += "You are an agent: pick a tool, then answer from tool results.\n"
    s += f"User: {user_question}\n"
    s += "Decision (JSON):\n"
    # Prefer constrained decoding (json_schema / response_format) over free text + retry
    s += gen("tool_decision", max_tokens=256, temperature=0.0)

    decision = json.loads(s["tool_decision"])
    tool, arg = decision.get("tool_name"), decision.get("query_argument")

    if tool == "fetch_database":
        result = fetch_database(arg)
    elif tool == "web_search":
        result = web_search(arg)
    else:
        result = "no tool"

    s += f"\nTool [{tool}] => {result}\n"
    s += "Final answer:\n"
    s += gen("final_answer", max_tokens=300)


backend = sgl.RuntimeEndpoint("http://localhost:8000")
state = deepseek_agent.run(
    user_question="Latest sales and tech choices?",
    backend=backend,
)
print(state.text())
```

**Agent tips**

- Tool **routing**: low temperature + schema / regex / `select`-style constraints.
- **ReAct loops**: wrap the decide→act→observe block in a Python `for` with a stop condition; each turn still hits RadixAttention on the shared prefix.
- **R1 `<think>`**: slice on `</think>` (stop / regex / reasoning parser) so control logic sees “thinking” vs “answer” separately.

### B. OpenAI-compatible `/v1` + LangGraph / AutoGen / custom ReAct

Point any OpenAI client at SGLang:

```text
base_url = http://localhost:8000/v1
```

Keep LangGraph (etc.) for graph state; SGLang only replaces the model endpoint — you still get server-side prefix cache and DeepSeek tool parsers when configured. Useful if the team already owns orchestration code ([LangGraph note](../post/2023-09-06-create-your-own-ai-agent-langgraph)).

Native **function calling** (server parses `tool_calls`): launch with `--tool-call-parser deepseekv3` (or V4’s parser) and send `tools` in the chat request — see the DeepSeek usage doc curl examples. Prefer low `temperature` for tool calls.

## 4. Advanced: fork / multi-agent debate

`fork` clones the current prompt into parallel branches (e.g. developer / tester / security). Shared prefix KV stays one copy in the radix tree; only divergent suffixes allocate new cache — usually much cheaper than N independent full prefills ([SGLang blog](https://www.lmsys.org/blog/2024-01-17-sglang/)).

Pattern: build shared context → `fork(N)` → each branch `gen` a role opinion → merge / judge in the parent.

## 5. Supplement: How RadixAttention works

From [Inference.net — SGLang Complete Guide](https://inference.net/content/sglang-complete-guide/#how-radixattention-works) (Jan 2026). Complements §1 with the cache mechanics agents rely on.

### Problem → tree

Shared prefixes are everywhere: system prompts, few-shot exemplars, multi-turn history, tool-trace stems. Recomputing their KV every request wastes GPU time and memory.

**RadixAttention** stores KV tensors in a **radix tree** (compressed trie):

- Paths = token sequences; an edge can hold a **variable-length** chunk (not only one token).
- Node values = corresponding **KV tensors** in GPU memory.
- On a new request, walk the tree for the **longest matching prefix** → skip prefill for that prefix (TTFT drops on hits).

No manual “declare this prefix cacheable” step — the tree learns whatever sharing your traffic actually has.

### Memory pools & eviction

| Pool | Role |
|------|------|
| Model weights | Fixed (size / quantization) |
| **KV cache** | Radix tree; size via `--mem-fraction-static` (default **0.9**) |
| Activations | Forward-pass scratch |

Default 0.9 is aggressive (good when cache hits pay off). Long sequences / large batches → try **0.8 / 0.7** to leave activation headroom and avoid OOM.

**LRU on leaves:** under pressure, evict least-recently-used **leaves** first; if a parent becomes a leaf, it can be evicted later. Shared roots (e.g. system prompt) stay hot because every request touches them; stale conversation tails die first.

### vs PagedAttention (vLLM)

| | RadixAttention (SGLang) | PagedAttention (vLLM) |
|--|-------------------------|------------------------|
| Layout | Dynamic radix tree over prefixes | Fixed-size KV blocks (like VM pages) |
| Cache policy | Auto-discover from traffic | Often needs predicted / configured APC patterns |
| Sweet spot | Multi-turn, branching, messy dialog | Templated batch / predictable prefixes |

Guide’s ShareGPT-style H100 / Llama 3.1 8B numbers (orienting, not gospel): ~**+29%** throughput, ~**23%** lower mean TTFT vs vLLM in that setup; SGLang more stable under high concurrency. Prefer SGLang when agent/chat prefixes dominate; vLLM still fine for simple templated batch jobs.

### Runtime path (one request)

1. Frontend (OpenAI-compatible API)  
2. Tokenizer (separate process — doesn’t block GPU)  
3. Scheduler: **prefix match** on radix tree  
4. Batch assemble (prefer co-scheduling shared-prefix requests)  
5. GPU forward with reused KV  
6. Stream tokens  

Alongside RadixAttention: **overlapped CPU/GPU schedule** (prep next batch while GPU runs) + **continuous batching** (fill slots as generations finish). Cache-aware ordering raises hit rate.

### Why this matters for DeepSeek agents (§1–4)

- Each tool round **extends** a shared stem → later turns should hit the tree hard if the server stays warm.
- `fork` debate = new branches off one cached stem (pay only for divergent suffixes).
- Cold start / tiny unique prompts → little win; **long-lived** multi-turn sessions are the point.

## 6. Practical checklist

1. Pick model size for the box (32B distill vs full V3/R1/V4 Flash/Pro).
2. Enable the right **reasoning** and **tool-call** parsers for that checkpoint.
3. Put tools in **Python**; constrain model outputs (schema or official tool API).
4. Prefer long-lived server + multi-turn sessions so RadixAttention actually hits; tune `--mem-fraction-static` if OOM.
5. For Lang* stacks: only swap `base_url`; don’t expect SGLang to own durable agent memory.

## See also

- [SGLang DeepSeek V3/R1 usage](https://github.com/sgl-project/sglang/blob/main/docs/basic_usage/deepseek_v3.md)
- [DeepSeek-V4 on SGLang](https://docs.sglang.io/cookbook/autoregressive/DeepSeek/DeepSeek-V4)
- [RadixAttention / SGLang intro (LMSYS)](https://www.lmsys.org/blog/2024-01-17-sglang/)
- [Inference.net — SGLang Complete Guide (RadixAttention)](https://inference.net/content/sglang-complete-guide/#how-radixattention-works)
- [Function calling on DeepSeek via SGLang (writeup)](https://medium.com/@elricwan/bringing-function-calling-to-deepseek-models-on-sglang-8fb6f37c86f6)
- Related notes: LangGraph agent tutorial; ultimate LLM agent build guide

## Source

- SGLang + DeepSeek agent programming briefing (serve → `@function` agent → fork / R1 think / OpenAI API), cross-checked against SGLang DeepSeek docs.
- Supplement §5: [SGLang: The Complete Guide to High-Performance LLM Inference](https://inference.net/content/sglang-complete-guide/#how-radixattention-works) (Inference.net, Jan 2026).
