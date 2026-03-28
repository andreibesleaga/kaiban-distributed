import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { wrapSigned, unwrapVerified } from '../../../src/infrastructure/security/channel-signing';

describe('channel-signing', () => {
  const SECRET = 'test-channel-signing-secret-32!!';

  afterEach(() => {
    delete process.env['CHANNEL_SIGNING_SECRET'];
    vi.useRealTimers();
  });

  // ─── Legacy mode (no secret) ─────────────────────────────────────────────

  describe('without CHANNEL_SIGNING_SECRET (legacy mode)', () => {
    it('wrapSigned returns plain JSON', () => {
      const payload = { teamWorkflowStatus: 'RUNNING' };
      const result = wrapSigned(payload);
      expect(JSON.parse(result)).toEqual(payload);
    });

    it('unwrapVerified parses plain JSON', () => {
      const payload = { agents: [{ agentId: 'researcher', status: 'IDLE' }] };
      const raw = JSON.stringify(payload);
      const result = unwrapVerified(raw);
      expect(result).toEqual(payload);
    });

    it('unwrapVerified returns null on invalid JSON', () => {
      expect(unwrapVerified('not-json')).toBeNull();
    });

    it('round-trip: wrapSigned → unwrapVerified', () => {
      const payload = { metadata: { totalTokens: 100 } };
      const wrapped = wrapSigned(payload);
      const result = unwrapVerified(wrapped);
      expect(result).toEqual(payload);
    });
  });

  // ─── Signing mode (with secret) ───────────────────────────────────────────

  describe('with CHANNEL_SIGNING_SECRET', () => {
    beforeEach(() => {
      process.env['CHANNEL_SIGNING_SECRET'] = SECRET;
    });

    it('wrapSigned produces an envelope with payload, sig, ts', () => {
      const payload = { teamWorkflowStatus: 'RUNNING' };
      const raw = wrapSigned(payload);
      const envelope = JSON.parse(raw) as { payload: unknown; sig: string; ts: number };
      expect(envelope.payload).toEqual(payload);
      expect(typeof envelope.sig).toBe('string');
      expect(envelope.sig).toHaveLength(64); // SHA-256 hex = 64 chars
      expect(typeof envelope.ts).toBe('number');
    });

    it('unwrapVerified successfully verifies a freshly signed message', () => {
      const payload = { tasks: [{ taskId: 'abc', status: 'DOING' }] };
      const raw = wrapSigned(payload);
      const result = unwrapVerified(raw);
      expect(result).toEqual(payload);
    });

    it('round-trip preserves nested objects', () => {
      const payload = {
        agents: [{ agentId: 'writer', status: 'EXECUTING' }],
        metadata: { totalTokens: 500, estimatedCost: 0.01 },
      };
      const result = unwrapVerified(wrapSigned(payload));
      expect(result).toEqual(payload);
    });

    it('returns null when sig is tampered', () => {
      const payload = { teamWorkflowStatus: 'FINISHED' };
      const raw = wrapSigned(payload);
      const envelope = JSON.parse(raw) as { payload: unknown; sig: string; ts: number };
      envelope.sig = 'a'.repeat(64); // tampered signature
      expect(unwrapVerified(JSON.stringify(envelope))).toBeNull();
    });

    it('returns null when payload is tampered after signing', () => {
      const payload = { teamWorkflowStatus: 'RUNNING' };
      const raw = wrapSigned(payload);
      const envelope = JSON.parse(raw) as { payload: Record<string, unknown>; sig: string; ts: number };
      envelope.payload['teamWorkflowStatus'] = 'FINISHED'; // tampered
      expect(unwrapVerified(JSON.stringify(envelope))).toBeNull();
    });

    it('returns null when ts is missing', () => {
      const payload = { x: 1 };
      const raw = wrapSigned(payload);
      const envelope = JSON.parse(raw) as Record<string, unknown>;
      delete envelope['ts'];
      expect(unwrapVerified(JSON.stringify(envelope))).toBeNull();
    });

    it('returns null when sig is missing', () => {
      const payload = { x: 1 };
      const raw = wrapSigned(payload);
      const envelope = JSON.parse(raw) as Record<string, unknown>;
      delete envelope['sig'];
      expect(unwrapVerified(JSON.stringify(envelope))).toBeNull();
    });

    it('returns null when payload field is missing', () => {
      const payload = { x: 1 };
      const raw = wrapSigned(payload);
      const envelope = JSON.parse(raw) as Record<string, unknown>;
      delete envelope['payload'];
      expect(unwrapVerified(JSON.stringify(envelope))).toBeNull();
    });

    it('returns null when message is older than 30 s (replay attack)', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
      const payload = { x: 'old' };
      const raw = wrapSigned(payload);
      // Advance clock 31 seconds
      vi.advanceTimersByTime(31_000);
      expect(unwrapVerified(raw)).toBeNull();
    });

    it('accepts a message that is exactly within the 30 s window', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
      const payload = { x: 'fresh' };
      const raw = wrapSigned(payload);
      vi.advanceTimersByTime(29_000); // 29 s — within window
      expect(unwrapVerified(raw)).toEqual(payload);
    });

    it('returns null on plain JSON when signing is enabled', () => {
      // Plain JSON lacks sig/ts envelope fields — should be rejected
      const plain = JSON.stringify({ teamWorkflowStatus: 'RUNNING' });
      expect(unwrapVerified(plain)).toBeNull();
    });

    it('returns null on invalid JSON', () => {
      expect(unwrapVerified('not-json')).toBeNull();
    });

    it('returns null when sig buffer length mismatch (edge case)', () => {
      const payload = { x: 1 };
      const raw = wrapSigned(payload);
      const envelope = JSON.parse(raw) as { payload: unknown; sig: string; ts: number };
      envelope.sig = 'abcd'; // wrong length — timingSafeEqual will throw internally
      expect(unwrapVerified(JSON.stringify(envelope))).toBeNull();
    });
  });
});
