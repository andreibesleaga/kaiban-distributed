// SPDX-License-Identifier: Apache-2.0
/**
 * package-version — the version of the installed kaiban-distributed package,
 * read once from its `package.json`, so the agent card and the MCP
 * `Implementation` block never drift from the released version.
 *
 * The file is found by walking up from this module's directory, which works
 * from `src/` (tests), from `dist/src/` (a build) and from
 * `node_modules/kaiban-distributed/dist/src/` (an installed package).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "kaiban-distributed";

/** Returned when no kaiban-distributed `package.json` is found. */
export const UNKNOWN_VERSION = "0.0.0";

function readVersionAt(dir: string): string | undefined {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return undefined;
  const pkg = JSON.parse(readFileSync(file, "utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (pkg.name !== PACKAGE_NAME || typeof pkg.version !== "string") {
    return undefined;
  }
  return pkg.version;
}

/**
 * Find the nearest `package.json` named kaiban-distributed at or above
 * `startDir` and return its `version`; {@link UNKNOWN_VERSION} if none.
 */
export function findPackageVersion(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const version = readVersionAt(dir);
    if (version !== undefined) return version;
    const parent = dirname(dir);
    if (parent === dir) return UNKNOWN_VERSION;
    dir = parent;
  }
}

let cached: string | undefined;

/** The installed package version (looked up once, then cached). */
export function packageVersion(): string {
  cached ??= findPackageVersion(__dirname);
  return cached;
}
