import { Agent, Task, Team } from "kaibanjs";
import type { IAgentParams } from "kaibanjs";
import type { MessagePayload, IMessagingDriver } from "../messaging/interfaces";
import type { ITokenProvider } from "../../domain/security/token-provider";
import type { TaskHandler } from "../../application/actor/AgentActor";
import { buildOwnedLlm } from "./owned-llm";
import { createStructuredLogger } from "../../shared/structured-logger";

const log = createStructuredLogger({ component: "KaibanAgentBridge" });

export type KaibanAgentConfig = IAgentParams;

/** Structured result returned by every KaibanJS task handler. */
export type KaibanHandlerResult = {
  answer: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
};

/**
 * Model pricing in USD per 1M tokens (input / output).
 * Used to compute estimated cost independently of KaibanJS's costDetails
 * (which can produce incorrect values with some providers/versions).
 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  // Anthropic
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  // OpenRouter (provider/model prefix)
  "openai/gpt-4o": { input: 2.5, output: 10.0 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
  "anthropic/claude-3-haiku": { input: 0.25, output: 1.25 },
  "google/gemini-flash-1.5": { input: 0.075, output: 0.3 },
  // Fallback (mid-range estimate)
  default: { input: 1.0, output: 3.0 },
};

/**
 * Normalize a model identifier for pricing lookup:
 * - lowercase
 * - strip a leading `provider/` segment (OpenRouter slugs, e.g. `openai/gpt-4o-mini`)
 * - strip a trailing dated/version suffix (e.g. `-2024-08-06` or `:20241022`)
 */
function normalizeModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/^[^/]+\//, "")
    .replace(/[-:]\d{4}-?\d{2}-?\d{2}$/, "")
    .replace(/[-:]v\d+$/, "");
}

/** Does either of two model identifiers prefix the other (date/version aside)? */
function isPrefixMatch(normalized: string, key: string): boolean {
  const normalizedKey = normalizeModel(key);
  return (
    normalized.startsWith(normalizedKey) || normalizedKey.startsWith(normalized)
  );
}

/** Resolve a model name to a pricing entry, falling back to `default` with a one-time warn. */
function resolvePricing(model: string): { input: number; output: number } {
  const exact = MODEL_PRICING[model];
  if (exact) return exact;

  const normalized = normalizeModel(model);
  const byNormalized = MODEL_PRICING[normalized];
  if (byNormalized) return byNormalized;

  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (key !== "default" && isPrefixMatch(normalized, key)) return pricing;
  }

  log.warn(
    { model, normalized },
    "Model not in pricing table; using default pricing",
  );
  return MODEL_PRICING["default"]!;
}

function estimateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const p = resolvePricing(model);
  return (
    (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output
  );
}

/** LLM API key environment variable names */
const LLM_API_KEY_NAMES: string[] = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
];

/**
 * Build the env map for KaibanJS Team initialization.
 * When a tokenProvider is given, tokens are fetched per-task (JIT).
 * When absent, falls back to reading `process.env` directly.
 */
async function buildEnv(
  tokenProvider?: ITokenProvider,
  taskId?: string,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const key of LLM_API_KEY_NAMES) {
    const val =
      tokenProvider && taskId
        ? await tokenProvider.getToken(key, taskId)
        : process.env[key];
    if (val) env[key] = val;
  }
  return env;
}

/** Build a KaibanJS Task from a raw message payload and a pre-created agent. */
function buildTask(payload: MessagePayload, agent: Agent): Task {
  const instruction = String(payload.data["instruction"] ?? "Execute task");
  const context = String(payload.data["context"] ?? "");
  const description = context
    ? `${instruction}\n\nContext:\n${context}`
    : instruction;
  return new Task({
    description,
    expectedOutput: String(payload.data["expectedOutput"] ?? "Task result"),
    agent,
  });
}

/**
 * Render a WorkflowResult.result into the handler `answer` string.
 * Mirrors `formatDisplayResult`: null/undefined → "", strings verbatim, and
 * structured (object/number/…) outputs JSON-stringified (never "[object Object]").
 */
function formatAnswer(result: unknown): string {
  if (result == null) return "";
  return typeof result === "string" ? result : JSON.stringify(result);
}

