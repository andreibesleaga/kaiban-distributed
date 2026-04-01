import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@opentelemetry/api", () => ({
  propagation: {
    inject: vi.fn(),
    extract: vi.fn().mockReturnValue({}),
  },
  context: {
    active: vi.fn().mockReturnValue({}),
  },
  ROOT_CONTEXT: {},
}));

import {
  injectTraceContext,
  extractTraceContext,
} from "../../../src/infrastructure/telemetry/TraceContext";
import { propagation } from "@opentelemetry/api";

describe("TraceContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(propagation.extract).mockReturnValue(
      {} as ReturnType<typeof propagation.extract>,
    );
  });

  it("injectTraceContext() calls propagation.inject with the carrier", () => {
    const carrier: Record<string, string> = {};
    injectTraceContext(carrier);
    expect(propagation.inject).toHaveBeenCalledWith(expect.anything(), carrier);
  });

  it("extractTraceContext() calls propagation.extract with the carrier", () => {
    const carrier: Record<string, string> = { traceparent: "mock-trace" };
    extractTraceContext(carrier);
    expect(propagation.extract).toHaveBeenCalledWith(
      expect.anything(),
      carrier,
    );
  });

  it("extractTraceContext() returns the context from propagation.extract", () => {
    const mockCtx = { spanContext: () => "test" } as unknown as ReturnType<
      typeof propagation.extract
    >;
    vi.mocked(propagation.extract).mockReturnValueOnce(mockCtx);
    const result = extractTraceContext({});
    expect(result).toBe(mockCtx);
  });
});
