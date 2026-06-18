import { ResearcherOutputSchema } from '../../domain/hypothesis.ts';
import type { StrategyProfile } from '../../domain/strategy-profile.ts';
import type { BotRunResultDetail } from '../../ports/bot-results-read.port.ts';
import type { TradeEvidenceBundle } from '../../ports/trade-evidence-read.port.ts';
import type { CheckResult, ScoreResult } from './types.ts';

const DEFAULT_THRESHOLD = 0.7;

function textOf(raw: unknown): string {
  return JSON.stringify(raw).toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function check(id: string, weight: number, haystack: string, patterns: RegExp[], minMatches = 1): CheckResult {
  const matched = patterns.filter((p) => p.test(haystack)).map((p) => p.source);
  const contribution = matched.length === 0 ? 0 : weight * Math.min(matched.length / Math.max(minMatches, 1), 1);
  return { id, weight, contribution, matched };
}

function profileSpecificPatterns(profile: StrategyProfile | undefined): RegExp[] {
  if (!profile) return [];
  const details = (profile.profile ?? {}) as Partial<StrategyProfile['profile']>;
  const text = [
    profile.coreIdea,
    details.summary ?? '',
    ...(details.entryConditions ?? []),
    ...(details.exitConditions ?? []),
    details.positionManagementSummary ?? '',
  ].join(' ').toLowerCase();
  const patterns: RegExp[] = [];
  if (text.includes('10%')) patterns.push(/10\s*%/);
  if (text.includes('3.5%')) patterns.push(/3(?:[.,])?5\s*%/);
  if (text.includes('5%')) patterns.push(/(?:^|[^0-9.])5\s*%/);
  if (text.includes('12%')) patterns.push(/12\s*%/);
  if (text.includes('180 minutes')) patterns.push(/180\s*(minutes?|mins?|m)\b/);
  if (text.includes('dca')) patterns.push(/\bdca\b|усредн/);
  if (text.includes('breakeven') || text.includes('(be)')) patterns.push(/\bbreakeven\b|\bbe\b|безубыт/);
  if (text.includes('open interest') || text.includes('oi')) patterns.push(/\boi\b|open interest/);
  if (text.includes('liquidations')) patterns.push(/liquidation/);
  if (text.includes('dump')) patterns.push(/dump|sharp dump|пролив/);
  if (text.includes('bounce')) patterns.push(/bounce|reversal|отскок/);
  return patterns;
}

function evidenceSpecificPatterns(
  botResults: readonly BotRunResultDetail[] | undefined,
  tradeEvidence: readonly TradeEvidenceBundle[] | undefined,
): RegExp[] {
  const symbols = unique((botResults ?? [])
    .flatMap((detail) => detail.trades)
    .filter((trade) => Number(trade.realizedPnl) < 0)
    .map((trade) => trade.symbol.toLowerCase())
    .slice(0, 5));
  const closeReasons = unique([
    ...(botResults ?? []).flatMap((detail) => detail.trades)
      .filter((trade) => Number(trade.realizedPnl) < 0)
      .map((trade) => trade.closeReason?.toLowerCase())
      .filter((reason): reason is string => Boolean(reason)),
    ...(tradeEvidence ?? [])
      .map((bundle) => bundle.closeReason?.toLowerCase())
      .filter((reason): reason is string => Boolean(reason)),
  ]);
  const eventTypes = unique((tradeEvidence ?? [])
    .flatMap((bundle) => bundle.lifecycleEvents)
    .map((event) => event.type.toLowerCase())
    .filter((type) => type !== 'entry'));

  return [
    ...symbols.map((symbol) => new RegExp(escapeRegExp(symbol), 'i')),
    ...closeReasons.map((reason) => new RegExp(escapeRegExp(reason), 'i')),
    ...eventTypes.map((type) => new RegExp(`\\b${escapeRegExp(type)}\\b`, 'i')),
  ];
}

const FORBIDDEN = /\b(place|submit|execute|cancel)\s+(live\s+)?orders?\b|\bleverage\s*[:=]?\s*\d|\bdeploy\b|\bapi[_ -]?key\b|секрет|ордер/i;

export function scoreResearcherOutput(
  raw: unknown,
  opts: {
    threshold?: number;
    profile?: StrategyProfile;
    botResults?: readonly BotRunResultDetail[];
    tradeEvidence?: readonly TradeEvidenceBundle[];
  } = {},
): ScoreResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const parsed = ResearcherOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      gates: { schemaValid: false, hasHypothesis: false, researchOnly: false, contextGrounded: false },
      checks: [],
      score: 0,
      threshold,
      verdict: 'FAIL',
    };
  }

  const output = parsed.data;
  const haystack = textOf(output);
  const profileGrounding = check('profile_specificity', 0.1, haystack, profileSpecificPatterns(opts.profile), 2);
  const evidenceGrounding = check('evidence_specificity', 0.15, haystack, evidenceSpecificPatterns(opts.botResults, opts.tradeEvidence), 2);
  const needsProfileGrounding = profileSpecificPatterns(opts.profile).length > 0;
  const needsEvidenceGrounding = evidenceSpecificPatterns(opts.botResults, opts.tradeEvidence).length > 0;
  const gates = {
    schemaValid: true,
    hasHypothesis: output.hypotheses.length > 0,
    researchOnly: !FORBIDDEN.test(haystack),
    contextGrounded: (!needsProfileGrounding || profileGrounding.contribution > 0)
      && (!needsEvidenceGrounding || evidenceGrounding.contribution > 0),
  };

  const checks: CheckResult[] = [
    check('uses_bot_results', 0.2, haystack, [/bot results?/, /\btrade/, /\bpnl\b/, /winrate/, /stop[_ -]?loss|be_stop|hard_stop|time_exit/, /holding/], 2),
    check('falsifiable_validation', 0.2, haystack, [/reject if/, /invalidation/, /compare/, /replay/, /does not improve/, /falls/], 2),
    check('targets_failure_pattern', 0.15, haystack, [/loss/, /negative/, /stop[_ -]?loss|be_stop|hard_stop|time_exit/, /slow/, /late/, /holding/], 2),
    check('builder_ready_overlay', 0.1, haystack, [/skip_entry|allow_entry|scale_in|scale_out|tighten_stop|widen_stop|exit_now|adjust_size|no_op/]),
    check('metric_specific', 0.1, haystack, [/pnl/, /winrate/, /holding/, /trade/], 2),
    profileGrounding,
    evidenceGrounding,
  ];

  const score = checks.reduce((sum, c) => sum + c.contribution, 0);
  const verdict = gates.schemaValid && gates.hasHypothesis && gates.researchOnly && gates.contextGrounded && score >= threshold ? 'PASS' : 'FAIL';
  return { gates, checks, score, threshold, verdict };
}
