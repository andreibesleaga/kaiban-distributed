/**
 * Live E2E: Global Research Swarm — Real LLM + Dockerized Services
 *
 * These tests run the complete distributed pipeline end-to-end:
 *   - Services in Docker: Redis, Gateway, Agent nodes (searcher×4, writer, reviewer, editor)
 *   - Real LLM calls via OpenRouter/OpenAI (no mocks)
 *   - Orchestrator run as compiled Node.js subprocess (dist/examples/...)
 *   - AUTO_PUBLISH=1 skips the readline HITL prompt (decision forced to PUBLISH)
 *
 * Run with:
 *   npm run test:e2e:live
 *
 * Requires:
 *   OPENROUTER_API_KEY or OPENAI_API_KEY in .env
 *   Docker running
 *   (On networks whose DNS blocks nom.telemetrydeck.com, also set
 *    KAIBAN_TELEMETRY_OPT_OUT=1 in .env — see .env.example.)
 *
 * Assertions target the v2.0 orchestrator's output contract
 * (examples/global-research/orchestrator.ts + phases.ts):
 *   - stdout phase banners:  STEP 1 Fan-Out → STEP 2 Fan-In → STEP 3 governance
 *     → STEP 4 editorial → HUMAN DECISION REQUIRED (HITL)
 *   - phase summaries:       "SEARCH PHASE COMPLETE — n/N results",
 *     "SYNTHESIS COMPLETE (n chars)", "Compliance Score: … Recommendation: …"
 *   - economics/metadata:    "Tokens used:", "Estimated cost: $", "Active nodes:"
 *   - the machine-readable run log (RunLogger): "Run log saved to <path>" — the
 *     JSON's `outcome` field is the authoritative terminal verdict
 *     (PUBLISHED | REVISED | REJECTED | FAILED | STOPPED).
 *
 * A governance REJECTED verdict is a legitimate terminal state (the reviewer
 * gate doing its job on live LLM output), so scenarios accept it as a clean
 * stop — but when the pipeline proceeds, the full editorial + HITL + PUBLISHED
 * chain is asserted strictly.
 *
 * Scenarios:
 *   1. Golden Path          — full pipeline (search → write → review → edit → publish)
 *   2. Governance output    — structured compliance review present in output
 *   3. ResearchContext      — metadata fields (nodes, tokens, cost) reported
 *   4. Fault tolerance      — partial searcher failure tolerated, pipeline completes
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";
import * as dotenv from "dotenv";

const ROOT = resolve(__dirname, "../..");
dotenv.config({ path: resolve(ROOT, ".env") });

/** Base env for all live orchestrator runs */
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GATEWAY_URL: "http://localhost:3000",
    REDIS_URL: "redis://localhost:6379",
    MESSAGING_DRIVER: "bullmq",
    NUM_SEARCHERS: "2", // 2 searchers → faster live run
    SEARCH_WAIT_MS: "240000", // 4 min per stage
    WRITE_WAIT_MS: "240000",
    REVIEW_WAIT_MS: "240000",
    EDIT_WAIT_MS: "240000",
    AUTO_PUBLISH: "1",
    LLM_MODEL: process.env["LLM_MODEL"] ?? "openai/gpt-4o-mini",
    ...overrides,
  };
}

