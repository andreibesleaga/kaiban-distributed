/** Minimal payload shape needed for firewall evaluation — no infrastructure import needed. */
export interface EvaluationPayload {
  taskId: string;
  agentId: string;
  data: Record<string, unknown>;
}

export interface FirewallVerdict {
  allowed: boolean;
  reason?: string;
}

export interface ISemanticFirewall {
  evaluate(payload: EvaluationPayload): Promise<FirewallVerdict>;
}
