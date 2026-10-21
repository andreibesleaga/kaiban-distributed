/**
 * Every example worker entry point gets the token caps.
 *
 * A worker either calls `startAgentNode` or builds its publisher with
 * `createAgentStatePublisher` — both resolve MAX_TOKEN_BUDGET and
 * MAX_TASK_TOKEN_BUDGET. A bare `new AgentStatePublisher(` in an entry point
 * would run that worker with no caps at all (the searcher used to). Every
 * worker service in the compose files must also forward both variables, or a
 * value set in `.env` never reaches the worker.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { parse } from "yaml";

const ROOT = join(__dirname, "../../..");
const EXAMPLES = join(ROOT, "examples");

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

/** README.md plus every Markdown file under docs/ (recursive), repo-relative. */
function userDocs(): string[] {
  const docs = readdirSync(join(ROOT, "docs"), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".md"))
    .map((f) => join("docs", f));
  return ["README.md", ...docs].sort();
}

describe("worker samples in the user docs", () => {
  it("are scanned (guards the scan itself)", () => {
    expect(userDocs()).toContain(join("docs", "KAIBANJS_INTEGRATION.md"));
  });

  it.each(userDocs())("%s builds no uncapped AgentStatePublisher", (file) => {
    const source = readFileSync(join(ROOT, file), "utf8");
    expect(source).not.toMatch(/new\s+AgentStatePublisher\s*\(/);
  });
});

/** Root and example compose files, repo-relative. */
function composeFiles(): string[] {
  const isCompose = (f: string): boolean => /^docker-compose.*\.ya?ml$/.test(f);
  const root = readdirSync(ROOT).filter(isCompose);
  const examples = readdirSync(EXAMPLES, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) =>
      readdirSync(join(EXAMPLES, d.name))
        .filter(isCompose)
        .map((f) => join("examples", d.name, f)),
    );
  return [...root, ...examples].sort();
}

interface ComposeService {
  command?: string | string[];
  environment?: Record<string, unknown> | string[];
  build?: { args?: Record<string, unknown> | string[] };
}

/** Compose `environment` / `build.args` as a map (both the map and the list form). */
function asMap(value: Record<string, unknown> | string[] | undefined): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((entry) => {
        const eq = entry.indexOf("=");
        return eq === -1 ? [entry, ""] : [entry.slice(0, eq), entry.slice(eq + 1)];
      }),
    );
  }
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([k, v]) => [k, v === null ? "" : String(v)]),
  );
}

/** A worker runs an example `*-node.js` entry point or the image with ROLE=worker. */
function isWorker(service: ComposeService): boolean {
  const command = [service.command ?? []].flat().join(" ");
  return (
    /-node\.js\b/.test(command) ||
    asMap(service.environment)["ROLE"] === "worker" ||
    asMap(service.build?.args)["ROLE"] === "worker"
  );
}

function workerServices(): Array<[string, string, Record<string, string>]> {
  return composeFiles().flatMap((file) => {
    const doc = parse(readFileSync(join(ROOT, file), "utf8")) as {
      services?: Record<string, ComposeService>;
    };
    return Object.entries(doc.services ?? {})
      .filter(([, service]) => isWorker(service))
      .map(([name, service]): [string, string, Record<string, string>] => [
        file,
        name,
        asMap(service.environment),
      ]);
  });
}

describe("worker services in the compose files", () => {
  it("are found (guards the scan itself)", () => {
    expect(composeFiles()).toEqual(
      [
        "docker-compose.yml",
        join("examples", "blog-team", "docker-compose.kafka.yml"),
        join("examples", "blog-team", "docker-compose.yml"),
        join("examples", "global-research", "docker-compose.kafka.yml"),
        join("examples", "global-research", "docker-compose.yml"),
      ].sort(),
    );
    const names = workerServices().map(([file, name]) => `${file}#${name}`);
    expect(names).toContain("docker-compose.yml#kaiban-worker");
    expect(names).toContain(`${join("examples", "global-research", "docker-compose.yml")}#searcher`);
    expect(names).not.toContain("docker-compose.yml#kaiban-gateway");
    expect(names.length).toBeGreaterThanOrEqual(15);
  });

  it.each(workerServices())("%s service %s forwards MAX_TOKEN_BUDGET and MAX_TASK_TOKEN_BUDGET", (_file, _name, env) => {
    expect(env["MAX_TOKEN_BUDGET"]).toMatch(/^\$\{MAX_TOKEN_BUDGET(:-[^}]*)?\}$/);
    expect(env["MAX_TASK_TOKEN_BUDGET"]).toMatch(/^\$\{MAX_TASK_TOKEN_BUDGET(:-[^}]*)?\}$/);
  });
});
