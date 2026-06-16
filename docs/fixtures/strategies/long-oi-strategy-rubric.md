# Rubric: long_oi StrategyProfile evaluation

Score the candidate StrategyProfile against these dimensions (each 0–1). Use the source
description and the research notes as ground truth. Penalize invented specifics.

## Dimensions

1. **Direction** — Net bias is long-only. No short branch invented.
2. **Core idea** — Mean-reversion after a sharp dump; enter long on a confirmed bounce backed by OI recovery + long liquidations. Not trend-following.
3. **Market features** — Names the real data needs: OHLCV (1m candles), open interest (OI), liquidations. No technical indicators claimed (the strategy is rule-based).
4. **Entry trigger** — Dump detection (~10% drop) → watch → confirmed reversal (price rising / green candles), OI recovering, long liquidations present.
5. **Exit ladder** — TP1 (+3.5%, partial), TP2 (+5%, full), hard stop (−12%), time exit (180m). Move stop to breakeven after TP1.
6. **Position management** — DCA averaging (max two adds on further dips); breakeven after TP1.
7. **Boundary discipline** — Treats position sizing, leverage, fills, fees, exchange, and instrument universe as runner/platform-owned. Does NOT invent exact leverage or base order size. DCA size multipliers are hints only.
8. **Unknowns honesty** — Flags missing sizing/leverage, fees, exchange, and instrument universe (or equivalents) rather than fabricating them.

## Hallucination flags (list any present)

- Invented leverage (e.g. "10x") or base order size (e.g. "$100").
- Invented fees, commissions, exchange, or specific instrument list.
- Claimed 8-minute liquidation window or technical indicators (the module uses neither).
- Trailing stop (the module has none).

## Missing-from-profile (list rubric items the profile omitted)

Note any of dimensions 1–8 the profile fails to cover.