/** Convert a KaibanJS WorkflowResult into the structured KaibanHandlerResult. */
function toHandlerResult(
  result: {
    result: unknown;
    status?: unknown;
    stats: {
      llmUsageStats: { inputTokens: number; outputTokens: number };
    } | null;
  },
  model: string,
): KaibanHandlerResult {
  const inputTokens = result.stats?.llmUsageStats.inputTokens ?? 0;
  const outputTokens = result.stats?.llmUsageStats.outputTokens ?? 0;
  // Preserve structured (non-string) LLM outputs verbatim: stringify objects as
  // JSON rather than coercing to "[object Object]" (mirrors formatDisplayResult,
  // which renders null/undefined as "" and JSON-stringifies everything else).
  const answer = formatAnswer(result.result);
  return {
    answer,
    inputTokens,
    outputTokens,
    estimatedCost: estimateCost(model, inputTokens, outputTokens),
  };
}

function isSuccessfulWorkflowStatus(status: unknown): boolean {
  const normalised = String(status ?? "").toUpperCase();
  if (!normalised) return true;
  return [
    "COMPLETED",
    "DONE",
    "FINISHED",
    "SUCCESS",
    "SUCCEEDED",
    "STOPPED",
  ].includes(normalised);
}

type WorkflowLogLike = {
  logType?: unknown;
  agentStatus?: unknown;
  logDescription?: unknown;
  metadata?: {
    error?: unknown;
  };
};

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function extractNestedErrorMessageFromRecord(
  record: Record<string, unknown>,
  depth: number,
): string | undefined {
  const nestedKeys = [
    "originalError",
    "rootError",
    "cause",
    "error",
    "details",
  ];
  for (const key of nestedKeys) {
    const nestedMessage = extractNestedErrorMessage(record[key], depth + 1);
    if (nestedMessage) {
      return nestedMessage;
    }
  }

  return (
    toNonEmptyString(record["message"]) ??
    toNonEmptyString(record["blockReason"]) ??
    toNonEmptyString(record["logDescription"])
  );
}

