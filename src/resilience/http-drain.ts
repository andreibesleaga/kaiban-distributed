// SPDX-License-Identifier: Apache-2.0
import type { Server } from "http";

export interface HttpDrainOptions {
  /** Ends the upgraded (WebSocket) connections, which `server.close()` never touches. */
  disconnectClients: () => void;
  /** How long in-flight requests may finish before their sockets are cut. */
  graceMs: number;
}

/**
 * Stop accepting connections and resolve once every one has ended.
 *
 * `server.close()` alone waits for each open connection: a connected board
 * (WebSocket) or a long A2A/MCP stream would hold it until the whole shutdown
 * deadline. So: stop listening, end the WebSocket clients, close idle
 * keep-alive sockets now, let in-flight requests finish for `graceMs`, then
 * cut what remains. Rejects when the server was not listening.
 */
export function drainHttpServer(
  server: Server,
  opts: HttpDrainOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cutRemaining = setTimeout(
      () => server.closeAllConnections(),
      opts.graceMs,
    );
    server.close((err) => {
      clearTimeout(cutRemaining);
      if (err) reject(err);
      else resolve();
    });
    opts.disconnectClients();
    server.closeIdleConnections();
  });
}
