/**
 * Every example worker entry point gets the token caps.
 *
 * A worker either calls `startAgentNode` or builds its publisher with
 * `createAgentStatePublisher` — both resolve MAX_TOKEN_BUDGET and
 * MAX_TASK_TOKEN_BUDGET. A bare `new AgentStatePublisher(` in an entry point
 * would run that worker with no caps at all (the searcher used to).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const EXAMPLES = join(__dirname, "../../../examples");

function workerEntryPoints(): string[] {
  return readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(join(EXAMPLES, d.name))
        .filter((f) => f.endsWith("-node.ts"))
        .map((f) => join(d.name, f)),
    )
    .sort();
}

describe("example worker entry points", () => {
  it("are found (guards the scan itself)", () => {
    expect(workerEntryPoints()).toContain(join("global-research", "searcher-node.ts"));
    expect(workerEntryPoints().length).toBeGreaterThanOrEqual(7);
  });

  it.each(workerEntryPoints())("%s builds its state publisher with the resolved caps", (file) => {
    const source = readFileSync(join(EXAMPLES, file), "utf8");
    expect(source).not.toMatch(/new\s+AgentStatePublisher\s*\(/);
    expect(source).toMatch(/\b(startAgentNode|createAgentStatePublisher)\s*\(/);
  });
});
