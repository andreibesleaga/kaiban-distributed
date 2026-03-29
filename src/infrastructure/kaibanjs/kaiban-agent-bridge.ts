import { Agent, Task, Team } from 'kaibanjs';
import type { IAgentParams } from 'kaibanjs';
import type { MessagePayload, IMessagingDriver } from '../messaging/interfaces';
import type { ITokenProvider } from '../../domain/security/token-provider';

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
  'gpt-4o':                     { input: 2.50,  output: 10.00 },
  'gpt-4o-mini':                { input: 0.15,  output: 0.60  },
  'gpt-4-turbo':                { input: 10.00, output: 30.00 },
  'gpt-3.5-turbo':              { input: 0.50,  output: 1.50  },
  // Anthropic
  'claude-3-5-sonnet-20241022': { input: 3.00,  output: 15.00 },
  'claude-3-5-haiku-20241022':  { input: 0.80,  output: 4.00  },
  'claude-3-haiku-20240307':    { input: 0.25,  output: 1.25  },
  // OpenRouter (provider/model prefix)
  'openai/gpt-4o':              { input: 2.50,  output: 10.00 },
  'openai/gpt-4o-mini':         { input: 0.15,  output: 0.60  },
  'anthropic/claude-3-haiku':   { input: 0.25,  output: 1.25  },
  'google/gemini-flash-1.5':    { input: 0.075, output: 0.30  },
  // Fallback (mid-range estimate)
  'default':                    { input: 1.00,  output: 3.00  },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = MODEL_PRICING[model] ?? MODEL_PRICING['default']!;
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

/** LLM API key environment variable names */
const LLM_API_KEY_NAMES: string[] = [
  'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY',
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
    const val = tokenProvider && taskId
      ? await tokenProvider.getToken(key, taskId)
      : process.env[key];
    if (val) env[key] = val;
  }
  return env;
}

/** Build a KaibanJS Task from a raw message payload and a pre-created agent. */
function buildTask(payload: MessagePayload, agent: Agent): Task {
  const instruction = String(payload.data['instruction'] ?? 'Execute task');
  const context     = String(payload.data['context'] ?? '');
  const description = context ? `${instruction}\n\nContext:\n${context}` : instruction;
  return new Task({
    description,
    expectedOutput: String(payload.data['expectedOutput'] ?? 'Task result'),
    agent,
  });
}

/** Convert a KaibanJS WorkflowResult into the structured KaibanHandlerResult. */
function toHandlerResult(
  result: { result: unknown; stats: { llmUsageStats: { inputTokens: number; outputTokens: number } } | null },
  model: string,
): KaibanHandlerResult {
  const inputTokens  = result.stats?.llmUsageStats.inputTokens  ?? 0;
  const outputTokens = result.stats?.llmUsageStats.outputTokens ?? 0;
  return {
    answer: String(result.result ?? ''),
    inputTokens,
    outputTokens,
    estimatedCost: estimateCost(model, inputTokens, outputTokens),
  };
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
): (payload: MessagePayload) => Promise<unknown> {

  return async (payload: MessagePayload): Promise<unknown> => {
    const env   = await buildEnv(tokenProvider, payload.taskId);
    const agent = new Agent(agentConfig);
    const team  = new Team({
      name: `task-${payload.taskId}`,
      agents: [agent],
      tasks:  [buildTask(payload, agent)],
      env,
    });

    const inputs = (payload.data['inputs'] as Record<string, unknown>) ?? {};
    const result = await team.start(inputs);

    // Compute cost before the ERRORED check so we can log it regardless.
    // KaibanJS's own summary box shows $-1 when the model isn't in its private
    // pricing table — this line prints the correct value from our MODEL_PRICING.
    const model = agentConfig.llmConfig?.model ?? 'default';
    const handlerResult = toHandlerResult(result, model);
    console.log(
      `[Cost] model=${model} ` +
      `input=${handlerResult.inputTokens} output=${handlerResult.outputTokens} ` +
      `cost=$${handlerResult.estimatedCost.toFixed(6)}`,
    );

    if (result.status === 'ERRORED') {
      throw new Error(`KaibanJS workflow error: ${String(result.result ?? 'unknown')}`);
    }

    return handlerResult;
  };
}
