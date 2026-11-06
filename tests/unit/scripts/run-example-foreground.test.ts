import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const script = readFileSync(join(__dirname, "../../../scripts/run-example.sh"), "utf8");

describe("scripts/run-example.sh orchestrator launch (WF-02)", () => {
  it("gives the orchestrator the terminal's stdin while the shell waits for it", () => {
    const launch = script
      .split("\n")
      .filter((l) => l.includes('ts-node "$EXAMPLE_PATH/orchestrator.ts"'));
    expect(launch).toHaveLength(1);
    // A bare `&` would give the job /dev/null as stdin in a non-interactive shell;
    // the explicit redirection keeps the terminal, and `wait` lets a signal reach
    // the trap at once instead of after the orchestrator ends on its own.
    expect(launch[0]).toContain("<&0 &");
    expect(script).toContain('wait "$ORCH_PID"');
    expect(script).toContain("trap forward_signal INT TERM");
  });

  it("an explicitly redirected background child really reads the shell's stdin", () => {
    // The pattern the script relies on, run in bash with piped stdin. (`<&0`
    // duplicates the descriptor, so it also works when stdin is a socket, where
    // opening /dev/stdin fails.)
    const dir = mkdtempSync(join(tmpdir(), "run-example-"));
    const sh = join(dir, "t.sh");
    writeFileSync(sh, 'cat <&0 &\nP=$!\nwait "$P"\n');
    const r = spawnSync("bash", [sh], { input: "from-terminal\n", encoding: "utf8" });
    expect(r.stdout).toBe("from-terminal\n");
  });
});
