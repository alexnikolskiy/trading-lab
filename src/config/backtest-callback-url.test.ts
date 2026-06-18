import { describe, it, expect } from 'vitest';
import { buildBacktestCallbackUrl } from './backtest-callback-url.ts';

describe('buildBacktestCallbackUrl', () => {
  it('returns undefined when public URL or token is missing', () => {
    expect(buildBacktestCallbackUrl(undefined, 'tok')).toBeUndefined();
    expect(buildBacktestCallbackUrl('http://lab:3000', undefined)).toBeUndefined();
  });

  it('builds a URL with encoded query token and no trailing slash on base', () => {
    expect(buildBacktestCallbackUrl('http://lab:3000/', 'dev-callback-token')).toBe(
      'http://lab:3000/callbacks/backtest-completed?token=dev-callback-token',
    );
  });
});
