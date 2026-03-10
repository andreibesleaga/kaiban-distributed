# Technical Specifications (SPEC.md)

## 1. Domain Models

### Agent State Schema
```typescript
interface DistributedAgentState {
  agentId: string;
  status: 'IDLE' | 'THINKING' | 'EXECUTING' | 'ERROR';
  currentTaskId: string | null;
  memory: Record<string, any>; // Ephemeral AI Context
  version: string; // ETag for optimistic concurrency control
}
```

### Task Workflow Schema
```typescript
interface DistributedTask {
  taskId: string;
  assignedToAgentId: string | null;
  status: 'TODO' | 'DOING' | 'AWAITING_VALIDATION' | 'DONE' | 'BLOCKED';
  payload: {
    instruction: string;
    expectedOutput: string;
    context: string[];
  };
  result: any | null;
  logs: Array<{
    timestamp: string;
    level: string;
    message: string;
    traceId: string;
  }>;
}
```

## 2. API Definitions

### Messaging Abstraction Layer (MAL) Interface
```typescript
interface MessagingDriver {
  connect(config: any): Promise<void>;
  publishTask(topic: string, task: DistributedTask): Promise<void>;
  subscribeToTasks(queueName: string, handler: (task: DistributedTask) => Promise<void>): void;
  publishStateDelta(topic: string, delta: Partial<DistributedAgentState>): Promise<void>;
  subscribeToState(topic: string, handler: (delta: Partial<DistributedAgentState>) => void): void;
  disconnect(): Promise<void>;
}
```

### Federation: A2A Protocol Standard Endpoints
- `GET /.well-known/agent-card.json`: Returns the capabilities of the Kaiban Distributed Node.
- `POST /a2a/rpc`: Accepts JSON-RPC 2.0 requests from external agents.

**Example AgentCard Request Response:**
```json
{
  "name": "Kaiban Distributed Cluster",
  "version": "1.0.0",
  "description": "Enterprise-scale multi-agent distributed system",
  "capabilities": ["Research", "Writing", "System Configuration"],
  "endpoints": {
    "rpc": "https://api.internal/a2a/rpc"
  }
}
```
