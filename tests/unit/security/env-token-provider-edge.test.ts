import { describe, it, expect } from "vitest";
import { EnvTokenProvider } from "../../../src/infrastructure/security/env-token-provider";

describe("EnvTokenProvider — edge cases", () => {
  const provider = new EnvTokenProvider();

  it("returns empty string when env var is set to empty string", async () => {
    process.env["EMPTY_VAR"] = "";
    const token = await provider.getToken("EMPTY_VAR", "task-x");
    // Empty string is falsy but still a defined value — should return it
    expect(token).toBe("");
    delete process.env["EMPTY_VAR"];
  });

  it("returns value with special characters intact", async () => {
    process.env["SPECIAL_KEY"] = "sk-or-v1-abc/def+ghi==";
    const token = await provider.getToken("SPECIAL_KEY", "task-y");
    expect(token).toBe("sk-or-v1-abc/def+ghi==");
    delete process.env["SPECIAL_KEY"];
  });
});
