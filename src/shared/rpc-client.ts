/**
 * A2A JSON-RPC client — shared across all examples.
 *
 * Wraps the A2A gateway's POST /a2a/rpc endpoint: builds JSON-RPC 2.0 envelopes,
 * attaches Bearer auth tokens when set, and throws on JSON-RPC error responses.
 *
 * Usage:
 *   const rpc = createRpcClient('http://localhost:3000');
 *   rpc.setToken(issueA2AToken('my-service'));    // optional — called at startup
 *   const result = await rpc.call('tasks.create', { agentId: 'writer', ... });
 */

export interface RpcClient {
  /** Sets the Bearer token to include on all subsequent requests. */
  setToken(token: string): void;
  /** Calls method on the gateway and returns the JSON-RPC result object. Throws on error. */
  call(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

/**
 * Creates a stateful RPC client for the given gateway URL.
 *
 * @param gatewayUrl  Base URL of the kaiban-distributed gateway (e.g. http://localhost:3000).
 */
export function createRpcClient(gatewayUrl: string): RpcClient {
  let token = "";

  return {
    setToken(t: string): void {
      token = t;
    },
    async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`${gatewayUrl}/a2a/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method,
          params,
        }),
      });

      const body = (await res.json()) as {
        result: Record<string, unknown>;
        error?: { message: string };
      };

      if (body.error) throw new Error(body.error.message);
      return body.result;
    },
  };
}
