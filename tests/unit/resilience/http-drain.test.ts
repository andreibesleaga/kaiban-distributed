/** drainHttpServer — shutdown must not wait for connected boards (SEC-V-02). */
import { describe, it, expect, vi } from "vitest";
import { createServer, request } from "http";
import type { AddressInfo } from "net";
import { drainHttpServer } from "../../../src/resilience/http-drain";

const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: (server.address() as AddressInfo).port };
};

describe("drainHttpServer", () => {
  it("resolves when an upgraded (WebSocket-like) connection is ended by disconnectClients", async () => {
    const { server, port } = await listen(undefined);
    const upgraded: Array<import("net").Socket> = [];
    server.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n");
      upgraded.push(socket);
    });
    await new Promise<void>((resolve) => {
      const req = request({ port, headers: { Connection: "Upgrade", Upgrade: "x" } });
      req.on("upgrade", () => resolve());
      req.on("error", () => undefined);
      req.end();
    });
    const start = Date.now();
    await drainHttpServer(server, {
      disconnectClients: () => upgraded.forEach((s) => s.destroy()),
      graceMs: 5_000,
    });
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("cuts an in-flight request that outlasts the grace period", async () => {
    const { server, port } = await listen(() => undefined); // never answers
    const failed = new Promise<boolean>((resolve) => {
      const req = request({ port }, () => resolve(false));
      req.on("error", () => resolve(true));
      req.end();
    });
    await vi.waitFor(() => expect(server.listening).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    await drainHttpServer(server, { disconnectClients: () => undefined, graceMs: 100 });
    expect(await failed).toBe(true);
  });

  it("rejects when the server was not listening", async () => {
    const server = createServer();
    await expect(
      drainHttpServer(server, { disconnectClients: () => undefined, graceMs: 100 }),
    ).rejects.toThrow();
  });
});
