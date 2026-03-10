import { Team } from 'kaibanjs';
import type { Agent, Task } from 'kaibanjs';
import { DistributedStateMiddleware } from '../../adapters/state/distributedMiddleware';
import type { IMessagingDriver } from '../messaging/interfaces';

export interface KaibanTeamConfig {
  name: string;
  agents: Agent[];
  tasks: Task[];
  env?: Record<string, string>;
  inputs?: Record<string, unknown>;
}

/**
 * Wraps a KaibanJS Team with DistributedStateMiddleware so that every Zustand
 * state mutation is published to the messaging layer → Redis Pub/Sub →
 * SocketGateway → kaiban-board in real-time.
 *
 * Usage:
 *   const bridge = new KaibanTeamBridge({ name, agents, tasks }, driver);
 *   const result = await bridge.start({ topic: 'AI news' });
 */
export class KaibanTeamBridge {
  private readonly team: Team;
  private readonly middleware: DistributedStateMiddleware;

  constructor(
    config: KaibanTeamConfig,
    driver: IMessagingDriver,
    stateChannel = 'kaiban-state-events',
  ) {
    this.team = new Team({ name: config.name, agents: config.agents, tasks: config.tasks, env: config.env ?? {} });
    this.middleware = new DistributedStateMiddleware(driver, stateChannel);

    const store = this.team.getStore() as unknown as { setState: (p: Record<string, unknown>) => void };
    this.middleware.attach(store);
  }

  getTeam(): Team {
    return this.team;
  }

  async start(inputs: Record<string, unknown> = {}): Promise<{ status: string; result: unknown; stats: unknown }> {
    return this.team.start(inputs);
  }

  subscribeToChanges(
    listener: (changes: Record<string, unknown>) => void,
    properties: string[] = [],
  ): () => void {
    return this.team.subscribeToChanges(listener, properties);
  }
}
