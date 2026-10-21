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

/** Token usage of one paid LLM attempt (the handler-result usage fields). */
export interface AttemptUsage {
  /** Tokens sent to the model in this attempt. */
  inputTokens: number;
  /** Tokens received from the model in this attempt. */
  outputTokens: number;
  /** Estimated USD cost of this attempt (not counted by the token caps). */
  estimatedCost: number;
}

/**
 * A task attempt that failed AFTER it spent tokens (e.g. a KaibanJS workflow
 * that ended BLOCKED; an ERRORED one makes `team.start()` reject). It stays
 * retryable — it is not a `NonRetryableError` — but carries the attempt's
 * `usage`, so
 * `AgentStatePublisher.wrapHandler` counts it against the per-agent and
 * per-task token caps before the actor retries. When that reaches a cap the
 * publisher raises a non-retryable `BudgetExceededError` instead, and no
 * further paid attempt is made. Only this error carries usage: a custom
 * `TaskHandler` must throw it for its failed paid attempts to count, and any
 * other thrown error is not counted. A timed-out attempt still counts when its
 * handler finishes later — by returning a result or by throwing this error —
 * which can be after the retry has started.
 */
export class FailedAttemptError extends DomainError {
  /** Stable, machine-readable error code. */
  readonly code = "ATTEMPT_FAILED";

  /** Usage of the failed attempt (the publisher counts a non-finite or negative value as 0). */
  readonly usage: AttemptUsage;

  constructor(message: string, usage: AttemptUsage) {
    super(message);
    this.usage = usage;
  }
}
