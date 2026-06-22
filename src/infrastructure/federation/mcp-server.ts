/**
 * MCP server (master plan §B5.1 Phase M, ADR-017).
 *
 * Exposes a curated, ALLOW-LISTED slice of the distributed runtime to MCP
 * clients as the four MCP primitives:
 *   - Tools     — actions (`dispatch_task`: hand an instruction to an agent)
 *   - Resources — read-only grounding context (`kaiban://agents`, per-agent status)
 *   - Prompts   — reusable templated flows (`delegate_task`)
 *   - Elicitation — a protocol-level HITL consent gate in front of the one
 *                   side-effecting tool (dispatching real, token-spending work).
 *
 * Federation posture (§B1.2): **A2A is the public front door; MCP is the
 * internal tool/context surface.** Least-privilege — only allow-listed
 * capabilities are registered, and `dispatch_task` is fail-closed: if the client
 * cannot be asked for consent (no elicitation capability), it refuses to dispatch.
 *
 * The server takes its capabilities as injected dependencies (dispatch + agent
 * lookups) so it unit-tests against an in-memory transport with zero brokers and
 * never reaches into the messaging layer directly.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  CallToolResult,
  GetPromptResult,
  ListResourcesResult,
  ReadResourceResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import { z } from "zod";

/** Result of handing a task to an agent. */
export interface McpDispatchResult {
  taskId: string;
  status: string;
}

/** One agent as advertised on the `kaiban://agents` resource. */
export interface McpAgentSummary {
  id: string;
  status: string;
}

/** Detailed, last-known status of a single agent. */
export interface McpAgentStatusDetail {
  agentId: string;
  status: string;
  seen: boolean;
}

/** Input to the `dispatch_task` tool (post-validation). */
export interface McpDispatchInput {
  agentId: string;
  instruction: string;
  expectedOutput?: string;
}

/**
 * Allow-list (least-privilege). When a kind's array is provided, ONLY those
 * capability names are registered; when omitted, the full curated set for that
 * kind ships. Default-deny is achieved by passing an empty array.
 */
export interface McpAllowList {
  tools?: string[];
  resources?: string[];
  prompts?: string[];
}

/** Capability names this server knows how to expose (the curated set). */
export const MCP_TOOL_DISPATCH = "dispatch_task";
export const MCP_RESOURCE_AGENTS = "agents";
export const MCP_RESOURCE_AGENT_STATUS = "agent-status";
export const MCP_PROMPT_DELEGATE = "delegate_task";

export interface McpServerDeps {
  /** Hand an instruction to an allow-listed agent (the one side-effecting action). */
  dispatchTask(input: McpDispatchInput): Promise<McpDispatchResult>;
  /** Enumerate the agents this server may expose (grounding context). */
  listAgents(): McpAgentSummary[] | Promise<McpAgentSummary[]>;
  /** Last-known status of one agent (grounding context). */
  getAgentStatus(
    agentId: string,
  ): McpAgentStatusDetail | Promise<McpAgentStatusDetail>;
  /** Restrict which capabilities are registered (least-privilege). */
  allow?: McpAllowList;
  /**
   * Gate `dispatch_task` behind an elicitation consent prompt. Default `true`
   * (fail-closed). When `false`, dispatch runs without asking — only for trusted,
   * non-interactive deployments that accept the risk.
   */
  requireDispatchConsent?: boolean;
  /** Server identity advertised in the MCP `Implementation` block. */
  name?: string;
  version?: string;
}

const DEFAULT_NAME = "kaiban-distributed";
const DEFAULT_VERSION = "2.0.0";
const CONSENT_INSTRUCTION_PREVIEW = 200;

/** Whether a capability of `kind`/`name` is permitted by the allow-list. */
function isAllowed(
  allow: McpAllowList | undefined,
  kind: keyof McpAllowList,
  name: string,
): boolean {
  const list = allow?.[kind];
  return list === undefined || list.includes(name);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A text tool result carrying both a human string and machine-readable JSON. */
function toolJson(payload: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

type ConsentDecision = { granted: boolean; reason: string };

/**
 * Ask the connected client to authorize a dispatch via MCP elicitation.
 * Fail-closed: a client that does not support elicitation is refused outright.
 */
async function requestDispatchConsent(
  server: McpServer,
  input: McpDispatchInput,
): Promise<ConsentDecision> {
  const capabilities = server.server.getClientCapabilities();
  if (!capabilities?.elicitation) {
    return {
      granted: false,
      reason:
        "client does not support elicitation (consent) — refusing dispatch (fail-closed)",
    };
  }
  const result = await server.server.elicitInput({
    message:
      `Authorize dispatching a task to agent "${input.agentId}"? ` +
      `Instruction: ${truncate(input.instruction, CONSENT_INSTRUCTION_PREVIEW)}`,
    requestedSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "boolean",
          title: "Confirm dispatch",
          description: "Approve starting this task on the distributed agent.",
        },
      },
      required: ["confirm"],
    },
  });
  if (result.action !== "accept") {
    return { granted: false, reason: `consent ${result.action}` };
  }
  if (result.content?.["confirm"] !== true) {
    return { granted: false, reason: "consent form rejected" };
  }
  return { granted: true, reason: "approved" };
}

