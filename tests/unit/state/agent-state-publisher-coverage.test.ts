import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentStatePublisher } from "../../../src/adapters/state/agent-state-publisher";

const mockPublish = vi.fn().mockResolvedValue(1);
const mockQuit = vi.fn().mockResolvedValue("OK");

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(function () {
    return { publish: mockPublish, quit: mockQuit };
  }),
}));

const agentInfo = {
  agentId: "researcher",
  name: "Ava",
  role: "Researcher",
};

describe("AgentStatePublisher — coverage branches", () => {
  let publisher: AgentStatePublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    publisher = new AgentStatePublisher("redis://localhost:6379", agentInfo);
  });

  afterEach(async () => {
    await publisher.disconnect().catch(() => {});
  });

  it("renders an empty string when a Kaiban-style answer field is undefined", async () => {
    const wrapped = publisher.wrapHandler(
      vi.fn().mockResolvedValue({ answer: undefined }),
    );

    await wrapped({
      taskId: "task-empty-answer",
      agentId: "researcher",
      timestamp: Date.now(),
      data: {},
    });

    const done = JSON.parse(mockPublish.mock.calls.at(-1)![1] as string) as {
      tasks: Array<{ result: string }>;
    };
    expect(done.tasks[0]?.result).toBe("");
  });

  it("serializes plain object results and converts token metadata to numbers", async () => {
    const wrapped = publisher.wrapHandler(
      vi.fn().mockResolvedValue({
        summary: "structured output",
        inputTokens: "7",
        outputTokens: "5",
      }),
    );

    await wrapped({
      taskId: "task-structured",
      agentId: "researcher",
      timestamp: Date.now(),
      data: { instruction: "summarize" },
    });

    const done = JSON.parse(mockPublish.mock.calls.at(-1)![1] as string) as {
      tasks: Array<{ result: string; tokens: number; cost: number }>;
      metadata: { totalTokens: number; estimatedCost: number };
    };
    expect(done.tasks[0]?.result).toContain('"summary":"structured output"');
    expect(done.tasks[0]?.tokens).toBe(12);
    expect(done.tasks[0]?.cost).toBe(0);
    expect(done.metadata.totalTokens).toBe(12);
    expect(done.metadata.estimatedCost).toBe(0);
  });

  it("falls back to zero when token fields are present but undefined", async () => {
    const wrapped = publisher.wrapHandler(
      vi.fn().mockResolvedValue({
        inputTokens: undefined,
        outputTokens: undefined,
        estimatedCost: undefined,
      }),
    );

    await wrapped({
      taskId: "task-zero-tokens",
      agentId: "researcher",
      timestamp: Date.now(),
      data: {},
    });

    const done = JSON.parse(mockPublish.mock.calls.at(-1)![1] as string) as {
      tasks: Array<{ tokens: number; cost: number }>;
      metadata: { totalTokens: number; estimatedCost: number };
    };
    expect(done.tasks[0]?.tokens).toBe(0);
    expect(done.tasks[0]?.cost).toBe(0);
    expect(done.metadata.totalTokens).toBe(0);
    expect(done.metadata.estimatedCost).toBe(0);
  });
});