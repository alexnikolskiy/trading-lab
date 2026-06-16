// src/experiments/strategy-analyst/scoring.ts
import { AnalystProfileOutputSchema, type AnalystProfileOutput } from '../../domain/strategy-profile.ts';
import type { CheckResult, ScoreResult } from './types.ts';

export const DEFAULT_THRESHOLD = 0.8;

/** A bucket is satisfied when ANY of its regex sources matches the haystack (case-insensitive). */
interface Bucket {
  label: string;
  any: string[]; // regex sources
}

interface PositiveCheckDef {
  id: string;
  weight: number;
  primary: (p: AnalystProfileOutput) => string;
  fallback?: (p: AnalystProfileOutput) => string;
  buckets: Bucket[];
}

function joinFields(...parts: Array<string | string[] | null | undefined>): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part == null) continue;
    if (Array.isArray(part)) out.push(part.join(' • '));
    else out.push(part);
  }
  return out.join(' • ').toLowerCase();
}

function matchBuckets(haystack: string, buckets: Bucket[]): { hits: number; matched: string[] } {
  const matched: string[] = [];
  for (const bucket of buckets) {
    const hit = bucket.any.some((src) => new RegExp(src, 'i').test(haystack));
    if (hit) matched.push(bucket.label);
  }
  return { hits: matched.length, matched };
}

// --- lexicon (EN + RU synonyms; short ASCII tokens use \b boundaries to avoid false positives) ---
const OI: Bucket = { label: 'oi', any: ['\\boi\\b', 'open[ _]?interest', 'интерес'] };
const LIQ: Bucket = { label: 'liquidations', any: ['liquidation', '\\bliq\\b', 'ликвидац'] };

const POSITIVE_CHECKS: PositiveCheckDef[] = [
  {
    id: 'market_features',
    weight: 0.2,
    primary: (p) => joinFields(p.requiredMarketFeatures),
    fallback: (p) => joinFields(p.summary, p.coreIdea),
    buckets: [
      { label: 'ohlcv', any: ['ohlcv', 'candle', 'свеч', 'klines', '\\bprice\\b'] },
      OI,
      LIQ,
    ],
  },
  {
    id: 'entry_trigger',
    weight: 0.2,
    primary: (p) => joinFields(p.entryConditions),
    fallback: (p) => joinFields(p.summary, p.coreIdea),
    buckets: [
      { label: 'dump', any: ['dump', 'drop', 'sell[ -]?off', 'crash', 'пролив', 'падени', 'обвал'] },
      { label: 'bounce', any: ['bounce', 'rebound', 'revers', 'отскок', 'разворот', 'восстановлен'] },
      OI,
      LIQ,
    ],
  },
  {
    id: 'exit_ladder',
    weight: 0.2,
    primary: (p) => joinFields(p.exitConditions),
    fallback: (p) => joinFields(p.summary),
    buckets: [
      { label: 'tp1', any: ['tp[ _]?1', 'take[ _]?profit[ _]?1', '3\\.5\\s*%', '\\+3\\.5', 'первый\\s+тейк'] },
      { label: 'tp2', any: ['tp[ _]?2', 'take[ _]?profit[ _]?2', '(?<![.\\d])5\\s*%', 'второй\\s+тейк'] },
      { label: 'sl', any: ['\\bsl\\b', 'stop[ -]?loss', 'hard[ _]?stop', 'стоп', '12\\s*%'] },
      { label: 'time', any: ['time[ _]?exit', 'time[ -]?based', '\\b180\\b', 'timeout', 'по\\s+времени', 'времен'] },
    ],
  },
  {
    id: 'position_mgmt',
    weight: 0.15,
    primary: (p) => joinFields(p.positionManagementSummary),
    fallback: (p) => joinFields(p.summary),
    buckets: [
      { label: 'dca', any: ['\\bdca\\b', 'averag', 'add[ _]?to[ _]?position', 'scal\\w*\\s*in', 'усреднен', 'доливк', 'докуп'] },
      { label: 'breakeven', any: ['break[ _-]?even', '\\bbe\\b', 'безубыт'] },
    ],
  },
  {
    id: 'unknowns_flagged',
    weight: 0.1,
    primary: (p) => joinFields(p.unknowns),
    buckets: [
      { label: 'sizing', any: ['\\bsiz', 'leverage', 'плеч', 'equity', 'марж'] },
      { label: 'fees', any: ['\\bfee', 'commission', 'комисс'] },
      { label: 'exchange', any: ['exchange', 'venue', 'бирж', 'okx', 'bybit', 'binance', 'bitget'] },
      { label: 'universe', any: ['universe', '\\bsymbol', 'instrument', '\\bpairs?\\b', 'which\\s+coins', 'инструмент', 'тикер'] },
    ],
  },
];

