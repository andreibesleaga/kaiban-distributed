import { Agent, Task } from 'kaibanjs';
import type { IAgentParams } from 'kaibanjs';
import type { MessagePayload, IMessagingDriver } from '../messaging/interfaces';
import type { ITokenProvider } from '../../domain/security/token-provider';

export type KaibanAgentConfig = IAgentParams;

/**
 * KaibanJS AgentLoopResult shape.
 * When LLM call fails, KaibanJS returns { error, metadata } with no `result` field.
 * When LLM call succeeds, it returns { result: { finalAnswer } | string }.
 */
type AgentLoopResult =
  | { result?: { finalAnswer?: string } | string | null; error?: never }
  | { error: string; metadata: { iterations: number; maxAgentIterations: number }; result?: never };

function extractFinalAnswer(loopResult: AgentLoopResult): unknown {
  // KaibanJS error result — throw so AgentActor retries and eventually DLQs
  if (loopResult && typeof loopResult === 'object' && 'error' in loopResult && loopResult.error) {
    throw new Error(`KaibanJS execution error: ${loopResult.error}`);
  }
  const r = (loopResult as { result?: { finalAnswer?: string } | string | null }).result;
  if (!r) return loopResult;
  if (typeof r === 'object' && 'finalAnswer' in r) return r.finalAnswer;
  if (typeof r === 'string') return r;
  return r;
}

/** LLM API key environment variable names */
const LLM_API_KEY_NAMES: string[] = [
  'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY',
];

/**
 * KaibanJS agents require initialization by a Team (which calls agentInstance.initialize(store, env)).
 * Without it, llmInstance is never set and workOnTask() throws "LLM instance is not initialized".
 * This helper bootstraps the internal LLM from llmConfig without needing a full Team.
 *
 * When a tokenProvider is given, tokens are fetched per-task (JIT).
 * When absent, falls back to reading `process.env` directly (backwards-compatible).
 */
async function initializeAgentLLM(
  agent: Agent,
  tokenProvider?: ITokenProvider,
  taskId?: string,
): Promise<void> {
  const internal = (agent as unknown as {
    agentInstance: {
      initialize: (store: null, env: Record<string, string>) => void;
      llmInstance?: unknown;
      llmConfig?: unknown;
    };
  }).agentInstance;

  if (!internal) return;

  // When using JIT tokens, always re-initialize to get fresh tokens per task
  if (internal.llmInstance && !tokenProvider) return;

  const env: Record<string, string> = {};

  if (tokenProvider && taskId) {
    for (const key of LLM_API_KEY_NAMES) {
      const val = await tokenProvider.getToken(key, taskId);
      if (val) env[key] = val;
    }
  } else {
    for (const key of LLM_API_KEY_NAMES) {
      const val = process.env[key];
      if (val) env[key] = val;
    }
  }

  internal.initialize(null, env);
}

/**
 * Creates an AgentActor-compatible task handler backed by a real KaibanJS Agent.
 *
 * Maps MessagePayload → KaibanJS Task → agent.workOnTask() → returns LLM finalAnswer.
 * Throws on KaibanJS error results so AgentActor retries (max 3 times), then DLQs.
 * The result is included in kaiban-events-completed data.result for downstream chaining.
 */
export function createKaibanTaskHandler(
  agentConfig: KaibanAgentConfig,
  _driver: IMessagingDriver,
  tokenProvider?: ITokenProvider,
): (payload: MessagePayload) => Promise<unknown> {
  const agent = new Agent(agentConfig);

  // Initial sync initialization (backwards-compatible when no tokenProvider)
  if (!tokenProvider) {
    void initializeAgentLLM(agent);
  }

  return async (payload: MessagePayload): Promise<unknown> => {
    await initializeAgentLLM(agent, tokenProvider, payload.taskId);

    const task = new Task({
      description: String(payload.data['instruction'] ?? 'Execute task'),
      expectedOutput: String(payload.data['expectedOutput'] ?? 'Task result'),
      agent,
    });

    const inputs = (payload.data['inputs'] as Record<string, unknown>) ?? {};
    const context = String(payload.data['context'] ?? '');

    const loopResult = await agent.workOnTask(task, inputs, context) as AgentLoopResult;
    return extractFinalAnswer(loopResult);
  };
}