/** Run the compiled orchestrator as a subprocess, return { stdout, stderr, status } */
function runOrchestrator(
  env: NodeJS.ProcessEnv,
  timeoutMs = 540_000,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(
    "node",
    ["dist/examples/global-research/orchestrator.js"],
    { cwd: ROOT, env, timeout: timeoutMs, encoding: "utf8" },
  );
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

/** Shape of the RunLogger JSON flushed to examples/global-research/runs/ */
interface RunLogFile {
  query: string;
  contextId: string;
  numSearchers: number;
  tasks: Array<{ phase: string; agentId: string; outputTokens: number }>;
  errors: unknown[];
  totalTokens: number;
  totalCost: number;
  outcome: string;
}

/** Parse the "Run log saved to <path>" line and load the JSON run log. */
function readRunLog(stdout: string): RunLogFile {
  const m = stdout.match(/Run log saved to (.+\.json)/);
  expect(m, "orchestrator must flush a run log").not.toBeNull();
  return JSON.parse(readFileSync((m as RegExpMatchArray)[1], "utf8")) as RunLogFile;
}

/** True when the governance gate rejected the report (a legitimate clean stop). */
function governanceRejected(stdout: string): boolean {
  return /Governance review REJECTED the report\. Workflow stopped\./.test(
    stdout,
  );
}

function echo(label: string, stdout: string, stderr = ""): void {
  console.log(`\n── Orchestrator stdout (${label}) ──────────────────────────`);
  console.log(stdout.slice(0, 6000));
  if (stderr.trim()) {
    console.log("\n── stderr ────────────────────────────────────────────────");
    console.log(stderr.slice(0, 1000));
  }
}

// ── Test suite ────────────────────────────────────────────────────────────

describe(
  "Live E2E: Global Research Swarm (Real LLM + Docker)",
  { timeout: 600_000 },
  () => {
    // ─────────────────────────────────────────────────────────────────────
    // Scenario 1 — Golden Path: all stages complete and the report publishes
    // ─────────────────────────────────────────────────────────────────────
    it("Scenario 1 — Golden Path: search → write → governance → editorial → PUBLISHED", () => {
      const { stdout, stderr, status } = runOrchestrator(
        baseEnv({
          QUERY: "Distributed AI Agent Systems in 2025",
        }),
      );
      echo("Scenario 1", stdout, stderr);

      // Gateway reachable
      expect(stdout).toMatch(/Gateway: OK|Gateway: UP/i);

      // Fan-out search phase: banner, generated sub-topics, ≥1 of 2 results
      expect(stdout).toMatch(/STEP 1 — Fan-Out: 2 Searcher nodes/);
      expect(stdout).toMatch(/Sub-topics:[\s\S]*1\./);
      expect(stdout).toMatch(/SEARCH PHASE COMPLETE — [1-2]\/2 results/);

      // Fan-in write phase: non-empty synthesis
      expect(stdout).toMatch(/STEP 2 — Fan-In/);
      expect(stdout).toMatch(/SYNTHESIS COMPLETE \([1-9]\d* chars\)/);

      // Governance review: score + structured recommendation
      expect(stdout).toMatch(/STEP 3 /);
      expect(stdout).toMatch(/Compliance Score: \S+ +Recommendation: (APPROVED|CONDITIONAL|REJECTED)/);

      const log = readRunLog(stdout);
      if (governanceRejected(stdout)) {
        // The governance gate stopping a weak report IS correct system behavior.
        expect(log.outcome).toBe("REJECTED");
      } else {
        // Editorial + HITL (AUTO_PUBLISH forces the PUBLISH decision)
        expect(stdout).toMatch(/STEP 4 /);
        expect(stdout).toMatch(/Editorial: +\S+ +— Recommendation:/);
        expect(stdout).toMatch(/HUMAN DECISION REQUIRED \(HITL\)/);
        expect(stdout).toMatch(/Board: FINISHED/);
        expect(log.outcome).toBe("PUBLISHED");
      }

      // Machine-readable verdict: real tokens were spent across the fleet
      expect(log.totalTokens).toBeGreaterThan(0);
      expect(log.tasks.length).toBeGreaterThanOrEqual(1);

      // Clean exit
      expect(status).toBe(0);
    }, 600_000);

    // ─────────────────────────────────────────────────────────────────────
    // Scenario 2 — Governance structured output present and parseable
    // ─────────────────────────────────────────────────────────────────────
    it("Scenario 2 — Governance: structured compliance review with score and recommendation", () => {
      const { stdout, status } = runOrchestrator(
        baseEnv({
          QUERY: "AI Safety and Alignment Research",
        }),
      );
      echo("Scenario 2", stdout);

      // Must reach the governance stage
      expect(stdout).toMatch(/STEP 3 — Sage \(Reviewer\) running governance compliance check/);

      // Compliance score + structured recommendation present
      expect(stdout).toMatch(/Compliance Score: \S+ +Recommendation: (APPROVED|CONDITIONAL|REJECTED)/);

      // Either continues to editorial (approved/conditional) or stops cleanly (rejected)
      const reachedEditorial = /STEP 4 — Morgan \(Editor\)/.test(stdout);
      expect(reachedEditorial || governanceRejected(stdout)).toBe(true);

      // The run log records the governance task with real token usage
      const log = readRunLog(stdout);
      const govTask = log.tasks.find((t) => t.phase === "governance");
      expect(govTask, "governance phase must be recorded in the run log").toBeDefined();
      expect(govTask?.outputTokens).toBeGreaterThan(0);

      expect(status).toBe(0);
    }, 600_000);

    // ─────────────────────────────────────────────────────────────────────
    // Scenario 3 — ResearchContext metadata fields reported
    // ─────────────────────────────────────────────────────────────────────
    it("Scenario 3 — ResearchContext: metadata (active nodes, tokens, cost) reported", () => {
      const { stdout, status } = runOrchestrator(
        baseEnv({
          QUERY: "Large Language Models and Autonomous Agents",
        }),
      );
      echo("Scenario 3", stdout);

      // Search results flowed into the shared ResearchContext
      expect(stdout).toMatch(/SEARCH PHASE COMPLETE — [1-2]\/2 results/);

      // Economics/metadata report: tokens, cost, active nodes, context id
      expect(stdout).toMatch(/Tokens used: +[1-9]\d*/);
      expect(stdout).toMatch(/Estimated cost: +\$\d+\.\d+/);
      expect(stdout).toMatch(/Active nodes: +.*writer/);
      expect(stdout).toMatch(/Context ID: [0-9a-f-]{36}/);

      // Machine-readable metadata mirrors the CLI report
      const log = readRunLog(stdout);
      expect(log.totalTokens).toBeGreaterThan(0);
      expect(log.totalCost).toBeGreaterThan(0);
      expect(log.contextId).toMatch(/^[0-9a-f-]{36}$/);

      expect(status).toBe(0);
    }, 600_000);

    // ─────────────────────────────────────────────────────────────────────
    // Scenario 4 — Fault tolerance: partial searcher failure tolerated
    // ─────────────────────────────────────────────────────────────────────
    it("Scenario 4 — Chaos Mode: searcher crashes tolerated, pipeline completes", () => {
      // CHAOS_MODE crash-injection is a property of the searcher *containers*
      // (set via docker-compose env at stack-up time). From the orchestrator's
      // side we verify the fan-out phase degrades gracefully: with 3 sub-topics
      // across the searcher pool, the pipeline must complete with at least one
      // successful search result even if individual searchers fail or restart.
      const { stdout, status } = runOrchestrator(
        baseEnv({
          QUERY: "Fault Tolerance in Distributed AI Systems",
          NUM_SEARCHERS: "3",
        }),
      );
      echo("Scenario 4", stdout);

      // Search phase must complete with at least 1 of 3 results
      expect(stdout).toMatch(/SEARCH PHASE COMPLETE — [1-3]\/3 results/);

      // Writer must have received enough data to proceed
      expect(stdout).toMatch(/SYNTHESIS COMPLETE \([1-9]\d* chars\)/);

      // Terminal verdict is a legitimate outcome, with no unhandled errors
      const log = readRunLog(stdout);
      expect(["PUBLISHED", "REVISED", "REJECTED"]).toContain(log.outcome);

      expect(status).toBe(0);
    }, 600_000);
  },
);
