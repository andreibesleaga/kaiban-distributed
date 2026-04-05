import { describe, it, expect } from "vitest";
import {
  parseHandlerResult,
  parseRecommendation,
  parseScore,
  normaliseEditorialText,
} from "../../../src/shared";

describe("parseHandlerResult", () => {
  it("parses valid JSON handler result with all fields", () => {
    const raw = JSON.stringify({
      answer: "test answer",
      inputTokens: 100,
      outputTokens: 50,
      estimatedCost: 0.001,
    });
    const result = parseHandlerResult(raw);
    expect(result.answer).toBe("test answer");
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
    expect(result.estimatedCost).toBe(0.001);
  });

  it("returns plain text as answer when not JSON", () => {
    const result = parseHandlerResult("plain text result");
    expect(result.answer).toBe("plain text result");
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedCost).toBe(0);
  });

  it("returns full raw string as answer when JSON but without answer field", () => {
    const raw = JSON.stringify({ something: "else" });
    const result = parseHandlerResult(raw);
    expect(result.answer).toBe(raw);
    expect(result.inputTokens).toBe(0);
  });

  it("defaults missing numeric fields to 0", () => {
    const raw = JSON.stringify({ answer: "only answer" });
    const result = parseHandlerResult(raw);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedCost).toBe(0);
  });

  it("coerces non-numeric fields to numbers", () => {
    const raw = JSON.stringify({
      answer: "x",
      inputTokens: "50",
      outputTokens: null,
      estimatedCost: "0.5",
    });
    const result = parseHandlerResult(raw);
    expect(result.inputTokens).toBe(50);
    expect(result.outputTokens).toBe(0);
    expect(result.estimatedCost).toBe(0.5);
  });

  it("coerces Infinity token count to 0 (Number.isFinite guard)", () => {
    // JSON does not support Infinity literals, but scientific notation like 9e999
    // parses to Infinity in JS — this exercises the Number.isFinite(n) ? n : 0 branch.
    const raw = '{"answer":"x","inputTokens":9e999}';
    const result = parseHandlerResult(raw);
    expect(result.inputTokens).toBe(0);
  });

  it("falls back to empty string when answer is null (parsed.answer ?? '' branch)", () => {
    const raw = JSON.stringify({ answer: null, inputTokens: 10 });
    const result = parseHandlerResult(raw);
    expect(result.answer).toBe("");
    expect(result.inputTokens).toBe(10);
  });
});

describe("parseRecommendation", () => {
  it("detects PUBLISH from plain Recommendation label", () => {
    expect(parseRecommendation("Recommendation: PUBLISH")).toBe("PUBLISH");
  });

  it("detects REVISE from bold markdown Recommendation", () => {
    expect(parseRecommendation("**Recommendation:** REVISE")).toBe("REVISE");
  });

  it("detects REJECT from bold with no space", () => {
    expect(parseRecommendation("**Recommendation: REJECT**")).toBe("REJECT");
  });

  it("detects APPROVED", () => {
    expect(parseRecommendation("Recommendation: APPROVED")).toBe("APPROVED");
  });

  it("detects CONDITIONAL", () => {
    expect(parseRecommendation("Recommendation: CONDITIONAL")).toBe(
      "CONDITIONAL",
    );
  });

  it("detects REJECTED from governance reviews", () => {
    expect(parseRecommendation("Recommendation: REJECTED")).toBe("REJECTED");
  });

  it("detects recommendation from JSON key format", () => {
    expect(parseRecommendation('"Recommendation": "PUBLISH"')).toBe("PUBLISH");
  });

  it("returns UNKNOWN when no recommendation token found", () => {
    expect(parseRecommendation("no recommendation here at all")).toBe(
      "UNKNOWN",
    );
  });

  it("is case-insensitive", () => {
    expect(parseRecommendation("recommendation: publish")).toBe("PUBLISH");
  });
});

describe("parseScore", () => {
  it("extracts accuracy score with Accuracy label", () => {
    expect(parseScore("Accuracy Score: 7.5/10", "Accuracy")).toBe("7.5/10");
  });

  it("extracts compliance score with Compliance label", () => {
    expect(parseScore("Compliance Score: 8/10", "Compliance")).toBe("8/10");
  });

  it("uses default label matching Accuracy", () => {
    expect(parseScore("Accuracy Score: 9/10")).toBe("9/10");
  });

  it("uses default label matching Compliance", () => {
    expect(parseScore("Compliance Score: 6/10")).toBe("6/10");
  });

  it("returns N/A when no score found", () => {
    expect(parseScore("no score here")).toBe("N/A");
  });

  it("handles bold markdown formatting around score", () => {
    expect(parseScore("**Accuracy Score:** 8.5/10", "Accuracy")).toBe("8.5/10");
  });

  it("handles integer score (no decimal)", () => {
    expect(parseScore("Accuracy Score: 9/10", "Accuracy")).toBe("9/10");
  });
});

describe("normaliseEditorialText", () => {
  it("returns Markdown unchanged when not starting with {", () => {
    const text = "## Editorial Review\n**Topic:** test";
    expect(normaliseEditorialText(text)).toBe(text);
  });

  it("converts JSON with all fields to Markdown editorial structure", () => {
    const json = JSON.stringify({
      Topic: "AI Ethics",
      "Accuracy Score": "8/10",
      "Editorial Assessment": "Well written",
      "Issues Found": "Minor",
      "Required Changes": "None significant",
      Recommendation: "PUBLISH",
      Rationale: "Meets standards",
    });
    const result = normaliseEditorialText(json);
    expect(result).toContain("## EDITORIAL REVIEW");
    expect(result).toContain("**Topic:** AI Ethics");
    expect(result).toContain("**Accuracy Score:** 8/10");
    expect(result).toContain("### Editorial Assessment\nWell written");
    expect(result).toContain("### Issues Found\nMinor");
    expect(result).toContain("### Required Changes\nNone significant");
    expect(result).toContain("### Recommendation: PUBLISH");
    expect(result).toContain("### Rationale\nMeets standards");
  });

  it("handles JSON with only Recommendation field", () => {
    const json = JSON.stringify({ Recommendation: "REVISE" });
    const result = normaliseEditorialText(json);
    expect(result).toContain("## EDITORIAL REVIEW");
    expect(result).toContain("### Recommendation: REVISE");
  });

  it("handles JSON without Recommendation field (covers Recommendation if-FALSE branch)", () => {
    const json = JSON.stringify({ Topic: "AI", "Accuracy Score": "8/10" });
    const result = normaliseEditorialText(json);
    expect(result).toContain("**Topic:** AI");
    expect(result).not.toContain("Recommendation");
  });

  it("returns trimmed input on invalid JSON starting with {", () => {
    const invalid = "{ bad json }";
    expect(normaliseEditorialText(invalid)).toBe("{ bad json }");
  });

  it("returns empty string unchanged", () => {
    expect(normaliseEditorialText("")).toBe("");
  });

  it("trims leading/trailing whitespace from non-JSON text", () => {
    expect(normaliseEditorialText("  markdown text  ")).toBe("markdown text");
  });
});
