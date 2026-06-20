/**
 * Admission-gate adapters (master plan §B5.1 Phase G hot-path enforcement, ADR-021).
 *
 * `buildAdmissionGate` maps an Action-Gate decision onto the actor's IAdmissionGate
 * (allow/degrade ⇒ proceed; escalate/block/terminate ⇒ block). `buildWorkerAdmissionGate`
 * assembles the default worker gate from config (policy-as-code + optional cost reservation).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildAdmissionGate,
  buildWorkerAdmissionGate,
} from "../../../src/shared/admission-gate";
import type { ActionGate } from "../../../src/governance/action-gate";
import type {
  GateAction,
  GateContext,
  GateDecision,
} from "../../../src/governance/types";
import type {
  CostLimiterPort,
  EconomicsConfig,
} from "../../../src/economics/types";
import type { EvaluationPayload } from "../../../src/domain/security/semantic-firewall";

function gateReturning(
  action: GateAction,
): { gate: Pick<ActionGate, "evaluate">; calls: GateContext[] } {
  const calls: GateContext[] = [];
  const gate = {
    evaluate: vi.fn((ctx: GateContext): Promise<GateDecision> => {
      calls.push(ctx);
      return Promise.resolve({ action, verdicts: [], context: ctx });
    }),
  };
  return { gate, calls };
}

const payload: EvaluationPayload = {
  taskId: "t-1",
  agentId: "agent-1",
  data: { instruction: "do" },
};

describe("buildAdmissionGate", () => {
  it("allows allow + degrade, blocks escalate/block/terminate (with reason)", async () => {
    for (const action of ["allow", "degrade"] as GateAction[]) {
      const { gate } = gateReturning(action);
      expect(await buildAdmissionGate(gate).evaluate(payload)).toEqual({
        allowed: true,
      });
    }
    for (const action of ["escalate", "block", "terminate"] as GateAction[]) {
      const { gate } = gateReturning(action);
      expect(await buildAdmissionGate(gate).evaluate(payload)).toEqual({
        allowed: false,
        reason: `gate:${action}`,
      });
    }
  });

  it("builds a default tool-call context with no tenant/cost", async () => {
    const { gate, calls } = gateReturning("allow");
    await buildAdmissionGate(gate).evaluate(payload);
    expect(calls[0]).toEqual({
      operation: "tool-call",
      agentId: "agent-1",
      payload: { instruction: "do" },
    });
  });

  it("threads operation, tenantId and estimatedCostUnits when derivers are given", async () => {
    const { gate, calls } = gateReturning("allow");
    await buildAdmissionGate(gate, {
      operation: "memory-write",
      tenantIdOf: () => "tenant-x",
      estimatedCostUnitsOf: () => 42,
    }).evaluate(payload);
    expect(calls[0]).toEqual({
      operation: "memory-write",
      agentId: "agent-1",
      payload: { instruction: "do" },
      tenantId: "tenant-x",
      estimatedCostUnits: 42,
    });
  });

  it("omits tenantId/cost when the derivers return undefined", async () => {
    const { gate, calls } = gateReturning("allow");
    await buildAdmissionGate(gate, {
      tenantIdOf: () => undefined,
      estimatedCostUnitsOf: () => undefined,
    }).evaluate(payload);
    expect(calls[0]).not.toHaveProperty("tenantId");
    expect(calls[0]).not.toHaveProperty("estimatedCostUnits");
  });
});

describe("buildWorkerAdmissionGate", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  });

  function policyFile(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "kaiban-policies-"));
    tmpDirs.push(dir);
    const path = join(dir, "policies.yml");
    writeFileSync(path, yaml);
    return path;
  }

  const economicsOn: EconomicsConfig = {
    enabled: true,
    maxRequestsPerWindow: 0,
    maxCostPerWindow: 100,
    globalCostCeiling: 0,
    windowSeconds: 60,
    degradeThreshold: 0.75,
  };

  it("returns undefined when governance is disabled", () => {
    expect(buildWorkerAdmissionGate({ enabled: false })).toBeUndefined();
  });

  it("default-allows with no policies file", async () => {
    const gate = buildWorkerAdmissionGate({ enabled: true });
    expect(gate).toBeDefined();
    expect(await gate!.evaluate(payload)).toEqual({ allowed: true });
  });

  it("enforces a policies.yml (blocks a matching payload)", async () => {
    const path = policyFile(
      'default: allow\nrules:\n  - id: block-secret\n    matchAny: ["secret"]\n    effect: block\n',
    );
    const gate = buildWorkerAdmissionGate({ enabled: true, policiesPath: path });
    expect(
      await gate!.evaluate({ ...payload, data: { instruction: "leak secret" } }),
    ).toEqual({ allowed: false, reason: "gate:block" });
    expect(await gate!.evaluate(payload)).toEqual({ allowed: true });
  });

  it("adds a cost-reservation validator when economics is enabled + a limiter is given", async () => {
    const limiter: CostLimiterPort = {
      consumeRequest: vi.fn(() =>
        Promise.resolve({ ok: true, remaining: 10, utilization: 0 }),
      ),
      reserveCost: vi.fn(() =>
        Promise.resolve({ ok: false, remaining: 0, utilization: 1 }),
      ),
      releaseCost: vi.fn(() => Promise.resolve()),
    };
    const gate = buildWorkerAdmissionGate(
      { enabled: true },
      { economics: economicsOn, costLimiter: limiter },
    );
    // Default-allow policy passes; the cost validator rejects → block.
    expect(
      await gate!.evaluate({ ...payload, estimatedCostUnits: 50 } as never),
    ).toEqual({ allowed: false, reason: "gate:block" });
    expect(limiter.reserveCost).toHaveBeenCalled();
  });

  it("does NOT add the cost validator when economics is enabled but no limiter is given", async () => {
    const gate = buildWorkerAdmissionGate(
      { enabled: true },
      { economics: economicsOn },
    );
    expect(await gate!.evaluate(payload)).toEqual({ allowed: true });
  });

  it("does NOT add the cost validator when a limiter is given but economics is disabled", async () => {
    const limiter: CostLimiterPort = {
      consumeRequest: vi.fn(),
      reserveCost: vi.fn(),
      releaseCost: vi.fn(),
    };
    const gate = buildWorkerAdmissionGate(
      { enabled: true },
      { economics: { ...economicsOn, enabled: false }, costLimiter: limiter },
    );
    expect(await gate!.evaluate(payload)).toEqual({ allowed: true });
    expect(limiter.reserveCost).not.toHaveBeenCalled();
  });
});
