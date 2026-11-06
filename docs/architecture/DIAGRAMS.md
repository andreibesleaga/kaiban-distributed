# Architecture views

Extra views of the system. The main container view and the task state machine are in the [README](../../README.md#architecture); the design is explained in [ACTOR_MODEL.md](ACTOR_MODEL.md), the plan and C4 sources in [PLAN.md](PLAN.md).

## Detailed ASCII view (layout, 2.1)

```
┌──────────────────────────────────────────────────────────────────────┐
│  Board Viewers (browser)                                             │
│  A. board/  — React + Vite app  (npm run dev → :5173)                │
│     Interactive HITL: Approve / Revise / Reject buttons              │
│     socket.emit('hitl:decision') ───────────────────────────────┐    │
│  B. examples/blog-team/viewer/board.html  (zero-setup)          │    │
│  Socket.io client ──────────────────────────────────────────────┼────┘
└─────────────────────────────────────────────────────────────────│────┘
                                                                  │ ws
┌─────────────────────────────────────────────────────────────────▼────┐
│  Edge Gateway  (port 3000)                                           │
│  GatewayApp:   GET /health · /ready · /startup                       │
│                GET /.well-known/agent-card.json                      │
│                POST /a2a/rpc  (JSON-RPC 2.0 → routes to queue)       │
│                /mcp (when enabled) · POST /control/stop-all          │
│  CompletionRouter: reads kaiban-events-completed / -failed           │
│  SocketGateway: subscribes Redis kaiban-state-events → Socket.io     │
│                 listens 'hitl:decision' → publishes kaiban-hitl-     │
│                 decisions (Redis) → orchestrator picks up decision   │
│                 'control:stop-all' → kaiban-control (Redis)          │
└──────────────────────────────────────────────────────────────────────┘
         │ BullMQ / Kafka task queues        │ Redis Pub/Sub
         │ kaiban-agents-{agentId}           │ kaiban-state-events
┌────────▼──────────┐  ┌────────▼────────┐  ┌────────▼───────────────┐
│ Worker: researcher│  │ Worker: writer  │  │ Worker: editor         │
│  AgentActor       │  │  AgentActor     │  │  AgentActor            │
│  KaibanAgentBridge│  │  KaibanBridge   │  │  KaibanBridge          │
│  → team.start()   │  │  → team.start() │  │  → team.start()        │
│  AgentState       │  │  AgentState     │  │  AgentState            │
│  Publisher        │  │  Publisher      │  │  Publisher             │
│  (ioredis pub/sub)│  │  (ioredis)      │  │  (ioredis)             │
└───────────────────┘  └─────────────────┘  └────────────────────────┘
         │                      │                        │
         └──────────────────────┴────────────────────────┘
                                │
                    ┌───────────▼────────────┐
                    │  Redis 7 (always)      │
                    │  BullMQ queues +       │
                    │  kaiban-state-events   │
                    └────────────────────────┘

  Redis Pub/Sub channels: kaiban-state-events · kaiban-hitl-decisions ·
  kaiban-control (STOP ALL; every worker and orchestrator holds a
  ControlSubscriber; `npm run stop-all` publishes to it directly)

  Optional: Kafka (MESSAGING_DRIVER=kafka)
┌─────────────────────────────────────────────────────────────────────┐
│  Zookeeper + Kafka — high-throughput alternative to BullMQ          │
│  KafkaDriver implements IMessagingDriver (swap via env var)         │
│  State broadcast still uses Redis Pub/Sub (SocketGateway)           │
└─────────────────────────────────────────────────────────────────────┘
```



## High-Level Distributed Topology Example

```mermaid
graph TD
    UI[Kanban Board UI<br>Browser] -- WebSockets --> Gateway
    RedisPubSub[(Redis Pub/Sub<br>State Stream)] -- state events --> Gateway
    subgraph Gateway[Edge Gateway APP, Port 3000]
        A2A[A2A Executor]
    end
    Ext[External A2A client] -- JSON-RPC message/send --> A2A
    
    A2A --> Queue[(Message Queue<br>BullMQ / Kafka)]
    
    Queue --> |Tasks| AgentA[Node 1: Researcher Actor]
    Queue --> |Tasks| AgentB[Node 2: Writer Actor]
    Queue --> |Tasks| AgentC[Node 3: Editor Actor]
    
    AgentA -- State Updates --> RedisPubSub
    AgentB -- State Updates --> RedisPubSub
    AgentC -- State Updates --> RedisPubSub
    
    AgentA <--> LLM[LLM APIs<br>OpenAI/Anthropic]
    AgentB <--> LLM
    AgentC <--> LLM
    AgentA <--> MCP[MCP Servers<br>Search/Database]
    AgentB <--> MCP
    AgentC <--> MCP
```


### Complete Architectural Schema (Digitalized from Sketch)

Conceptual overview, not a module map. Dify is shown as an example of an external workflow tool; this repository has no Dify code. Task lifecycle in the sketch omits STOPPED (see the state machine in the README).

```mermaid
flowchart TD
    classDef plain fill:none,stroke:none,color:inherit,font-style:italic;
    classDef solidBox fill:none,stroke:#333,stroke-width:2px;

    %% Row 1
    subgraph TopLevel [" "]
        direction LR
        TL["DISTRIBUTED AGENTIC"]:::plain
        Kanban["VISUALIZE TASKS, STREAMS:<br/> KANBAN STYLE BOARD<br/>(TODO, DOING, DONE, BLOCKED, AWAITING_VALIDATION)"]:::solidBox
        TR["WRAPPER ON KAIBANJS + OTHERS(DIFY, MCP, ETC.)<br/>ACTOR MODEL, ENTERPRISE GRADE MESSAGING + QUEUEING"]:::plain
        TL ~~~ Kanban ~~~ TR
    end
    style TopLevel fill:none,stroke:none;

    %% Row 2
    subgraph MidLevel [" "]
        direction LR
        MsgLayer["MESSAGE LAYER<br/>ASYNC. STREAMING MSG. / REALTIME (KAFKA, REDIS, ETC)"]:::solidBox
        MAL["MAL + DRIVERS / INTERFACES<br/>(MESSAGING AGENT LAYER)"]:::plain
        MsgLayer ~~~ MAL
    end
    style MidLevel fill:none,stroke:none;

    Kanban <--> MsgLayer

    %% Row 3
    subgraph AgentLevel [" "]
        direction LR
        ActorModelText["DISTRIBUTED INFRA: AI NODE AGENTS<br/>EACH AGENT ACTOR MODEL<br/>EDGE, IOT, LOCAL, KUBERNETES, ETC."]:::plain
        N1(("AGENT NODE<br/>optional V. SCALING"))
        N2(("AGENT<br/>NODE"))
        N3(("AGENT<br/>NODE"))
        N4(("AGENT NODE"))
        DistInfraText["TEAM WORKFLOW: RUNNING → FINISHED / STOPPED"]:::plain

        ActorModelText ~~~ N1
        N1 -- "optional H. SCALING" --- N2
        N2 ~~~ N3
        N3 -- "optional H. SCALING" --- N4
        N4 ~~~ DistInfraText
    end
    style AgentLevel fill:none,stroke:none;

    MsgLayer <--> N1
    MsgLayer <--> N2
    MsgLayer <--> N3
    MsgLayer <--> N4

    %% Row 4
    subgraph BottomLevel [" "]
        direction LR
        OtherSystemsText["OTHER SYSTEMS COMPONENTS<br/>INTERACTING VIA A2A, MCP, MESSAGING"]:::plain
        Dify["WORKFLOWS: ◯ ➞ ◻️ ➞ ◇ ➞ ◻️ [RES/OK]<br/>GRAPHIC AI PROGRAMMING"]:::solidBox
        OtherSystemsBox["OTHER SYSTEMS: CONNECTORS TO M.A.L<br/>CUSTOMIZED TO ORG/PROJECT"]:::solidBox

        OtherSystemsText ~~~ Dify ~~~ OtherSystemsBox
    end
    style BottomLevel fill:none,stroke:none;

    N1 -. "I/O - A2A" .-> Dify
    N2 -. "MCP I/O" .-> Dify
    N4 -->|"I/O: A2A, MCP MESSAGING"| OtherSystemsBox
```

