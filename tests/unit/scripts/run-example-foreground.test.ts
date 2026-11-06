import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const script = readFileSync(join(__dirname, "../../../scripts/run-example.sh"), "utf8");

describe("scripts/run-example.sh orchestrator launch (WF-02)", () => {
  it("runs the orchestrator in the foreground so it keeps the terminal's stdin", () => {
    const launch = script
      .split("\n")
      .filter((l) => l.includes('ts-node "$EXAMPLE_PATH/orchestrator.ts"'));
    expect(launch).toHaveLength(1);
    // A trailing `&` would give the job /dev/null as stdin in a non-interactive shell.
    expect(launch[0]!.trim().endsWith("&")).toBe(false);
  });
});
