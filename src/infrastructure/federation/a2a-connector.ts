import { randomUUID } from 'crypto';
import { Result, ok } from '../../domain/result';
import { DomainError } from '../../domain/errors/DomainError';
import type { IMessagingDriver } from '../messaging/interfaces';

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
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

// ── Input validation constants ───────────────────────────────────────
const MAX_AGENT_ID_LEN = 64;
const MAX_INSTRUCTION_LEN = 10_000;
const MAX_METHOD_ECHO_LEN = 100;
const AGENT_ID_PATTERN = /^[\w-]+$/;  // alphanumeric, underscore, hyphen

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
    if (request.jsonrpc !== '2.0') {
      return ok({
        jsonrpc: '2.0',
        id: request.id ?? null,
        error: { code: -32600, message: 'Invalid Request' },
      });
    }

    const dispatched = await this.dispatch(request.method, request.params);
    if ('error' in dispatched) {
      return ok({ jsonrpc: '2.0', id: request.id, error: dispatched.error });
    }
    return ok({ jsonrpc: '2.0', id: request.id, result: dispatched.result });
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<{ result: unknown } | { error: JsonRpcError }> {
    switch (method) {
      case 'agent.status':
        return { result: { status: 'IDLE', agentId: this.agentCard.name } };
      case 'tasks.create':
        return this.handleTasksCreate(params);
      case 'tasks.get':
        return { result: { taskId: params?.['taskId'] ?? null, status: 'TODO' } };
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
  ): { agentId: string } | { error: JsonRpcError } {
    const agentId = String(params?.['agentId'] ?? '');

    if (!agentId) {
      return {
        error: {
          code: -32602,
          message: 'agentId is required',
        },
      };
    }

    if (agentId.length > MAX_AGENT_ID_LEN || !AGENT_ID_PATTERN.test(agentId)) {
      return {
        error: {
          code: -32602,
          message: `Invalid agentId: must be alphanumeric/hyphens, max ${MAX_AGENT_ID_LEN} chars`,
        },
      };
    }

    const instruction = params?.['instruction'];
    if (instruction !== undefined && typeof instruction === 'string' && instruction.length > MAX_INSTRUCTION_LEN) {
      return {
        error: {
          code: -32602,
          message: `instruction too long: max ${MAX_INSTRUCTION_LEN} chars`,
        },
      };
    }

    return { agentId };
  }

  private async handleTasksCreate(
    params: Record<string, unknown> | undefined,
  ): Promise<{ result: unknown } | { error: JsonRpcError }> {
    const validated = this.validateCreateParams(params);
    if ('error' in validated) return validated;

    const taskId = randomUUID();
    const { agentId } = validated;

    if (this.driver) {
      await this.driver.publish(`kaiban-agents-${agentId}`, {
        taskId,
        agentId,
        data: params ?? {},
        timestamp: Date.now(),
      });
    }

    return { result: { taskId, status: 'QUEUED', agentId } };
  }
}
