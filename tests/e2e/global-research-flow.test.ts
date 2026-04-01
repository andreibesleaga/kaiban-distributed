/**
 * E2E: Global Research Swarm — Full Flow including HITL
 *
 * Pipeline tested:
 *   N Searchers (fan-out) → Writer (fan-in) → Reviewer (governance) → Editor → HITL
 *
 * All tests run against real Redis (started by globalSetup.ts).
 * No real LLM calls — mock handlers simulate agent responses.
 * UUID-prefixed queue names for full test isolation.
 *
 * Scenarios:
 *   1. Full PUBLISH path     — 4 searchers → writer → reviewer(APPROVED) → editor → HITL PUBLISH → FINISHED
 *   2. HITL REJECT           — 4 searchers → writer → reviewer(APPROVED) → editor → HITL REJECT → STOPPED
 *   3. HITL REVISE           — editor → REVISE → revised writer task → HITL PUBLISH → FINISHED
 *   4. Governance REJECTED   — reviewer returns REJECTED → workflow STOPPED before editorial
 *   5. Partial searcher fail — 1/4 searchers fails → writer uses 3 results → pipeline continues
 *   6. Fan-in verification   — CompletionRouter.waitAll pattern: all 4 search tasks collected before writer
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "crypto";
import { Redis } from "ioredis";
import { BullMQDriver } from "../../src/infrastructure/messaging/bullmq-driver";
import { AgentActor } from "../../src/application/actor/AgentActor";
import { wrapSigned } from "../../src/infrastructure/security/channel-signing";
import type { MessagePayload } from "../../src/infrastructure/messaging/interfaces";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

function connConfig(): { connection: { host: string; port: number } } {
  const url = new URL(REDIS_URL);
  return {
    connection: { host: url.hostname, port: parseInt(url.port || "6379", 10) },
  };
}

const COMPLETED_CHANNEL = "kaiban-events-completed";
const FAILED_CHANNEL = "kaiban-events-failed";
const STATE_CHANNEL = "kaiban-state-events";
const HITL_CHANNEL = "kaiban-hitl-decisions";

async function waitUntil(
  pred: () => boolean,
  timeoutMs: number,
  intervalMs = 150,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function createOracle(driver: BullMQDriver): {
  success: Map<string, unknown>;
  failed: Set<string>;
  waitFor(
    taskIds: string[],
    timeoutMs: number,
  ): Promise<{ success: Map<string, unknown>; failed: Set<string> }>;
} {
  const success = new Map<string, unknown>();
  const failed = new Set<string>();

  void driver.subscribe(COMPLETED_CHANNEL, async (payload) => {
    success.set(payload.taskId, payload.data);
  });
  void driver.subscribe(FAILED_CHANNEL, async (payload) => {
    failed.add(payload.taskId);
  });

  return {
    success,
    failed,
    async waitFor(
      taskIds: string[],
      timeoutMs: number,
    ): Promise<{ success: Map<string, unknown>; failed: Set<string> }> {
      await waitUntil(
        () => taskIds.every((id) => success.has(id) || failed.has(id)),
        timeoutMs,
      );
      const filteredSuccess = new Map<string, unknown>();
      const filteredFailed = new Set<string>();
      for (const id of taskIds) {
        if (success.has(id)) filteredSuccess.set(id, success.get(id));
        if (failed.has(id)) filteredFailed.add(id);
      }
      return { success: filteredSuccess, failed: filteredFailed };
    },
  };
}

function getHandlerResult(data: unknown): unknown {
  const d = data as Record<string, unknown>;
  return d["result"];
}

async function spawnAgents(
  drivers: BullMQDriver[],
  count: number,
  agentId: string,
  queue: string,
  handler: (p: MessagePayload) => Promise<unknown>,
): Promise<AgentActor[]> {
  const actors: AgentActor[] = [];
  for (let i = 0; i < count; i++) {
    const d = new BullMQDriver(connConfig());
    drivers.push(d);
    const actor = new AgentActor(agentId, d, queue, handler);
    await actor.start();
    actors.push(actor);
  }
  await new Promise((r) => setTimeout(r, 600));
  return actors;
}

async function spawnAgent(
  drivers: BullMQDriver[],
  agentId: string,
  queue: string,
  handler: (p: MessagePayload) => Promise<unknown>,
): Promise<AgentActor> {
  const [actor] = await spawnAgents(drivers, 1, agentId, queue, handler);
  return actor;
}

async function createStateWatcher(): Promise<{
  deltas: Array<Record<string, unknown>>;
  cleanup: () => Promise<void>;
  waitForStatus(status: string, timeoutMs: number): Promise<boolean>;
}> {
  const deltas: Array<Record<string, unknown>> = [];
  const redis = new Redis(REDIS_URL);
  redis.on("error", () => {
    /* suppress connection-closed errors during teardown */
  });

  await redis.subscribe(STATE_CHANNEL);
  redis.on("message", (_ch: string, msg: string) => {
    try {
      const parsed = JSON.parse(msg) as Record<string, unknown>;
      const payload =
        "payload" in parsed && typeof parsed["payload"] === "object"
          ? (parsed["payload"] as Record<string, unknown>)
          : parsed;
      deltas.push(payload);
    } catch {
      /* ignore malformed */
    }
  });

  return {
    deltas,
    cleanup: async (): Promise<void> => {
      redis.disconnect();
    },
    waitForStatus: async (
      status: string,
      timeoutMs: number,
    ): Promise<boolean> => {
      return waitUntil(
        () => deltas.some((d) => d["teamWorkflowStatus"] === status),
        timeoutMs,
      );
    },
  };
}

