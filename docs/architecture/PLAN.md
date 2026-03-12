# Architecture Plan (PLAN.md)
## System Architecture & C4 Diagrams

### 1. System Context Diagram
```mermaid
graph TB
  %% Node Definitions
  user["fa:fa-user Human Operator<br/>(Monitors & manages workflows)"]
  
  subgraph Core ["Internal System"]
    kaibanjs["fa:fa-gear KaibanJS Environment<br/>(Core workflow engine)"]
  end

  subgraph External ["External Ecosystem"]
    langgraph["fa:fa-network-wired LangGraph Systems<br/>(Federated AI via A2A)"]
    mcp["fa:fa-server MCP Servers<br/>(Tool & Context access)"]
  end

  %% Relationships
  user -- "Views state & manages tasks<br/>(WebSocket / HTTP)" --- kaibanjs
  kaibanjs -- "Delegates sub-tasks<br/>(A2A Protocol)" --> langgraph
  kaibanjs -- "Fetches tools & context<br/>(MCP Protocol)" --> mcp

  %% Styling
  style kaibanjs fill:#2d3e50,color:#fff,stroke:#1a252f,stroke-width:2px
  style Core fill:#f8f9fa,stroke:#dee2e6,stroke-dasharray: 5 5
  style External fill:#f1f3f5,stroke:#ced4da,stroke-dasharray: 5 5
  style user fill:#e7f5ff,stroke:#228be6
```

### 2. Container Diagram
```mermaid
C4Container
    title Container Diagram for Distributed KaibanJS
    Person(user, "Human Operator", "Monitors board via browser.")
    
    Container(ui, "Kaiban Board UI", "React", "Visualizes tasks and logs.")
    Container(gateway, "Edge Gateway APIs", "Node.js (Express)", "Routes API calls and maintains WebSocket connections.")
    Container(broker, "Messaging Abstraction Layer (MAL)", "Redis/BullMQ or Kafka", "Message broker handling queueing and Pub/Sub state sync.")
    Container(orchestrator, "Team Orchestrator Nodes", "Node.js + KaibanJS", "Evaluates workflows and assigns tasks.")
    Container(worker, "Agent Worker Nodes", "Node.js + KaibanJS", "Lightweight Actor wrappers that process AI tasks sequentially.")

    Rel(user, ui, "Interacts with", "HTTPS")
    Rel(ui, gateway, "Listens to state via", "Socket.io")
    Rel(gateway, broker, "Subscribes to Event Stream", "Redis Pub/Sub")
    Rel(orchestrator, broker, "Publishes new tasks to", "BullMQ or Kafka")
    Rel(worker, broker, "Consumes tasks from", "BullMQ or Kafka")
    Rel(worker, broker, "Publishes status updates to", "Redis Pub/Sub")
```

### 3. Component Hierarchy (Internal Node.js Layout)
- `src/infrastructure/messaging/`
  - `interfaces.ts`: Base interfaces for Drivers
  - `bullmq-driver.ts`: Implementation using BullMQ & Redis.
  - `kafka-driver.ts`: Implementation using KafkaJS.
- `src/adapters/state/`
  - `distributedMiddleware.ts`: Zustand interceptor publishing state deltas.
  - `agent-state-publisher.ts`: Direct Redis pub/sub; 15s heartbeat; lifecycle.
- `src/application/actor/`
  - `AgentActor.ts`: Encapsulation of a single KaibanJS agent with local task queue processing.
- `src/infrastructure/federation/`
  - `a2a-connector.ts`: Generates AgentCards and handles JSON-RPC.
  - `mcp-client.ts`: Integrates existing MCP servers securely.
