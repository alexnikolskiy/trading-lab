# Code-Analyst (code→profile) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Научить аналитик lab точно извлекать `StrategyProfile` из КОДА стратегии (возможно multi-file): ветка `bot_code`-промпта в существующем аналитике + multi-file input helper + gated round-trip валидация на curated long_oi.

**Architecture:** Без нового агента/порта/kind. `bot_code` уже в `SOURCE_KINDS`; `buildPrompt(input)` в `MastraStrategyAnalyst` ветвится по kind (код → code-analysis guidance, текст → нынешний промпт; token-economy). Multi-file → `buildCodeSource(files)` конкатенирует в `content` с FILE-маркерами (схема входа `content:string` и выход `StrategyProfile` неизменны).

**Tech Stack:** TypeScript ESM (node22), vitest, Mastra-аналитик (`MastraStrategyAnalyst`), gpt-5.5.

## Global Constraints

- Все `.ts`/`.mts` ESM, импорты с расширением `.ts`.
- НЕ менять `SOURCE_KINDS`, `StrategyAnalystInputSchema` (`content` остаётся `string`), выход `AnalystProfileOutput`/`StrategyProfile`.
- НЕ менять поведение текстового пути аналитика — ветка ТОЛЬКО добавляет `bot_code`-guidance.
- `pnpm check` (vitest) ДОЛЖЕН оставаться зелёным; gated round-trip — ВНЕ vitest.
- FILE-маркер: ровно `// ===== FILE: <path> =====` (выровнен с code-analysis guidance в промпте).
- Проза в коммитах — допускается русский.

---

### Task 1: `buildCodeSource` + `CodeFile`

**Files:**
- Create: `src/domain/code-source.ts`
- Test: `src/domain/code-source.test.ts`

**Interfaces:**
- Produces: `interface CodeFile { readonly path: string; readonly content: string }`; `buildCodeSource(files: readonly CodeFile[]): string`.

- [ ] **Step 1: Падающий тест**

`src/domain/code-source.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildCodeSource } from './code-source.ts';

describe('buildCodeSource', () => {
  it('single file → FILE marker + content', () => {
    expect(buildCodeSource([{ path: 'a.ts', content: 'const x = 1;' }]))
      .toBe('// ===== FILE: a.ts =====\nconst x = 1;');
  });
  it('multiple files → markers in caller order, blank-line separated', () => {
    expect(buildCodeSource([{ path: 'a.ts', content: 'A' }, { path: 'b.ts', content: 'B' }]))
      .toBe('// ===== FILE: a.ts =====\nA\n\n// ===== FILE: b.ts =====\nB');
  });
  it('preserves caller order (no internal sort)', () => {
    const s = buildCodeSource([{ path: 'z.ts', content: 'Z' }, { path: 'a.ts', content: 'A' }]);
    expect(s.indexOf('z.ts')).toBeLessThan(s.indexOf('a.ts'));
  });
  it('empty list → empty string', () => {
    expect(buildCodeSource([])).toBe('');
  });
});
```

- [ ] **Step 2: Прогнать — FAIL**

Run: `cd <worktree> && npx vitest run src/domain/code-source.test.ts`
Expected: FAIL — `buildCodeSource` не определён.

- [ ] **Step 3: Реализация**

`src/domain/code-source.ts`:
```ts
/** Файл исходника стратегии для анализа: относительный путь + содержимое. */
export interface CodeFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Конкатенация файлов в единый source-блок с явными FILE-границами для LLM-анализа.
 * Порядок файлов сохраняется (вызывающий решает порядок). Маркер: `// ===== FILE: <path> =====`.
 */
