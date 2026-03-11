import { describe, it, expect, vi } from 'vitest';
import { A2AConnector, type AgentCard } from '../../../src/infrastructure/federation/a2a-connector';
import type { IMessagingDriver } from '../../../src/infrastructure/messaging/interfaces';

const testCard: AgentCard = {
  name: 'test-worker', version: '1.0.0', description: 'test',
  capabilities: ['tasks.create'], endpoints: { rpc: '/a2a/rpc' },
};

function makeMockDriver(): IMessagingDriver {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

describe('A2AConnector — input validation & hardening', () => {
  // ── agentId validation ─────────────────────────────────────────────
  describe('agentId validation', () => {
    it('rejects agentId with special characters (SQL injection attempt)', async () => {
      const conn = new A2AConnector(testCard, makeMockDriver());
      const result = await conn.handleRpc({
        jsonrpc: '2.0', id: 1, method: 'tasks.create',
        params: { agentId: "agent'; DROP TABLE--", instruction: 'hi' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.error?.code).toBe(-32602);
        expect(result.value.error?.message).toContain('Invalid agentId');
      }
    });

    it('rejects agentId longer than 64 chars', async () => {
      const conn = new A2AConnector(testCard, makeMockDriver());
      const result = await conn.handleRpc({
        jsonrpc: '2.0', id: 2, method: 'tasks.create',
        params: { agentId: 'a'.repeat(65), instruction: 'hi' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.error?.code).toBe(-32602);
    });

    it('accepts agentId with hyphens and underscores', async () => {
      const conn = new A2AConnector(testCard, makeMockDriver());
      const result = await conn.handleRpc({
        jsonrpc: '2.0', id: 3, method: 'tasks.create',
        params: { agentId: 'my-agent_v2', instruction: 'hi' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.result).toBeDefined();
    });

    it('accepts agentId exactly 64 chars', async () => {
      const conn = new A2AConnector(testCard, makeMockDriver());
      const result = await conn.handleRpc({
        jsonrpc: '2.0', id: 4, method: 'tasks.create',
        params: { agentId: 'a'.repeat(64), instruction: 'hi' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.result).toBeDefined();
    });

    it('accepts wildcard agentId (*) — skips validation', async () => {
      const conn = new A2AConnector(testCard, makeMockDriver());
      const result = await conn.handleRpc({
        jsonrpc: '2.0', id: 5, method: 'tasks.create',
        params: { agentId: '*', instruction: 'hi' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const r = result.value.result as { agentId: string };
        expect(r.agentId).toBe('*');
      }
    });

    it('rejects agentId with path traversal (../)', async () => {
      const conn = new A2AConnector(testCard, makeMockDriver());
      const result = await conn.handleRpc({
        jsonrpc: '2.0', id: 6, method: 'tasks.create',
        params: { agentId: '../../../etc/passwd', instruction: 'hi' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.error?.code).toBe(-32602);
    });

    it('rejects agentId with spaces', async () => {
      const conn = new A2AConnector(testCard, makeMockDriver());
      const result = await conn.handleRpc({
        jsonrpc: '2.0', id: 7, method: 'tasks.create',
        params: { agentId: 'agent one', instruction: 'hi' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.error?.code).toBe(-32602);
    });
  });

  // ── instruction validation ─────────────────────────────────────────
  describe('instruction validation', () => {
    it('rejects instruction longer than 10,000 chars', async () => {
      const conn = new A2AConnector(testCard, makeMockDriver());
      const result = await conn.handleRpc({
        jsonrpc: '2.0', id: 10, method: 'tasks.create',
        params: { agentId: 'researcher', instruction: 'x'.repeat(10_001) },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.error?.code).toBe(-32602);
        expect(result.value.error?.message).toContain('instruction too long');
      }
    });

    it('accepts instruction exactly 10,000 chars', async () => {
      const conn = new A2AConnector(testCard, makeMockDriver());
      const result = await conn.handleRpc({
        jsonrpc: '2.0', id: 11, method: 'tasks.create',
        params: { agentId: 'researcher', instruction: 'x'.repeat(10_000) },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.result).toBeDefined();
    });

    it('accepts missing instruction (undefined)', async () => {
      const conn = new A2AConnector(testCard, makeMockDriver());
      const result = await conn.handleRpc({
        jsonrpc: '2.0', id: 12, method: 'tasks.create',
        params: { agentId: 'researcher' },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.result).toBeDefined();
    });

    it('accepts non-string instruction (number) — no length check', async () => {
      const conn = new A2AConnector(testCard, makeMockDriver());
      const result = await conn.handleRpc({
        jsonrpc: '2.0', id: 13, method: 'tasks.create',
        params: { agentId: 'researcher', instruction: 42 },
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.result).toBeDefined();
    });
  });

  // ── method echo sanitization ───────────────────────────────────────
  describe('method echo sanitization', () => {
    it('truncates long method name in error response', async () => {
      const longMethod = 'x'.repeat(200);
      const conn = new A2AConnector(testCard);
      const result = await conn.handleRpc({ jsonrpc: '2.0', id: 20, method: longMethod });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.error?.code).toBe(-32601);
        // Error message should not contain the full 200-char method
        expect(result.value.error!.message.length).toBeLessThan(200);
        // But should contain the truncated portion
        expect(result.value.error!.message).toContain('x'.repeat(100));
      }
    });

    it('short method names pass through unchanged', async () => {
      const conn = new A2AConnector(testCard);
      const result = await conn.handleRpc({ jsonrpc: '2.0', id: 21, method: 'foo.bar' });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.error?.message).toBe('Method not found: foo.bar');
    });
  });
});
