import type { BotRunResultDetail, ClosedTrade } from '../../ports/bot-results-read.port.ts';

export interface BotResultsDigestOptions {
  readonly worstTradesLimit?: number;
}

function num(value: string | number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function holdingMinutes(trade: ClosedTrade): number | null {
  if (trade.closedAtMs === null) return null;
  return round2((trade.closedAtMs - trade.openedAtMs) / 60_000);
}

function avgHoldingMinutes(trades: readonly ClosedTrade[]): number | null {
  const durations = trades.map(holdingMinutes).filter((v): v is number => v !== null);
  if (durations.length === 0) return null;
  return round2(durations.reduce((sum, v) => sum + v, 0) / durations.length);
}

function exitReasonText(exitReasons: Record<string, number>): string {
  const entries = Object.entries(exitReasons).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return entries.length > 0 ? entries.map(([reason, count]) => `${reason}:${count}`).join(', ') : '(none)';
}

function worstTradesText(trades: readonly ClosedTrade[], limit: number): string[] {
  return trades
    .filter((trade) => num(trade.realizedPnl) < 0)
    .slice()
    .sort((a, b) => num(a.realizedPnl) - num(b.realizedPnl))
    .slice(0, limit)
    .map((trade) => {
      const hold = holdingMinutes(trade);
      return `  - ${trade.symbol} pnlUsd=${trade.realizedPnl} pnlPct=${trade.pnlPct}`
        + ` holdingMinutes=${hold ?? 'unknown'} closeReason=${trade.closeReason ?? 'unknown'}`;
    });
}

export function buildBotResultsDigestText(
  details: readonly BotRunResultDetail[] | undefined,
  options: BotResultsDigestOptions = {},
): string | null {
  if (!details || details.length === 0) return null;
  const worstTradesLimit = options.worstTradesLimit ?? 5;

  const lines = ['Live/paper bot performance evidence (use this to infer what failed and propose targeted, falsifiable improvements):'];
  for (const detail of details) {
    const avgHold = avgHoldingMinutes(detail.trades);
    lines.push(
      `- ${detail.run.strategy.name}@${detail.run.strategy.version} [${detail.run.mode}/${detail.run.status}]`
      + ` runId=${detail.run.runId} symbols=${detail.run.symbols.join(',') || '(none)'}`
      + ` trades=${detail.summary.closedTrades} winratePct=${detail.summary.winratePct}`
      + ` pnlUsd=${detail.summary.pnlUsd} avgPnl=${detail.summary.avgPnl}`
      + ` avgHoldingMinutes=${avgHold ?? 'unknown'}`
      + ` exitReasons=${exitReasonText(detail.summary.exitReasons)}`,
    );

    const worst = worstTradesText(detail.trades, worstTradesLimit);
    if (worst.length > 0) {
      lines.push('Worst losing trades:');
      lines.push(...worst);
    }
  }
  return lines.join('\n');
}