export function buildCodeSource(files: readonly CodeFile[]): string {
  return files.map((f) => `// ===== FILE: ${f.path} =====\n${f.content}`).join('\n\n');
}
```

- [ ] **Step 4: Прогнать — PASS**

Run: `npx vitest run src/domain/code-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/domain/code-source.ts src/domain/code-source.test.ts
git commit -m "feat(code-analyst): buildCodeSource + CodeFile (multi-file → FILE-marked source)"
```

---

### Task 2: `readCodeDir`

**Files:**
- Create: `src/adapters/code-source/read-code-dir.ts`
- Test: `src/adapters/code-source/read-code-dir.test.ts`

**Interfaces:**
- Consumes: `CodeFile` (Task 1).
- Produces: `readCodeDir(dir: string, exts?: readonly string[]): CodeFile[]` — рекурсивно, детерминированный (лексикографический) порядок по path, исключая `*.test.ts`.

- [ ] **Step 1: Падающий тест**

`src/adapters/code-source/read-code-dir.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCodeDir } from './read-code-dir.ts';

describe('readCodeDir', () => {
  it('reads .ts recursively, sorted by path, excludes *.test.ts and non-.ts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rcd-'));
    try {
      writeFileSync(join(dir, 'b.ts'), 'B');
      writeFileSync(join(dir, 'a.ts'), 'A');
      writeFileSync(join(dir, 'a.test.ts'), 'TEST');
      writeFileSync(join(dir, 'readme.md'), 'MD');
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'c.ts'), 'C');
      const files = readCodeDir(dir);
      expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'sub/c.ts']);
      expect(files.find((f) => f.path === 'a.ts')?.content).toBe('A');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Прогнать — FAIL**

Run: `npx vitest run src/adapters/code-source/read-code-dir.test.ts`
Expected: FAIL — `readCodeDir` не определён.

- [ ] **Step 3: Реализация**

`src/adapters/code-source/read-code-dir.ts`:
```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { CodeFile } from '../../domain/code-source.ts';

/**
 * Рекурсивно читает исходные файлы из `dir` (по умолчанию `.ts`), исключая `*.test.ts`.
 * Возвращает CodeFile[] с path относительно `dir` (POSIX-разделители), в детерминированном
 * лексикографическом порядке. Источник = поведенческие файлы стратегии (вызывающий выбирает dir).
 */
export function readCodeDir(dir: string, exts: readonly string[] = ['.ts']): CodeFile[] {
  const out: CodeFile[] = [];
  const walk = (cur: string): void => {
    for (const name of readdirSync(cur).sort()) {
      const full = join(cur, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (name.endsWith('.test.ts')) continue;
      if (!exts.some((e) => name.endsWith(e))) continue;
      out.push({ path: relative(dir, full).split(sep).join('/'), content: readFileSync(full, 'utf8') });
    }
  };
  walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
```

- [ ] **Step 4: Прогнать — PASS**

Run: `npx vitest run src/adapters/code-source/read-code-dir.test.ts`
Expected: PASS.

- [ ] **Step 5: Коммит**

```bash
git add src/adapters/code-source/read-code-dir.ts src/adapters/code-source/read-code-dir.test.ts
git commit -m "feat(code-analyst): readCodeDir (recursive, deterministic, excludes tests)"
```

---

### Task 3: `buildPrompt` kind-branch (`bot_code` → code-analysis guidance)

**Files:**
- Modify: `src/adapters/analyst/mastra-strategy-analyst.ts`
- Test: `src/adapters/analyst/mastra-strategy-analyst.test.ts` (create if absent)

**Interfaces:**
- Consumes: `StrategyAnalystInput` (kinds incl. `bot_code`).
- Produces: `export function buildPrompt(input: StrategyAnalystInput): string` — `bot_code` несёт code-analysis guidance; текстовые kinds — нет (token-economy). `analyze()` поведение неизменно для текста.

- [ ] **Step 1: Падающий тест**

`src/adapters/analyst/mastra-strategy-analyst.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildPrompt } from './mastra-strategy-analyst.ts';

describe('buildPrompt kind branching', () => {
  it('bot_code carries code-analysis guidance (exact/exhaustive/off-by-one)', () => {
    const p = buildPrompt({ kind: 'bot_code', content: '// ===== FILE: a.ts =====\nconst d = 10;' });
    expect(p).toContain('COMPLETE implementation');
    expect(p).toContain('EXACT');
    expect(p).toContain('off-by-one');
    expect(p).toContain('const d = 10;');
  });
  it('text kinds do NOT carry code-analysis guidance (token economy)', () => {
    const p = buildPrompt({ kind: 'manual_description', content: 'buy the rebound' });
    expect(p).not.toContain('COMPLETE implementation');
    expect(p).not.toContain('off-by-one');
    expect(p).toContain('buy the rebound');
    expect(p).toContain('Source kind: manual_description');
  });
});
```

