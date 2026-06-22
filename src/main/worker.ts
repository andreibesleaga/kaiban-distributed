import { loadConfig } from "./config";
import { initRuntimeTelemetry } from "./runtime";
import { buildLLMConfig } from "../shared/build-llm-config";
import { startAgentNode } from "../shared/agent-node";
import type { KaibanAgentConfig } from "../infrastructure/kaibanjs/kaiban-agent-bridge";
import { createStructuredLogger } from "../shared/structured-logger";

const log = createStructuredLogger({ component: "worker" });

/**
 * Build a default KaibanJS agent config for a worker-pool agent id.
 *
 * The generic worker image runs a configurable pool of agents (`AGENT_IDS`).
 * Each gets a real, LLM-backed task handler (Finding #1 fix / ADR-013) — unlike
 * the old single-entrypoint code, which built handler-less actors that silently
 * dropped tasks. Examples that need richer personas wire their own configs via
 * `startAgentNode` directly; this default keeps the generic image functional.
 */
export function buildDefaultAgentConfig(agentId: string): KaibanAgentConfig {
  const llmConfig = buildLLMConfig();
  return {
    name: agentId,
    role: "Distributed Worker Agent",
    goal: "Execute the assigned task accurately and return a concise, useful result",
    background: "A general-purpose distributed agent in the kaiban worker pool.",
    maxIterations: 10,
    ...(llmConfig ? { llmConfig } : {}),
  };
}

/**
 * Worker role (Finding #1 fix / ADR-013).
 *
 * Loads the agent pool from `AGENT_IDS` and wires a REAL, LLM-backed,
 * AbortSignal-aware task handler for every agent. The worker does NOT expose the
 * HTTP/WebSocket/A2A surface — that is the gateway role's job.
 */
export async function runWorker(): Promise<void> {
  const config = loadConfig();
  initRuntimeTelemetry(config);

  log.info({ agents: config.agentIds }, "Worker starting agent pool");

  await Promise.all(
    config.agentIds.map((agentId) =>
      startAgentNode({
        agentId,
        queue: `kaiban-agents-${agentId}`,
        agentConfig: buildDefaultAgentConfig(agentId),
        displayName: agentId,
        role: "Distributed Worker Agent",
        label: `[Worker:${agentId}]`,
        redisUrl: config.redis.url,
      }),
    ),
  );

  log.info({ agents: config.agentIds }, "Worker pool ready");
}
