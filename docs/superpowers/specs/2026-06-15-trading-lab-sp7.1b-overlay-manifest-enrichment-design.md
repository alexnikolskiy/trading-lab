# SP-7.1b — Validation-ready 017 Overlay Manifest Enrichment — Design

- **Date:** 2026-06-15
- **Status:** Design approved (ready for implementation plan)
- **Predecessor:** SP-7.1 (`docs/superpowers/specs/2026-06-15-trading-lab-sp7.1-platform-validate-module-design.md`)
- **Slice boundary:** This is **not** SP-7.2. No submit / status / result / artifacts; no backtest-via-platform; no persistence; no callback/resume.

## 1. Problem

SP-7.1 wired a standalone `validate_module` dry-run bridge: `ResearchPlatformPort.validateModule(bundle, options?)`, the `toSubmittedBundle` mapper, `GatewayValidationError`, the mock/MCP/Lazy adapters, `runValidateProbe`, and the `platform:validate` CLI. SP-7.1 intentionally accepted that `validate_module` may return `status: 'rejected'` when the reason is an **incomplete 017 overlay manifest** — that gap is what SP-7.1b closes.

### Where the gap actually lives

The platform's `validate_module` (`trading-platform/src/research/mcp-gateway/handlers/validate-module.ts`) for a `submitted` bundle calls `materializeAndLoadBundle` → `loadBundle`, which **parses `manifest.json` from the materialized bundle directory** and casts it to the platform 017 `ModuleManifest`. It then runs `validateBundle` → the 017 `validateModule` semantic checks against **those bytes**. The wire field `submitted.manifest` is *not* what gets validated — `manifest.json` is.

Today `toSubmittedBundle` writes `manifest.json = JSON.stringify(bundle.manifest)`, i.e. the **lab-native** manifest:

```
{ moduleId, moduleKind: 'hypothesis_overlay', appliesTo, entry, exports, capabilities: string[], sdkContractVersion }
```

Against the 017 overlay contract this fails hard, and not only on missing fields:

- **Missing required fields:** `id, version, name, summary, rationale, author, contractVersion, status, paramsSchema, dataNeeds, hooks, targetStrategyRef, interceptionPoint`.
- **Type mismatch:** lab `capabilities` is a `string[]`; 017 wants a `CapabilityDeclaration` **object**.
- **Overlay structural rules** (`trading-platform/.../validation/validate-module.ts`): `hooks` must be exactly `['apply']`; `targetStrategyRef` and `interceptionPoint` are required.

So the lab manifest cannot pass even as a superset. **The wire `manifest.json` must become a real 017 overlay manifest, distinct from the lab-native manifest.** A two-manifest model is forced.

### The lever (keeps this slice small)

The vendored SDK already exposes the platform-blessed constructor `createOverlayManifest(input: OverlayManifestInput): ModuleManifest` at `@trading-platform/sdk/builder` (confirmed exported subpath: `packages/sdk/package.json` → `./builder` → `dist/builder/index.js`). It fixes all structural defaults for us:

- `kind: 'overlay'`, `status: 'research_only'`, `hooks: ['apply']`
- `contractVersion` default `'017.2'`, `capabilities: { platformSdk: true }`, `dataNeeds` = safe (`closedCandlesUpToCurrent` + `asOfIndicators`).

We do not reinvent the 017 shape — we feed `createOverlayManifest` an input derived from data already in hand at build time.

## 2. Decisions (locked)

