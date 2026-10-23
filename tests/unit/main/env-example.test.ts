/**
 * The documented .env.example values must parse with the real loaders: the
 * file is what operators copy, so a value the loader rejects is a bug.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { loadConfig } from "../../../src/main/config";

const example = parse(
  readFileSync(resolve(__dirname, "../../../.env.example"), "utf8"),
);

describe(".env.example through the real loader", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, ...example };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("documents RETRY_ON_TIMEOUT as off and AGENT_TIMEOUT_MS as the 5-minute default", () => {
    expect(example["RETRY_ON_TIMEOUT"]).toBe("false");
    const config = loadConfig();
    expect(config.retryOnTimeout).toBe(false);
    expect(config.agentTimeoutMs).toBe(300000);
  });
});
