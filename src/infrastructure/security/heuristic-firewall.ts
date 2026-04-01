import type {
  EvaluationPayload,
  ISemanticFirewall,
  FirewallVerdict,
} from "../../domain/security/semantic-firewall";

/**
 * Known prompt-injection patterns that attempt ASI01 goal hijacking.
 * These are evaluated against the `instruction` and `context` fields in the payload.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?(your\s+)?(?:previous\s+)?instructions/i,
  /forget\s+(everything|all|your\s+instructions)/i,
  /you\s+are\s+now\s+(?:a|an)\s+(?:different|new)\s+(?:ai|agent|assistant)/i,
  /your\s+new\s+(?:role|goal|objective|mission)\s+is/i,
  /override\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions|rules)/i,
  /\[system\]\s*:/i,
  /\[\[system\s*prompt\]\]/i,
  /act\s+as\s+(?:if|though)\s+you\s+(?:have\s+)?no\s+(?:rules|restrictions)/i,
  /do\s+not\s+follow\s+(?:your\s+)?(?:original|previous|system)\s+(?:instructions|prompt)/i,
];

/**
 * Heuristic-based Semantic Firewall implementation.
 * Scans inbound task payloads for known prompt injection patterns.
 * Stateless and lightweight — no external dependencies.
 */
export class HeuristicFirewall implements ISemanticFirewall {
  async evaluate(payload: EvaluationPayload): Promise<FirewallVerdict> {
    const instruction = String(payload.data["instruction"] ?? "");
    const context = String(payload.data["context"] ?? "");
    const combined = `${instruction}\n${context}`;

    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(combined)) {
        return {
          allowed: false,
          reason: `Blocked by semantic firewall: matched injection pattern "${pattern.source}"`,
        };
      }
    }

    return { allowed: true };
  }
}
