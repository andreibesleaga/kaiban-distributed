/**
 * A slow OpenAI-compatible chat-completions server for the emergency STOP ALL
 * e2e tests (ADR-025): it holds every request for `holdMs`, so a test can stop
 * a task mid-call and see whether the client really dropped the connection.
 */
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

export interface MockModel {
  /** Base URL to use as `apiBaseUrl` (ends in /v1). */
  url: string;
  /** Chat requests received so far. */
  requests(): number;
  /** Requests whose connection the client closed before the answer. */
  aborted(): number;
  /** Resolve once `n` requests have arrived (rejects after `ms`). */
  waitForRequests(n: number, ms: number): Promise<void>;
  /** Resolve once `n` requests were aborted by the client (rejects after `ms`). */
  waitForAborts(n: number, ms: number): Promise<void>;
  close(): Promise<void>;
}

const completion = JSON.stringify({
  id: "chatcmpl-mock",
  object: "chat.completion",
  created: 0,
  model: "mock",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: '{"finalAnswer":"mock answer"}' },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

async function until(check: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export async function startMockModel(holdMs: number): Promise<MockModel> {
  let requests = 0;
  let aborted = 0;
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    requests++;
    req.resume();
    const timer = setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" }).end(completion);
    }, holdMs);
    res.on("close", () => {
      clearTimeout(timer);
      if (!res.writableEnded) aborted++;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
    aborted: () => aborted,
    waitForRequests: (n, ms) => until(() => requests >= n, ms, `${n} model request(s)`),
    waitForAborts: (n, ms) => until(() => aborted >= n, ms, `${n} aborted model request(s)`),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
