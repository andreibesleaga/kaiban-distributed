export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class TaskNotFoundError extends DomainError {
  readonly code = "TASK_NOT_FOUND";

  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
  }
}

export class AgentNotFoundError extends DomainError {
  readonly code = "AGENT_NOT_FOUND";

  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
  }
}

export class ValidationError extends DomainError {
  readonly code = "VALIDATION_ERROR";

  constructor(message: string) {
    super(message);
  }
}

export class MessagingError extends DomainError {
  readonly code = "MESSAGING_ERROR";

  constructor(message: string) {
    super(message);
  }
}

/**
 * Base class for failures the actor must NOT retry (roadmap §7.2 items 1–2).
 *
 * `AgentActor.executeWithRetries` re-throws any `NonRetryableError` on the first
 * attempt and dead-letters the task with `reasonCode` as the DLQ `reason`, so a
 * budget breach (or, later, a control abort) costs at most one attempt instead
 * of three paid calls. Subclasses set `reasonCode` to a stable snake_case token.
 */
export abstract class NonRetryableError extends DomainError {
  /** Stable, machine-readable reason written to the DLQ record. */
  abstract readonly reasonCode: string;
}
