# MCP server (Model Context Protocol) — Phase M

> Authoritative spec: `KAIBAN-v2.0-MASTER-PLAN.md` §B5.1 Phase M · decision: `docs/decisions/ADR-017`.

kaiban-distributed speaks MCP in **both** directions:

| Direction | Component | Purpose |
| --- | --- | --- |
| **Outbound** (consumer) | `MCPFederationClient` (`mcp-client.ts`) | agent workers call *external* MCP tools |
| **Inbound** (provider) | **`buildMcpServer` + `createMcpHttpHandler`** (Phase M) | expose *our* capabilities to MCP hosts |

Federation posture (§B1.2): **A2A is the public agent-to-agent front door; MCP is the internal
tool/context surface.** The MCP server is **off by default** and sits **behind the gateway's security
chain** (helmet → rate-limit → env-gated JWT → timeout).

## Enabling it

```bash
MCP_SERVER_ENABLED=true            # off by default
MCP_SERVER_PATH=/mcp               # mount path (default /mcp)
MCP_DISPATCH_CONSENT=true          # require elicitation consent before dispatch (default true)
# Optional least-privilege allow-lists (CSV). Unset ⇒ the full curated set ships.
MCP_ALLOWED_TOOLS=dispatch_task
MCP_ALLOWED_RESOURCES=agents,agent-status
MCP_ALLOWED_PROMPTS=delegate_task
# Auth: when A2A_JWT_SECRET is set, the MCP route requires the same bearer token as /a2a/rpc.
A2A_JWT_SECRET=<random 32+ bytes>
```

The surface is **Streamable HTTP** at `${MCP_SERVER_PATH}`:
`POST` (initialize / call), `GET` (notification stream), `DELETE` (terminate). It runs **stateful**
(one session per `mcp-session-id`) so elicitation can round-trip; responses are plain JSON
(`enableJsonResponse`), not SSE.

## Capabilities (curated, allow-listed)

### Tools
- **`dispatch_task`** — hand an instruction to an allow-listed agent.
  Input: `{ agentId, instruction, expectedOutput? }`. **Side-effecting** → gated by **elicitation
  consent** (see below). Publishes to the agent mailbox (`kaiban-agents-{agentId}`) through the same
  `validateTaskInput` caps + `taskId` dedup as A2A. Returns `{ dispatched, taskId, status }`.

### Resources (read-only grounding context)
- **`kaiban://agents`** — the agents this gateway can route to, with last-known status.
- **`kaiban://agents/{agentId}/status`** — one agent's last-known status (URI template; the list
  callback enumerates one entry per agent).

### Prompts
- **`delegate_task`** — args `{ agentId, goal }`; renders a delegation message that steers the model to
  call `dispatch_task` (and to expect a consent prompt).

### Elicitation (HITL consent)
Before `dispatch_task` starts any work it asks the client to **authorize** via MCP elicitation
(a `confirm` boolean form). Outcomes:
- client **accepts** + `confirm: true` → dispatched;
- client **declines** / cancels / `confirm: false` → **not** dispatched (`dispatched: false`);
- client **does not support elicitation** → **fail-closed**: refused, never dispatched.

Set `MCP_DISPATCH_CONSENT=false` only for trusted, non-interactive deployments that accept the risk.

## Least-privilege

`MCP_ALLOWED_*` filter which capabilities are registered. If a kind's list is **empty**, nothing of
that kind is registered and the capability is **not advertised at all** (an MCP `list` call returns
`-32601 Method not found`). Unset ⇒ the full curated set ships.

## Connecting (example)

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client(
  { name: "my-host", version: "1.0.0" },
  { capabilities: { elicitation: {} } }, // required to call dispatch_task
);
await client.connect(
  new StreamableHTTPClientTransport(new URL("http://localhost:3000/mcp")),
);
await client.listTools();      // → dispatch_task
await client.readResource({ uri: "kaiban://agents" });
await client.callTool({ name: "dispatch_task", arguments: { agentId: "writer", instruction: "…" } });
```

## Deferred (roadmap)
MCP **Roots**, **OAuth 2.1 / PKCE** (gateway JWT is v2.0 auth), `resource_link` overflow for large
tool outputs, and server→client **sampling** are not exposed yet. See ADR-017.

## Library API
Exported from both `kaiban-distributed` and `kaiban-distributed/shared` is not applicable — these ship
from the main entry point (`kaiban-distributed`):
`buildMcpServer`, `createMcpHttpHandler`, `McpServerDeps`, `McpHttpHandler`, `McpAllowList`, the
`MCP_*` capability-name constants, and the `McpDispatch*` / `McpAgent*` types.