- [ ] **Step 2: Прогнать — FAIL**

Run: `npx vitest run src/adapters/analyst/mastra-strategy-analyst.test.ts`
Expected: FAIL — `buildPrompt` не экспортирован (сейчас module-private).

- [ ] **Step 3: Реализация — экспорт + ветка**

В `src/adapters/analyst/mastra-strategy-analyst.ts` заменить приватную `buildPrompt` на экспортируемую с веткой по kind (добавить константу-guidance над ней):
```ts
const CODE_ANALYSIS_GUIDANCE =
  'The SOURCE below is the COMPLETE implementation of a trading strategy (one or more files, each ' +
  'delimited by a `// ===== FILE: <path> =====` marker). Extract an EXACT, exhaustive profile: every ' +
  'parameter default, numeric threshold, window length, index offset, gate condition, and the precise ' +
  'comparison/formula. Capture fine-grained gates (warmup bar count, OI-recovery percent over N buckets, ' +
  'liquidation minima and liq/OI ratios, dump-quality filters, off-by-one indexing). Do NOT approximate ' +
  'or summarize — a builder must reproduce the EXACT runtime behavior from this profile. Put ' +
  'genuinely-absent details in `unknowns`.';

export function buildPrompt(input: StrategyAnalystInput): string {
  const header =
    `Source kind: ${input.kind}` +
    (input.title ? `\nTitle: ${input.title}` : '') +
    (input.uri ? `\nURI: ${input.uri}` : '');
  const guidance = input.kind === 'bot_code' ? `\n\n${CODE_ANALYSIS_GUIDANCE}` : '';
  return `${header}${guidance}\n\n--- SOURCE START ---\n${input.content}\n--- SOURCE END ---\n\nReturn the structured strategy profile.`;
}
```
`analyze()` продолжает звать `buildPrompt(input)` — менять не нужно.

- [ ] **Step 4: Прогнать — PASS (новый файл + регресс адаптера)**

Run: `npx vitest run src/adapters/analyst/mastra-strategy-analyst.test.ts`
Expected: PASS (обе ветки).

- [ ] **Step 5: Коммит**

```bash
git add src/adapters/analyst/mastra-strategy-analyst.ts src/adapters/analyst/mastra-strategy-analyst.test.ts
git commit -m "feat(code-analyst): bot_code prompt branch (exact code-analysis guidance; token-economy)"
```

---

### Task 4: Gated round-trip eval (ВНЕ vitest)

Заземление: повторяет паттерн `scripts/regen-long-oi-profile.mts` (composeMastra→analyst→wrap StrategyProfile) + `scripts/prove-builder-loop.mts` (builder + shell prove). Читает curated long_oi из ПЛАТФОРМЫ. Печатает профиль + вердикт; `proven` эмпиричен, НЕ ассертится.

**Files:**
- Create: `scripts/code-analyst-roundtrip.mts`

**Interfaces:**
- Consumes: `readCodeDir` (T2), `buildCodeSource` (T1), `composeMastra`, `MastraStrategyAnalyst`, `MastraStrategyBuilder`, `createStrategyBuilderAgent`, `assembleStrategyBundle`, `createShellBundleProver` (F2b `src/proof/`), `getAuthoringDoc`, `resolveLanguageModel`, `STRATEGY_PROFILE_CONTRACT_VERSION`, `sourceFingerprint`.
- Produces: исполняемый eval (manual).

- [ ] **Step 1: Скрипт**

`scripts/code-analyst-roundtrip.mts` (свериться с реальными конструкторами при impl — они в main; форма ниже каноническая):
```ts
/**
 * GATED round-trip eval (ВНЕ vitest): curated long_oi КОД → code-analyst → профиль → builder →
 * бандл → платформенный prove_bundle vs curated. Печатает профиль-сводку + вердикт.
 * Запуск:
 *   PLATFORM_REPO_PATH=/abs/trading-platform \
 *   MODEL_PROVIDER=openrouter OPENROUTER_API_KEY=... STRATEGY_BUILDER_MODEL=openrouter/openai/gpt-5.5 \
 *   STRATEGY_ANALYST_MODEL=openrouter/openai/gpt-5.5 \
 *   npx -y tsx scripts/code-analyst-roundtrip.mts
 * Предусловие: платформа собрана (`npm run build`); SDK ≥0.4.0 (market-tape authoring-doc).
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readCodeDir } from '../src/adapters/code-source/read-code-dir.ts';
import { buildCodeSource } from '../src/domain/code-source.ts';
import { composeMastra, type MastraCompositionEnv } from '../src/mastra/compose-mastra.ts';
import { MastraStrategyAnalyst } from '../src/adapters/analyst/mastra-strategy-analyst.ts';
import { MastraStrategyBuilder } from '../src/adapters/builder/mastra-strategy-builder.ts';
import { createStrategyBuilderAgent } from '../src/mastra/agents/strategy-builder.agent.ts';
import { assembleStrategyBundle } from '../src/domain/strategy-bundle.ts';
import { createShellBundleProver } from '../src/proof/shell-bundle-prover.ts';
import { getAuthoringDoc } from '@trading-backtester/sdk/builder';
import { resolveLanguageModel } from '../src/adapters/llm/model-provider.ts';
import { STRATEGY_PROFILE_CONTRACT_VERSION } from '../src/domain/strategy-profile.ts';
import { sourceFingerprint } from '../src/domain/fingerprint.ts';

const platformRepo = process.env['PLATFORM_REPO_PATH'] ?? resolve(process.cwd(), '../trading-platform');
const longOiDir = join(platformRepo, 'src/strategies/long_oi');
const cli = join(platformRepo, 'scripts/prove_bundle.mjs');

// 1) curated long_oi код → FILE-marked source
const files = readCodeDir(longOiDir);
const content = buildCodeSource(files);

// 2) реальный аналитик (composeMastra, STRATEGY_ANALYST_ADAPTER=mastra) → analyze(bot_code)
const base = process.env as unknown as Record<string, string | undefined>;
const env = {
  MODEL_PROVIDER: base['MODEL_PROVIDER'],
  ANTHROPIC_API_KEY: base['ANTHROPIC_API_KEY'], OPENAI_API_KEY: base['OPENAI_API_KEY'], OPENROUTER_API_KEY: base['OPENROUTER_API_KEY'],
  STRATEGY_ANALYST_ADAPTER: 'mastra', STRATEGY_ANALYST_MODEL: base['STRATEGY_ANALYST_MODEL'] ?? 'openrouter/openai/gpt-5.5',
  RESEARCHER_ADAPTER: 'fake', RESEARCHER_MODEL: 'fake', CRITIC_ADAPTER: 'fake', CRITIC_MODEL: 'fake', ENABLE_CRITIC_AGENT: false,
  TURN_INTERPRETER_ADAPTER: 'fake', TURN_INTERPRETER_MODEL: 'fake', BUILDER_ADAPTER: 'fake', BUILDER_MODEL: 'fake',
  STRATEGY_CRITIC_ADAPTER: 'fake', STRATEGY_CRITIC_MODE: 'two_stage', STRATEGY_CRITIC_MODEL: 'fake', STRATEGY_REFINER_MODEL: 'fake',
  PHOENIX_ENABLED: false, PHOENIX_COLLECTOR_ENDPOINT: 'http://localhost:6006/v1/traces', PHOENIX_PROJECT_NAME: 'trading-lab',
} as unknown as MastraCompositionEnv;
const runtime = composeMastra(env);
const aEntry = runtime.agents.analyst;
if (!aEntry) throw new Error('analyst agent not composed');
const analyst = new MastraStrategyAnalyst(aEntry.agent, aEntry.label);
const profileOut = await analyst.analyze({ kind: 'bot_code', content });

// 3) wrap AnalystProfileOutput → StrategyProfile (паттерн regen)
const fp = sourceFingerprint('bot_code', content);
const now = new Date().toISOString();
const profile = {
  id: randomUUID(), version: 1, sourceKind: 'bot_code', sourceFingerprint: fp,
  direction: profileOut.direction, coreIdea: profileOut.coreIdea, requiredMarketFeatures: profileOut.requiredMarketFeatures,
  confidence: profileOut.confidence, unknowns: profileOut.unknowns, profile: profileOut,
  sourceArtifactRef: { artifact_id: randomUUID(), uri: `artifacts/strategy_source/${fp}`, content_hash: fp,
    kind: 'strategy_source', size_bytes: Buffer.byteLength(content, 'utf8'), mime_type: 'text/plain',
    created_at: now, producer: 'scripts/code-analyst-roundtrip.mts', metadata: { sourceKind: 'bot_code', uri: null, title: null } },
  contractVersion: STRATEGY_PROFILE_CONTRACT_VERSION, createdAt: now, updatedAt: now,
};

// 4) реальный билдер → бандл (свериться с конструкторами F2a: MastraStrategyBuilder(agent, label))
const resolved = resolveLanguageModel(env as never, base['STRATEGY_BUILDER_MODEL'] ?? 'openrouter/openai/gpt-5.5');
const builder = new MastraStrategyBuilder(createStrategyBuilderAgent({ model: resolved.model, authoringDoc: getAuthoringDoc('strategy') }), resolved.label);
const out = await builder.build({ spec: { description: 'long oi rebound (code-analyst round-trip)' }, authoringDoc: getAuthoringDoc('strategy'), profile } as never);
const bundle = await assembleStrategyBundle(out);

// 5) прогон через платформенный prove_bundle vs curated
const verdict = await createShellBundleProver({ cli }).prove(bundle.source);

// eslint-disable-next-line no-console
console.log('[round-trip] params:', profileOut.parameters?.length, 'entryConditions:', profileOut.entryConditions?.length);
// eslint-disable-next-line no-console
console.log('[round-trip] verdict:', JSON.stringify(verdict, null, 2));
```
(Реализатор: свериться с точными сигнатурами `composeMastra` env / `runtime.agents.analyst` / `MastraStrategyBuilder` constructor / `StrategyProfile` поля в main — это единственный не-TDD таск, проверяется ручным прогоном. Типизация `as never` минимизировать там, где реальные типы выводятся.)

- [ ] **Step 2: Typecheck (не запуск LLM)**

Run: `npx tsc -p tsconfig.json` (eval вне include → отдельно: temp-tsconfig, extends-паттерн как у `prove-builder-loop.mts`). Report EXIT.
`npx vitest run` — полный сьют зелёный, `.mts` не подхвачен.

- [ ] **Step 3: Коммит**

```bash
git add scripts/code-analyst-roundtrip.mts
git commit -m "feat(code-analyst): gated round-trip eval (curated long_oi код → профиль → бандл vs curated)"
```

---

### Финал: регресс

- [ ] **Прогнать `pnpm check`** — vitest зелёный (T1–T3 герметичны; eval `.mts` вне глобов). Зафиксировать EXIT=0.

## Self-Review

**Spec coverage:** design §1 (multi-file helper) → T1+T2; §2 (prompt branching) → T3; §3 (round-trip validation) → T4; §Границы (bot_code reuse, StrategyProfile неизменен, текст-путь не трогаем) → Global Constraints + T3 (ветка только добавляет). Все секции покрыты.

**Placeholder-скан:** код полный в T1–T3. T4 (gated eval, не TDD-гейт) содержит «свериться с конструкторами» на composeMastra/MastraStrategyBuilder/StrategyProfile-полях — намеренно (eval wired реальные символы из main; точные сигнатуры реализатор подтверждает в их файлах, как в F2b T6). Не плейсхолдер логики.

**Type consistency:** `CodeFile`/`buildCodeSource` (T1) → `readCodeDir` (T2) → round-trip (T4); `buildPrompt` (T3) экспорт стабилен; round-trip wrap-поля совпадают с regen-паттерном (`profile: profileOut`, `contractVersion`, `sourceArtifactRef`).
