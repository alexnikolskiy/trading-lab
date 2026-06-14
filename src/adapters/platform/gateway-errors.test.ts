import { describe, it, expect } from 'vitest';
import { GatewayValidationError } from './gateway-errors.ts';

describe('GatewayValidationError', () => {
  it('carries category + code and a descriptive message', () => {
    const e = new GatewayValidationError({ category: 'validation_error', code: 'invalid_module', message: 'bad kind' });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('GatewayValidationError');
    expect(e.category).toBe('validation_error');
    expect(e.code).toBe('invalid_module');
    expect(e.message).toContain('validation_error');
    expect(e.message).toContain('invalid_module');
    expect(e.message).toContain('bad kind');
  });
});
