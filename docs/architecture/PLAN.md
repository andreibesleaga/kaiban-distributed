# Architecture Plan (PLAN.md)
## System Architecture & C4 Diagrams

### 1. System Context Diagram
```mermaid
C4Context
    title System Context for Distributed KaibanJS
    Person(user, "Human Operator", "Monitors and manages workflows via Kaiban Board.")
    System(kaibanjs, "KaibanJS Environment", "Core workflow engine where AI agents execute tasks.")
    SystemExt(langgraph, "External AI Systems (LangGraph)", "Federated external AI networks communicating via A2A.")
    SystemExt(mcp, "MCP Servers", "External Model Context Protocol servers providing tool access.")

    Rel(user, kaibanjs, "Views state & manages tasks using", "WebSocket / HTTP")
    Rel(kaibanjs, langgraph, "Delegates sub-tasks using", "A2A Protocol")
    Rel(kaibanjs, mcp, "Fetches tools and context using", "MCP Protocol")
```

### 2. Container Diagram
```mermaid
C4Container
    title Container Diagram for Distributed KaibanJS
    Person(user, "Human Operator", "Monitors board via browser.")
    
    Container(ui, "Kaiban Board UI", "React", "Visualizes tasks and logs.")
    Container(gateway, "Edge Gateway APIs", "Node.js (Express)", "Routes API calls and maintains WebSocket connections.")
    Container(broker, "Messaging Abstraction Layer (MAL)", "Redis / BullMQ", "Message broker handling queueing and Pub/Sub state sync.")
    Container(orchestrator, "Team Orchestrator Nodes", "Node.js + KaibanJS", "Evaluates workflows and assigns tasks.")
    Container(worker, "Agent Worker Nodes", "Node.js + KaibanJS", "Lightweight Actor wrappers that process AI tasks sequentially.")

    Rel(user, ui, "Interacts with", "HTTPS")
    Rel(ui, gateway, "Listens to state via", "Socket.io")
    Rel(gateway, broker, "Subscribes to Event Stream", "Redis Pub/Sub")
    Rel(orchestrator, broker, "Publishes new tasks to", "BullMQ")
    Rel(worker, broker, "Consumes tasks from", "BullMQ")
    Rel(worker, broker, "Publishes status updates to", "Redis Pub/Sub")
```

### 3. Component Hierarchy (Internal Node.js Layout)
- `core/messaging`
  - `interfaces.ts`: Base interfaces for Drivers
  - `bullmq-driver.ts`: Implementation using BullMQ & Redis.
- `core/state`
  - `distributedMiddleware.ts`: Zustand interceptor publishing state deltas.
- `core/actor`
  - `AgentActor.ts`: Encapsulation of a single KaibanJS agent with local task queue processing.
- `core/federation`
  - `a2a-connector.ts`: Generates AgentCards and handles JSON-RPC.
  - `mcp-client.ts`: Integrates existing MCP servers securely.