function toErrorRecord(value: unknown): Record<string, unknown> | undefined {
  if (value instanceof Error) {
    return {
      originalError: (value as Error & { originalError?: unknown })
        .originalError,
      rootError: (value as Error & { rootError?: unknown }).rootError,
      cause: (value as Error & { cause?: unknown }).cause,
      error: (value as Error & { error?: unknown }).error,
      details: (value as Error & { details?: unknown }).details,
      message: value.message,
    };
  }

  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function extractRootCauseMessage(
  value: unknown,
  depth = 0,
): string | undefined {
  if (depth > 4 || value == null) {
    return undefined;
  }

  if (typeof value === "string") {
    return toNonEmptyString(value);
  }

  const record = toErrorRecord(value);
  if (!record) {
    return undefined;
  }

  const nestedKeys = [
    "originalError",
    "rootError",
    "cause",
    "error",
    "details",
  ];
  for (const key of nestedKeys) {
    const nestedMessage = extractRootCauseMessage(record[key], depth + 1);
    if (nestedMessage) {
      return nestedMessage;
    }
  }

  return depth > 0 ? toNonEmptyString(record["message"]) : undefined;
}
function extractNestedErrorMessage(
  value: unknown,
  depth = 0,
): string | undefined {
  if (depth > 4 || value == null) {
    return undefined;
  }

  if (typeof value === "string") {
    return toNonEmptyString(value);
  }

  const record = toErrorRecord(value);
  if (!record) {
    return undefined;
  }

  return extractNestedErrorMessageFromRecord(record, depth);
}

function extractWorkflowFailureReason(
  team: Team,
  result: { result: unknown },
): string | undefined {
  let workflowLogs: WorkflowLogLike[] = [];
  try {
    const state = team.getStore().getState() as {
      workflowLogs?: WorkflowLogLike[];
    };
    workflowLogs = state.workflowLogs ?? [];
  } catch {
    // getStore unavailable in minimal test mocks — fall back to result
  }

  return (
    findWorkflowRootCauseMessage(workflowLogs) ??
    findWorkflowFallbackMessage(workflowLogs) ??
    extractNestedErrorMessage(result.result) ??
    toNonEmptyString(result.result)
  );
}

function findWorkflowRootCauseMessage(
  workflowLogs: WorkflowLogLike[],
): string | undefined {
  for (let index = workflowLogs.length - 1; index >= 0; index -= 1) {
    const log = workflowLogs[index];
    if (!isRootCauseLog(log)) {
      continue;
    }

    const rootCauseMessage = extractRootCauseMessage(log?.metadata?.error);
    if (rootCauseMessage) {
      return rootCauseMessage;
    }
  }

  return undefined;
}

function isRootCauseLog(log: WorkflowLogLike | undefined): boolean {
  return (
    String(log?.logType ?? "") === "AgentStatusUpdate" ||
    String(log?.agentStatus ?? "").toUpperCase() === "THINKING_ERROR"
  );
}

function findWorkflowFallbackMessage(
  workflowLogs: WorkflowLogLike[],
): string | undefined {
  for (let index = workflowLogs.length - 1; index >= 0; index -= 1) {
    const log = workflowLogs[index];
    const errorMessage = extractNestedErrorMessage(log?.metadata?.error);
    if (errorMessage) {
      return errorMessage;
    }

    const description = toNonEmptyString(log?.logDescription);
    if (description) {
      return description
        .replace(/^Workflow blocked:\s*/i, "")
        .replace(/^Task blocked:.*?Reason:\s*/i, "")
        .trim();
    }
  }

  return undefined;
}

/**
 * Creates an AgentActor-compatible task handler backed by a KaibanJS Team.
 *
 * Uses Team.start() (one Team per task) instead of agent.workOnTask() so that
 * WorkflowResult.stats provides real token counts and cost — no extraction hacks.
 *
 * Maps MessagePayload → KaibanJS Task → Team.start() → returns KaibanHandlerResult.
 * Throws on ERRORED status so AgentActor retries (max 3 times), then DLQs.
 * The result is included in kaiban-events-completed data.result for downstream chaining.
 */
export function createKaibanTaskHandler(
  agentConfig: KaibanAgentConfig,
  _driver: IMessagingDriver,
  tokenProvider?: ITokenProvider,
): TaskHandler {
  return async (
    payload: MessagePayload,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const env = await buildEnv(tokenProvider, payload.taskId);

    // Finding #2 (ADR-014): when the actor supplies an AbortSignal, OWN the
    // LangChain LLM so the signal reaches `.invoke(input, { signal })` and a
    // timed-out / cancelled task stops burning tokens. KaibanJS 0.24.2 exposes
    // no abort on team.start(); it accepts our pre-built model verbatim. When
    // there is no signal (or a non-openai provider), KaibanJS builds its own
    // instance from env — unchanged behavior.
    const ownedLlm = signal
      ? buildOwnedLlm(agentConfig.llmConfig, signal)
      : undefined;
    const agent = new Agent(
      ownedLlm ? { ...agentConfig, llmInstance: ownedLlm } : agentConfig,
    );
    const team = new Team({
      name: `task-${payload.taskId}`,
      agents: [agent],
      tasks: [buildTask(payload, agent)],
      env,
    });

    const inputs = (payload.data["inputs"] as Record<string, unknown>) ?? {};
    const result = await team.start(inputs);

    // Compute cost before the ERRORED check so we can log it regardless.
    // KaibanJS's own summary box shows $-1 when the model isn't in its private
    // pricing table — this line prints the correct value from our MODEL_PRICING.
    const model = agentConfig.llmConfig?.model ?? "default";
    const handlerResult = toHandlerResult(result, model);
    log.info(
      {
        model,
        inputTokens: handlerResult.inputTokens,
        outputTokens: handlerResult.outputTokens,
        estimatedCost: handlerResult.estimatedCost,
      },
      "LLM cost",
    );

    if (!isSuccessfulWorkflowStatus(result.status)) {
      const failureReason =
        extractWorkflowFailureReason(team, result) ?? "unknown";
      throw new Error(
        /* v8 ignore next — null/undefined status returns true from isSuccessfulWorkflowStatus so "failed" fallback is unreachable */
        `KaibanJS workflow ${String(result.status ?? "failed").toLowerCase()}: ${failureReason}`,
      );
    }

    return handlerResult;
  };
}
