/**
 * Live E2E: Global Research Swarm — Real LLM + Dockerized Services
 *
 * These tests run the complete distributed pipeline end-to-end:
 *   - 4 services in Docker: Redis, Gateway, Agent nodes (searcher×4, writer, reviewer, editor)
 *   - Real LLM calls via OpenRouter/OpenAI (no mocks)
 *   - Orchestrator run as compiled Node.js subprocess (dist/examples/...)
 *   - AUTO_PUBLISH=1 skips the readline HITL prompt
 *
 * Run with:
 *   npm run test:e2e:live
 *
 * Requires:
 *   OPENROUTER_API_KEY or OPENAI_API_KEY in .env
 *   Docker running
 *
 * Scenarios:
 *   1. Golden Path          — full pipeline (search → write → review → edit → publish)
 *   2. Governance output    — structured compliance review present in output
 *   3. ResearchContext      — metadata fields (nodes, tokens, cost) reported
 *   4. Fault tolerance      — CHAOS_MODE: some searchers crash, pipeline still completes
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
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

// ── Test suite ────────────────────────────────────────────────────────────

describe(
  "Live E2E: Global Research Swarm (Real LLM + Docker)",
  { timeout: 600_000 },
  () => {
    // ─────────────────────────────────────────────────────────────────────
    // Scenario 1 — Golden Path: all 4 stages complete and research publishes
    // ─────────────────────────────────────────────────────────────────────
    it("Scenario 1 — Golden Path: search → write → governance → editorial → PUBLISHED", () => {
      const { stdout, stderr, status } = runOrchestrator(
        baseEnv({
          QUERY: "Distributed AI Agent Systems in 2025",
        }),
      );

      console.log(
        "\n── Orchestrator stdout (Scenario 1) ──────────────────────────",
      );
      console.log(stdout.slice(0, 6000));
      if (stderr.trim()) {
        console.log(
          "\n── stderr ────────────────────────────────────────────────────",
        );
        console.log(stderr.slice(0, 1000));
      }

      // Gateway reachable
      expect(stdout).toMatch(/Gateway: OK|Gateway: UP/i);

      // Fan-out search phase
      expect(stdout).toMatch(/Fan-Out.*Searcher|STEP 1/i);
      expect(stdout).toMatch(/Search task \d+\/\d+ queued/);
      expect(stdout).toMatch(/SEARCH PHASE COMPLETE/);
      expect(stdout).toMatch(/Succeeded: [1-9]/);

      // Fan-in write phase
      expect(stdout).toMatch(/Fan-In.*Writer|STEP 2/i);
      expect(stdout).toMatch(/SYNTHESIS COMPLETE/);

      // Governance review
      expect(stdout).toMatch(/STEP 3/i);
      expect(stdout).toMatch(/GOVERNANCE REVIEW BY SAGE/);
      expect(stdout).toMatch(/Compliance Score:/);
      expect(stdout).toMatch(/Recommendation:/);

      // Editorial + HITL (auto-published)
      expect(stdout).toMatch(/STEP 4/i);
      expect(stdout).toMatch(/EDITORIAL REVIEW BY MORGAN/);
      expect(stdout).toMatch(
        /AUTO_PUBLISH.*auto-approving|RESEARCH PUBLISHED/i,
      );

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

      console.log(
        "\n── Orchestrator stdout (Scenario 2) ──────────────────────────",
      );
      console.log(stdout.slice(0, 4000));

      // Must reach governance stage
      expect(stdout).toMatch(/GOVERNANCE REVIEW BY SAGE/);

      // Compliance score present
      expect(stdout).toMatch(/Compliance Score:/i);

      // Recommendation is one of the valid values
      expect(stdout).toMatch(/APPROVED|CONDITIONAL|REJECTED/);

      // Either continues to editorial (approved/conditional) or stops cleanly (rejected)
      const reachedEditorial = /EDITORIAL REVIEW BY MORGAN/.test(stdout);
      const rejectedByGovernance =
        /Governance review REJECTED|Workflow stopped/i.test(stdout);
      expect(reachedEditorial || rejectedByGovernance).toBe(true);

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

      console.log(
        "\n── Orchestrator stdout (Scenario 3) ──────────────────────────",
      );
      console.log(stdout.slice(0, 4000));

      // ResearchContext populated message
      expect(stdout).toMatch(
        /ResearchContext populated with \d+ search results/,
      );

      // Active nodes tracked
      expect(stdout).toMatch(/Active nodes:/);

      // If published: economics report section
      if (/RESEARCH PUBLISHED/.test(stdout)) {
        expect(stdout).toMatch(/Nodes Active:/);
        expect(stdout).toMatch(/Started:/);
        expect(stdout).toMatch(/Completed:/);
      }

      expect(status).toBe(0);
    }, 600_000);

    // ─────────────────────────────────────────────────────────────────────
    // Scenario 4 — Chaos Mode: ~20% crash rate, pipeline still completes
    // ─────────────────────────────────────────────────────────────────────
    it("Scenario 4 — Chaos Mode: searcher crashes tolerated, pipeline completes", () => {
      // CHAOS_MODE is passed via env to the searcher containers via docker-compose
      // but for the orchestrator we just verify it handles partial failures gracefully.
      // We use NUM_SEARCHERS=3 so there is headroom even if 1 searcher fails permanently.
      const { stdout, status } = runOrchestrator(
        baseEnv({
          QUERY: "Fault Tolerance in Distributed AI Systems",
          NUM_SEARCHERS: "3",
        }),
      );

      console.log(
        "\n── Orchestrator stdout (Scenario 4) ──────────────────────────",
      );
      console.log(stdout.slice(0, 4000));

      // Search phase must complete (with at least 1 result)
      expect(stdout).toMatch(/SEARCH PHASE COMPLETE/);
      expect(stdout).toMatch(/Succeeded: [1-9]/);

      // Writer must have received enough data to proceed
      expect(stdout).toMatch(/SYNTHESIS COMPLETE|ResearchContext populated/);

      expect(status).toBe(0);
    }, 600_000);
  },
);
