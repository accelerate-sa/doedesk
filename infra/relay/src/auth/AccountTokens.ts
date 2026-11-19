// @effect-diagnostics globalFetch:off - the JWKS fetch feeds a per-isolate cache shared by every request, outside any one request's services.
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/**
 * Verifies the short-lived tokens DoeDesk Cloud signs for a signed-in account.
 * They are ES256 JWTs; the public keys are published at the issuer's JWKS address.
 */
export interface AccountTokenSettings {
  /** The `iss` a token must carry, such as `https://api.doedesk.com`. */
  readonly issuer: string;
  /** The `aud` a token must carry for this relay. */
  readonly audience: string;
  /** Public keys to use instead of fetching the issuer's JWKS. Set in tests. */
  readonly keys?: ReadonlyArray<JsonWebKey & { readonly kid?: string }>;
}

export class AccountTokenInvalid extends Schema.TaggedError<AccountTokenInvalid>()(
  "AccountTokenInvalid",
  {
    reason: Schema.Literals([
      "malformed",
      "unsupported_algorithm",
      "unknown_key",
      "bad_signature",
      "issuer_mismatch",
      "audience_mismatch",
      "expired",
      "not_yet_valid",
      "missing_subject",
      "keys_unavailable",
    ]),
  },
) {
  override get message(): string {
    return `Account token rejected: ${this.reason}`;
  }
}

export interface VerifiedAccountToken {
  readonly sub: string;
}

const JWKS_TTL_MS = 10 * 60_000;
/** Allowed disagreement between this clock and the issuer's. */
const CLOCK_SKEW_SECONDS = 30;

interface CachedKeys {
  readonly fetchedAt: number;
  readonly keys: ReadonlyArray<JsonWebKey & { readonly kid?: string }>;
}
// Per isolate. A key the cache does not know triggers one refetch, so a rotated key works at once.
const jwksCache = new Map<string, CachedKeys>();

const decodeSegment = (segment: string): Uint8Array<ArrayBuffer> => {
  const padded = segment
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const parseJson = (bytes: Uint8Array): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const fetchKeys = async (issuer: string): Promise<CachedKeys["keys"]> => {
  const response = await fetch(`${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`JWKS answered ${response.status}`);
  const body = (await response.json()) as { readonly keys?: unknown };
  if (!Array.isArray(body.keys)) throw new Error("JWKS has no keys");
  return body.keys as CachedKeys["keys"];
};

const keysFor = async (
  settings: AccountTokenSettings,
  kid: string | undefined,
  now: number,
): Promise<CachedKeys["keys"]> => {
  if (settings.keys !== undefined) return settings.keys;
  const cached = jwksCache.get(settings.issuer);
  const knowsKey = cached?.keys.some((key) => kid === undefined || key.kid === kid) ?? false;
  if (cached !== undefined && knowsKey && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const keys = await fetchKeys(settings.issuer);
  jwksCache.set(settings.issuer, { fetchedAt: now, keys });
  return keys;
};

const hasAudience = (audience: unknown, expected: string): boolean =>
  typeof audience === "string"
    ? audience === expected
    : Array.isArray(audience) && audience.some((entry) => entry === expected);

export const verifyAccountToken = Effect.fn("AccountTokens.verify")(function* (
  settings: AccountTokenSettings,
  token: string,
  nowMillis: number,
): Effect.fn.Return<VerifiedAccountToken, AccountTokenInvalid> {
  const segments = token.split(".");
  if (segments.length !== 3) return yield* new AccountTokenInvalid({ reason: "malformed" });
  const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
  const decoded = yield* Effect.try({
    try: () => ({
      header: parseJson(decodeSegment(headerSegment)),
      payload: parseJson(decodeSegment(payloadSegment)),
      signature: decodeSegment(signatureSegment),
    }),
    catch: () => new AccountTokenInvalid({ reason: "malformed" }),
  });
  const { header, payload, signature } = decoded;
  if (header === null || payload === null) {
    return yield* new AccountTokenInvalid({ reason: "malformed" });
  }
  // Only the one algorithm the issuer uses. Accepting what the token names would let it choose.
  if (header.alg !== "ES256")
    return yield* new AccountTokenInvalid({ reason: "unsupported_algorithm" });
  const kid = typeof header.kid === "string" ? header.kid : undefined;

  const keys = yield* Effect.tryPromise({
    try: () => keysFor(settings, kid, nowMillis),
    catch: () => new AccountTokenInvalid({ reason: "keys_unavailable" }),
  });
  const jwk = keys.find((key) => (kid === undefined ? true : key.kid === kid));
  if (jwk === undefined) return yield* new AccountTokenInvalid({ reason: "unknown_key" });

  const valid = yield* Effect.tryPromise({
    try: async () => {
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", x: jwk.x ?? "", y: jwk.y ?? "" },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      return crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        signature,
        new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
      );
    },
    catch: () => new AccountTokenInvalid({ reason: "bad_signature" }),
  });
  if (!valid) return yield* new AccountTokenInvalid({ reason: "bad_signature" });

  const nowSeconds = Math.floor(nowMillis / 1000);
  if (payload.iss !== settings.issuer)
    return yield* new AccountTokenInvalid({ reason: "issuer_mismatch" });
  if (!hasAudience(payload.aud, settings.audience)) {
    return yield* new AccountTokenInvalid({ reason: "audience_mismatch" });
  }
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_SECONDS < nowSeconds) {
    return yield* new AccountTokenInvalid({ reason: "expired" });
  }
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_SECONDS > nowSeconds) {
    return yield* new AccountTokenInvalid({ reason: "not_yet_valid" });
  }
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    return yield* new AccountTokenInvalid({ reason: "missing_subject" });
  }
  return { sub: payload.sub };
});
