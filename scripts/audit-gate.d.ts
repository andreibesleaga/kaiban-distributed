export interface GateResult {
  blocking: string[];
  waived: string[];
  expired: string[];
}
export function parseIgnores(text: string, today: string): { active: Set<string>; expired: string[] };
export function evaluate(audit: unknown, ignoreText: string, today: string): GateResult;
