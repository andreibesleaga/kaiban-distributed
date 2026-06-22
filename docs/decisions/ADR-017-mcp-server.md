# ADR-017 — MCP server (internal Tools/Resources/Prompts/Elicitation surface)

- **Status:** Accepted
- **Date:** 2026-06-19
- **Refs:** `KAIBAN-v2.0-MASTER-PLAN.md` §B5.1 Phase M + §B1.2 (federation invariants); §B8 BETA.2

## Context
v2.0 adds a first-party **MCP server** so MCP-speaking hosts (IDEs, agents, the Model Context Protocol
ecosystem) can discover and use a curated slice of the distributed runtime. The repo already ships an
MCP **client** (`MCPFederationClient`) so agent workers can *consume* external tools; what was missing
is the inbound direction — exposing *our* capabilities as MCP primitives.

The federation posture is fixed by §B1.2: **A2A is the public, agent-to-agent front door; MCP is the
internal tool/context surface.** The MCP server must therefore be least-privilege, env-gated off by
default, and must not become an unauthenticated side-door around the gateway's security chain.

## Decision
- **`src/infrastructure/federation/mcp-server.ts` — `buildMcpServer(deps)`** builds an
  `@modelcontextprotocol/sdk` `McpServer` exposing an **allow-listed** set of the four primitives:
  - **Tools** — `dispatch_task` (the one side-effecting action: hand an instruction to an agent).
  - **Resources** — `kaiban://agents` (agent list) and the `kaiban://agents/{agentId}/status` URI
    template (read-only grounding context).
  - **Prompts** — `delegate_task` (a reusable templated delegation flow).
  - **Elicitation** — a protocol-level **HITL consent gate** in front of `dispatch_task`.
  Capabilities come in as **injected dependencies** (`dispatchTask`, `listAgents`, `getAgentStatus`),
  so the server never reaches into the messaging layer directly and unit-tests against an in-memory
  transport with zero brokers.
- **Least-privilege:** an optional `allow` list (per kind) restricts what is registered; nothing
  registered ⇒ that capability is **not advertised** at all (the SDK answers list calls with `-32601`).
- **Fail-closed consent:** `dispatch_task` asks the client to authorize via **elicitation** before any
  token-spending work starts. A client that does **not** support elicitation is **refused** (no silent
  dispatch). `requireDispatchConsent: false` is available for trusted non-interactive deployments.
- **`src/infrastructure/federation/mcp-http.ts` — `createMcpHttpHandler(deps)`** bridges the gateway's
  Express surface to the SDK `StreamableHTTPServerTransport` in **stateful** mode (one transport +
  server per `mcp-session-id`) so server→client requests (elicitation) round-trip within a session.
  `enableJsonResponse` keeps it a plain-JSON RPC surface (no lingering SSE). Session lifecycle uses the
  transport's `onsessioninitialized` / `onsessionclosed` callbacks (each handed a guaranteed id).
- **Wired into the gateway** (`GatewayApp` POST/GET/DELETE at `MCP_SERVER_PATH`) **behind the same
  security chain as A2A** — helmet → per-IP rate-limit → env-gated JWT (`A2A_JWT_SECRET`) → request
  timeout. **Env-gated OFF by default** (`MCP_SERVER_ENABLED`). Dispatch reuses the A2A
  `validateTaskInput` caps + `taskId` dedup, so the MCP path and the A2A path enforce the same input
  contract and idempotency invariant.
- **New direct dependency: `zod ^4.4.3`** — required by the MCP SDK's tool/prompt input schemas (it was
  already present transitively via the SDK). Additive; no consumer-facing change.

## Invariants preserved
- **A2A in front, MCP internally** (§B1.2): A2A remains the agent-to-agent wire; the MCP server is an
  internal surface and the MCP client is the worker-side consumer. The MCP server never bypasses the
  gateway auth/rate-limit chain.
- **`taskId` idempotency / input caps:** MCP `dispatch_task` publishes through the same
  `validateTaskInput` (A2A_INPUT_CAPS) and per-`taskId` dedup as A2A.
- **Security opt-in / default-off / fail-closed:** the whole surface is off unless `MCP_SERVER_ENABLED`,
  and the consent gate fails closed.

## Deferred (roadmap)
- **MCP Roots** and **OAuth 2.1 / PKCE** — the gateway JWT (`A2A_JWT_SECRET`) is v2.0 auth; OAuth is a
  later beta.
- **`resource_link` overflow for large tool outputs** — current tool outputs are small structured JSON
  (`taskId`/`status`); when tools later return large payloads they should emit `resource_link`s.
- **Sampling / server→client `createMessage`** — not exposed yet.

## Consequences
- Hosts can drive the runtime over MCP, but only the curated, allow-listed, consent-gated slice.
- The server is fully unit-tested (real SDK `Client` over an in-memory transport + a real
  `StreamableHTTPClientTransport` round-trip over loopback) at 100% coverage with no brokers.
- One more env knob (`MCP_SERVER_ENABLED` + path/consent/allow-list) and one new direct dep (`zod`).
