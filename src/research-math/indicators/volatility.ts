import { sma } from './trend.ts';

export function atr(
  highs: readonly number[], lows: readonly number[], closes: readonly number[], period: number,
): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period <= 0 || n <= period) return out;
  const tr = new Array<number>(n);
  tr[0] = highs[0]! - lows[0]!;
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i]! - lows[i]!,
      Math.abs(highs[i]! - closes[i - 1]!),
      Math.abs(lows[i]! - closes[i - 1]!),
    );
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i]!;
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < n; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

export function realizedVol(closes: readonly number[], window: number): (number | null)[] {
  const n = closes.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (window <= 0 || n <= window) return out;
  const rets = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) rets[i] = closes[i - 1]! !== 0 ? (closes[i]! - closes[i - 1]!) / closes[i - 1]! : 0;
  for (let i = window; i < n; i++) {
    let mean = 0;
    for (let j = i - window + 1; j <= i; j++) mean += rets[j]!;
    mean /= window;
    let v = 0;
    for (let j = i - window + 1; j <= i; j++) { const d = rets[j]! - mean; v += d * d; }
    out[i] = Math.sqrt(v / window);
  }
  return out;
}

export interface BollingerPoint { upper: number; mid: number; lower: number; pctB: number; bandwidth: number; }

export function bollinger(values: readonly number[], period: number, k: number): (BollingerPoint | null)[] {
  const n = values.length;
  const out: (BollingerPoint | null)[] = new Array(n).fill(null);
  if (period <= 0) return out;
  const mid = sma(values, period);
  let sum = 0, sumSq = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i]!; sumSq += values[i]! * values[i]!;
    if (i >= period) { sum -= values[i - period]!; sumSq -= values[i - period]! * values[i - period]!; }
    if (i >= period - 1) {
      const m = mid[i] as number;
      const variance = Math.max(sumSq / period - m * m, 0);
      const sd = Math.sqrt(variance);
      const upper = m + k * sd, lower = m - k * sd;
      const pctB = upper === lower ? 0.5 : (values[i]! - lower) / (upper - lower);
      const bandwidth = m === 0 ? 0 : (upper - lower) / m;
      out[i] = { upper, mid: m, lower, pctB, bandwidth };
    }
  }
  return out;
}

export function linregEndpoint(values: readonly (number | null)[], period: number): (number | null)[] {
  const n = values.length;
  const out: (number | null)[] = new Array(n).fill(null);
  if (period <= 0) return out;
  let sumX = 0, sumXX = 0;
  for (let x = 0; x < period; x++) { sumX += x; sumXX += x * x; }
  const denom = period * sumXX - sumX * sumX;
  for (let i = period - 1; i < n; i++) {
    let sumY = 0, sumXY = 0, ok = true;
    for (let j = 0; j < period; j++) {
      const v = values[i - period + 1 + j];
      if (v == null) { ok = false; break; }
      sumY += v; sumXY += j * v;
    }
    if (!ok) continue;
    if (denom === 0) { out[i] = sumY / period; continue; }
    const slope = (period * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / period;
    out[i] = intercept + slope * (period - 1);
  }
  return out;
}

export interface SqueezePoint { on: boolean; momentum: number | null; }

export function squeeze(
  highs: readonly number[], lows: readonly number[], closes: readonly number[],
  period: number, bbK: number, kcMult: number,
): (SqueezePoint | null)[] {
  const n = closes.length;
  const out: (SqueezePoint | null)[] = new Array(n).fill(null);
  if (period <= 0) return out;
  const mid = sma(closes, period);
  const atrArr = atr(highs, lows, closes, period);
  // rolling population stddev of closes (matches bollinger: sumSq/period − m²)
  let sum = 0, sumSq = 0;
  const sd: (number | null)[] = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    sum += closes[i]!; sumSq += closes[i]! * closes[i]!;
    if (i >= period) { sum -= closes[i - period]!; sumSq -= closes[i - period]! * closes[i - period]!; }
    if (i >= period - 1) {
      const m = sum / period;
      sd[i] = Math.sqrt(Math.max(sumSq / period - m * m, 0));
    }
  }
  // TTM momentum input series d[i] = close − ½·(½·(HH+LL) + SMA)
  const d: (number | null)[] = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - period + 1; j <= i; j++) { if (highs[j]! > hh) hh = highs[j]!; if (lows[j]! < ll) ll = lows[j]!; }
    const m = mid[i];
    if (m == null) continue;
    d[i] = closes[i]! - 0.5 * (0.5 * (hh + ll) + m);
  }
  const mom = linregEndpoint(d, period);
  for (let i = 0; i < n; i++) {
    const m = mid[i], s = sd[i], a = atrArr[i];
    if (m == null || s == null || a == null) continue; // on needs BB + ATR
    const bbUpper = m + bbK * s, bbLower = m - bbK * s;
    const kcUpper = m + kcMult * a, kcLower = m - kcMult * a;
    out[i] = { on: bbUpper < kcUpper && bbLower > kcLower, momentum: mom[i] ?? null };
  }
  return out;
}
