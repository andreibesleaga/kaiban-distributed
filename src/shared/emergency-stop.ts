// SPDX-License-Identifier: Apache-2.0
/**
 * Emergency STOP ALL wiring for worker nodes and orchestrators (roadmap §6.10,
 * ADR-025). Off unless `CONTROL_PLANE_ENABLED` is `true` or `1`; callers check
 * {@link controlPlaneEnabled} before attaching anything.
 */
import { randomUUID } from "crypto";
import { hostname } from "os";
import {
  ControlSubscriber,
  type ControlAck,
  type StopAllCommand,
  type StopSource,
} from "../infrastructure/control/control-channel";
import { EmergencyStopError } from "../domain/errors/DomainError";
import type { EmergencyStopResult } from "../application/actor/AgentActor";
import { createStructuredLogger } from "./structured-logger";

const log = createStructuredLogger({ component: "emergency-stop" });

/** True only when `CONTROL_PLANE_ENABLED` is the literal `true` or `1`. */
export function controlPlaneEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const v = env["CONTROL_PLANE_ENABLED"];
  return v === "true" || v === "1";
}

/** A new STOP_ALL command whose moment is `now` (epoch ms). */
export function createStopAllCommand(
  issuedBy: string,
  reason?: string,
  now: number = Date.now(),
): StopAllCommand {
  return {
    commandId: randomUUID(),
    command: "STOP_ALL",
    issuedBy,
    issuedAt: now,
    ...(reason ? { reason } : {}),
  };
}

/** A closable handle on a control-channel subscription. */
export interface EmergencyStopHandle {
  close(): Promise<void>;
}

export interface AttachEmergencyStopOptions {
  /** The worker's actor (an `AgentActor`). */
  actor: { emergencyStop(stoppedAt: number): EmergencyStopResult };
  /** Where acks go (an `AgentStatePublisher`); none = no acks. */
  publisher?: { publishControlAck(ack: ControlAck): void };
  redisUrl: string;
  agentId: string;
  /** Defaults to `<hostname>:<pid>`. */
  nodeId?: string;
  /** Clock for the ack's `at` (tests). */
  now?: () => number;
}

/**
 * Wire a worker's actor to the control channel: every STOP_ALL (live, or the
 * saved one read at start and on reconnect) stops the actor at the command's
 * moment. A live command is always acked; a saved one only when it killed a
 * task (a node that just started has nothing to report).
 */
export async function attachEmergencyStop(
  opts: AttachEmergencyStopOptions,
): Promise<EmergencyStopHandle> {
  const nodeId = opts.nodeId ?? `${hostname()}:${process.pid}`;
  const now = opts.now ?? Date.now;
  const onStop = (cmd: StopAllCommand, source: StopSource): void => {
    const result = opts.actor.emergencyStop(cmd.issuedAt);
    log.warn(
      { commandId: cmd.commandId, source, agentId: opts.agentId, ...result },
      "Emergency STOP ALL received",
    );
    if (source === "saved" && result.aborted === 0) return;
    opts.publisher?.publishControlAck({
      commandId: cmd.commandId,
      issuedAt: cmd.issuedAt,
      issuedBy: cmd.issuedBy,
      ...(cmd.reason ? { reason: cmd.reason } : {}),
      nodeId,
      agentId: opts.agentId,
      outcome: result.outcome,
      aborted: result.aborted,
      at: now(),
    });
  };
  const subscriber = new ControlSubscriber({ redisUrl: opts.redisUrl, onStop });
  await subscriber.start();
  return { close: (): Promise<void> => subscriber.close() };
}

/** An orchestrator's stop signal and the subscription behind it. */
export interface EmergencyStopSignal extends EmergencyStopHandle {
  signal: AbortSignal;
}

/**
 * The signal an orchestrator passes to `WorkflowOrchestrator` (ES-4): aborted
 * with an `EmergencyStopError` by the first STOP_ALL whose moment is at or after
 * `startedAt`. An older saved stop never ends a run started after it.
 */
export async function createEmergencyStopSignal(
  redisUrl: string,
  startedAt: number = Date.now(),
): Promise<EmergencyStopSignal> {
  const controller = new AbortController();
  const onStop = (cmd: StopAllCommand): void => {
    if (cmd.issuedAt < startedAt || controller.signal.aborted) return;
    controller.abort(
      new EmergencyStopError(
        cmd.reason ? `Emergency stop: ${cmd.reason}` : "Emergency stop",
      ),
    );
  };
  const subscriber = new ControlSubscriber({ redisUrl, onStop });
  await subscriber.start();
  return {
    signal: controller.signal,
    close: (): Promise<void> => subscriber.close(),
  };
}
