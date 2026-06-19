import { describe, it, expect } from "vitest";
import {
  validateTaskInput,
  A2A_INPUT_CAPS,
} from "../../../src/infrastructure/federation/a2a-input-validation";

function ok(
  r: ReturnType<typeof validateTaskInput>,
): Extract<typeof r, { params: unknown }>["params"] {
  if ("error" in r) throw new Error(`expected ok, got error: ${r.error.message}`);
  return r.params;
}

describe("validateTaskInput", () => {
  it("exposes the documented caps (no magic numbers in tests)", () => {
    expect(A2A_INPUT_CAPS.maxAgentIdLen).toBe(64);
    expect(A2A_INPUT_CAPS.maxInstructionLen).toBe(10_000);
    expect(A2A_INPUT_CAPS.maxExpectedOutputLen).toBe(10_000);
    expect(A2A_INPUT_CAPS.maxContextLen).toBe(20_000);
    expect(A2A_INPUT_CAPS.maxInputsKeys).toBe(64);
    expect(A2A_INPUT_CAPS.maxTotalParamsBytes).toBe(65_536);
  });

  it("accepts a minimal valid payload", () => {
    const params = ok(validateTaskInput({ agentId: "writer" }));
    expect(params.agentId).toBe("writer");
  });

  it("accepts all optional fields within caps", () => {
    const params = ok(
      validateTaskInput({
        agentId: "writer",
        instruction: "Write",
        expectedOutput: "An essay",
        context: "background",
        inputs: { tone: "formal" },
      }),
    );
    expect(params.instruction).toBe("Write");
    expect(params.expectedOutput).toBe("An essay");
    expect(params.context).toBe("background");
    expect(params.inputs).toEqual({ tone: "formal" });
  });

  it("rejects a missing agentId with -32602", () => {
    const r = validateTaskInput({});
    expect("error" in r && r.error.code).toBe(-32602);
  });

  it("rejects an agentId that fails the pattern", () => {
    const r = validateTaskInput({ agentId: "bad id!" });
    expect("error" in r && r.error.code).toBe(-32602);
  });

  it("rejects an over-long agentId", () => {
    const r = validateTaskInput({ agentId: "a".repeat(65) });
    expect("error" in r && r.error.message).toMatch(/agentId/i);
  });

  it("rejects a wildcard agentId", () => {
    const r = validateTaskInput({ agentId: "*" });
    expect("error" in r && r.error.code).toBe(-32602);
  });

  it("rejects a non-string instruction", () => {
    const r = validateTaskInput({ agentId: "w", instruction: 123 });
    expect("error" in r && r.error.message).toMatch(/instruction must be a string/);
  });

  it("rejects an over-long instruction", () => {
    const r = validateTaskInput({
      agentId: "w",
      instruction: "x".repeat(10_001),
    });
    expect("error" in r && r.error.message).toMatch(/too long/);
  });

  it("rejects an over-long expectedOutput", () => {
    const r = validateTaskInput({
      agentId: "w",
      expectedOutput: "x".repeat(10_001),
    });
    expect("error" in r && r.error.message).toMatch(/expectedOutput/);
  });

  it("rejects an over-long context", () => {
    const r = validateTaskInput({ agentId: "w", context: "x".repeat(20_001) });
    expect("error" in r && r.error.message).toMatch(/context/);
  });

  it("rejects a non-object inputs", () => {
    const r = validateTaskInput({ agentId: "w", inputs: [1, 2] });
    expect("error" in r && r.error.message).toMatch(/inputs must be a plain object/);
  });

  it("rejects inputs with too many keys", () => {
    const inputs: Record<string, number> = {};
    for (let i = 0; i < 65; i++) inputs[`k${i}`] = i;
    const r = validateTaskInput({ agentId: "w", inputs });
    expect("error" in r && r.error.message).toMatch(/too many keys/);
  });

  it("rejects an oversized total payload before walking it (OOM guard)", () => {
    const r = validateTaskInput({
      agentId: "w",
      instruction: "x".repeat(9_000),
      context: "y".repeat(19_000),
      expectedOutput: "z".repeat(9_000),
      inputs: { blob: "q".repeat(40_000) },
    });
    expect("error" in r && r.error.message).toMatch(/params too large/);
  });

  it("tolerates undefined params", () => {
    const r = validateTaskInput(undefined);
    expect("error" in r && r.error.code).toBe(-32602);
  });

  it("does not crash on a circular-reference payload (size-guard catch)", () => {
    const circular: Record<string, unknown> = { agentId: "writer" };
    circular["self"] = circular;
    // safeStringify returns "" on a circular ref → size check passes → agentId valid.
    const r = validateTaskInput(circular);
    expect("params" in r).toBe(true);
  });
});
