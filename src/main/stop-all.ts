// SPDX-License-Identifier: Apache-2.0
/**
 * `npm run stop-all` — issue an emergency STOP ALL (roadmap §6.10, ADR-025).
 *
 * Saves the stop moment in Redis and publishes the command on the control
 * channel, signed with CHANNEL_SIGNING_SECRET when it is set. Every node with
 * CONTROL_PLANE_ENABLED=true kills the tasks and workflows sent up to now.
 *
 *   npm run stop-all -- --reason "runaway loop" --by oncall
 *   node dist/src/main/stop-all.js --reason "runaway loop"   (in the image)
 */
import "dotenv/config";
import { createRedisClient } from "../shared/redis-connection";
import {
  issueStopAll,
  type ControlPublisher,
} from "../infrastructure/control/control-channel";
import { createStopAllCommand } from "../shared/emergency-stop";

export const STOP_ALL_USAGE = [
  "Usage: npm run stop-all -- [--reason <text>] [--by <name>]",
  "Kills every running model call, task and workflow sent up to now (emergency STOP ALL).",
  "Env: REDIS_URL (default redis://localhost:6379), CHANNEL_SIGNING_SECRET (signs the message).",
].join("\n");

export interface StopAllArgs {
  by: string;
  reason?: string;
  help?: true;
}

type Env = Record<string, string | undefined>;

/** Parse `--reason`, `--by` (each as `--x v` or `--x=v`) and `--help`. */
export function parseStopAllArgs(argv: string[], env: Env): StopAllArgs {
  const args: StopAllArgs = { by: env["USER"] || "cli" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    const [flag, inline] = arg.split(/=(.*)/s, 2) as [
      string,
      string | undefined,
    ];
    if (flag !== "--reason" && flag !== "--by") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = inline ?? argv[++i];
    if (!value) throw new Error(`${flag} needs a value`);
    if (flag === "--reason") args.reason = value;
    else args.by = value;
  }
  return args;
}

export interface StopAllDeps {
  env: Env;
  connect: (
    redisUrl: string,
  ) => ControlPublisher & { quit(): Promise<unknown> };
  now?: () => number;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** Run the CLI; resolves with the exit code (0 issued, 1 failed). */
export async function runStopAll(
  argv: string[],
  deps: StopAllDeps,
): Promise<number> {
  const out = deps.out ?? ((line: string): void => console.log(line));
  const err = deps.err ?? ((line: string): void => console.error(line));
  let args: StopAllArgs;
  try {
    args = parseStopAllArgs(argv, deps.env);
  } catch (e) {
    err(`${(e as Error).message}\n${STOP_ALL_USAGE}`);
    return 1;
  }
  if (args.help) {
    out(STOP_ALL_USAGE);
    return 0;
  }
  const redis = deps.connect(deps.env["REDIS_URL"] ?? "redis://localhost:6379");
  try {
    const cmd = createStopAllCommand(
      args.by,
      args.reason,
      (deps.now ?? Date.now)(),
    );
    const { saved } = await issueStopAll(redis, cmd);
    out(
      JSON.stringify({
        commandId: cmd.commandId,
        issuedAt: cmd.issuedAt,
        issuedBy: cmd.issuedBy,
        ...(cmd.reason ? { reason: cmd.reason } : {}),
        saved,
      }),
    );
    return 0;
  } catch (e) {
    err(`stop-all failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await redis.quit().catch(() => undefined);
  }
}

/** The CLI's Redis client: full URL (password, `rediss://`) plus `REDIS_TLS_*`. */
export function connectRedis(
  url: string,
): ReturnType<typeof createRedisClient> {
  return createRedisClient(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
  });
}

/* v8 ignore start — process entrypoint; runStopAll itself is covered. */
if (require.main === module) {
  void runStopAll(process.argv.slice(2), {
    env: process.env,
    connect: connectRedis,
  }).then((code) => process.exit(code));
}
/* v8 ignore stop */
