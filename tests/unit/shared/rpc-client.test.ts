import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRpcClient } from "../../../src/shared";

describe("createRpcClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("call() sends a JSON-RPC 2.0 POST to /a2a/rpc and returns result", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ result: { taskId: "t1", status: "QUEUED" } }),
    } as Response);

    const rpc = createRpcClient("http://localhost:3000");
    const result = await rpc.call("tasks.create", { agentId: "researcher" });

    expect(mockFetch).toHaveBeenCalledWith(
      "http://localhost:3000/a2a/rpc",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(result).toEqual({ taskId: "t1", status: "QUEUED" });
  });

  it("call() includes JSON-RPC envelope fields in the body", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ result: {} }),
    } as Response);

    const rpc = createRpcClient("http://gateway");
    await rpc.call("tasks.get", { taskId: "abc" });

    const callArgs = mockFetch.mock.calls[0];
    const body = JSON.parse(callArgs![1]!.body as string) as Record<
      string,
      unknown
    >;
    expect(body["jsonrpc"]).toBe("2.0");
    expect(body["method"]).toBe("tasks.get");
    expect((body["params"] as Record<string, unknown>)["taskId"]).toBe("abc");
    expect(typeof body["id"]).toBe("number");
  });

  it("call() throws when the response has an error field", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ error: { message: "Invalid agentId" } }),
    } as Response);

    const rpc = createRpcClient("http://gateway");
    await expect(rpc.call("tasks.create", {})).rejects.toThrow(
      "Invalid agentId",
    );
  });

  it("setToken() causes subsequent call() to include Authorization header", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ result: {} }),
    } as Response);

    const rpc = createRpcClient("http://gateway");
    rpc.setToken("my-jwt-token");
    await rpc.call("tasks.list", {});

    const headers = mockFetch.mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBe("Bearer my-jwt-token");
  });

  it("call() does NOT include Authorization header when no token is set", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ result: {} }),
    } as Response);

    const rpc = createRpcClient("http://gateway");
    await rpc.call("tasks.list", {});

    const headers = mockFetch.mock.calls[0]![1]!.headers as Record<
      string,
      string
    >;
    expect(headers["Authorization"]).toBeUndefined();
  });

  it("multiple sequential calls() each send their own requests", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce({
        json: async () => ({ result: { id: 1 } }),
      } as Response)
      .mockResolvedValueOnce({
        json: async () => ({ result: { id: 2 } }),
      } as Response);

    const rpc = createRpcClient("http://gateway");
    const r1 = await rpc.call("tasks.create", { n: 1 });
    const r2 = await rpc.call("tasks.create", { n: 2 });

    expect(r1).toEqual({ id: 1 });
    expect(r2).toEqual({ id: 2 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
