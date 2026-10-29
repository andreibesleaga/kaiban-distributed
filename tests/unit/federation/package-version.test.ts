import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UNKNOWN_VERSION,
  findPackageVersion,
  packageVersion,
} from "../../../src/infrastructure/federation/package-version";

const repoPackage = JSON.parse(
  readFileSync(join(__dirname, "../../../package.json"), "utf8"),
) as { version: string };

describe("package-version", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kd-version-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writePackage(dir: string, body: unknown): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify(body));
  }

  it("packageVersion() returns the version in this repository's package.json", () => {
    expect(packageVersion()).toBe(repoPackage.version);
    expect(packageVersion()).toBe(repoPackage.version); // cached path
  });

  it("walks up past a package.json with another name", () => {
    writePackage(root, { name: "kaiban-distributed", version: "9.8.7" });
    const nested = join(root, "dist", "src");
    writePackage(nested, { name: "something-else", version: "1.0.0" });
    expect(findPackageVersion(nested)).toBe("9.8.7");
  });

  it("skips a kaiban-distributed package.json without a string version", () => {
    writePackage(root, { name: "kaiban-distributed", version: "3.2.1" });
    const nested = join(root, "inner");
    writePackage(nested, { name: "kaiban-distributed", version: 3 });
    expect(findPackageVersion(nested)).toBe("3.2.1");
  });

  it("returns UNKNOWN_VERSION at the filesystem root when nothing matches", () => {
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    writePackage(join(root, "a"), { name: "other", version: "1.0.0" });
    // The temp folder's ancestors hold no kaiban-distributed package.json.
    expect(findPackageVersion(nested)).toBe(UNKNOWN_VERSION);
  });
});
