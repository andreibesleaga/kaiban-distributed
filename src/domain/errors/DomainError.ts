export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class TaskNotFoundError extends DomainError {
  readonly code = 'TASK_NOT_FOUND';

  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
  }
}

export class AgentNotFoundError extends DomainError {
  readonly code = 'AGENT_NOT_FOUND';

  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
  }
}

export class MessagingError extends DomainError {
  readonly code = 'MESSAGING_ERROR';

  constructor(message: string) {
    super(message);
  }
}
