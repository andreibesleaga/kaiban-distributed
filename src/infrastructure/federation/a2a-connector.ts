import { randomUUID } from "crypto";
import { Result, ok } from "../../domain/result";
import { DomainError } from "../../domain/errors/DomainError";
import type { IMessagingDriver } from "../messaging/interfaces";

export interface AgentCard {
  name: string;
  version: string;
  description: string;
  capabilities: string[];
  endpoints: { rpc: string };
}

export interface JsonRpcRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcError {
  code: number;
  message: string;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

// ── Input validation constants ───────────────────────────────────────
const MAX_AGENT_ID_LEN = 64;
const MAX_INSTRUCTION_LEN = 10_000;
const MAX_METHOD_ECHO_LEN = 100;
const AGENT_ID_PATTERN = /^[\w-]+$/; // alphanumeric, underscore, hyphen

/**
 * Per-field + total input caps for `tasks.create` (Finding #3 hardening).
 *
 * Every accepted field is validated for type AND size, and the total serialized
 * params byte size is capped so a giant array/object cannot OOM downstream. Only
 * a validated, size-capped payload is forwarded to the queue — never raw params.
 * Exported so tests assert against the exact limits (no magic numbers in tests).
 */
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
interface ValidatedCreateParams {
  agentId: string;
  instruction?: string;
  expectedOutput?: string;
  context?: string;
  inputs?: Record<string, unknown>;
}

function invalidParam(message: string): { error: JsonRpcError } {
  return { error: { code: -32602, message } };
}

/**
 * Serialize for the byte-size guard without throwing on circular references.
 * A non-serializable value collapses to "{}" — it is rejected later by the
 * per-field type checks, but must not crash the size pre-check.
 */
function safeStringify(value: Record<string, unknown>): string {
  try {
    // `value` is always a plain object here (callers pass `params ?? {}`), so
    // JSON.stringify returns a string; only a circular ref can throw.
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** Validate an optional string field for presence-typed correctness + length. */
function validateOptionalString(
  value: unknown,
  field: string,
  maxLen: number,
): { value?: string } | { error: JsonRpcError } {
  if (value === undefined) return {};
  if (typeof value !== "string") {
    return invalidParam(`${field} must be a string`);
  }
  if (value.length > maxLen) {
    return invalidParam(`${field} too long: max ${maxLen} chars`);
  }
  return { value };
}

/** Validate the optional `inputs` object (plain object, bounded key count). */
function validateInputs(
  value: unknown,
): { value?: Record<string, unknown> } | { error: JsonRpcError } {
  if (value === undefined) return {};
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
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

/**
 * Total-size OOM guard: reject a giant params blob before walking it, so a huge
 * array/object can never reach the queue or balloon memory here.
 */
function checkTotalSize(
  params: Record<string, unknown>,
): { error: JsonRpcError } | undefined {
  const totalBytes = Buffer.byteLength(safeStringify(params), "utf8");
  if (totalBytes > A2A_INPUT_CAPS.maxTotalParamsBytes) {
    return invalidParam(
      `params too large: max ${A2A_INPUT_CAPS.maxTotalParamsBytes} bytes`,
    );
  }
  return undefined;
}

/** Validate `agentId`; returns the string on success or a JSON-RPC error. */
function validateAgentId(raw: unknown): string | { error: JsonRpcError } {
  const agentId = String(raw ?? "");
  if (!agentId) return invalidParam("agentId is required");
  if (agentId.length > MAX_AGENT_ID_LEN || !AGENT_ID_PATTERN.test(agentId)) {
    return invalidParam(
      `Invalid agentId: must be alphanumeric/hyphens, max ${MAX_AGENT_ID_LEN} chars`,
    );
  }
  return agentId;
}

/** Validate the optional fields and assemble the capped payload (or an error). */
function buildValidatedParams(
  agentId: string,
  p: Record<string, unknown>,
): ValidatedCreateParams | { error: JsonRpcError } {
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
    agentId,
    ...(instruction.value !== undefined
      ? { instruction: instruction.value }
      : {}),
    ...(expectedOutput.value !== undefined
      ? { expectedOutput: expectedOutput.value }
      : {}),
    ...(context.value !== undefined ? { context: context.value } : {}),
    ...(inputs.value !== undefined ? { inputs: inputs.value } : {}),
  };
}

export class A2AConnector {
  constructor(
    private readonly agentCard: AgentCard,
    private readonly driver?: IMessagingDriver,
  ) {}

  getAgentCard(): AgentCard {
    return this.agentCard;
  }

  async handleRpc(
    request: JsonRpcRequest,
  ): Promise<Result<JsonRpcResponse, DomainError>> {
    if (request.jsonrpc !== "2.0") {
      return ok({
        jsonrpc: "2.0",
        id: request.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
    }

    const dispatched = await this.dispatch(request.method, request.params);
    if ("error" in dispatched) {
      return ok({ jsonrpc: "2.0", id: request.id, error: dispatched.error });
    }
    return ok({ jsonrpc: "2.0", id: request.id, result: dispatched.result });
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<{ result: unknown } | { error: JsonRpcError }> {
    switch (method) {
      case "agent.status":
        return { result: { status: "IDLE", agentId: this.agentCard.name } };
      case "tasks.create":
        return this.handleTasksCreate(params);
      case "tasks.get":
        return {
          result: { taskId: params?.["taskId"] ?? null, status: "TODO" },
        };
      default:
        // Sanitize echoed method name to prevent log/response injection
        return {
          error: {
            code: -32601,
            message: `Method not found: ${String(method).slice(0, MAX_METHOD_ECHO_LEN)}`,
          },
        };
    }
  }

  private validateCreateParams(
    params: Record<string, unknown> | undefined,
  ): ValidatedCreateParams | { error: JsonRpcError } {
    const p = params ?? {};

    const sizeError = checkTotalSize(p);
    if (sizeError) return sizeError;

    const agentId = validateAgentId(p["agentId"]);
    if (typeof agentId !== "string") return agentId;

    return buildValidatedParams(agentId, p);
  }

  private async handleTasksCreate(
    params: Record<string, unknown> | undefined,
  ): Promise<{ result: unknown } | { error: JsonRpcError }> {
    const validated = this.validateCreateParams(params);
    if ("error" in validated) return validated;

    const taskId = randomUUID();
    const { agentId, ...payload } = validated;

    if (this.driver) {
      await this.driver.publish(`kaiban-agents-${agentId}`, {
        taskId,
        agentId,
        // Forward ONLY the validated, size-capped payload — never raw params.
        data: { ...payload },
        timestamp: Date.now(),
      });
    }

    return { result: { taskId, status: "QUEUED", agentId } };
  }
}
