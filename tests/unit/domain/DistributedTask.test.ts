import { describe, it, expect } from "vitest";
import {
  isDistributedTask,
  type DistributedTask,
  type TaskStatus,
} from "../../../src/domain/entities/DistributedTask";
import {
  isDistributedAgentState,
  type DistributedAgentState,
  type AgentStatus,
} from "../../../src/domain/entities/DistributedAgentState";
import {
  TaskNotFoundError,
  AgentNotFoundError,
  ValidationError,
  MessagingError,
} from "../../../src/domain/errors/DomainError";

const validTask: DistributedTask = {
  taskId: "task-001",
  assignedToAgentId: "agent-1",
  status: "TODO",
  payload: {
    instruction: "Write a summary",
    expectedOutput: "Summary",
    context: [],
  },
  result: null,
  logs: [],
};

describe("DistributedTask", () => {
  it("isDistributedTask() returns true for a valid task", () => {
    expect(isDistributedTask(validTask)).toBe(true);
  });
  it("isDistributedTask() returns false for missing taskId", () => {
    expect(isDistributedTask({ status: "TODO", payload: {}, logs: [] })).toBe(
      false,
    );
  });
  it("isDistributedTask() returns false for null", () => {
    expect(isDistributedTask(null)).toBe(false);
  });
  it("isDistributedTask() returns false for undefined", () => {
    expect(isDistributedTask(undefined)).toBe(false);
  });
  it("isDistributedTask() returns false for non-object", () => {
    expect(isDistributedTask("string")).toBe(false);
  });
  it("isDistributedTask() returns false for invalid status", () => {
    expect(isDistributedTask({ ...validTask, status: "INVALID" })).toBe(false);
  });
  it("isDistributedTask() returns false for missing status", () => {
    expect(isDistributedTask({ ...validTask, status: undefined })).toBe(false);
  });
  it("isDistributedTask() returns false when logs is not an array", () => {
    expect(isDistributedTask({ ...validTask, logs: "not-array" })).toBe(false);
  });
  it("isDistributedTask() returns false when payload is null", () => {
    expect(isDistributedTask({ ...validTask, payload: null })).toBe(false);
  });
  it("all valid task statuses are accepted", () => {
    const statuses: TaskStatus[] = [
      "TODO",
      "DOING",
      "AWAITING_VALIDATION",
      "DONE",
      "BLOCKED",
    ];
    for (const status of statuses)
      expect(isDistributedTask({ ...validTask, status })).toBe(true);
  });
  it("task logs timestamp is a number", () => {
    const t: DistributedTask = {
      ...validTask,
      logs: [
        { timestamp: Date.now(), level: "info", message: "x", traceId: "tr" },
      ],
    };
    expect(typeof t.logs[0].timestamp).toBe("number");
  });
});

const validState: DistributedAgentState = {
  agentId: "agent-001",
  status: "IDLE",
  currentTaskId: null,
  memory: {},
  version: "v1",
};

describe("DistributedAgentState", () => {
  it("isDistributedAgentState() returns true for valid state", () => {
    expect(isDistributedAgentState(validState)).toBe(true);
  });
  it("isDistributedAgentState() returns false for missing agentId", () => {
    expect(isDistributedAgentState({ status: "IDLE", version: "v1" })).toBe(
      false,
    );
  });
  it("isDistributedAgentState() returns false for invalid status", () => {
    expect(isDistributedAgentState({ ...validState, status: "UNKNOWN" })).toBe(
      false,
    );
  });
  it("isDistributedAgentState() returns false for missing version", () => {
    expect(isDistributedAgentState({ ...validState, version: undefined })).toBe(
      false,
    );
  });
  it("isDistributedAgentState() returns false for null", () => {
    expect(isDistributedAgentState(null)).toBe(false);
  });
  it("isDistributedAgentState() returns false for non-object", () => {
    expect(isDistributedAgentState(42)).toBe(false);
  });
  it("all valid agent statuses are accepted", () => {
    const statuses: AgentStatus[] = ["IDLE", "THINKING", "EXECUTING", "ERROR"];
    for (const status of statuses)
      expect(isDistributedAgentState({ ...validState, status })).toBe(true);
  });
});

describe("DomainError subtypes", () => {
  it("TaskNotFoundError has correct code and message", () => {
    const e = new TaskNotFoundError("task-999");
    expect(e.code).toBe("TASK_NOT_FOUND");
    expect(e.message).toContain("task-999");
    expect(e).toBeInstanceOf(Error);
  });
  it("AgentNotFoundError has correct code", () => {
    const e = new AgentNotFoundError("agent-x");
    expect(e.code).toBe("AGENT_NOT_FOUND");
    expect(e.message).toContain("agent-x");
  });
  it("ValidationError has correct code", () => {
    expect(new ValidationError("bad").code).toBe("VALIDATION_ERROR");
  });
  it("MessagingError has correct code", () => {
    expect(new MessagingError("down").code).toBe("MESSAGING_ERROR");
  });
});
