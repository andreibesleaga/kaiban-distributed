import "dotenv/config";
import { runGateway } from "./gateway";
import { runWorker } from "./worker";
import { createStructuredLogger } from "../shared/structured-logger";

const log = createStructuredLogger({ component: "main" });

export type Role = "gateway" | "worker";

/**
 * Resolve the process role from the `ROLE` env var (Finding #1 fix / ADR-013).
 *
 * Single image, role chosen at runtime:
 *   ROLE=gateway → HTTP / WebSocket / A2A front door, no task-consuming actors
 *   ROLE=worker  → LLM-backed task-consuming agent pool, no HTTP surface
 *
 * Default is `gateway` (backward-compatible: the previous single entrypoint
 * exposed the HTTP `/health` surface; workers MUST opt in with `ROLE=worker`).
 * An unknown ROLE is rejected loudly rather than silently mis-deployed.
 */
export function resolveRole(raw: string | undefined): Role {
  const role = (raw ?? "gateway").trim().toLowerCase();
  if (role === "gateway" || role === "worker") return role;
  throw new Error(`Invalid ROLE "${raw}": must be "gateway" or "worker"`);
}

export async function main(roleEnv: string | undefined): Promise<void> {
  const role = resolveRole(roleEnv);
  log.info({ role }, "Starting kaiban-distributed");
  if (role === "worker") {
    await runWorker();
  } else {
    await runGateway();
  }
}

/* v8 ignore start — process-level entrypoint guard; exercised by the image,
   not by unit tests (main() itself is covered). */
if (require.main === module) {
  main(process.env["ROLE"]).catch((err) => {
    log.error({ err }, "Fatal startup error");
    process.exit(1);
  });
}
/* v8 ignore stop */
