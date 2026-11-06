// SPDX-License-Identifier: Apache-2.0
import { Team } from "kaibanjs";
import type { Agent, Task } from "kaibanjs";
import { startTeam } from "./team-start";

export interface KaibanTeamConfig {
  name: string;
  agents: Agent[];
  tasks: Task[];
  env?: Record<string, string>;
  inputs?: Record<string, unknown>;
}

/** Minimal interface for state middleware — allows injection without importing adapters. */
export interface IStateMiddleware {
  attach(store: {
    subscribe: (listener: (state: never, prev: never) => void) => () => void;
  }): unknown;
  disconnect(): Promise<void>;
}

/**
 * Wraps a KaibanJS Team with optional DistributedStateMiddleware so that every Zustand
 * state mutation is published to the messaging layer → Redis Pub/Sub →
 * SocketGateway → kaiban-board in real-time.
 *
 * The middleware is injected via the constructor to keep infrastructure clean
 * (no adapters imported from infrastructure layer).
 *
 * Usage:
 *   const middleware = new DistributedStateMiddleware(redisUrl);
 *   const bridge = new KaibanTeamBridge({ name, agents, tasks }, middleware);
 *   const result = await bridge.start({ topic: 'AI news' });
 *
 * @deprecated For single-task execution prefer `createKaibanTaskHandler` from
 *   `kaiban-agent-bridge.ts` which provides built-in token/cost tracking via
 *   `WorkflowResult.stats`.  Use `KaibanTeamBridge` only when you need full
 *   Zustand state streaming to the board for a long-running multi-task team.
 */
export class KaibanTeamBridge {
  private readonly team: Team;
  private readonly middleware: IStateMiddleware | null;

  constructor(config: KaibanTeamConfig, middleware?: IStateMiddleware) {
    this.team = new Team({
      name: config.name,
      agents: config.agents,
      tasks: config.tasks,
      env: config.env ?? {},
    });
    this.middleware = middleware ?? null;

    if (this.middleware) {
      // KaibanJS store actions call the `set` Zustand gave them at creation, so
      // patching `setState` would never see them; `subscribe` sees every change.
      const store = this.team.getStore() as unknown as Parameters<
        IStateMiddleware["attach"]
      >[0];
      this.middleware.attach(store);
    }
  }

  getTeam(): Team {
    return this.team;
  }

  /**
   * Start the team. With a `signal`, an abort (an emergency STOP ALL, a
   * timeout, a shutdown) stops the team and rejects with the signal's reason;
   * an already-aborted signal never starts it. The team stops at the agent
   * loop's next step: unlike tasks run by an `AgentActor` (whose handler owns
   * the model instance, ADR-014), a model call already in flight here is not
   * cancelled and finishes, because the agents are built by the caller.
   */
  async start(
    inputs: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<{ status: string; result: unknown; stats: unknown }> {
    return startTeam(this.team, inputs, signal);
  }

  subscribeToChanges(
    listener: (changes: Record<string, unknown>) => void,
    properties: string[] = [],
  ): () => void {
    return this.team.subscribeToChanges(listener, properties);
  }

  async disconnect(): Promise<void> {
    await this.middleware?.disconnect();
  }
}
