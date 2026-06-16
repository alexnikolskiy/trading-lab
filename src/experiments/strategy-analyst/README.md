# StrategyAnalyst evaluation harness (experimental)

Runs the **existing** production `StrategyAnalyst` over a fixture across candidate LLM
models, scores each structured output **offline** against a deterministic rubric, and
(optionally) runs an LLM-as-a-judge. It does **not** touch the production prompt, agent,
`AnalystProfileOutput` schema, or the scoring buckets — it aggregates over them.

No DB, no backtester, no persistence. `--run` is the **sole** trigger for paid calls;
the default is a dry-run that constructs no models and makes no network calls.

## Usage

```bash
# Dry-run (default): plan + per-model API-key report, no paid calls
pnpm analyst:eval --fixture long-oi --models openrouter/x-ai/grok-4.3,openrouter/google/gemini-2.5-pro

# Real run with judge
pnpm analyst:eval --run --judge --judge-model openrouter/anthropic/claude-opus-4.8 \
  --models openrouter/x-ai/grok-4.3,openrouter/google/gemini-2.5-flash

# Repeat each model N times and rank by aggregated stats (single runs are noisy:
# judge/det spread of ~0.05–0.17 has been observed on one model/fixture)
pnpm analyst:eval --run --judge --judge-model openrouter/anthropic/claude-opus-4.8 \
  --models openrouter/x-ai/grok-4.3,openrouter/google/gemini-2.5-pro --repeat 5
```

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--fixture` | `long-oi` | Fixture id (see `fixtures.ts`). |
| `--models` | — (required) | Comma-separated OpenRouter/provider model ids. |
| `--run` | off | Make real (paid) calls. Off = dry-run, no model construction. |
| `--threshold` | `0.8` | Deterministic PASS threshold (0–1). |
| `--judge` | off | Run the opt-in LLM-as-a-judge (requires `--judge-model`). |
| `--judge-model` | — | Judge model id (no default; must be explicit). |
| `--repeat` | `1` | Independent runs per model (1–20). Runs are sequential (no parallelism, to avoid rate limits). |

With `--repeat N`, the dry-run `plannedPaidCalls` is `(analyst + judge) × N`, and the run
prints a ranked summary (by **judge-mean → PASS-rate → det-mean**) plus per-run aggregates.

## Artifacts (`--run`)

Under `.artifacts/experiments/strategy-analyst/<fixture>/<timestamp>/` (gitignored):

- `<model>.run<k>.json` — each run's `CandidateResult` (judge excluded), `k = 1..N`
- `<model>.run<k>.judge.json` — that run's judge verdict, only when the judge ran
- `<model>.aggregate.json` — per-model aggregate (runs, PASS-rate, det/judge/latency stats)
- `manifest.json` — run summary incl. `repeat` and per-model `{ passRate, detMean, judgeMean }`

The judge is best-effort and **never** affects the deterministic verdict/score.
