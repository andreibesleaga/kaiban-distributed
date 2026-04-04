/**
 * Result parsing utilities — shared across all examples.
 *
 * Helpers to extract structured data from raw agent handler results (JSON strings)
 * returned via the messaging layer.  All functions degrade gracefully when input
 * is not JSON or has missing fields.
 */

/** Structured result shape returned by KaibanJS task handlers. */
export interface HandlerResult {
  answer: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

/**
 * Parses the raw string result from a completed agent task.
 *
 * Handles two formats:
 *  1. JSON string matching KaibanHandlerResult shape → extracts fields
 *  2. Any other string → treats as plain-text answer, tokens/cost = 0
 */
export function parseHandlerResult(raw: string): HandlerResult {
  try {
    const parsed = JSON.parse(raw) as {
      answer?: string;
      inputTokens?: number;
      outputTokens?: number;
      estimatedCost?: number;
    };
    if (typeof parsed === "object" && parsed !== null && "answer" in parsed) {
      const toSafeNumber = (x: number | undefined): number => {
        const n = Number(x ?? 0);
        return Number.isFinite(n) ? n : 0;
      };
      return {
        answer: String(parsed.answer ?? ""),
        inputTokens: toSafeNumber(parsed.inputTokens),
        outputTokens: toSafeNumber(parsed.outputTokens),
        estimatedCost: toSafeNumber(parsed.estimatedCost),
      };
    }
  } catch {
    /* not JSON — treat as plain text */
  }
  return { answer: raw, inputTokens: 0, outputTokens: 0, estimatedCost: 0 };
}

/**
 * Extracts PUBLISH / REVISE / REJECT / APPROVED / CONDITIONAL / REJECTED
 * from an editorial or governance review text.
 *
 * Handles plain, bold markdown (**Recommendation:**), and JSON key formats.
 * Returns 'UNKNOWN' when no recommendation token is found.
 */
export function parseRecommendation(review: string): string {
  const TOKENS = "APPROVED|CONDITIONAL|REJECTED|PUBLISH|REVISE|REJECT";
  const mdMatch = new RegExp(
    `\\*{0,2}Recommendation:?\\*{0,2}[*\\s"]*\\**\\s*(${TOKENS})`,
    "i",
  ).exec(review);
  if (mdMatch) return mdMatch[1].toUpperCase();
  const jsonMatch = new RegExp(
    `"[Rr]ecommendation"\\s*:\\s*"(${TOKENS})"`,
    "i",
  ).exec(review);
  if (jsonMatch) return jsonMatch[1].toUpperCase();
  return "UNKNOWN";
}

/**
 * Extracts a score string like "7.5/10" from review text.
 *
 * @param review   The review text to scan.
 * @param label    Score label prefix to match (default matches both 'Accuracy' and 'Compliance').
 */
export function parseScore(
  review: string,
  label = "(?:Compliance|Accuracy)",
): string {
  const match = new RegExp(
    `${label}\\s+Score[*\\s"]*:[*\\s"]*([0-9]+(?:\\.[0-9]+)?\\/10)`,
    "i",
  ).exec(review);
  return match ? match[1] : "N/A";
}

/**
 * Normalises editorial text that may arrive as JSON (from some LLM output formats)
 * into Markdown format for consistent display and parsing.
 *
 * Returns the trimmed input if it is already Markdown (does not start with `{`).
 * Input is always trimmed before processing or returning.
 */
export function normaliseEditorialText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const lines = ["## EDITORIAL REVIEW"];
    if (obj["Topic"]) lines.push(`**Topic:** ${obj["Topic"]}`);
    if (obj["Accuracy Score"])
      lines.push(`**Accuracy Score:** ${obj["Accuracy Score"]}`);
    if (obj["Editorial Assessment"])
      lines.push(`### Editorial Assessment\n${obj["Editorial Assessment"]}`);
    if (obj["Issues Found"])
      lines.push(`### Issues Found\n${String(obj["Issues Found"])}`);
    if (obj["Required Changes"])
      lines.push(`### Required Changes\n${String(obj["Required Changes"])}`);
    if (obj["Recommendation"])
      lines.push(`### Recommendation: ${obj["Recommendation"]}`);
    if (obj["Rationale"]) lines.push(`### Rationale\n${obj["Rationale"]}`);
    return lines.join("\n");
  } catch {
    return trimmed;
  }
}
