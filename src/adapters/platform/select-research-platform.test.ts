import { describe, it, expect } from 'vitest';
import { selectResearchPlatform } from './select-research-platform.ts';
import { MockResearchPlatformAdapter } from './mock-research-platform.adapter.ts';
import { HttpBacktesterAdapter } from './http-backtester.adapter.ts';

describe('selectResearchPlatform', () => {
  it('defaults to the mock adapter', () => {
    expect(selectResearchPlatform('mock')).toBeInstanceOf(MockResearchPlatformAdapter);
  });

  it('returns the HTTP backtester adapter for backtester (inert construction, no network)', () => {
    expect(selectResearchPlatform('backtester')).toBeInstanceOf(HttpBacktesterAdapter);
  });
});
