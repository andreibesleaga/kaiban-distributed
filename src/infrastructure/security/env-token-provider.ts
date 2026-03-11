import type { ITokenProvider } from '../../domain/security/token-provider';

/**
 * Default token provider that reads API keys from environment variables.
 * This is the backwards-compatible fallback — identical to the current behaviour
 * of reading `process.env[service]` directly.
 *
 * Future implementations can fetch from HashiCorp Vault, AWS Secrets Manager,
 * or any other ephemeral token source.
 */
export class EnvTokenProvider implements ITokenProvider {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getToken(service: string, _taskId: string): Promise<string | undefined> {
    return process.env[service];
  }
}
