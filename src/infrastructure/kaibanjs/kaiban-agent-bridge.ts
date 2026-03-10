import { Agent, Task } from 'kaibanjs';
import type { IAgentParams } from 'kaibanjs';
import type { MessagePayload, IMessagingDriver } from '../messaging/interfaces';

export type KaibanAgentConfig = IAgentParams;

type AgentLoopResult = { result?: { finalAnswer?: string } | string | null };

function extractFinalAnswer(loopResult: AgentLoopResult): unknown {
  const r = loopResult?.result;
  if (!r) return loopResult;
  if (typeof r === 'object' && 'finalAnswer' in r) return r.finalAnswer;
  if (typeof r === 'string') return r;
  return r;
}

/**
 * KaibanJS agents require initialization by a Team (which calls agentInstance.initialize(store, env)).
 * Without it, llmInstance is never set and workOnTask() throws "LLM instance is not initialized".
 * This helper bootstraps the internal LLM from llmConfig without needing a full Team.
 */
function initializeAgentLLM(agent: Agent): void {
  const internal = (agent as unknown as {
    agentInstance: {
      initialize: (store: null, env: Record<string, string>) => void;
      llmInstance?: unknown;
      llmConfig?: unknown;
    };
  }).agentInstance;

  if (!internal || internal.llmInstance) return; // Already initialized

  const env: Record<string, string> = {};
  const keys: Array<keyof NodeJS.ProcessEnv> = [
    'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY',
    'GOOGLE_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY',
  ];
  for (const key of keys) {
    const val = process.env[key as string];
    if (val) env[key as string] = val;
  }

  internal.initialize(null, env);
}

/**
 * Creates an AgentActor-compatible task handler backed by a real KaibanJS Agent.
 *
 * Maps MessagePayload → KaibanJS Task → agent.workOnTask() → returns LLM finalAnswer.
 * The result is included in kaiban-events-completed data.result for downstream chaining.
 */
export function createKaibanTaskHandler(
  agentConfig: KaibanAgentConfig,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _driver: IMessagingDriver,
): (payload: MessagePayload) => Promise<unknown> {
  const agent = new Agent(agentConfig);
  initializeAgentLLM(agent);

  return async (payload: MessagePayload): Promise<unknown> => {
    // Re-initialize on each call in case env changed (e.g. in tests)
    initializeAgentLLM(agent);

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
