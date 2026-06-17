// src/experiments/intent-classifier/report.ts
// Human-readable markdown report for one eval round, written alongside the JSON artifacts.
// renderReport is a PURE function (markdown string from ManifestMeta + EvalRunResult + the dataset
// cases). Cases are passed in because CaseResult intentionally carries no message text — that keeps
// the JSON artifact / type contract unchanged; the renderer looks up messages by case id.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { rankAggregates } from './aggregate.ts';
import type { CandidateResult, EvalCase, EvalRunResult, ManifestMeta } from './types.ts';

const MSG_MAX = 80;

function f3(x: number): string {
  return x.toFixed(3);
}
function tick(b: boolean): string {
  return b ? '✓' : '✗';
}
function truncate(s: string, n = MSG_MAX): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Deterministic markdown render of an eval round. */
export function renderReport(meta: ManifestMeta, result: EvalRunResult, cases: EvalCase[]): string {
  const msgById = new Map(cases.map((c) => [c.id, c.message]));
  const ranked = rankAggregates(result.aggregates, result.judgeEnabled);
  const winner = ranked[0]?.model;

  // The flat perModel list is model-major then run index; keep the LAST run per model.
  const lastRunByModel = new Map<string, CandidateResult>();
  for (const r of result.perModel) lastRunByModel.set(r.model, r);

  const lines: string[] = [];

  // ---- Header ----
  lines.push('# IntentClassifier eval — report', '');
  lines.push(`- **timestamp:** ${meta.timestamp}`);
  lines.push(`- **gitSha:** ${meta.gitSha}`);
  lines.push(`- **harness:** ${meta.harnessVersion} · contract ${meta.contractVersion}`);
  lines.push(`- **dataset:** ${result.dataset.id} (\`${result.dataset.fingerprint}\`)`);
  lines.push(`- **caseCount:** ${result.dataset.caseCount}`);
  lines.push(`- **threshold:** ${result.threshold}`);
  lines.push(`- **repeat:** ${result.repeat}`);
  lines.push(`- **judge:** ${result.judgeEnabled ? 'enabled' : 'disabled'}`);
  lines.push(`- **models:** ${result.models.join(', ')}`);
  lines.push(`- **overallSuccess:** ${result.overallSuccess}`);
  lines.push('');

  // ---- Summary table (ranked) ----
  lines.push('## Summary (ranked)', '');
  const header = ['#', 'Model', 'Runs', 'passRate', 'Intent acc (mean±std)', 'Schema valid', 'Payload'];
  if (result.judgeEnabled) header.push('Judge');
  header.push('Latency (ms)');
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`|${header.map(() => '---').join('|')}|`);
  ranked.forEach((a, i) => {
    const name = a.model === winner ? `★ ${a.model}` : a.model;
    const det = a.det ? `${f3(a.det.mean)} ± ${f3(a.det.std)}` : '—';
    const schema = a.schemaValid ? f3(a.schemaValid.mean) : '—';
    const payload = a.payload ? f3(a.payload.mean) : '—';
    const row = [`${i + 1}`, name, `${a.runs.ok}/${a.runs.total}`, f3(a.passRate), det, schema, payload];
    if (result.judgeEnabled) row.push(a.judge ? f3(a.judge.mean) : '—');
    row.push(`${Math.round(a.latency.mean)}`);
    lines.push(`| ${row.join(' | ')} |`);
  });
  lines.push('');
  lines.push(
    '★ = winner (rank #1). **Intent acc** is the primary, ranked metric; **Schema valid** is the share of outputs that pass the strict ChatIntentSchema gate (what prod would accept) — informational, not a ranking key.',
    '',
  );

  // ---- Per-model sections (ranked order) ----
  for (const a of ranked) {
    lines.push(`## ${a.model}`, '');
    const last = lastRunByModel.get(a.model);
    if (!last || last.score == null) {
      const err = last?.error;
      lines.push(`Run failed: ${err ? `${err.type} — ${err.message}` : 'no score produced'}.`, '');
      continue;
    }
    const s = last.score;
    lines.push(
      `verdict: **${s.verdict}** · intent accuracy ${f3(s.intentAccuracy)} · ` +
        `payload ${s.payloadAccuracy != null ? f3(s.payloadAccuracy) : '—'} · ` +
        `${s.schemaValidCount}/${s.caseCount} schema-valid · runs ${a.runs.ok}/${a.runs.total}.`,
      '',
    );

    // Per-case table (last run).
    const ch = ['Case', 'Lang', 'Expected → Actual', 'Match', 'Schema', 'Payload', 'Latency (ms)', 'Error'];
    lines.push(`| ${ch.join(' | ')} |`);
    lines.push(`|${ch.map(() => '---').join('|')}|`);
    for (const c of s.cases) {
      const payload = c.payloadScore != null ? c.payloadScore.toFixed(2) : '—';
      lines.push(
        `| ${c.id} | ${c.lang} | ${c.expectedIntent} → ${c.actualIntent ?? '—'} | ` +
          `${tick(c.intentMatch)} | ${tick(c.schemaValid)} | ${payload} | ${c.latencyMs} | ${c.error ? c.error.type : ''} |`,
      );
    }
    lines.push('');

    // Mislabels — failures only, with truncated message text.
    const mislabels = s.cases.filter((c) => !c.intentMatch);
    lines.push(`**Mislabels (${mislabels.length}):**`, '');
    if (mislabels.length === 0) {
      lines.push('_none._', '');
    } else {
      for (const c of mislabels) {
        const tag = c.schemaValid ? '' : ' _(schema-invalid)_';
        lines.push(`- ${c.expectedIntent} → ${c.actualIntent ?? '—'}${tag} — "${truncate(msgById.get(c.id) ?? '')}"`);
      }
      lines.push('');
    }

    // Intent correct but the object failed the strict gate — invisible to Mislabels (intentMatch=true),
    // surfaced here so the "prod would reject this" signal is not lost.
    const schemaInvalidButRight = s.cases.filter((c) => c.intentMatch && !c.schemaValid);
    if (schemaInvalidButRight.length > 0) {
      lines.push(`**Schema-invalid but intent correct (${schemaInvalidButRight.length}):**`, '');
      for (const c of schemaInvalidButRight) {
        lines.push(`- ${c.actualIntent ?? c.expectedIntent} _(schema-invalid)_ — "${truncate(msgById.get(c.id) ?? '')}"`);
      }
      lines.push('');
    }

    // Judge verdict (only when this run produced one).
    if (last.judge) {
      const j = last.judge;
      lines.push(`### Judge verdict (overall ${f3(j.overallScore)})`, '');
      for (const d of j.dimensions) lines.push(`- **${d.name}** (${f3(d.score)}): ${d.rationale}`);
      if (j.dimensions.length) lines.push('');
      if (j.disputedCases.length) {
        lines.push('Disputed cases:');
        for (const dc of j.disputedCases) lines.push(`- ${dc.id}: ${dc.note}`);
        lines.push('');
      }
      lines.push(`Notes: ${j.notes}`, '');
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Writes report.md into outDir and returns its path. Content is exactly renderReport(...). */
export function writeReport(outDir: string, meta: ManifestMeta, result: EvalRunResult, cases: EvalCase[]): string {
  const path = join(outDir, 'report.md');
  writeFileSync(path, renderReport(meta, result, cases), 'utf8');
  return path;
}
