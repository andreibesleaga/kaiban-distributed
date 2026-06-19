/**
 * A2A task-input validation (Finding #3 hardening — OOM/DoS guard).
 *
 * Extracted from the legacy `A2AConnector` so the SDK-backed executor preserves
 * the exact Phase-1.3 contract: every accepted field is validated for type AND
 * size, the total serialized payload is byte-capped, and an invalid field yields
 * a JSON-RPC `-32602` (Invalid params) error. Only a validated, size-capped
 * payload is ever forwarded onto the messaging layer — never raw caller input.
 */

const MAX_AGENT_ID_LEN = 64;
const MAX_INSTRUCTION_LEN = 10_000;
const AGENT_ID_PATTERN = /^[\w-]+$/; // alphanumeric, underscore, hyphen

/** Per-field + total input caps. Exported so tests assert exact limits. */
export const A2A_INPUT_CAPS = {
  maxAgentIdLen: MAX_AGENT_ID_LEN,
  maxInstructionLen: MAX_INSTRUCTION_LEN,
  maxExpectedOutputLen: 10_000,
  maxContextLen: 20_000,
  maxInputsKeys: 64,
  /** Total serialized `params` byte cap — mirrors the 64 KB outbound data cap. */
  maxTotalParamsBytes: 65_536,
} as const;

/** A validated, size-capped task payload — the ONLY thing forwarded downstream. */
export interface ValidatedTaskInput {
  agentId: string;
  instruction?: string;
  expectedOutput?: string;
  context?: string;
  inputs?: Record<string, unknown>;
}

/** JSON-RPC error shape (code -32602 = Invalid params). */
export interface A2AInputError {
  code: number;
  message: string;
}

export type ValidationResult =
  | { params: ValidatedTaskInput }
  | { error: A2AInputError };

function invalidParam(message: string): { error: A2AInputError } {
  return { error: { code: -32602, message } };
}

/** Serialize for the byte-size guard without throwing on circular references. */
function safeStringify(value: Record<string, unknown>): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function validateOptionalString(
  value: unknown,
  field: string,
  maxLen: number,
): { value?: string } | { error: A2AInputError } {
  if (value === undefined) return {};
  if (typeof value !== "string") {
    return invalidParam(`${field} must be a string`);
  }
  if (value.length > maxLen) {
    return invalidParam(`${field} too long: max ${maxLen} chars`);
  }
  return { value };
}

function validateInputs(
  value: unknown,
): { value?: Record<string, unknown> } | { error: A2AInputError } {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidParam("inputs must be a plain object");
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length > A2A_INPUT_CAPS.maxInputsKeys) {
    return invalidParam(
      `inputs has too many keys: max ${A2A_INPUT_CAPS.maxInputsKeys}`,
    );
  }
  return { value: value as Record<string, unknown> };
}

function checkTotalSize(
  params: Record<string, unknown>,
): { error: A2AInputError } | undefined {
  const totalBytes = Buffer.byteLength(safeStringify(params), "utf8");
  if (totalBytes > A2A_INPUT_CAPS.maxTotalParamsBytes) {
    return invalidParam(
      `params too large: max ${A2A_INPUT_CAPS.maxTotalParamsBytes} bytes`,
    );
  }
  return undefined;
}

function validateAgentId(raw: unknown): string | { error: A2AInputError } {
  const agentId = String(raw ?? "");
  if (!agentId) return invalidParam("agentId is required");
  if (agentId.length > MAX_AGENT_ID_LEN || !AGENT_ID_PATTERN.test(agentId)) {
    return invalidParam(
      `Invalid agentId: must be alphanumeric/hyphens, max ${MAX_AGENT_ID_LEN} chars`,
    );
  }
  return agentId;
}

function buildValidated(
  agentId: string,
  p: Record<string, unknown>,
): ValidationResult {
  const instruction = validateOptionalString(
    p["instruction"],
    "instruction",
    A2A_INPUT_CAPS.maxInstructionLen,
  );
  if ("error" in instruction) return instruction;

  const expectedOutput = validateOptionalString(
    p["expectedOutput"],
    "expectedOutput",
    A2A_INPUT_CAPS.maxExpectedOutputLen,
  );
  if ("error" in expectedOutput) return expectedOutput;

  const context = validateOptionalString(
    p["context"],
    "context",
    A2A_INPUT_CAPS.maxContextLen,
  );
  if ("error" in context) return context;

  const inputs = validateInputs(p["inputs"]);
  if ("error" in inputs) return inputs;

  return {
    params: {
      agentId,
      ...(instruction.value !== undefined
        ? { instruction: instruction.value }
        : {}),
      ...(expectedOutput.value !== undefined
        ? { expectedOutput: expectedOutput.value }
        : {}),
      ...(context.value !== undefined ? { context: context.value } : {}),
      ...(inputs.value !== undefined ? { inputs: inputs.value } : {}),
    },
  };
}

/**
 * Validate a task-creation payload. On success returns the size-capped params;
 * otherwise a JSON-RPC `-32602` error describing the first violation.
 */
export function validateTaskInput(
  params: Record<string, unknown> | undefined,
): ValidationResult {
  const p = params ?? {};

  const sizeError = checkTotalSize(p);
  if (sizeError) return sizeError;

  const agentId = validateAgentId(p["agentId"]);
  if (typeof agentId !== "string") return agentId;

  return buildValidated(agentId, p);
}
