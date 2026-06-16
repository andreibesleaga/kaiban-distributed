import { describe, it, expect, afterEach } from "vitest";
import fc from "fast-check";
import {
  wrapSigned,
  unwrapVerified,
} from "../../../src/infrastructure/security/channel-signing";

const KEY = "test-signing-secret-key-0123456789";

afterEach(() => {
  delete process.env["CHANNEL_SIGNING_SECRET"];
});

describe("channel-signing (property-based)", () => {
  it("round-trips any JSON payload when signing is enabled", () => {
    process.env["CHANNEL_SIGNING_SECRET"] = KEY;
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string().filter((k) => k !== "__proto__"),
          fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        ),
        (payload) => {
          const out = unwrapVerified(wrapSigned(payload));
          expect(out).toEqual(payload);
        },
      ),
    );
  });

  it("rejects an envelope verified with a different secret (forge/tamper)", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.string()),
        fc.string({ minLength: 1 }),
        (payload, otherSecret) => {
          fc.pre(otherSecret !== KEY);
          process.env["CHANNEL_SIGNING_SECRET"] = KEY;
          const envelope = wrapSigned(payload);
          process.env["CHANNEL_SIGNING_SECRET"] = otherSecret;
          expect(unwrapVerified(envelope)).toBeNull();
        },
      ),
    );
  });
});
