import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { type AccountTokenSettings, verifyAccountToken } from "./AccountTokens.ts";

const ISSUER = "https://api.doedesk.test";
const AUDIENCE = "doedesk-relay";
const NOW = 1_800_000_000_000;

const base64Url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const segment = (value: unknown): string =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

const makeIssuer = Effect.promise(async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "key-1" };
  const sign = async (claims: Record<string, unknown>, header: Record<string, unknown> = {}) => {
    const unsigned = `${segment({ alg: "ES256", typ: "JWT", kid: "key-1", ...header })}.${segment(claims)}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(unsigned),
    );
    return `${unsigned}.${base64Url(signature)}`;
  };
  const settings: AccountTokenSettings = { issuer: ISSUER, audience: AUDIENCE, keys: [publicJwk] };
  return { settings, sign };
});

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: AUDIENCE,
  sub: "user-1",
  iat: NOW / 1000,
  nbf: NOW / 1000 - 5,
  exp: NOW / 1000 + 300,
  ...overrides,
});

const reasonOf = (settings: AccountTokenSettings, token: string, now = NOW) =>
  verifyAccountToken(settings, token, now).pipe(
    Effect.as("accepted"),
    Effect.catch((error) => Effect.succeed(error.reason)),
  );

describe("verifyAccountToken", () => {
  it.effect("accepts a token the issuer signed for this relay", () =>
    Effect.gen(function* () {
      const { settings, sign } = yield* makeIssuer;
      const token = yield* Effect.promise(() => sign(claims()));
      assert.deepEqual(yield* verifyAccountToken(settings, token, NOW), { sub: "user-1" });
    }),
  );

  it.effect("refuses a token for another audience, issuer or time", () =>
    Effect.gen(function* () {
      const { settings, sign } = yield* makeIssuer;
      const signed = (overrides: Record<string, unknown>) =>
        Effect.promise(() => sign(claims(overrides)));
      assert.equal(yield* reasonOf(settings, yield* signed({ aud: "other" })), "audience_mismatch");
      assert.equal(
        yield* reasonOf(settings, yield* signed({ iss: "https://evil.test" })),
        "issuer_mismatch",
      );
      assert.equal(yield* reasonOf(settings, yield* signed({ exp: NOW / 1000 - 120 })), "expired");
      assert.equal(
        yield* reasonOf(settings, yield* signed({ nbf: NOW / 1000 + 120 })),
        "not_yet_valid",
      );
      assert.equal(yield* reasonOf(settings, yield* signed({ sub: "" })), "missing_subject");
    }),
  );

  it.effect("refuses a changed payload, another key and other algorithms", () =>
    Effect.gen(function* () {
      const { settings, sign } = yield* makeIssuer;
      const other = yield* makeIssuer;
      const token = yield* Effect.promise(() => sign(claims()));
      const [header, , signature] = token.split(".");
      const forged = `${header}.${segment(claims({ sub: "admin" }))}.${signature}`;
      assert.equal(yield* reasonOf(settings, forged), "bad_signature");
      const foreign = yield* Effect.promise(() => other.sign(claims()));
      assert.equal(yield* reasonOf(settings, foreign), "bad_signature");
      const unsignedToken = `${segment({ alg: "none", kid: "key-1" })}.${segment(claims())}.`;
      assert.equal(yield* reasonOf(settings, unsignedToken), "unsupported_algorithm");
      const unknownKey = yield* Effect.promise(() => sign(claims(), { kid: "key-9" }));
      assert.equal(yield* reasonOf(settings, unknownKey), "unknown_key");
      assert.equal(yield* reasonOf(settings, "not-a-token"), "malformed");
    }),
  );
});