1. **Acceptance bar: manifest-shape only.** SP-7.1b closes the `schema_invalid` / missing-rich-field / `forbidden_capability` / `unsupported_contract_version` class of problems. `unknown_strategy_ref` remains a live-gateway/catalog concern and is **acceptable** as the only remaining validation issue (same spirit as SP-7.1's accepted-or-rejected).
2. **Manifest topology: lazy wire projection.** The lab `ModuleManifest` stays the lab-native source of truth and is unchanged. The 017 overlay manifest is materialized **only** at the `SubmittedBundle` boundary inside `toSubmittedBundle` via `createOverlayManifest(...)`. It is never stored in the lab domain.
3. **Field sourcing: deterministic mapper.** A pure lab function `deriveOverlayManifestMeta(hypothesis, profile, labManifest)` produces a lab-native `OverlayManifestMeta`. `BuilderPort` / `BuilderOutput` are unchanged (not builder-authored). `StrategyProfile` is unchanged (not profile-owned).

## 3. Architecture & data flow

Two manifests, cleanly separated:

- **Lab-native `ModuleManifest`** (unchanged): source of truth for the *code module* — `moduleId, moduleKind, appliesTo, entry, exports, capabilities[], sdkContractVersion`. Still drives `descriptor.entryPoint` (`module/<entry>`), the file payload, and the lab `bundleHash`.
- **017 overlay manifest** (the *semantic envelope* the platform validates): built lazily at the wire boundary, emitted as `manifest.json` **and** `submitted.manifest`.

Between them: a lab-native `OverlayManifestMeta` carrier and a pure deterministic mapper. The mapper imports **only lab domain types** — zero platform/SDK import — so it adds no platform dependency to the handler or domain. The platform 017 / SDK import stays confined to `submitted-bundle.ts`, which is already platform-coupled.

```
hypothesisBuildHandler
  ├─ out  = builder.build(...)            // lab ModuleManifest + files  (BuilderPort unchanged)
  ├─ meta = deriveOverlayManifestMeta(hypothesis, profile, out.manifest)  // pure lab, no platform import
  └─ bundle = assembleBundle(out.manifest, out.files, meta)   // meta attached; bundleHash unchanged
        │
        ▼  (validate path only — SP-4 backtest path never calls toSubmittedBundle)
   toSubmittedBundle(bundle)
     ├─ input = mapMetaToOverlayInput(bundle.overlayMeta)   // lab OverlayManifestMeta → SDK OverlayManifestInput
     ├─ m017  = createOverlayManifest(input)                // @trading-platform/sdk/builder
     └─ manifest.json = JSON.stringify(m017) ; submitted.manifest = m017 ; entryPoint = module/<labManifest.entry>
```

Note both manifests remain load-bearing and neither is redundant: the lab manifest still supplies `entry`/`exports`/files for the descriptor, while the 017 manifest is the semantic envelope.

## 4. Components

### 4.1 New: `src/domain/overlay-manifest-meta.ts`

- `OverlayManifestMeta` — lab-native interface mirroring the rich overlay fields (no platform import):
  `id, version, name, summary, rationale, author, targetStrategyRef, interceptionPoint, paramsSchema` (and room for optional `params` / `dataNeeds` later; omitted in this slice).
- `deriveOverlayManifestMeta(hypothesis: HypothesisProposal, profile: StrategyProfile, labManifest: ModuleManifest): OverlayManifestMeta` — pure, deterministic. Imports only from `./hypothesis.ts`, `./strategy-profile.ts`, `./module-bundle.ts`. **Must not import `@trading-platform/*`.**

### 4.2 `src/domain/module-bundle.ts`

- Add **optional** `overlayMeta?: OverlayManifestMeta` to `ModuleBundle`.
- `assembleBundle(manifest, files, overlayMeta?)` — optional 3rd param, attached verbatim to the returned bundle.
- **`bundleHash` stays computed over `{ manifest, files }` only** — `overlayMeta` is excluded from the hash. The lab `bundleHash` is therefore byte-identical to SP-7.1 for the same `manifest` + `files`. (`overlayMeta` is deterministically derived from the same hypothesis/profile context, so no realistic hash-collision concern arises from excluding it.)
- `MODULE_BUNDLE_CONTRACT_VERSION` stays `module-bundle-v1` — `overlayMeta` is an additive, optional extension; its presence is the "validate-ready" signal.

### 4.3 `src/adapters/platform/submitted-bundle.ts`

- Map `bundle.overlayMeta → OverlayManifestInput`, call `createOverlayManifest`, and emit the result as both `manifest.json` (the bytes that drive `descriptor.files`/`manifestSha256`/wire `bundleHash`) and `submitted.manifest`.
- `descriptor.entryPoint` continues to come from `bundle.manifest.entry` (lab-native) → `module/<entry>`. `descriptor.kind` stays `'overlay'`.
- **Fail-closed:** if `bundle.overlayMeta` is absent, throw a clear typed error (e.g. `toSubmittedBundle: bundle is missing overlayMeta (pre-SP-7.1b bundle is not validation-ready)`). No silent fallback to the old lab-manifest-as-`manifest.json` behavior.
- This fixes a latent looseness: `submitted.manifest` now carries a real platform `ModuleManifest` instead of the lab shape.

### 4.4 `src/orchestrator/handlers/hypothesis-build.handler.ts`

- One pure-lab addition: `const overlayMeta = deriveOverlayManifestMeta(hypothesis, profile, out.manifest);` then `assembleBundle(out.manifest, out.files, overlayMeta)`.
- **No `@trading-platform/sdk` import. No real platform dependency. The SP-4 submit/backtest/evaluate logic is untouched.**

## 5. Field mapping (deterministic)

| 017 field | Source | Note |
|---|---|---|
| `id` | `labManifest.moduleId` (`overlay-${hyp.id}`) | reuse |
| `version` | constant `'0.1.0'` | platform requires only a non-empty string |
| `name` | `hypothesis.targetBehavior` | meaningful, non-empty |
| `summary` | `hypothesis.thesis` | |
| `rationale` | `profile.coreIdea` | the "why" |
| `author` | `'agent'` | lab is agent-driven research |
| `targetStrategyRef` | `strategy:${profile.id}` | mirrors the handler's existing `baselineModuleId` |
| `interceptionPoint` | constant `'post_entry_management'` | see §5.1 |
| `paramsSchema` | `{ type: 'object', additionalProperties: false }` | valid empty JSON Schema (compiles under ajv; empty → no separation violations) |
| `params` | omitted | |
| `dataNeeds` | omitted → SDK `SAFE_DATA_NEEDS` | `closedCandlesUpToCurrent` + `asOfIndicators` |
| `contractVersion` | omitted → SDK `'017.2'` | |
| `capabilities` | fixed by SDK `{ platformSdk: true }` | not an `OverlayManifestInput` field; see §5.2 |
| `kind` / `status` / `hooks` | fixed by SDK | `overlay` / `research_only` / `['apply']` |

### 5.1 `interceptionPoint = 'post_entry_management'`

`'post_entry_management'` is the canonical overlay interception point used by the SDK overlay templates (`packages/sdk/src/builder/_vendor/templates/early-exit-overlay/template.ts`, `builder/examples/overlay-template.ts`), the 017 valid fixtures (`specs/017-.../fixtures/valid/overlay-module.json`), and `scripts/verify_017_taxonomy.mjs`. `'onBarClose'` is deliberately **not** used — it is strategy-flavoured and semantically confusing next to the overlay `hooks: ['apply']`.

`validate_module` itself only requires `interceptionPoint` to be a non-empty string (`validate-module.ts:211`). Using the supported overlay value additionally keeps the bundle forward-compatible with the **backtest runner's** interceptionPoint compatibility check (`runner.ts:635` rejects unsupported values with `overlay_composition_invalid`) — relevant later for SP-7.2, at no cost now.

### 5.2 Deliberate foot-gun avoidance

Lab `capabilities[]` / `requiredFeatures` are advisory **market-data features**, not platform sandbox capabilities. They are **not** mapped into the 017 `CapabilityDeclaration` (which would risk `forbidden_capability`) nor into `dataNeeds` (which would risk `lookahead_violation` / `unsupported_market_data_kind`). The 017 `capabilities` and `dataNeeds` stay at the SDK safe defaults. Mapping recognized lab market-data features into 017 `dataNeeds` is explicitly deferred (see §8).

## 6. Compatibility policy (with SP-7.1)

- **Lab `bundleHash`:** unchanged (hash over `{ manifest, files }`; `overlayMeta` excluded). Existing stored `ModuleBundle` artifacts remain hash-valid and deserialize fine (new field simply absent).
- **`MODULE_BUNDLE_CONTRACT_VERSION`:** unchanged (`module-bundle-v1`). `overlayMeta` is additive.
- **`toSubmittedBundle` behavior change (intended):** `manifest.json` goes lab-native → 017. The platform wire `descriptor.bundleHash` bytes therefore change, but **parity with the gateway is preserved** because both lab and gateway hash the *same* `manifest.json` bytes — the SP-7.1 bundle-hash-parity invariant holds.
- **Pre-SP-7.1b bundles** (no `overlayMeta`): running `platform:validate` / `toSubmittedBundle` on them throws the fail-closed error. They are not validation-ready by definition. Acceptable.
- **SP-7.1 tests** that assert the old `manifest.json` shape / wire `bundleHash` in `submitted-bundle.test.ts` will be updated to the 017 shape.

## 7. Acceptance criteria

### Offline / CI-provable

1. `toSubmittedBundle(bundle).manifest` (and the decoded `manifest.json`) **deep-equals `createOverlayManifest(expectedInput)`** — shape correctness is delegated to the platform-blessed constructor.
2. The emitted manifest has all 017 required fields present, with `kind: 'overlay'`, `status: 'research_only'`, `hooks: ['apply']`, no forbidden capabilities, and a `paramsSchema` that compiles under ajv.
3. `deriveOverlayManifestMeta` is pure and deterministic: identical inputs → byte-identical meta.
4. Lab `bundleHash` is byte-identical to SP-7.1 for the same `manifest` + `files` when `overlayMeta` is attached.
5. `toSubmittedBundle` on a bundle **without** `overlayMeta` throws a clear typed error (fail-closed).
6. `src/domain/overlay-manifest-meta.ts` contains **no** `@trading-platform/*` / SDK import (guard test).
7. SDK `preflightValidate` on the projected bundle returns no `schema_invalid` / `forbidden_capability` / `unsupported_contract_version` issues (cheap vendored subset smoke — not a full oracle, used as a regression guard).
8. SP-4 path, `PlatformGatewayPort`, and `BuilderPort` are unchanged in behavior (existing tests stay green); no platform import added to lab domain core.

### Authoritative (documented PENDING — same status as SP-7.1)

9. Live `validate_module` round-trip returns `accepted` (catalog knows `targetStrategyRef`) **or** returns **only** `unknown_strategy_ref` with no schema / missing-field issues. Provable only against a live gateway (none in the dev env). Manual recipe: build an SP-7.1b bundle and run `platform:validate`.

> **Testability note.** There is no faithful **offline** oracle for full 017 semantic validation: the mock adapter returns a canned `{ status: 'accepted', issues: [] }`; the SDK `preflightValidate` enforces only a subset (kind / contractVersion / forbidden capabilities / bundle.json layout); and the authoritative validator (`trading-platform/src/research/validation`) is **not** vendored in the SDK and must not be pulled in (it would re-couple lab to the platform). Offline confidence therefore rests on equivalence to `createOverlayManifest` — by construction the platform's own definition of a valid overlay manifest.

## 8. Non-goals

- No submit / status / result / artifacts (SP-7.2).
- No backtest-via-platform; `PlatformGatewayPort` / `submitBacktest` / mock backtest path untouched.
- No persistence / DB changes.
- No callback / resume changes.
- No execution authority — research / validation-only.
- No catalog wiring / resolving `unknown_strategy_ref`.
- No `BuilderPort` / `BuilderOutput` contract change (mapper, not builder-authored).
- No `StrategyProfile` contract change (mapper, not profile-owned).
- No mapping of lab `capabilities[]` / market-data features into 017 `capabilities` / `dataNeeds` (safe SDK defaults only).
- No real-LLM manifest enrichment.

## 9. Files

### May change

- `src/domain/overlay-manifest-meta.ts` — **new** (type + pure mapper).
- `src/domain/module-bundle.ts` — `overlayMeta?` on `ModuleBundle`; optional `assembleBundle` param; hash unchanged.
- `src/adapters/platform/submitted-bundle.ts` — 017 projection via `createOverlayManifest`; fail-closed on missing meta.
- `src/orchestrator/handlers/hypothesis-build.handler.ts` — derive + attach meta (pure-lab line only).
- Tests: `src/adapters/platform/submitted-bundle.test.ts` (updated), `src/adapters/platform/validate-probe.test.ts` (fixtures gain `overlayMeta`), new `src/domain/overlay-manifest-meta.test.ts`, plus a `module-bundle` hash-invariance test.
- `scripts/platform-validate.ts` — only if a usage/docs note is needed (input bundle JSON must now carry `overlayMeta`).

### May not change

- Anything under `trading-platform/**` — read-only sibling; SDK consumed as the vendored tarball (`@trading-platform/sdk`).
- `src/ports/builder.port.ts`, `src/ports/research-platform.port.ts`, `src/ports/platform.port.ts` (`PlatformGatewayPort`).
- SP-4 backtest / evaluate logic in `hypothesis-build.handler.ts`; `GatewayValidationError`; `runValidateProbe` core flow; the mock / MCP / Lazy adapter `validateModule` signatures (they flow `overlayMeta` through transparently via the `ModuleBundle`).

## 10. Implementation order (TDD; full plan via writing-plans)

1. `OverlayManifestMeta` + `deriveOverlayManifestMeta` pure mapper — RED/GREEN; purity + determinism + no-platform-import guard tests.
2. `ModuleBundle.overlayMeta?` + `assembleBundle` optional param + `bundleHash`-invariance test.
3. `toSubmittedBundle` → 017 projection via `createOverlayManifest`; deep-equal-vs-constructor test; fail-closed test; update SP-7.1 `submitted-bundle.test.ts`.
4. Handler wiring (derive + attach); SP-4 regression stays green.
5. Acceptance smoke: ajv `paramsSchema` compile + `preflightValidate` subset on the projected bundle.

### Explicitly required tests (per sign-off)

- No platform/SDK import in `src/domain/overlay-manifest-meta.ts`.
- Lab `bundleHash` unchanged when `overlayMeta` is attached.
- `toSubmittedBundle` without `overlayMeta` fails closed with a clear error.
- `toSubmittedBundle` `manifest.json` deep-equals `createOverlayManifest(expectedInput)`.
- SP-4 path and `PlatformGatewayPort` remain untouched.
