/**
 * Gateway readiness + startup probes (master plan §B5.1 Phase R, ADR-018).
 *
 * `/ready` (200 ready / 503 not-ready) verifies downstream deps (Redis + broker)
 * are reachable so k8s only routes traffic to a replica that can serve it;
 * `/startup` gates slow boot. Both are optional deps — unset ⇒ the gateway
 * reports ready (back-compatible with the existing `/health`-only shape).
 */
import { describe, it, expect } from "vitest";
import request from "supertest";
import { GatewayApp } from "../../../src/adapters/gateway/GatewayApp";
import type { ProbeResult } from "../../../src/resilience/health";
import { makeRequestHandler, makeStatusTracker } from "./gateway-test-helpers";

function gatewayWith(
  probes: {
    readinessProbe?: () => Promise<ProbeResult>;
    startupProbe?: () => Promise<ProbeResult>;
  } = {},
): GatewayApp {
  return new GatewayApp({
    requestHandler: makeRequestHandler(),
    statusTracker: makeStatusTracker() as never,
    ...probes,
  });
}

describe("GatewayApp readiness / startup probes", () => {
  it("GET /ready returns 200 when the readiness probe is ready", async () => {
    const gw = gatewayWith({
      readinessProbe: () =>
        Promise.resolve({
          ready: true,
          checks: [{ name: "redis", ok: true }],
        }),
    });
    const res = await request(gw.app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.data.ready).toBe(true);
    expect(res.body.data.checks).toEqual([{ name: "redis", ok: true }]);
  });

  it("GET /ready returns 503 when a dependency is unreachable", async () => {
    const gw = gatewayWith({
      readinessProbe: () =>
        Promise.resolve({
          ready: false,
          checks: [{ name: "broker", ok: false, error: "ECONNREFUSED" }],
        }),
    });
    const res = await request(gw.app).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.data.ready).toBe(false);
  });

  it("GET /ready defaults to ready (200) when no probe is wired", async () => {
    const gw = gatewayWith();
    const res = await request(gw.app).get("/ready");
    expect(res.status).toBe(200);
    expect(res.body.data.ready).toBe(true);
    expect(res.body.data.checks).toEqual([]);
  });

  it("GET /startup returns 503 until boot completes, then 200", async () => {
    const notStarted = gatewayWith({
      startupProbe: () =>
        Promise.resolve({
          ready: false,
          checks: [{ name: "startup", ok: false }],
        }),
    });
    expect((await request(notStarted.app).get("/startup")).status).toBe(503);

    const started = gatewayWith({
      startupProbe: () =>
        Promise.resolve({
          ready: true,
          checks: [{ name: "startup", ok: true }],
        }),
    });
    expect((await request(started.app).get("/startup")).status).toBe(200);
  });

  it("GET /startup defaults to ready (200) when no probe is wired", async () => {
    const gw = gatewayWith();
    const res = await request(gw.app).get("/startup");
    expect(res.status).toBe(200);
    expect(res.body.data.ready).toBe(true);
  });
});