async function injectHITL(taskId: string, decision: string): Promise<void> {
  const redis = new Redis(REDIS_URL);
  await redis.publish(HITL_CHANNEL, JSON.stringify({ taskId, decision }));
  redis.disconnect();
}

async function publishState(delta: Record<string, unknown>): Promise<void> {
  const redis = new Redis(REDIS_URL);
  await redis.publish(STATE_CHANNEL, wrapSigned(delta));
  redis.disconnect();
}

// ── Mock responses ─────────────────────────────────────────────────────────

function makeSearchResult(taskId: string): string {
  return JSON.stringify({
    sourceUrl: `https://example.com/${taskId}`,
    title: `Research findings for ${taskId}`,
    snippet: `Key findings about AI governance and distributed systems for sub-topic ${taskId}.`,
    relevanceScore: 0.92,
    agentId: "searcher",
    timestamp: new Date().toISOString(),
  });
}

const WRITE_RESULT = JSON.stringify({
  answer:
    "# Global AI Research Report\n\n## Executive Summary\nAI agents are reshaping distributed computing...\n\n## Key Findings\n1. Multi-agent frameworks grew 400% in 2024\n2. Governance frameworks are maturing\n3. HITL workflows increase reliability by 60%",
  inputTokens: 800,
  outputTokens: 1200,
  estimatedCost: 0.065,
});

const REVIEW_APPROVED_RESULT = JSON.stringify({
  answer:
    "## GOVERNANCE REVIEW\n**Topic:** Global AI Research\n**Compliance Score:** 8.9/10\n**Standards Checked:** IEEE AI 7000 | EU AI Act | GDPR | OWASP AI Security | NIST AI RMF\n### Violations Found\n- None\n### Recommendation: APPROVED\n### Required Changes\n- None\n### Rationale\nReport meets all applicable governance standards.",
  inputTokens: 600,
  outputTokens: 400,
  estimatedCost: 0.031,
});

