import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';

// Dynamic import so env vars are read fresh each test
async function getBoardAuth(): Promise<typeof import('../../../src/infrastructure/security/board-auth')> {
  return import('../../../src/infrastructure/security/board-auth');
}

describe('board-auth', () => {
  const SECRET = 'test-board-secret-32bytes-padded!!';

  beforeEach(() => {
    process.env['BOARD_JWT_SECRET'] = SECRET;
  });

  afterEach(() => {
    delete process.env['BOARD_JWT_SECRET'];
  });

  // ─── issueBoardToken ──────────────────────────────────────────────────────

  it('issues a valid JWT string', async () => {
    const { issueBoardToken } = await getBoardAuth();
    const token = issueBoardToken('operator');
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3); // header.payload.signature
  });

  it('embeds correct subject and role claims', async () => {
    const { issueBoardToken } = await getBoardAuth();
    const token = issueBoardToken('alice');
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded['sub']).toBe('alice');
    expect(decoded['role']).toBe('board-viewer');
  });

  it('respects custom expiry (default 3600 s)', async () => {
    const { issueBoardToken } = await getBoardAuth();
    const before = Math.floor(Date.now() / 1000);
    const token = issueBoardToken('bob', 7200);
    const decoded = jwt.decode(token) as Record<string, unknown>;
    const exp = decoded['exp'] as number;
    expect(exp).toBeGreaterThanOrEqual(before + 7200 - 2);
    expect(exp).toBeLessThanOrEqual(before + 7200 + 2);
  });

  it('throws when BOARD_JWT_SECRET is not set', async () => {
    delete process.env['BOARD_JWT_SECRET'];
    const { issueBoardToken } = await getBoardAuth();
    expect(() => issueBoardToken('x')).toThrow('BOARD_JWT_SECRET not set');
  });

  // ─── verifyBoardToken ─────────────────────────────────────────────────────

  it('verifies a token it issued', async () => {
    const { issueBoardToken, verifyBoardToken } = await getBoardAuth();
    const token = issueBoardToken('carol');
    const payload = verifyBoardToken(token);
    expect(payload['sub']).toBe('carol');
    expect(payload['role']).toBe('board-viewer');
  });

  it('throws on expired token', async () => {
    const { verifyBoardToken } = await getBoardAuth();
    // Sign with -1 s expiry (already expired)
    const expired = jwt.sign({ sub: 'x', role: 'board-viewer' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: -1,
    });
    expect(() => verifyBoardToken(expired)).toThrow();
  });

  it('throws on token signed with wrong secret', async () => {
    const { verifyBoardToken } = await getBoardAuth();
    const bad = jwt.sign({ sub: 'x', role: 'board-viewer' }, 'wrong-secret', {
      algorithm: 'HS256',
      expiresIn: 3600,
    });
    expect(() => verifyBoardToken(bad)).toThrow();
  });

  it('throws on malformed token string', async () => {
    const { verifyBoardToken } = await getBoardAuth();
    expect(() => verifyBoardToken('not.a.token')).toThrow();
  });

  it('throws when BOARD_JWT_SECRET is not set during verify', async () => {
    const { issueBoardToken, verifyBoardToken } = await getBoardAuth();
    const token = issueBoardToken('dave');
    delete process.env['BOARD_JWT_SECRET'];
    expect(() => verifyBoardToken(token)).toThrow('BOARD_JWT_SECRET not set');
  });

  it('throws on completely empty token string', async () => {
    const { verifyBoardToken } = await getBoardAuth();
    expect(() => verifyBoardToken('')).toThrow();
  });
});
