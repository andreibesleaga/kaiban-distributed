// SPDX-License-Identifier: Apache-2.0
import type { MessagePayload } from "./interfaces";

/**
 * Runtime check of a decoded queue message. Both drivers apply it at the
 * consume boundary, because the `MessagePayload` type is not enforced for a
 * hand-built or third-party producer: a record that fails is logged and
 * acknowledged, never handed to the actor.
 */
export function isMessagePayload(value: unknown): value is MessagePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v["taskId"] === "string" &&
    typeof v["agentId"] === "string" &&
    typeof v["data"] === "object" &&
    v["data"] !== null &&
    !Array.isArray(v["data"]) &&
    typeof v["timestamp"] === "number" &&
    Number.isFinite(v["timestamp"])
  );
}
