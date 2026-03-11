import { describe, it, expect } from 'vitest';
import { EnvTokenProvider } from '../../../src/infrastructure/security/env-token-provider';

describe('EnvTokenProvider', () => {
  const provider = new EnvTokenProvider();

  it('returns the env var value for a known key', async () => {
    process.env['TEST_TOKEN_KEY'] = 'secret-value';
    const token = await provider.getToken('TEST_TOKEN_KEY', 'task-123');
    expect(token).toBe('secret-value');
    delete process.env['TEST_TOKEN_KEY'];
  });

  it('returns undefined for an unset key', async () => {
    delete process.env['MISSING_KEY'];
    const token = await provider.getToken('MISSING_KEY', 'task-123');
    expect(token).toBeUndefined();
  });

  it('ignores the taskId parameter (for backwards compatibility)', async () => {
    process.env['STABLE_KEY'] = 'value';
    const token1 = await provider.getToken('STABLE_KEY', 'task-1');
    const token2 = await provider.getToken('STABLE_KEY', 'task-2');
    expect(token1).toBe(token2);
    delete process.env['STABLE_KEY'];
  });
});