async function handleDispatch(
  server: McpServer,
  deps: McpServerDeps,
  input: McpDispatchInput,
): Promise<CallToolResult> {
  if (deps.requireDispatchConsent !== false) {
    const consent = await requestDispatchConsent(server, input);
    if (!consent.granted) {
      return {
        ...toolJson({ dispatched: false, reason: consent.reason }),
        isError: true,
      };
    }
  }
  const result = await deps.dispatchTask({
    agentId: input.agentId,
    instruction: input.instruction,
    ...(input.expectedOutput !== undefined
      ? { expectedOutput: input.expectedOutput }
      : {}),
  });
  return toolJson({
    dispatched: true,
    taskId: result.taskId,
    status: result.status,
  });
}

function registerTools(server: McpServer, deps: McpServerDeps): void {
  if (!isAllowed(deps.allow, "tools", MCP_TOOL_DISPATCH)) return;
  server.registerTool(
    MCP_TOOL_DISPATCH,
    {
      title: "Dispatch a task to an agent",
      description:
        "Hand an instruction to an allow-listed distributed agent. Side-effecting: " +
        "starts real, token-spending work, so it asks for human consent (elicitation) first.",
      inputSchema: {
        agentId: z.string().min(1).describe("Target agent id (must be allow-listed)"),
        instruction: z.string().min(1).describe("What the agent should do"),
        expectedOutput: z
          .string()
          .optional()
          .describe("Optional acceptance criteria for the result"),
      },
      annotations: {
        title: "Dispatch a task to an agent",
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
      },
    },
    (args): Promise<CallToolResult> => handleDispatch(server, deps, args),
  );
}

function registerResources(server: McpServer, deps: McpServerDeps): void {
  if (isAllowed(deps.allow, "resources", MCP_RESOURCE_AGENTS)) {
    server.registerResource(
      MCP_RESOURCE_AGENTS,
      "kaiban://agents",
      {
        title: "Distributed agents",
        description: "The agents this gateway can route to, with last-known status.",
        mimeType: "application/json",
      },
      async (uri): Promise<ReadResourceResult> => {
        const agents = await deps.listAgents();
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(agents),
            },
          ],
        };
      },
    );
  }

  if (isAllowed(deps.allow, "resources", MCP_RESOURCE_AGENT_STATUS)) {
    server.registerResource(
      MCP_RESOURCE_AGENT_STATUS,
      new ResourceTemplate("kaiban://agents/{agentId}/status", {
        list: async (): Promise<ListResourcesResult> => {
          const agents = await deps.listAgents();
          return {
            resources: agents.map((a) => ({
              name: `agent-status:${a.id}`,
              uri: `kaiban://agents/${a.id}/status`,
              mimeType: "application/json",
            })),
          };
        },
      }),
      {
        title: "Agent status",
        description: "Last-known status of a single agent by id.",
        mimeType: "application/json",
      },
      async (uri, variables: Variables): Promise<ReadResourceResult> => {
        const agentId = String(variables["agentId"]);
        const status = await deps.getAgentStatus(agentId);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(status),
            },
          ],
        };
      },
    );
  }
}

function registerPrompts(server: McpServer, deps: McpServerDeps): void {
  if (!isAllowed(deps.allow, "prompts", MCP_PROMPT_DELEGATE)) return;
  server.registerPrompt(
    MCP_PROMPT_DELEGATE,
    {
      title: "Delegate a goal to an agent",
      description:
        "Produce a delegation message instructing the model to dispatch a goal to a named agent.",
      argsSchema: {
        agentId: z.string().min(1).describe("Target agent id"),
        goal: z.string().min(1).describe("The goal to delegate"),
      },
    },
    (args): GetPromptResult => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Delegate to agent "${args.agentId}": ${args.goal}. ` +
              `Use the ${MCP_TOOL_DISPATCH} tool — you will be asked to confirm before any work starts.`,
          },
        },
      ],
    }),
  );
}

/**
 * Build an MCP server exposing the allow-listed Tools, Resources and Prompts.
 * Caller is responsible for connecting it to a transport.
 */
export function buildMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({
    name: deps.name ?? DEFAULT_NAME,
    version: deps.version ?? DEFAULT_VERSION,
  });
  registerTools(server, deps);
  registerResources(server, deps);
  registerPrompts(server, deps);
  return server;
}
