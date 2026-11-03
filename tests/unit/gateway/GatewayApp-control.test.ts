/**
 * Gateway `POST /control/stop-all` (roadmap §6.10 ES-6, ES-7, ES-10; ADR-025):
 * mounted only with the control plane on (else 404); the ingress decides, the
 * route maps its outcome to HTTP.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { GatewayApp } from "../../../src/adapters/gateway/GatewayApp";
import type { EmergencyStopIngress } from "../../../src/adapters/gateway/emergency-stop-ingress";
import { makeRequestHandler, makeStatusTracker } from "./gateway-test-helpers";

const gatewayWith = (control?: { stopAll: ReturnType<typeof vi.fn> }): GatewayApp =>
  new GatewayApp({
    requestHandler: makeRequestHandler(),
    statusTracker: makeStatusTracker() as never,
    ...(control ? { emergencyStop: control as unknown as EmergencyStopIngress } : {}),
  });

describe("POST /control/stop-all", () => {
  it("is not mounted when the control plane is off (404, ES-7)", async () => {
    const res = await request(gatewayWith().app).post("/control/stop-all").send({});
    expect(res.status).toBe(404);
  });

  it("passes the bearer token, body and client IP to the ingress; 202 with the command", async () => {
    const control = {
      stopAll: vi.fn().mockResolvedValue({ ok: true, commandId: "c-1", issuedAt: 9, saved: true }),
    };
    const res = await request(gatewayWith(control).app)
      .post("/control/stop-all")
      .set("Authorization", "Bearer tok-123")
      .send({ reason: "runaway" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      data: { commandId: "c-1", issuedAt: 9, saved: true },
      meta: {},
      errors: [],
    });
    expect(control.stopAll).toHaveBeenCalledWith(
      "tok-123",
      { reason: "runaway" },
      expect.any(String),
    );
  });

  it("maps a refusal to its status and message; no header means no token", async () => {
    const control = {
      stopAll: vi.fn().mockResolvedValue({ ok: false, status: 401, error: "Missing board token" }),
    };
    const res = await request(gatewayWith(control).app).post("/control/stop-all").send({});
    expect(res.status).toBe(401);
    expect(res.body.errors).toEqual([{ message: "Missing board token" }]);
    expect(control.stopAll).toHaveBeenCalledWith(undefined, {}, expect.any(String));
  });

  it("a non-Bearer Authorization header counts as no token", async () => {
    const control = {
      stopAll: vi.fn().mockResolvedValue({ ok: false, status: 401, error: "Missing board token" }),
    };
    await request(gatewayWith(control).app)
      .post("/control/stop-all")
      .set("Authorization", "Basic abc")
      .send({});
    expect(control.stopAll).toHaveBeenCalledWith(undefined, {}, expect.any(String));
  });

  it("an ingress that throws is a 500", async () => {
    const control = { stopAll: vi.fn().mockRejectedValue(new Error("boom")) };
    const res = await request(gatewayWith(control).app).post("/control/stop-all").send({});
    expect(res.status).toBe(500);
    expect(res.body.errors).toEqual([{ message: "Emergency stop failed" }]);
  });
});
