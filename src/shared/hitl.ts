/**
 * Human-In-The-Loop decision gate — shared across all examples.
 *
 * Accepts a decision from either:
 *   • Terminal — user types 1/2/3 (PUBLISH / REVISE / REJECT), 4 = VIEW re-prompt
 *   • Board    — Socket.io → SocketGateway → Redis `kaiban-hitl-decisions` channel
 *
 * The first source to deliver a valid decision wins; the other is cleaned up.
 * Both sources are resolved to the canonical word: 'PUBLISH' | 'REVISE' | 'REJECT'.
 *
 * Usage:
 *   const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
 *   const decision = await waitForHITLDecision({
 *     taskId, rl, redisUrl,
 *     onView: () => console.log(draft),
 *   });
 *   // decision === 'PUBLISH' | 'REVISE' | 'REJECT'
 *
 * With AUTO_PUBLISH (no readline):
 *   const decision = await waitForHITLDecision({ taskId, rl: null, redisUrl });
 *   // Waits only for a board signal; call is unresolved until one arrives.
 */

import { Redis } from "ioredis";
import readline from "readline";
import { unwrapVerified } from "../infrastructure/security/channel-signing";

export type HitlDecision = "PUBLISH" | "REVISE" | "REJECT";

export interface HitlOptions {
  /** The task currently under review — must match the board's taskId field. */
  taskId: string;
  /**
   * Open readline interface for terminal input.
   * Pass `null` to skip terminal prompts (Auto-Publish mode / board-only).
   */
  rl: readline.Interface | null;
  /** Redis URL for the board subscription channel (kaiban-hitl-decisions). */
  redisUrl: string;
  /**
   * Called when the user types "4" (VIEW) at the terminal prompt.
   * Typically prints the draft to stdout. Omit if VIEW is not applicable.
   */
  onView?: () => void;
}

/** Canonical map from board decision strings to HitlDecision. */
const BOARD_DECISION_MAP: Record<string, HitlDecision> = {
  PUBLISH: "PUBLISH",
  REVISE: "REVISE",
  REJECT: "REJECT",
};

/**
 * Wait for a HITL decision from the terminal or the board.
 * Resolves with 'PUBLISH', 'REVISE', or 'REJECT'.
 */
export function waitForHITLDecision(opts: HitlOptions): Promise<HitlDecision> {
  const { taskId, rl, redisUrl, onView } = opts;
  const listKey = `kaiban-hitl-decisions:${taskId}`;

  return new Promise<HitlDecision>((resolve) => {
    let resolved = false;

    const finish = (decision: HitlDecision): void => {
      /* v8 ignore next — idempotent guard: once resolved, extra finish() calls are no-ops */
      if (resolved) return;
      resolved = true;
      sub.disconnect();
      poller.disconnect();
      // Feed empty line to release any pending rl.question callback so the
      // readline interface is ready for a potential second HITL round (REVISE).
      if (rl) rl.write("\n");
      resolve(decision);
    };

    // ── Board path A: pub/sub (fast — delivers in <1ms when timing is right) ─
    // Register handler BEFORE subscribe() to avoid the race where a message
    // arrives between subscribe completing and .then() continuation.
    const sub = new Redis(redisUrl, { lazyConnect: false });

    sub.on("error", (err: unknown) => {
      /* v8 ignore next — FALSE branch: error fires after resolution (already disconnected) */
      if (!resolved) console.warn("[HITL] Redis subscriber error:", err);
    });

    sub.on("message", (_ch: string, msg: string) => {
      if (resolved) return;
      handleBoardMessage(msg, taskId, finish);
    });

    console.log(
      `[HITL] Subscribing to kaiban-hitl-decisions for taskId …${taskId.slice(-8)}`,
    );
    sub
      .subscribe("kaiban-hitl-decisions")
      .then(() => {
        console.log(`[HITL] ✓ Subscribed (pub/sub path ready)`);
      })
      .catch((err: unknown) => {
        console.warn(
          "[HITL] Redis subscribe failed — falling back to list-poll only:",
          err,
        );
      });

    // ── Board path B: BRPOP polling (reliable — works even if pub/sub races) ─
    // The gateway writes to `kaiban-hitl-decisions:<taskId>` via LPUSH so the
    // message persists in Redis until BRPOP consumes it — no timing dependency.
    const poller = new Redis(redisUrl, { lazyConnect: false });

    poller.on("error", (err: unknown) => {
      if (!resolved) console.warn("[HITL] Redis poller error:", err);
    });

    const runPoller = async (): Promise<void> => {
      while (!resolved) {
        try {
          const item = await poller.brpop(listKey, 1);
          if (item && !resolved) {
            console.log(`[HITL] ✓ Received via list-poll path`);
            handleBoardMessage(item[1], taskId, finish);
          }
        } catch (err) {
          /* v8 ignore next — FALSE branch: error fires after resolution (loop exits) */
          if (!resolved) {
            console.warn("[HITL] BRPOP error (retrying):", err);
            await new Promise<void>((r) => setTimeout(r, 500));
          }
        }
      }
    };

    void runPoller();

    // ── Terminal path ────────────────────────────────────────────────────
    if (rl) spawnTerminalPrompt(rl, finish, onView);
  });
}

/** Parse and validate a single board message, calling finish if valid. */
function handleBoardMessage(
  msg: string,
  taskId: string,
  finish: (d: HitlDecision) => void,
): void {
  try {
    const parsed = unwrapVerified(msg) as {
      taskId?: string;
      decision?: string;
    } | null;
    if (
      !parsed ||
      typeof parsed.taskId !== "string" ||
      typeof parsed.decision !== "string"
    )
      return;
    const decision = BOARD_DECISION_MAP[parsed.decision];
    if (!decision) {
      console.warn(`[HITL] Unrecognised board decision: ${parsed.decision}`);
      return;
    }
    if (parsed.taskId !== taskId) {
      console.warn(
        `[HITL] taskId mismatch — expected …${taskId.slice(-8)}, got …${parsed.taskId.slice(-8)}`,
      );
      return;
    }
    console.log(
      `\n[HITL] Board decision received: ${parsed.decision} for taskId …${taskId.slice(-8)}`,
    );
    finish(decision);
  } catch (err) {
    console.warn("[HITL] Failed to parse/verify board message:", err);
  }
}

/** Prompt the terminal in a loop until a valid decision is entered. */
function spawnTerminalPrompt(
  rl: readline.Interface,
  finish: (d: HitlDecision) => void,
  onView?: () => void,
): void {
  const PROMPT =
    "\nYour decision [1] PUBLISH  [2] REVISE  [3] REJECT  [4] VIEW: ";

  const ask = (): void => {
    rl.question(PROMPT, (answer) => {
      const a = answer.trim();
      if (a === "1") {
        console.log("\n[HITL] Terminal decision: PUBLISH");
        finish("PUBLISH");
      } else if (a === "2") {
        console.log("\n[HITL] Terminal decision: REVISE");
        finish("REVISE");
      } else if (a === "3") {
        console.log("\n[HITL] Terminal decision: REJECT");
        finish("REJECT");
      } else {
        if (a === "4" && onView) onView();
        ask();
      }
    });
  };

  ask();
}
