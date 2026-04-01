export type TaskStatus =
  | "TODO"
  | "DOING"
  | "AWAITING_VALIDATION"
  | "DONE"
  | "BLOCKED";

const VALID_TASK_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
  "TODO",
  "DOING",
  "AWAITING_VALIDATION",
  "DONE",
  "BLOCKED",
]);

export interface TaskLog {
  timestamp: number;
  level: string;
  message: string;
  traceId: string;
}

export interface TaskPayload {
  instruction: string;
  expectedOutput: string;
  context: string[];
}

export interface DistributedTask {
  taskId: string;
  assignedToAgentId: string | null;
  status: TaskStatus;
  payload: TaskPayload;
  result: unknown | null;
  logs: TaskLog[];
}

export function isDistributedTask(value: unknown): value is DistributedTask {
  if (value === null || value === undefined || typeof value !== "object")
    return false;
  const v = value as Record<string, unknown>;
  if (typeof v["taskId"] !== "string") return false;
  if (typeof v["status"] !== "string" || !VALID_TASK_STATUSES.has(v["status"]))
    return false;
  if (!Array.isArray(v["logs"])) return false;
  if (v["payload"] === null || typeof v["payload"] !== "object") return false;
  return true;
}
