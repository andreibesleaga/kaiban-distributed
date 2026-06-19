import { describe, it, expect, vi } from "vitest";
import { SlidingWindowRateLimiter } from "../../../src/adapters/gateway/GatewayApp";
import { makeGateway } from "./gateway-test-helpers";

describe("GatewayApp — health rate limit coverage", () => {
  it("healthRateLimit uses socket remoteAddress when req.ip is undefined", () => {
    const gw = makeGateway();
    const limiter = (
      gw as unknown as { healthRateLimiter: SlidingWindowRateLimiter }
    ).healthRateLimiter;
    const isAllowed = vi.spyOn(limiter, "isAllowed").mockReturnValue(true);
    const next = vi.fn();
    const req = { ip: undefined, socket: { remoteAddress: "10.0.0.7" } };
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };

    (
      gw as unknown as {
        healthRateLimit: (req: unknown, res: unknown, next: unknown) => void;
      }
    ).healthRateLimit(req, res, next);

    expect(isAllowed).toHaveBeenCalledWith("10.0.0.7");
    expect(next).toHaveBeenCalledOnce();
  });

  it('healthRateLimit falls back to "unknown" and returns 429 when no client address exists', () => {
    const gw = makeGateway();
    const limiter = (
      gw as unknown as { healthRateLimiter: SlidingWindowRateLimiter }
    ).healthRateLimiter;
    const isAllowed = vi.spyOn(limiter, "isAllowed").mockReturnValue(false);
    const next = vi.fn();
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const req = { ip: undefined, socket: { remoteAddress: undefined } };

    (
      gw as unknown as {
        healthRateLimit: (req: unknown, res: unknown, next: unknown) => void;
      }
    ).healthRateLimit(req, { status }, next);

    expect(isAllowed).toHaveBeenCalledWith("unknown");
    expect(status).toHaveBeenCalledWith(429);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        errors: [{ message: "Too Many Requests" }],
      }),
    );
    expect(next).not.toHaveBeenCalled();
  });
});