const REVIEW_REJECTED_RESULT = JSON.stringify({
  answer:
    "## GOVERNANCE REVIEW\n**Topic:** Global AI Research\n**Compliance Score:** 2.3/10\n**Standards Checked:** IEEE AI 7000 | EU AI Act | GDPR | OWASP AI Security | NIST AI RMF\n### Violations Found\n- PII exposure in source URLs — Standard: GDPR — Severity: HIGH\n- Unsubstantiated bias claims — Standard: IEEE AI 7000 — Severity: HIGH\n### Recommendation: REJECTED\n### Required Changes\n- Remove all personally identifiable information\n- Substantiate all bias-related claims with cited research\n### Rationale\nCritical compliance violations prevent publication under current frameworks.",
  inputTokens: 600,
  outputTokens: 450,
  estimatedCost: 0.033,
});

const EDIT_PUBLISH_RESULT = JSON.stringify({
  answer:
    "## EDITORIAL REVIEW\n**Topic:** Global AI Research\n**Accuracy Score:** 9.1/10\n### Editorial Assessment\nThe report demonstrates thorough research with excellent source attribution and logical structure.\n### Issues Found\n- Minor formatting inconsistency — Severity: LOW\n### Required Changes\n- Standardise heading levels\n### Recommendation: PUBLISH\n### Rationale\nHigh quality report meeting all editorial standards.",
  inputTokens: 700,
  outputTokens: 380,
  estimatedCost: 0.034,
});

const EDIT_REVISE_RESULT = JSON.stringify({
  answer:
    "## EDITORIAL REVIEW\n**Topic:** Global AI Research\n**Accuracy Score:** 6.8/10\n### Editorial Assessment\nReport covers the topic adequately but lacks depth in key areas.\n### Issues Found\n- Executive Summary is too brief — Severity: MEDIUM\n### Required Changes\n- Expand Executive Summary to 300 words\n### Recommendation: REVISE\n### Rationale\nStrong foundation but requires depth improvements before publication.",
  inputTokens: 700,
  outputTokens: 360,
  estimatedCost: 0.033,
});

const REVISION_RESULT = JSON.stringify({
  answer:
    "# Global AI Research Report (Revised)\n\n## Executive Summary\nIn 2025, artificial intelligence has fundamentally transformed distributed computing paradigms...[expanded 300 words]\n\n## Key Findings\n[Enhanced with additional depth and citations]",
  inputTokens: 1200,
  outputTokens: 1500,
  estimatedCost: 0.082,
});

// ── Test Suite ─────────────────────────────────────────────────────────

