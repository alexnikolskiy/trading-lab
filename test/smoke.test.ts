import { describe, it, expect } from 'vitest';
import { loadEnv } from '../src/config/env.ts';

describe('env', () => {
  it('defaults ENABLE_CRITIC_AGENT to false', () => {
    expect(loadEnv({}).ENABLE_CRITIC_AGENT).toBe(false);
  });
  it('parses ENABLE_CRITIC_AGENT=true', () => {
    expect(loadEnv({ ENABLE_CRITIC_AGENT: 'true' }).ENABLE_CRITIC_AGENT).toBe(true);
  });
  it('defaults INGRESS_PORT to 3000 when absent', () => {
    expect(loadEnv({}).INGRESS_PORT).toBe(3000);
  });
  it('parses a valid INGRESS_PORT string', () => {
    expect(loadEnv({ INGRESS_PORT: '8080' }).INGRESS_PORT).toBe(8080);
  });
  it('falls back to 3000 for an invalid INGRESS_PORT', () => {
    expect(loadEnv({ INGRESS_PORT: 'abc' }).INGRESS_PORT).toBe(3000);
  });
});