const RISK_WEIGHT = 0.15;

// Fabrication patterns for the negative check. Leverage requires >=2x OR the explicit word,
// so DCA size hints (1.2x/1.5x) are NOT flagged.
const FAB_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'leverage_x', re: /(?<![.\d])\b(?:[2-9]|\d{2,})(?:\.\d+)?\s*[x×]\b/i },
  { label: 'leverage_word', re: /leverage\s*[:=]?\s*\d/i },
  { label: 'leverage_ru', re: /плеч\w*\s*[:=]?\s*\d/i },
  { label: 'base_size_usd', re: /\$\s*\d|\b\d+\s*(?:usd|usdt|dollars?)\b|base[ _]?order\s*[:=]?\s*\d/i },
  { label: 'equity_fraction', re: /\b\d+(?:\.\d+)?\s*%\s*(?:of\s+)?(?:equity|account|balance|capital|portfolio|deposit|депозит)/i },
];

const FAB_PARAM_NAME = /leverage|плеч|margin|марж|base.?order|position.?siz|order.?siz|notional/i;

function scoreRiskNoFabrication(p: AnalystProfileOutput): CheckResult {
  const matched: string[] = [];
  const riskText = (p.riskManagementSummary ?? '').toString();
  for (const { label, re } of FAB_PATTERNS) if (re.test(riskText)) matched.push(label);
  const paramFab = p.parameters.some((param) => param.value != null && FAB_PARAM_NAME.test(param.name));
  if (paramFab) matched.push('param_sizing');
  const clean = matched.length === 0;
  return {
    id: 'risk_no_fabrication',
    weight: RISK_WEIGHT,
    bucketsHit: clean ? 1 : 0,
    bucketCount: 1,
    contribution: clean ? RISK_WEIGHT : 0,
    matched,
  };
}

export function scoreProfile(raw: unknown, opts?: { threshold?: number }): ScoreResult {
  const threshold = opts?.threshold ?? DEFAULT_THRESHOLD;
  const parsed = AnalystProfileOutputSchema.safeParse(raw);

  if (!parsed.success) {
    return { gates: { schemaValid: false, directionLong: false }, checks: [], score: 0, threshold, verdict: 'FAIL' };
  }

  const profile = parsed.data;
  const gates = { schemaValid: true, directionLong: profile.direction === 'long' };

  const checks: CheckResult[] = [];
  for (const def of POSITIVE_CHECKS) {
    let haystack = def.primary(profile);
    if (haystack.trim() === '' && def.fallback) haystack = def.fallback(profile);
    const { hits, matched } = matchBuckets(haystack, def.buckets);
    const bucketCount = def.buckets.length;
    checks.push({ id: def.id, weight: def.weight, bucketsHit: hits, bucketCount, contribution: (hits / bucketCount) * def.weight, matched });
  }
  checks.push(scoreRiskNoFabrication(profile));

  const score = checks.reduce((sum, c) => sum + c.contribution, 0);
  const verdict = gates.schemaValid && gates.directionLong && score >= threshold ? 'PASS' : 'FAIL';
  return { gates, checks, score, threshold, verdict };
}