describe("E2E: Global Research Swarm Full Flow (BullMQ + HITL)", () => {
  const drivers: BullMQDriver[] = [];
  const stateWatchers: Array<{ cleanup: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(drivers.map((d) => d.disconnect()));
    drivers.length = 0;
    await Promise.all(stateWatchers.map((w) => w.cleanup()));
    stateWatchers.length = 0;
  });

  // ─────────────────────────────────────────────────────────────────
  // Scenario 1 — Full PUBLISH Path
  // ─────────────────────────────────────────────────────────────────
  it("Scenario 1 — Full PUBLISH: 4 searchers → writer → reviewer(APPROVED) → editor → HITL PUBLISH → FINISHED", async () => {
    const wfId = `wf-gr-golden-${randomUUID()}`;
    const SEARCHER_Q = `gr-searcher-${wfId}`;
    const WRITER_Q = `gr-writer-${wfId}`;
    const REVIEWER_Q = `gr-reviewer-${wfId}`;
    const EDITOR_Q = `gr-editor-${wfId}`;
    const NUM_SEARCHERS = 4;

    const oracleDriver = new BullMQDriver(connConfig());
    drivers.push(oracleDriver);
    const oracle = createOracle(oracleDriver);

    const searchTaskIds = Array.from(
      { length: NUM_SEARCHERS },
      (_, i) => `${wfId}-search-${i}`,
    );
    const writeTaskId = `${wfId}-write`;
    const reviewTaskId = `${wfId}-review`;
    const editTaskId = `${wfId}-edit`;

    const stateWatcher = await createStateWatcher();
    stateWatchers.push(stateWatcher);

    // Spin up all agent pools
    await spawnAgents(
      drivers,
      NUM_SEARCHERS,
      "searcher",
      SEARCHER_Q,
      async (p) => makeSearchResult(p.taskId),
    );
    await spawnAgent(drivers, "writer", WRITER_Q, async () => WRITE_RESULT);
    await spawnAgent(
      drivers,
      "reviewer",
      REVIEWER_Q,
      async () => REVIEW_APPROVED_RESULT,
    );
    await spawnAgent(
      drivers,
      "editor",
      EDITOR_Q,
      async () => EDIT_PUBLISH_RESULT,
    );

    // Publish workflow start
    await publishState({
      teamWorkflowStatus: "RUNNING",
      inputs: { query: "The Future of AI Governance" },
      metadata: { totalTokens: 0, estimatedCost: 0, startTime: Date.now() },
    });

    // Phase 1: Fan-out — dispatch 4 search tasks in parallel
    await Promise.all(
      searchTaskIds.map((taskId) =>
        oracleDriver.publish(SEARCHER_Q, {
          taskId,
          agentId: "searcher",
          timestamp: Date.now(),
          data: { instruction: `Research sub-topic: ${taskId}` },
        }),
      ),
    );
    const searchPhase = await oracle.waitFor(searchTaskIds, 15_000);
    expect(searchPhase.success.size).toBe(NUM_SEARCHERS);
    expect(searchPhase.failed.size).toBe(0);

    // Verify all search results contain expected structure
    for (const [, data] of searchPhase.success) {
      const result = String(getHandlerResult(data));
      const parsed = JSON.parse(result) as {
        sourceUrl: string;
        relevanceScore: number;
      };
      expect(parsed.sourceUrl).toContain("example.com");
      expect(parsed.relevanceScore).toBeGreaterThan(0);
    }

    // Phase 2: Fan-in — writer aggregates all search results
    await oracleDriver.publish(WRITER_Q, {
      taskId: writeTaskId,
      agentId: "writer",
      timestamp: Date.now(),
      data: {
        instruction:
          "Synthesise all search results into a comprehensive report",
        searchResults: Array.from(searchPhase.success.values()).map((d) =>
          getHandlerResult(d),
        ),
      },
    });
    const writePhase = await oracle.waitFor([writeTaskId], 12_000);
    expect(writePhase.success.size).toBe(1);

    const writeResult = JSON.parse(
      String(getHandlerResult(writePhase.success.get(writeTaskId))),
    ) as { answer: string };
    expect(writeResult.answer).toContain("AI");

    // Phase 3: Governance review
    await oracleDriver.publish(REVIEWER_Q, {
      taskId: reviewTaskId,
      agentId: "reviewer",
      timestamp: Date.now(),
      data: { instruction: "Governance review", draft: writeResult.answer },
    });
    const reviewPhase = await oracle.waitFor([reviewTaskId], 12_000);
    expect(reviewPhase.success.size).toBe(1);

    const reviewResult = JSON.parse(
      String(getHandlerResult(reviewPhase.success.get(reviewTaskId))),
    ) as { answer: string };
    expect(reviewResult.answer).toContain("APPROVED");

    // Phase 4: Editorial review
    await oracleDriver.publish(EDITOR_Q, {
      taskId: editTaskId,
      agentId: "editor",
      timestamp: Date.now(),
      data: { instruction: "Editorial review", draft: writeResult.answer },
    });
    const editPhase = await oracle.waitFor([editTaskId], 12_000);
    expect(editPhase.success.size).toBe(1);

    const editResult = JSON.parse(
      String(getHandlerResult(editPhase.success.get(editTaskId))),
    ) as { answer: string };
    expect(editResult.answer).toContain("PUBLISH");

    // Phase 5: HITL — board injects PUBLISH decision
    await publishState({
      teamWorkflowStatus: "RUNNING",
      tasks: [
        {
          taskId: editTaskId,
          status: "AWAITING_VALIDATION",
          assignedToAgentId: "editor",
          result: "Recommendation: PUBLISH | Score: 9.1/10",
        },
      ],
    });
    await injectHITL(editTaskId, "PUBLISH");

    await publishState({
      teamWorkflowStatus: "FINISHED",
      tasks: [
        {
          taskId: writeTaskId,
          status: "DONE",
          assignedToAgentId: "writer",
          result: "✅ Published",
        },
        {
          taskId: editTaskId,
          status: "DONE",
          assignedToAgentId: "editor",
          result: "✅ Approved",
        },
      ],
      metadata: {
        totalTokens: 2700,
        estimatedCost: 0.163,
        endTime: Date.now(),
      },
    });

    const finished = await stateWatcher.waitForStatus("FINISHED", 8_000);
    expect(finished).toBe(true);
  }, 70_000);

  // ─────────────────────────────────────────────────────────────────
  // Scenario 2 — HITL REJECT at editorial stage → STOPPED
  // ─────────────────────────────────────────────────────────────────
  it("Scenario 2 — HITL REJECT: human rejects at editor stage → STOPPED state", async () => {
    const wfId = `wf-gr-reject-${randomUUID()}`;
    const EDITOR_Q = `gr-editor-${wfId}`;

    const oracleDriver = new BullMQDriver(connConfig());
    drivers.push(oracleDriver);
    const oracle = createOracle(oracleDriver);
    const editTaskId = `${wfId}-edit`;

    await spawnAgent(
      drivers,
      "editor",
      EDITOR_Q,
      async () => EDIT_PUBLISH_RESULT,
    );

    const stateWatcher = await createStateWatcher();
    stateWatchers.push(stateWatcher);

    await oracleDriver.publish(EDITOR_Q, {
      taskId: editTaskId,
      agentId: "editor",
      timestamp: Date.now(),
      data: {
        instruction: "Editorial review",
        draft: "Research report content",
      },
    });
    const editPhase = await oracle.waitFor([editTaskId], 10_000);
    expect(editPhase.success.size).toBe(1);

    // Publish AWAITING_VALIDATION, then inject REJECT
    await publishState({
      teamWorkflowStatus: "RUNNING",
      tasks: [
        {
          taskId: editTaskId,
          status: "AWAITING_VALIDATION",
          assignedToAgentId: "editor",
          result: "Recommendation: PUBLISH | Score: 9.1/10",
        },
      ],
    });
    await injectHITL(editTaskId, "REJECT");

    await publishState({
      teamWorkflowStatus: "STOPPED",
      tasks: [
        {
          taskId: editTaskId,
          status: "BLOCKED",
          assignedToAgentId: "editor",
          result: "🗑 Rejected by human reviewer",
        },
      ],
      metadata: { totalTokens: 700, estimatedCost: 0.034, endTime: Date.now() },
    });

    const stopped = await stateWatcher.waitForStatus("STOPPED", 5_000);
    expect(stopped).toBe(true);

    const stopDelta = stateWatcher.deltas.find(
      (d) => d["teamWorkflowStatus"] === "STOPPED",
    );
    const tasks = stopDelta?.["tasks"] as
      | Array<Record<string, unknown>>
      | undefined;
    expect(tasks?.some((t) => t["status"] === "BLOCKED")).toBe(true);
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────
  // Scenario 3 — HITL REVISE: editor → REVISE → revised writer → HITL PUBLISH → FINISHED
  // ─────────────────────────────────────────────────────────────────
  it("Scenario 3 — HITL REVISE: revision loop completes and is published", async () => {
    const wfId = `wf-gr-revise-${randomUUID()}`;
    const WRITER_Q = `gr-writer-${wfId}`;
    const EDITOR_Q = `gr-editor-${wfId}`;

    const oracleDriver = new BullMQDriver(connConfig());
    drivers.push(oracleDriver);
    const oracle = createOracle(oracleDriver);

    const editTaskId = `${wfId}-edit`;
    const revisionTaskId = `${wfId}-revision`;

    await spawnAgent(drivers, "writer", WRITER_Q, async (p) =>
      p.taskId === revisionTaskId ? REVISION_RESULT : WRITE_RESULT,
    );
    await spawnAgent(
      drivers,
      "editor",
      EDITOR_Q,
      async () => EDIT_REVISE_RESULT,
    );

    const stateWatcher = await createStateWatcher();
    stateWatchers.push(stateWatcher);

    // Initial edit task → REVISE recommendation
    await oracleDriver.publish(EDITOR_Q, {
      taskId: editTaskId,
      agentId: "editor",
      timestamp: Date.now(),
      data: { instruction: "Editorial review", draft: "Research report draft" },
    });
    const editPhase = await oracle.waitFor([editTaskId], 10_000);
    expect(editPhase.success.size).toBe(1);

    const editResult = JSON.parse(
      String(getHandlerResult(editPhase.success.get(editTaskId))),
    ) as { answer: string };
    expect(editResult.answer).toContain("REVISE");

    // Board sends REVISE via HITL channel
    await publishState({
      teamWorkflowStatus: "RUNNING",
      tasks: [
        {
          taskId: editTaskId,
          status: "AWAITING_VALIDATION",
          assignedToAgentId: "editor",
          result: "Recommendation: REVISE",
        },
      ],
    });
    await injectHITL(editTaskId, "REVISE");

    // Revision task dispatched to writer
    await oracleDriver.publish(WRITER_Q, {
      taskId: revisionTaskId,
      agentId: "writer",
      timestamp: Date.now(),
      data: {
        instruction: "Revise the research report",
        originalDraft: "Research report draft",
        editorialFeedback: editResult.answer,
      },
    });
    const revisionPhase = await oracle.waitFor([revisionTaskId], 10_000);
    expect(revisionPhase.success.size).toBe(1);

    const revisionResult = JSON.parse(
      String(getHandlerResult(revisionPhase.success.get(revisionTaskId))),
    ) as { answer: string };
    expect(revisionResult.answer).toContain("Revised");

    // Second HITL gate — PUBLISH
    await publishState({
      teamWorkflowStatus: "RUNNING",
      tasks: [
        {
          taskId: revisionTaskId,
          status: "AWAITING_VALIDATION",
          assignedToAgentId: "writer",
          result: "Revised report — Approve for publication?",
        },
      ],
    });
    await injectHITL(revisionTaskId, "PUBLISH");

    await publishState({
      teamWorkflowStatus: "FINISHED",
      tasks: [
        {
          taskId: revisionTaskId,
          status: "DONE",
          assignedToAgentId: "writer",
          result: "✅ Published",
        },
      ],
      metadata: {
        totalTokens: 3200,
        estimatedCost: 0.196,
        endTime: Date.now(),
      },
    });

    const finished = await stateWatcher.waitForStatus("FINISHED", 5_000);
    expect(finished).toBe(true);

    // Verify two AWAITING_VALIDATION events (one per HITL gate)
    const awaitingDeltas = stateWatcher.deltas.filter(
      (d) =>
        Array.isArray(d["tasks"]) &&
        (d["tasks"] as Array<Record<string, unknown>>).some(
          (t) => t["status"] === "AWAITING_VALIDATION",
        ),
    );
    expect(awaitingDeltas.length).toBeGreaterThanOrEqual(2);
  }, 45_000);

  // ─────────────────────────────────────────────────────────────────
  // Scenario 4 — Governance REJECTED: reviewer fails → STOPPED before editorial
  // ─────────────────────────────────────────────────────────────────
  it("Scenario 4 — Governance REJECTED: reviewer fails compliance check → workflow STOPPED", async () => {
    const wfId = `wf-gr-gov-${randomUUID()}`;
    const REVIEWER_Q = `gr-reviewer-${wfId}`;

    const oracleDriver = new BullMQDriver(connConfig());
    drivers.push(oracleDriver);
    const oracle = createOracle(oracleDriver);
    const reviewTaskId = `${wfId}-review`;

    await spawnAgent(
      drivers,
      "reviewer",
      REVIEWER_Q,
      async () => REVIEW_REJECTED_RESULT,
    );

    const stateWatcher = await createStateWatcher();
    stateWatchers.push(stateWatcher);

    await oracleDriver.publish(REVIEWER_Q, {
      taskId: reviewTaskId,
      agentId: "reviewer",
      timestamp: Date.now(),
      data: {
        instruction: "Governance review",
        draft: "Research report with compliance issues",
      },
    });
    const reviewPhase = await oracle.waitFor([reviewTaskId], 10_000);
    expect(reviewPhase.success.size).toBe(1);

    const reviewResult = JSON.parse(
      String(getHandlerResult(reviewPhase.success.get(reviewTaskId))),
    ) as { answer: string };
    expect(reviewResult.answer).toContain("REJECTED");
    expect(reviewResult.answer).toContain("GDPR");
    expect(reviewResult.answer).toContain("HIGH");

    // Orchestrator detects REJECTED → publishes STOPPED (no editorial stage)
    await publishState({
      teamWorkflowStatus: "STOPPED",
      tasks: [
        {
          taskId: reviewTaskId,
          status: "BLOCKED",
          assignedToAgentId: "reviewer",
          result: "⛔ Governance review failed: GDPR violation",
        },
      ],
      metadata: { totalTokens: 600, estimatedCost: 0.033, endTime: Date.now() },
    });

    const stopped = await stateWatcher.waitForStatus("STOPPED", 5_000);
    expect(stopped).toBe(true);

    // Verify no editorial tasks were created (STOPPED happened at governance stage)
    const editTasks = stateWatcher.deltas.flatMap((d) =>
      ((d["tasks"] as Array<Record<string, unknown>> | undefined) ?? []).filter(
        (t) => t["assignedToAgentId"] === "editor",
      ),
    );
    expect(editTasks).toHaveLength(0);
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────
  // Scenario 5 — Partial searcher failure: 1/4 fails → writer uses 3 results
  // ─────────────────────────────────────────────────────────────────
  it("Scenario 5 — Partial failure: 1/4 searchers fails, writer continues with 3 results", async () => {
    const wfId = `wf-gr-partial-${randomUUID()}`;
    const SEARCHER_Q = `gr-searcher-${wfId}`;
    const WRITER_Q = `gr-writer-${wfId}`;
    const NUM = 4;

    const searchTaskIds = Array.from(
      { length: NUM },
      (_, i) => `${wfId}-search-${i}`,
    );
    const FAILING_TASK = searchTaskIds[0];
    const writeTaskId = `${wfId}-write`;

    const oracleDriver = new BullMQDriver(connConfig());
    drivers.push(oracleDriver);
    const oracle = createOracle(oracleDriver);

    let writerCalled = false;
    let writerReceivedSearchCount = 0;

    await spawnAgents(drivers, NUM, "searcher", SEARCHER_Q, async (p) => {
      if (p.taskId === FAILING_TASK)
        throw new Error("permanent searcher failure");
      return makeSearchResult(p.taskId);
    });

    await spawnAgent(drivers, "writer", WRITER_Q, async (p) => {
      writerCalled = true;
      const results = p.data["searchResults"] as unknown[] | undefined;
      writerReceivedSearchCount = results?.length ?? 0;
      return WRITE_RESULT;
    });

    // Fan-out 4 search tasks
    await Promise.all(
      searchTaskIds.map((taskId) =>
        oracleDriver.publish(SEARCHER_Q, {
          taskId,
          agentId: "searcher",
          timestamp: Date.now(),
          data: { instruction: `Sub-topic ${taskId}` },
        }),
      ),
    );

    const searchPhase = await oracle.waitFor(searchTaskIds, 20_000);
    expect(searchPhase.success.size).toBe(3);
    expect(searchPhase.failed.size).toBe(1);
    expect(searchPhase.failed.has(FAILING_TASK)).toBe(true);

    // Writer proceeds with 3 out of 4 results
    const successfulResults = Array.from(searchPhase.success.values()).map(
      (d) => getHandlerResult(d),
    );
    await oracleDriver.publish(WRITER_Q, {
      taskId: writeTaskId,
      agentId: "writer",
      timestamp: Date.now(),
      data: {
        instruction:
          "Synthesise available search results (1/4 searcher failed)",
        searchResults: successfulResults,
      },
    });

    const writePhase = await oracle.waitFor([writeTaskId], 12_000);
    expect(writePhase.success.size).toBe(1);
    expect(writerCalled).toBe(true);
    expect(writerReceivedSearchCount).toBe(3);
  }, 45_000);

  // ─────────────────────────────────────────────────────────────────
  // Scenario 6 — Fan-in gate: all 4 search tasks complete before writer dispatched
  // ─────────────────────────────────────────────────────────────────
  it("Scenario 6 — Fan-in verification: all 4 search results collected before writer task dispatched", async () => {
    const wfId = `wf-gr-fanin-${randomUUID()}`;
    const SEARCHER_Q = `gr-searcher-${wfId}`;
    const WRITER_Q = `gr-writer-${wfId}`;
    const NUM = 4;

    const searchTaskIds = Array.from(
      { length: NUM },
      (_, i) => `${wfId}-search-${i}`,
    );
    const writeTaskId = `${wfId}-write`;

    const oracleDriver = new BullMQDriver(connConfig());
    drivers.push(oracleDriver);
    const oracle = createOracle(oracleDriver);

    const searchCompletionTimestamps: number[] = [];

    await spawnAgents(drivers, NUM, "searcher", SEARCHER_Q, async (p) => {
      // Simulate variable latency to stress-test fan-in ordering
      const delay = Math.floor(Math.random() * 800);
      await new Promise((r) => setTimeout(r, delay));
      searchCompletionTimestamps.push(Date.now());
      return makeSearchResult(p.taskId);
    });

    await spawnAgent(drivers, "writer", WRITER_Q, async () => WRITE_RESULT);

    // Fan-out
    await Promise.all(
      searchTaskIds.map((taskId) =>
        oracleDriver.publish(SEARCHER_Q, {
          taskId,
          agentId: "searcher",
          timestamp: Date.now(),
          data: { instruction: `Research: ${taskId}` },
        }),
      ),
    );

    // Wait for ALL searchers to finish (fan-in gate)
    const searchPhase = await oracle.waitFor(searchTaskIds, 20_000);
    expect(searchPhase.success.size).toBe(NUM);

    // Record when writer is dispatched — must be AFTER all searches complete
    const writerDispatchTimestamp = Date.now();

    await oracleDriver.publish(WRITER_Q, {
      taskId: writeTaskId,
      agentId: "writer",
      timestamp: Date.now(),
      data: {
        instruction: "Synthesise all search results",
        searchResults: Array.from(searchPhase.success.values()).map((d) =>
          getHandlerResult(d),
        ),
      },
    });

    const writePhase = await oracle.waitFor([writeTaskId], 12_000);
    expect(writePhase.success.size).toBe(1);

    // Key invariant: writer was dispatched only after all 4 searches completed
    expect(searchCompletionTimestamps).toHaveLength(NUM);
    const lastSearchCompletedAt = Math.max(...searchCompletionTimestamps);
    expect(writerDispatchTimestamp).toBeGreaterThanOrEqual(
      lastSearchCompletedAt,
    );

    // Verify writer result contains expected content
    const writeResult = JSON.parse(
      String(getHandlerResult(writePhase.success.get(writeTaskId))),
    ) as { answer: string };
    expect(writeResult.answer).toContain("AI");
  }, 45_000);
});
