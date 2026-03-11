import type { MessagePayload } from '../../infrastructure/messaging/interfaces';

export interface FirewallVerdict {
  allowed: boolean;
  reason?: string;
}

export interface ISemanticFirewall {
  evaluate(payload: MessagePayload): Promise<FirewallVerdict>;
}
