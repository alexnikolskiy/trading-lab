# Operator Reranker — scaffold (conditional reranking, default OFF)

**Status:** Approved design (brainstormed 2026-06-19). Implements operator-rag design §5/§7/§10.
**Date:** 2026-06-19
**Roadmap:** `docs/conversational-operator-roadmap.md` → "Reranker follow-up — now unblocked".
**Builds on:** `docs/superpowers/specs/2026-06-19-operator-rag-design.md` §5 (ports), §6 (RRF), §7 (conditional reranking), §8 (deadline), §10 (evaluation).

## 1. Goal & scope

Implement the conditional reranker as a **scaffold**: the capability + its measurement, wired behind a flag and **OFF by default**. We do **not** enable it now — the curated golden corpus (nDCG@5 ≈ 0.967, tiny) has no headroom to demonstrate the `+0.02 nDCG@5` enable-gate, and the roadmap's own tech-debt note requires an independent corpus before promoting a reranker. Enabling is deferred to a future slice once a larger/real corpus exists (likely generated from accumulated real strategies).

So this slice delivers: the `MastraRerankerAdapter` (RerankerPort impl), the §7 conditional-reranking integration in the retrieval pipeline (gated, deadline-aware, RRF fallback), the config flags, and an **eval comparison** (RRF-only vs reranker-enabled) with a CI no-regression gate — all reusable when enabling later.

## 2. Approved decisions (brainstorming)

1. **Scaffold, default OFF** — `OPERATOR_RERANKER=none`; not enabled. Capability + measurement only.
2. **CI eval uses a deterministic `FakeReranker`** (no network, reproducible). The live Mastra comparison is an **opt-in `--run`** mode (paid), **deferred** — not built now.
3. RRF-only ordering stays the mandatory baseline and the fallback on any reranker failure/timeout/abort.
4. Enable later, gated on an independent corpus (separate slice).

## 3. Current-state facts (verified)

- `RerankerPort` already exists, no impl: `src/ports/strategy-similarity.port.ts` —
  `rerank(query: string, candidates: readonly SimilarStrategyCandidate[], limit: number, signal?: AbortSignal): Promise<readonly SimilarStrategyCandidate[]>`.
- `OperatorRetrieval` (`src/operator/operator-retrieval.ts`) orchestrates exact → structured → `#runHybrid` (similarity.search → RRF fusion). It owns a `RetrievalBudget` (monotonic deadline, `signal`, soft/hard deadlines) and an injected `clock`/`scheduler` for deterministic deadline tests. Reranking slots **inside `#runHybrid`, after fusion**, before the fused candidates become evidence.
- `SimilarStrategyCandidate` / `StrategyCandidateSet` / `StrategySimilarityQuery` live in `src/domain/strategy-retrieval.ts`; RRF in `src/adapters/similarity/rrf.ts` (`RrfEntry`).
- Eval harness: `src/experiments/operator-rag/{eval-harness,metrics,fixtures,types}.ts` + `scripts/operator-rag-eval.ts`; metrics include nDCG@5 / MRR / recall.
- Mastra adapters live under `src/mastra/**` (import-boundary guard: new `Agent`/scorer construction only there).

## 4. Architecture

### 4.1 Adapters (RerankerPort)
- **`MastraRerankerAdapter`** — implements `RerankerPort` using Mastra's rerank scoring (semantic + vector + position weighting; **not** a cross-encoder, per §7). Constructed under `src/mastra/**`. Honors the `AbortSignal`; on its own timeout/error it throws (the orchestrator catches → RRF fallback). The exact Mastra rerank API is confirmed during implementation (context7); the adapter surface is the `RerankerPort`.
- **`FakeReranker`** (test/eval support) — deterministic reordering (e.g. by a fixture-provided score or a stable key), no network. Used by unit tests, the pipeline integration tests, and the CI eval comparison.

