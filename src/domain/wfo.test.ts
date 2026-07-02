import { describe, expect, it } from 'vitest';

import { classifyEntryAffectingParams } from './wfo.ts';

describe('classifyEntryAffectingParams', () => {
  it('classifies entry-affecting vs exit/risk params', () => {
    const r = classifyEntryAffectingParams([
      { name: 'dump.minDropPct', tunable: true },
      { name: 'entry.fastBouncePct', tunable: true },
      { name: 'tpLadder.tp1Pct', tunable: true },
      { name: 'hardStopPct', tunable: true },
      { name: 'maxHoldMin', tunable: true },
    ] as any);
    expect(r.entryAffecting.sort()).toEqual(['dump.minDropPct', 'entry.fastBouncePct']);
    expect(r.exitRisk).toContain('tpLadder.tp1Pct');
  });

  it('classifies oiFilter/liqFilter/watch.cooldown/warmup.maxSignalAge as entry-affecting', () => {
    const r = classifyEntryAffectingParams([
      { name: 'oiFilter.minOi', tunable: true },
      { name: 'liqFilter.minNotional', tunable: true },
      { name: 'watch.cooldownMin', tunable: true },
      { name: 'warmup.maxSignalAgeMin', tunable: true },
      { name: 'protection.maxDailyLossPct', tunable: true },
      { name: 'dca.stepPct', tunable: true },
      { name: 'failFast.maxAdverseExcursionPct', tunable: true },
    ] as any);
    expect(r.entryAffecting.sort()).toEqual([
      'liqFilter.minNotional',
      'oiFilter.minOi',
      'warmup.maxSignalAgeMin',
      'watch.cooldownMin',
    ]);
    expect(r.exitRisk.sort()).toEqual([
      'dca.stepPct',
      'failFast.maxAdverseExcursionPct',
      'protection.maxDailyLossPct',
    ]);
  });

  it('classifies by description keywords when the name does not match a prefix', () => {
    const r = classifyEntryAffectingParams([
      { name: 'customParam', tunable: true, description: 'Controls the entry signal filter cooldown' },
      { name: 'anotherParam', tunable: true, description: 'Unrelated risk sizing knob' },
    ] as any);
    expect(r.entryAffecting).toEqual(['customParam']);
    expect(r.exitRisk).toEqual(['anotherParam']);
  });

  it('ignores non-tunable params', () => {
    const r = classifyEntryAffectingParams([
      { name: 'entry.fastBouncePct', tunable: false },
      { name: 'tpLadder.tp1Pct', tunable: true },
    ] as any);
    expect(r.entryAffecting).toEqual([]);
    expect(r.exitRisk).toEqual(['tpLadder.tp1Pct']);
  });
});
