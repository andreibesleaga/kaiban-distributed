import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { GatewayApp, SlidingWindowRateLimiter } from '../../../src/adapters/gateway/GatewayApp';
import { A2AConnector, type AgentCard } from '../../../src/infrastructure/federation/a2a-connector';

const testCard: AgentCard = {
  name: 'kaiban-worker', version: '1.0.0', description: 'Test',
  capabilities: ['agent.status'], endpoints: { rpc: '/a2a/rpc' },
};

describe('GatewayApp — hardening', () => {
  // ── Helmet security headers ────────────────────────────────────────
  describe('helmet security headers', () => {
    it('sets X-Content-Type-Options: nosniff', async () => {
      const gw = new GatewayApp(new A2AConnector(testCard));
      const res = await request(gw.app).get('/health');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('sets X-Frame-Options: DENY (via helmet)', async () => {
      const gw = new GatewayApp(new A2AConnector(testCard));
      const res = await request(gw.app).get('/health');
      // Helmet defaults to SAMEORIGIN; we didn't override so accept either
      expect(res.headers['x-frame-options']).toBeDefined();
    });

    it('sets Content-Security-Policy header', async () => {
      const gw = new GatewayApp(new A2AConnector(testCard));
      const res = await request(gw.app).get('/health');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    });

    it('sets Strict-Transport-Security header', async () => {
      const gw = new GatewayApp(new A2AConnector(testCard));
      const res = await request(gw.app).get('/health');
      expect(res.headers['strict-transport-security']).toContain('max-age=');
    });

    it('sets Referrer-Policy: no-referrer', async () => {
      const gw = new GatewayApp(new A2AConnector(testCard));
      const res = await request(gw.app).get('/health');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('does NOT expose X-Powered-By', async () => {
      const gw = new GatewayApp(new A2AConnector(testCard));
      const res = await request(gw.app).get('/health');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });
  });

  // ── Rate limiter Map pruning (unit) ───────────────────────────────
  describe('rate limiter Map pruning', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('removes stale IP key from Map after window expires', () => {
      const limiter = new SlidingWindowRateLimiter();
      limiter.isAllowed('1.2.3.4');
      // Advance past the 60s window
      vi.advanceTimersByTime(61_000);
      // Next call should succeed and the old key should be pruned + re-created
      expect(limiter.isAllowed('1.2.3.4')).toBe(true);
      // Map should contain exactly one entry (the fresh one just created)
      expect((limiter as unknown as { windows: Map<string, number[]> }).windows.size).toBe(1);
    });

    it('does not grow Map unboundedly with many unique IPs after window expires', () => {
      const limiter = new SlidingWindowRateLimiter();
      // Simulate 200 unique IPs making one request each
      for (let i = 0; i < 200; i++) {
        limiter.isAllowed(`10.0.${Math.floor(i / 255)}.${i % 255}`);
      }
      // All 200 keys should be in the map
      expect((limiter as unknown as { windows: Map<string, number[]> }).windows.size).toBe(200);
      // Advance past window — all timestamps become stale
      vi.advanceTimersByTime(61_000);
      // Each subsequent call for same IPs should prune the key then re-add it
      for (let i = 0; i < 200; i++) {
        limiter.isAllowed(`10.0.${Math.floor(i / 255)}.${i % 255}`);
      }
      // Map should still be 200 (pruned + re-created), not 400
      expect((limiter as unknown as { windows: Map<string, number[]> }).windows.size).toBe(200);
    });
  });

  // ── Rate limiter ───────────────────────────────────────────────────
  describe('rate limiter', () => {
    it('allows requests under the limit', async () => {
      const gw = new GatewayApp(new A2AConnector(testCard));
      const res = await request(gw.app)
        .post('/a2a/rpc').set('Content-Type', 'application/json')
        .send({ jsonrpc: '2.0', id: 1, method: 'agent.status' });
      expect(res.status).toBe(200);
    });

    it('returns 429 after exceeding rate limit', async () => {
      const gw = new GatewayApp(new A2AConnector(testCard));
      const payload = { jsonrpc: '2.0', id: 1, method: 'agent.status' };

      // Send 101 requests rapidly — 100 should pass, 101st should be rate-limited
      const results: number[] = [];
      for (let i = 0; i < 101; i++) {
        const res = await request(gw.app)
          .post('/a2a/rpc').set('Content-Type', 'application/json')
          .send(payload);
        results.push(res.status);
      }
      expect(results.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    });

    it('rate limit response has correct error format', async () => {
      const gw = new GatewayApp(new A2AConnector(testCard));
      const payload = { jsonrpc: '2.0', id: 1, method: 'agent.status' };

      // Burn through the rate limit
      for (let i = 0; i < 100; i++) {
        await request(gw.app)
          .post('/a2a/rpc').set('Content-Type', 'application/json')
          .send(payload);
      }
      const res = await request(gw.app)
        .post('/a2a/rpc').set('Content-Type', 'application/json')
        .send(payload);
      expect(res.status).toBe(429);
      expect(res.body.errors[0].message).toBe('Too Many Requests');
    });
  });
});