### 4.2 Conditional reranking in `OperatorRetrieval` (§7)
Add an optional `reranker?: RerankerPort` + a `RerankConfig` to `OperatorRetrievalDeps`. After RRF fusion in `#runHybrid`, run the reranker **only when all hold**:
- a reranker is configured (flag `mastra`);
- at least **2** fused candidates exist (minimum to reorder anything);
- the remaining budget permits the configured reranker timeout (`remaining(now) ≥ timeoutMs`);
- no exact match already fully answers the lookup (exact-hit path skips hybrid anyway);
- **one trigger** is true: the turn explicitly asked to compare/show-similar; OR the top-two RRF score gap ≤ `RRF_MARGIN`; OR the fused count ≥ `MIN_CANDIDATES`.

Run under the budget `signal` AND a per-rerank timeout (min of `timeoutMs` and remaining budget, via the injected scheduler/clock). **On timeout/abort/error → keep the RRF order + add a degraded warning** (`RETRIEVAL_WARNINGS.rerankFailed`). Success → reranked top-`LIMIT` order. RRF order is always the input + the fallback.

### 4.3 Config
```text
OPERATOR_RERANKER=mastra | none        # default none
OPERATOR_RERANK_TIMEOUT_MS=1500
OPERATOR_RERANK_LIMIT=5
OPERATOR_RERANK_MIN_CANDIDATES=10
OPERATOR_RERANK_RRF_MARGIN=0.002
```
Wiring composes the `MastraRerankerAdapter` only when `OPERATOR_RERANKER=mastra`; otherwise `reranker` is `undefined` and `OperatorRetrieval` behaves exactly as today (RRF order, zero rerank calls). Default config = no behavior change.

### 4.4 Eval comparison (§10.2)
Extend the operator-rag eval harness to compute `nDCG@5` for **RRF-only** vs **reranker-enabled** (using `FakeReranker` for deterministic CI), report both + the delta, and **assert reranker-enabled does not regress** against RRF baseline (CI gate). Report the `+0.02` enable-threshold as *measured, not enforced* (we don't enable). The live Mastra delta is the deferred `--run` mode.

## 5. Invariants

- **RRF is the mandatory baseline + fallback**; a reranker never produces an empty/worse-than-RRF result that ships — failure degrades to RRF + a warning.
- **Deterministic CI** — fake reranker + injected clock/scheduler; no network, no flakiness; no live model call in the PR gate.
- **Mastra construction only under `src/mastra/**`** (import-boundary guard).
- **Privacy** — the reranker sees candidate text (query + candidate descriptions) to score, but audit events carry only IDs / scores / counts / codes / timings — never raw strategy text or embeddings (consistent with `OperatorRetrieval`'s audit-safety rule).
- **Strip-types-safe** (no TS parameter properties), ESM `.ts`, research-only.

## 6. Testing contract

- **Unit (reranker integration):** trigger gating (each trigger on/off; <2 candidates → skip; budget-insufficient → skip); success reorders to top-`LIMIT`; timeout/abort/error → RRF order + `rerankFailed` warning (fake clock); flag `none`/no dep → no rerank call.
- **Unit (FakeReranker):** deterministic reordering.
- **Integration:** `OperatorRetrieval.collect` with a reranker dep — reranked order on trigger; RRF order otherwise; exact-hit path never reranks.
- **Eval:** harness computes RRF-only vs reranker-enabled nDCG@5 on the golden set with `FakeReranker`; asserts no-regression; reports delta + threshold.

## 7. Delivery / rollout

Ships **OFF** (`OPERATOR_RERANKER=none`). No production behavior change. Enabling is a future slice gated on an independent eval corpus (roadmap tech debt) — at which point the live `--run` Mastra comparison + the `+0.02` decision happen.

## 8. Non-goals

- Enabling the reranker now; building the independent eval corpus; the live `--run` Mastra eval mode.
- A cross-encoder reranker (`CrossEncoderRerankerAdapter` is a later option per §7).
- Answer Synthesizer / Artifact RAG.

## 9. Open items (confirm during implementation)

1. Mastra's rerank API surface (function/scorer + model + weights) — confirm via context7; keep it behind the `RerankerPort` so the pipeline is agnostic.
2. The exact `RerankConfig` plumbing into `OperatorRetrievalDeps` + how the trigger reads "explicit comparison" from the turn input (`OperatorRetrievalInput`).
