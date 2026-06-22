/**
 * a2a-agent-card — builds the A2A v0.3 `AgentCard` served at
 * `/.well-known/agent-card.json`.
 *
 * Card construction is fully encapsulated here so the eventual A2A v1.0 swap
 * (which replaces `preferredTransport` + `additionalInterfaces` with a single
 * `supportedInterfaces[]` discriminator, and uses PascalCase method names) is a
 * drop-in change to this one module — nothing else in the codebase touches the
 * card shape.
 *
 * v0.3 shape (verified against @a2a-js/sdk 0.3.x `AgentCard` type):
 *   protocolVersion, name, description, url, version, preferredTransport,
 *   capabilities (object), defaultInputModes, defaultOutputModes, skills[],
 *   securitySchemes, additionalInterfaces[], provider.
 */
import type {
  AgentCard,
  AgentSkill,
  AgentInterface,
  HTTPAuthSecurityScheme,
} from "@a2a-js/sdk";

/** The A2A protocol version this card advertises (stable v0.3). */
export const A2A_PROTOCOL_VERSION = "0.3.0";

/** Well-known path for the agent card (matches the SDK constant). */
export const AGENT_CARD_PATH = ".well-known/agent-card.json";

/** Path the JSON-RPC transport is mounted at, relative to baseUrl. */
const RPC_PATH = "/a2a/rpc";

/** Default content modes — the bridge speaks plain text + JSON. */
const DEFAULT_MODES = ["text/plain", "application/json"] as const;

/** Security-scheme key used in the card + matching `security` requirement. */
const BEARER_SCHEME_KEY = "bearerAuth";

export interface AgentCardInput {
  /** Human-readable agent/service name. */
  name: string;
  /** The provider-defined agent version (e.g. the package version). */
  version: string;
  /** Absolute base URL the gateway is reachable at (no path). */
  baseUrl: string;
  /** Agent IDs this gateway can route to — one A2A skill is emitted per id. */
  agentIds: string[];
  /** When true, advertise the env-gated JWT bearer security scheme. */
  jwtEnabled?: boolean;
  /** When true, advertise the push-notification capability flag. */
  pushNotifications?: boolean;
  /** Optional human-facing description override. */
  description?: string;
  /** Optional provider block. */
  provider?: { organization: string; url: string };
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function buildSkills(agentIds: string[]): AgentSkill[] {
  if (agentIds.length === 0) {
    return [
      {
        id: "execute-task",
        name: "Execute task",
        description:
          "Dispatch a task to a kaiban-distributed agent and await its result.",
        tags: ["task", "agent"],
      },
    ];
  }
  return agentIds.map((id) => ({
    id,
    name: `Delegate to ${id}`,
    description: `Dispatch a task to the "${id}" agent and await its result.`,
    tags: ["task", "agent", id],
  }));
}

function buildBearerScheme(): HTTPAuthSecurityScheme {
  return {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
    description: "Service-to-service JWT bearer token (HS256).",
  };
}

function buildInterfaces(rpcUrl: string, baseUrl: string): AgentInterface[] {
  return [
    { transport: "JSONRPC", url: rpcUrl },
    { transport: "HTTP+JSON", url: `${baseUrl}/a2a/rest` },
    { transport: "GRPC", url: `${baseUrl}/a2a/grpc` },
  ];
}

/**
 * Build the v0.3 AgentCard. Pure + deterministic — given the same input it
 * always returns the same card, which the conformance + schema tests rely on.
 */
export function buildAgentCard(input: AgentCardInput): AgentCard {
  const baseUrl = trimTrailingSlash(input.baseUrl);
  const rpcUrl = `${baseUrl}${RPC_PATH}`;

  const card: AgentCard = {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: input.name,
    description:
      input.description ??
      "Kaiban distributed A2A gateway — bridges A2A tasks onto the actor messaging layer.",
    url: rpcUrl,
    version: input.version,
    preferredTransport: "JSONRPC",
    additionalInterfaces: buildInterfaces(rpcUrl, baseUrl),
    capabilities: {
      streaming: true,
      pushNotifications: input.pushNotifications === true,
      stateTransitionHistory: false,
    },
    defaultInputModes: [...DEFAULT_MODES],
    defaultOutputModes: [...DEFAULT_MODES],
    skills: buildSkills(input.agentIds),
  };

  if (input.provider) {
    card.provider = {
      organization: input.provider.organization,
      url: input.provider.url,
    };
  }

  if (input.jwtEnabled) {
    card.securitySchemes = { [BEARER_SCHEME_KEY]: buildBearerScheme() };
    card.security = [{ [BEARER_SCHEME_KEY]: [] }];
  }

  return card;
}
