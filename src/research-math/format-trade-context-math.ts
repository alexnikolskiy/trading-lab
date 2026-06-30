import type { TradeContextMath } from './trade-context-math.ts';
import type { TermMath, TermMathRow } from './market-context-math.ts';
import { summaryLine, rowLine, isoMinute, tableHeaderLines } from './format-market-context-math.ts';

function summariesFor(label: string, terms: readonly TermMath[]): string[] {
  return terms.map((t) => `${label} ${t.config.label}: ${summaryLine(t)}`);
}

function rowLineMarked(r: TermMathRow, exitMs: number): string {
  return r.tsMs === exitMs ? `${rowLine(r)} ← exit` : rowLine(r);
}

export function formatTradeContextMath(tc: TradeContextMath): string {
  const pnlPct = tc.pnlPct == null ? '' : ` (${tc.pnlPct >= 0 ? '+' : ''}${tc.pnlPct.toFixed(2)}%)`;
  const durMin = Math.round((tc.exitMs - tc.entryMs) / 60_000);
  const lines: string[] = [
    `### Trade ${tc.tradeId} · ${tc.symbol} · pnl ${tc.realizedPnl.toFixed(2)}${pnlPct} · close=${tc.closeReason ?? 'unknown'}`,
    `entry ${isoMinute(tc.entryMs)} → exit ${isoMinute(tc.exitMs)} (${durMin}m)`,
    ...summariesFor('@entry', tc.atEntry),
    ...summariesFor('@exit', tc.atExit),
  ];
  if (tc.postExitMs != null && tc.postExitMs > tc.exitMs && tc.atPostExit.length > 0) {
    const tailMin = Math.round((tc.postExitMs - tc.exitMs) / 60_000);
    lines.push(...summariesFor(`@post (exit+${tailMin}m)`, tc.atPostExit));
  } else {
    lines.push('@post n/a');
  }
  const micro = tc.atPostExit.find((t) => t.config.key === 'micro') ?? tc.atExit.find((t) => t.config.key === 'micro');
  if (micro && tc.microRows.length > 0) {
    const [cols, sep] = tableHeaderLines(micro.config);
    lines.push(cols, sep, ...tc.microRows.map((r) => rowLineMarked(r, tc.exitMs)));
  }
  if (tc.notes.length > 0) lines.push(`> Notes: ${tc.notes.join(' ')}`);
  return lines.join('\n');
}

export function formatTradeContexts(tcs: readonly TradeContextMath[], kind: 'losing' | 'winning' = 'losing'): string {
  if (tcs.length === 0) return '';
  return [`## Per-trade context (${kind} trades)`, '', ...tcs.map((tc) => formatTradeContextMath(tc) + '\n')]
    .join('\n').trimEnd() + '\n';
}
