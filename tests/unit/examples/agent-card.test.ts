import { describe, it, expect } from "vitest";
import { parseAgentCardSkills } from "../../../examples/blog-team/agent-card";

describe("parseAgentCardSkills (A2A v0.3 AgentCard, ADR-015)", () => {
  it("joins skill names when skills[] are present", () => {
    const card = {
      skills: [
        { id: "research", name: "Researcher" },
        { id: "write", name: "Writer" },
      ],
    };
    expect(parseAgentCardSkills(card)).toBe("Researcher, Writer");
  });

  it("falls back to id when a skill has no name", () => {
    const card = {
      skills: [{ id: "research" }, { id: "write", name: "Writer" }],
    };
    expect(parseAgentCardSkills(card)).toBe("research, Writer");
  });

  it("returns '' for an empty skills array", () => {
    expect(parseAgentCardSkills({ skills: [] })).toBe("");
  });

  it("returns '' when skills is missing", () => {
    expect(parseAgentCardSkills({})).toBe("");
  });

  it("ignores skill entries with neither name nor id", () => {
    const card = { skills: [{}, { name: "Editor" }] };
    expect(parseAgentCardSkills(card)).toBe("Editor");
  });

  // ── Regression: the live `card.capabilities.join is not a function` crash ──
  // A v0.3 card makes `capabilities` an OBJECT and moves abilities to `skills[]`.
  // Reading skills (and never calling .join on capabilities) must yield '' for a
  // card that only has an object `capabilities` and no skills — never throw.
  it("does NOT throw on a v0.3 card with object capabilities and no skills", () => {
    const v03Card = { capabilities: {} } as unknown as {
      skills?: Array<{ id?: string; name?: string }>;
    };
    expect(() => parseAgentCardSkills(v03Card)).not.toThrow();
    expect(parseAgentCardSkills(v03Card)).toBe("");
  });
});
