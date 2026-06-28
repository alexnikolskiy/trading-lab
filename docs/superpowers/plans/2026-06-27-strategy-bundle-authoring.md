# Strategy-Bundle Authoring (F1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add lab's first strategy-bundle authoring lane — emit a self-contained Variant-2 ESM `createStrategyModule` bundle from a deterministic stand-in and prove it through the backtester strategy-route (resultHash == golden).

**Architecture:** Parallel additive strategy-lane (overlay-lane untouched): `FakeStrategyBuilder` → `assembleStrategyBundle` (esbuild ESM + SDK `createModuleManifest` + `computeBundleHash`) → composite `validateStrategyBundle` → content-addressed `artifacts.put` → `submitStrategyRun` (backtester `POST /v1/runs` engine:'strategy') → outcome (`equivalent` via resultHash==golden; `signed`+evidence only in hermetic fixture). Two tiers: hermetic fixture (`pnpm check`) + Docker integration.

**Tech Stack:** TypeScript, vitest, esbuild (NEW dep), `@trading-backtester/sdk` ≥0.3.0 (NEW floor), `@trading-platform/sdk` 0.5.0 (`./validation`).

## Global Constraints

- **Variant-2 contract (do NOT change):** bundle = flat self-contained ESM `export default createStrategyModule`; `bundleHash = computeBundleHash(rawBytes) = 'sha256:'+hex` of raw ESM bytes. NEVER the canonical-JSON hash lab's overlay `assembleBundle` uses.
- **Additive only:** overlay-lane (`assembleBundle`, `validateBundle`, `toBacktesterBundle`, `builder.agent`, `hypothesisBuildHandler`) is NOT modified. New files / new methods only.
- **SDK floor:** `@trading-backtester/sdk` MUST be ≥0.3.0 (authoring surface shipped in PR#57). Lab currently pins 0.2.0.
- **Research-only:** no live-trading authority anywhere in this lane.
- **Outcome taxonomy (normal returns, never throw):** `signed | equivalent | divergent | rejected | unavailable`. `throw` only for infra (esbuild crash, SDK module load fail, artifact write fail).
- **Stand-in source = verbatim port** of `module/index.js` from `trading-backtester/apps/backtester/test/fixtures/overlay/bundles/short-after-pump.bundle.json` (engine-code-path twin of trusted shortAfterPump → golden `0be9931c`). Do NOT use the generic SDK worked-example.
- **F1 = backtester leg only.** No platform-049/long_oi here (that is F2). Real signed-evidence-over-HTTP is deferred (backtester follow-on); F1 integration proves `equivalent` (resultHash==golden).
- Gate: `pnpm check` EXIT 0. Integration tests are `*.integration.test.ts` (Docker-gated, not in `pnpm check`).

## File Structure

```
src/ports/strategy-builder.port.ts            # StrategyBuilder + I/O + StrategyManifestMeta types
src/ports/backtester-strategy.port.ts         # BacktesterStrategyPort + StrategyRunSubmission/Result
src/domain/strategy-bundle.ts                 # AssembledStrategyBundle + assembleStrategyBundle (esbuild+manifest+hash)
src/validation/strategy-bundle-validator.ts   # ValidationVerdict + validateStrategyBundle (composite)
src/adapters/builder/fixtures/short-after-pump.strategy-source.ts  # ported twin ESM string (stand-in)
src/adapters/builder/fake-strategy-builder.ts # FakeStrategyBuilder (emits twin source + meta)
src/adapters/platform/fixture-backtester.adapter.ts  # programmable FixtureBacktesterAdapter
src/adapters/platform/http-backtester.adapter.ts     # MODIFY: + submitStrategyRun
src/orchestrator/handlers/author-strategy-bundle.handler.ts  # authorStrategyBundleHandler (WorkflowHandler)
```

Tests live beside their unit (lab convention: `*.test.ts`; Docker → `*.integration.test.ts`).

---

### Task 1: Dependencies + SDK authoring-surface smoke

**Files:**
- Modify: `package.json` (bump `@trading-backtester/sdk` → ^0.3.0; add `esbuild` to devDependencies)
- Test: `src/adapters/builder/sdk-strategy-authoring-smoke.test.ts`

**Interfaces:**
- Produces: confirmed imports `computeBundleHash`, `createModuleManifest`, `getAuthoringDoc` from `@trading-backtester/sdk/builder`.

- [ ] **Step 1: Write the failing test** — `sdk-strategy-authoring-smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { computeBundleHash, getAuthoringDoc } from '@trading-backtester/sdk/builder';

describe('sdk strategy authoring surface (0.3.0)', () => {
  it('computeBundleHash returns sha256:hex over raw bytes', () => {
    const h = computeBundleHash(new TextEncoder().encode('x'));
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it('getAuthoringDoc("strategy") describes createStrategyModule', () => {
    expect(getAuthoringDoc('strategy')).toContain('createStrategyModule');
  });
});
```
- [ ] **Step 2: Run, verify it fails** — `pnpm vitest run src/adapters/builder/sdk-strategy-authoring-smoke.test.ts` → FAIL (module/export not found at 0.2.0).
- [ ] **Step 3: Bump deps** — set `@trading-backtester/sdk` to `^0.3.0` and add `"esbuild": "^0.x"` (match repo's existing esbuild floor if pinned elsewhere; else latest 0.x) in `package.json` devDependencies; `pnpm install`.
- [ ] **Step 4: Run, verify it passes** — same command → PASS.
- [ ] **Step 5: Commit** — `git add package.json pnpm-lock.yaml src/adapters/builder/sdk-strategy-authoring-smoke.test.ts && git commit -m "build(strategy-authoring): bump backtester-sdk 0.3.0 + esbuild; SDK surface smoke"`

---

### Task 2: Port the shortAfterPump byte-twin stand-in source

**Files:**
- Create: `src/adapters/builder/fixtures/short-after-pump.strategy-source.ts`
- Test: `src/adapters/builder/fixtures/short-after-pump.strategy-source.test.ts`

**Interfaces:**
- Produces: `export const SHORT_AFTER_PUMP_SOURCE: string` (self-contained ESM `createStrategyModule`).

- [ ] **Step 1: Write the failing test:**
```ts
import { describe, it, expect } from 'vitest';
import { SHORT_AFTER_PUMP_SOURCE } from './short-after-pump.strategy-source.js';

describe('stand-in source', () => {
  it('is self-contained ESM createStrategyModule', () => {
    expect(SHORT_AFTER_PUMP_SOURCE).toContain('export default');
    expect(SHORT_AFTER_PUMP_SOURCE).toContain('createStrategyModule');
    const stripped = SHORT_AFTER_PUMP_SOURCE.replace(/export\s+default/g, '');
    expect(/\b(import|require)\s*[(.]|\bfrom\s+['"]/.test(stripped)).toBe(false);
  });
});
```
- [ ] **Step 2: Run, verify it fails** — `pnpm vitest run src/adapters/builder/fixtures/short-after-pump.strategy-source.test.ts` → FAIL (module missing).
- [ ] **Step 3: Port the source** — copy the `module["index.js"]` string verbatim from `../trading-backtester/apps/backtester/test/fixtures/overlay/bundles/short-after-pump.bundle.json` into `SHORT_AFTER_PUMP_SOURCE` (a backtick template literal). This is the engine-code-path twin → golden `0be9931c`.
- [ ] **Step 4: Run, verify it passes** — same command → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(strategy-authoring): port shortAfterPump byte-twin stand-in source"`

---

### Task 3: StrategyBuilder port + FakeStrategyBuilder

**Files:**
- Create: `src/ports/strategy-builder.port.ts`, `src/adapters/builder/fake-strategy-builder.ts`
- Test: `src/adapters/builder/fake-strategy-builder.test.ts`

**Interfaces:**
- Consumes: `SHORT_AFTER_PUMP_SOURCE` (Task 2).
- Produces: `StrategyBuilder { build(i: StrategyBuilderInput): Promise<StrategyBuilderOutput> }`; `StrategyBuilderOutput { source: string; manifestMeta: StrategyManifestMeta }`; `StrategyManifestMeta { id; version; name; hooks: ['onBarClose','onPositionBar']; dataNeeds; paramsSchema; capabilities }`.

- [ ] **Step 1: Write the failing test** — assert `new FakeStrategyBuilder().build({spec, authoringDoc:''})` returns `{ source === SHORT_AFTER_PUMP_SOURCE, manifestMeta.hooks` includes both hooks, `manifestMeta.id` set `}`.
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement** the port interface + `FakeStrategyBuilder` returning `{ source: SHORT_AFTER_PUMP_SOURCE, manifestMeta: SHORT_AFTER_PUMP_META }` (a fixed meta with `hooks:['onBarClose','onPositionBar']`, `dataNeeds`/`paramsSchema` matching the twin's manifest in the fixture json).
- [ ] **Step 4: Run, verify it passes.**
- [ ] **Step 5: Commit** — `feat(strategy-authoring): StrategyBuilder port + FakeStrategyBuilder`

---

### Task 4: assembleStrategyBundle (esbuild + manifest + hash)

**Files:**
- Create: `src/domain/strategy-bundle.ts`
- Test: `src/domain/strategy-bundle.test.ts`

**Interfaces:**
- Consumes: `StrategyBuilderOutput` (Task 3); SDK `createModuleManifest` (`@trading-backtester/sdk/builder:manifest.ts:36`), `computeBundleHash` (`hash.ts:23`).
- Produces: `AssembledStrategyBundle { bytes: Uint8Array; source: string; manifest: BundleManifest; bundleHash: string }`; `assembleStrategyBundle(o: StrategyBuilderOutput): Promise<AssembledStrategyBundle>`.

- [ ] **Step 1: Write the failing test:**
```ts
const out = await new FakeStrategyBuilder().build({ spec, authoringDoc: '' });
const a = await assembleStrategyBundle(out);
expect(a.manifest.kind).toBe('strategy');
expect(a.bundleHash).toMatch(/^sha256:[0-9a-f]{64}$/);
expect(/\b(import|require)\s*[(.]|\bfrom\s+['"]/.test(new TextDecoder().decode(a.bytes).replace(/export\s+default/g,''))).toBe(false);
const a2 = await assembleStrategyBundle(out);
expect(a2.bundleHash).toBe(a.bundleHash);            // determinism
```
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement** — `assembleStrategyBundle`: `esbuild.build({ stdin:{contents:o.source, loader:'ts'}, bundle:true, format:'esm', platform:'neutral', write:false, logLevel:'silent' })` → `bytes = outputFiles[0].contents`; assert self-contained (throw on import/require leftovers — infra-level); `manifest = createModuleManifest({ kind:'strategy', ...o.manifestMeta })`; `bundleHash = computeBundleHash(bytes)`.
- [ ] **Step 4: Run, verify it passes.**
- [ ] **Step 5: Commit** — `feat(strategy-authoring): assembleStrategyBundle (esbuild ESM + SDK manifest + computeBundleHash)`

---

### Task 5: validateStrategyBundle (ambient/self-contained scan; SDK-017 deferred)

**Files:**
- Create: `src/validation/strategy-bundle-validator.ts`
- Test: `src/validation/strategy-bundle-validator.test.ts`

**Interfaces:**
- Consumes: `AssembledStrategyBundle` (Task 4).
- Produces: `type ValidationVerdict = {status:'valid'} | {status:'rejected'; reason:string; violations:string[]}`; `validateStrategyBundle(a): ValidationVerdict`.

> **Scope note (resolved post-grounding):** `@trading-platform/sdk/validation` (017 kernel `validate`) is NOT exported by lab's installed `@trading-platform/sdk` 0.5.0 (the `./validation` kernel export landed in 0.7.x). For F1 the composite's **SDK-017 manifest-validate half is DEFERRED** (follow-on: bump platform-SDK ≥0.7.x). The backtester acceptance-gate (`validateBundle` in `produceStrategyEvidence`, `platformContractContext`) validates manifest-contract downstream, so F1 does not lose contract coverage. The lab-side gate for F1 = the **ambient/self-contained scan** (the F2-critical "reject untrusted LLM code" check). Design's `ValidationVerdict` union + fail-closed behavior are unchanged.

- [ ] **Step 1: Write the failing test** — valid assembled bundle (the clean shortAfterPump twin) → `{status:'valid'}`; an assembled bundle whose source contains ambient authority (e.g. `process.env`/`eval(`) → `{status:'rejected', reason:'forbidden_ambient_authority', violations: non-empty}` (do NOT throw); (esbuild-unbuildable is covered in Task 4's throw path).
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement** — `validateStrategyBundle` = self-contained/ambient lexical scan over `a.source` mirroring platform `scanAmbientAuthority`: flag `process.`(env|binding|exit|kill|mainModule)/`require(`/`import(`/`eval(`/`new Function(`/node-builtin module strings (`'fs'`,`'net'`,`'child_process'`, etc.) → on hit `{status:'rejected', reason:'forbidden_ambient_authority', violations}`; else `{status:'valid'}`. (SDK-017 manifest-validate deferred per scope note above — leave a `// TODO(sdk-0.7): add SDK validate() manifest gate` marker, no SDK import.)
- [ ] **Step 4: Run, verify it passes.**
- [ ] **Step 5: Commit** — `feat(strategy-authoring): validateStrategyBundle (ambient/self-contained scan; SDK-017 deferred to platform-sdk 0.7)`

---

### Task 6: BacktesterStrategyPort + programmable FixtureBacktesterAdapter

**Files:**
- Create: `src/ports/backtester-strategy.port.ts`, `src/adapters/platform/fixture-backtester.adapter.ts`
- Test: `src/adapters/platform/fixture-backtester.adapter.test.ts`

**Interfaces:**
- Produces: `StrategyRunSubmission { bundleBytes; bundleHash; manifest; curatedBundleHash: string; scope }`; `StrategyRunResult { status:'signed'|'equivalent'|'divergent'|'rejected'|'unavailable'; resultHash?; evidence?; divergence? }`; `BacktesterStrategyPort { submitStrategyRun(s): Promise<StrategyRunResult> }`.

- [ ] **Step 1: Write the failing test** — `new FixtureBacktesterAdapter({ outcome: o }).submitStrategyRun(sub)` returns the configured outcome, for EACH of `signed`(+canned evidence), `equivalent`(+resultHash), `divergent`(+divergence), `rejected`, `unavailable`.
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement** — port types + `FixtureBacktesterAdapter` constructed with a programmable `outcome` (default `signed`); canned evidence shaped per `backtest-evidence/v1` (`{ body:{schema:'backtest-evidence/v1', backtesterRunId:'fixture', bundleHash: sub.bundleHash, verdict:'passed', datasetRef, window, symbols, timeframe, keyId:'fixture' }, signature:'fixture' }`).
- [ ] **Step 4: Run, verify it passes.**
- [ ] **Step 5: Commit** — `feat(strategy-authoring): BacktesterStrategyPort + programmable FixtureBacktesterAdapter`

---

### Task 7: authorStrategyBundleHandler (orchestration, hermetic)

**Files:**
- Create: `src/orchestrator/handlers/author-strategy-bundle.handler.ts`
- Test: `src/orchestrator/handlers/author-strategy-bundle.handler.test.ts`

**Interfaces:**
- Consumes: Tasks 3-6 (`StrategyBuilder`, `assembleStrategyBundle`, `validateStrategyBundle`, `BacktesterStrategyPort`); `services` DI bag (mirror `hypothesisBuildHandler` `:32`) with `{ strategyBuilder, artifacts, backtesterStrategy }`.
- Produces: `authorStrategyBundleHandler(input, services): Promise<{ bundleRef; bundleHash; evidenceRef?; status }>`.

- [ ] **Step 1: Write the failing tests** — (a) happy: `FixtureBacktesterAdapter({outcome:'signed'})` → result `{status:'signed', bundleRef, bundleHash, evidenceRef}`; bundle persisted (`artifacts.put` kind `strategy_bundle`), evidence persisted (kind `backtest_evidence`). (b) `strategy-outcomes` (parametrized over `equivalent|divergent|rejected|unavailable`): correct status returned; **bundle persisted on every non-throw outcome**; **evidence persisted ONLY on signed**; re-running same input → same `bundleRef` (idempotent). (c) validate-reject path: inject ambient source → `{status:'rejected'}`, **no submit** (spy backtester not called).
- [ ] **Step 2: Run, verify they fail.**
- [ ] **Step 3: Implement** the handler flow exactly per design §3 (author → assemble → validate(rejected→return, no submit) → persist bundle → submit → on signed persist evidence → return). All non-happy outcomes are normal returns.
- [ ] **Step 4: Run, verify they pass.**
- [ ] **Step 5: Commit** — `feat(strategy-authoring): authorStrategyBundleHandler + full hermetic outcome coverage`

---

### Task 8: HttpBacktesterAdapter.submitStrategyRun (real wire)

**Files:**
- Modify: `src/adapters/platform/http-backtester.adapter.ts` (add `submitStrategyRun`, implement `BacktesterStrategyPort`)
- Test: `src/adapters/platform/http-backtester.adapter.strategy.test.ts`

**Interfaces:**
- Consumes: `this.client.submitRun(req)` + result fetch (mirror `submitOverlayRun` `:212`). Request: `RunSubmitRequest` (`@trading-backtester/sdk` `contracts/run.ts:44`) with `engine:'strategy'`, `moduleBundle` (the assembled strategy bundle as backtester `ModuleBundle`), `moduleRef = { id, version }` of the bundle's OWN manifest (NOT a preset), no `overlayRefs`, `datasetRef/symbols/timeframe/period/seed`, `mode:'research'`.
- Produces: `StrategyRunResult` via resultHash compare.

- [ ] **Step 1: Write the failing test** — construct `HttpBacktesterAdapter({ ..., goldenResultHash: GOLDEN })` (adapter-level config; `GOLDEN` = shortAfterPump golden result_hash, the `0be9931c` anchor — NOT `curatedBundleHash`, which is reserved for the future signed-evidence curated-vs-candidate path). Mock `client.submitRun` → `{jobId}`, mock result fetch → `{resultSummary:{resultHash}}`; assert `submitStrategyRun` returns `{status:'equivalent', resultHash}` when `resultHash === GOLDEN`, `{status:'divergent', divergence}` otherwise, `{status:'unavailable'}` on client throw.
- [ ] **Step 2: Run, verify it fails.**
- [ ] **Step 3: Implement** — build the `engine:'strategy'` request, `submitRun` → poll `GET /v1/runs/:runId/result` → `resultHash`; compare against the adapter's configured `goldenResultHash`; map to `equivalent|divergent`; wrap connection/timeout → `unavailable` (no throw). (`curatedBundleHash` from the submission is passed through to the backtester unchanged for forward-compat, not used for the resultHash compare.)
- [ ] **Step 4: Run, verify it passes.**
- [ ] **Step 5: Commit** — `feat(strategy-authoring): HttpBacktesterAdapter.submitStrategyRun (engine:strategy, resultHash equivalence)`

---

### Task 9: Docker integration — real strategy-route equivalence

**Files:**
- Create: `src/adapters/platform/strategy-route-equivalence.integration.test.ts`

**Interfaces:**
- Consumes: full lane (Tasks 3-8) + real backtester via `HttpBacktesterAdapter`.

- [ ] **Step 1: Write the integration test** (Docker-gated, skip if backtester URL unset) — author twin → `assembleStrategyBundle` → `submitStrategyRun` against REAL backtester → assert `status:'equivalent'` AND `resultHash === '…0be9931c…'` (golden) AND `evidence.bundleHash`-pin note deferred (signed-evidence not over HTTP yet).
- [ ] **Step 2: Run against Docker backtester** — `BACKTESTER_URL=… pnpm vitest run …integration.test.ts` → PASS (golden match).
- [ ] **Step 3: Commit** — `test(strategy-authoring): Docker integration — lab-authored shortAfterPump == golden 0be9931c via strategy-route`

---

### Task 10: Wire into `pnpm check` + final regress

**Files:**
- Modify: test config / `pnpm check` glob if needed (hermetic tests auto-included; integration excluded).

- [ ] **Step 1:** Confirm all hermetic `*.test.ts` (Tasks 1-8) run under `pnpm check`; `*.integration.test.ts` excluded.
- [ ] **Step 2: Run** `pnpm check` → EXIT 0 (no overlay-lane regression).
- [ ] **Step 3: Commit** — `chore(strategy-authoring): wire strategy-lane hermetic tests into pnpm check`

---

## Self-Review

- **Spec coverage:** Architecture(§1)→Tasks 3-8; Components(§2)→Tasks 3-8 (each port=task); Data-flow(§3)→Task 7; Error-handling(§4: taxonomy + persist-before-submit + fail-closed)→Task 7 tests; Testing(§5: hermetic full taxonomy + Docker golden)→Tasks 6/7/9. Cross-repo contract(§Variant-2/hash)→Tasks 1/4/8 + Global Constraints. All sections mapped.
- **Placeholder scan:** SDK `validate` exact signature (Task 5) + esbuild floor (Task 1) flagged as confirm-at-impl against installed packages — not placeholders, explicit confirm-steps. Twin source = verbatim port from exact path (Task 2).
- **Type consistency:** `StrategyRunResult`/`ValidationVerdict`/`AssembledStrategyBundle`/`StrategyManifestMeta` names consistent across Tasks 3-8; `curatedBundleHash` typed `string` ('sha256:hex'); `status` enum identical in port (Task 6) + handler (Task 7) + http (Task 8).

## Deltas from design (post-grounding)

- Stand-in source = byte-twin from `short-after-pump.bundle.json` (not SDK generic example).
- `StrategyRunResult` += `equivalent` + `resultHash`; integration tier proves `equivalent` (resultHash==golden), real signed-evidence-over-HTTP deferred (backtester follow-on); hermetic fixture still exercises `signed`+evidence path.
- SDK floor bump 0.2.0→0.3.0 + esbuild added (Global Constraints).
