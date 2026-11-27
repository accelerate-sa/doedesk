/**
 * Sign-in for Google Cloud's APIs: a service account key, an API key, or a token as given.
 * https://developers.google.com/identity/protocols/oauth2/service-account#httprest
 */

import * as NodeCrypto from "node:crypto";

import { asRecord, readJson, send } from "./http.ts";
import { type GoogleSecrets, ProviderError, type ProviderRuntime } from "./types.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_LIFETIME_SECONDS = 3600;
/** A token this close to its end is replaced before it is sent. */
const RENEW_BEFORE_MS = 60_000;

const base64Url = (data: string | Uint8Array): string => Buffer.from(data).toString("base64url");

const misconfigured = (service: string, what: string): ProviderError =>
  new ProviderError(`${service} ${what} Check it in Settings, under Privacy.`, {
    kind: "misconfigured",
  });

/** The request headers that sign a call in. Asks Google for a token only when one is needed. */
export const makeGoogleAuth = (
  service: string,
  secrets: GoogleSecrets,
  runtime: ProviderRuntime,
): (() => Promise<Record<string, string>>) => {
  let cached: { readonly token: string; readonly expiresAt: number } | undefined;

  const exchange = async (keyFile: string): Promise<string> => {
    const now = (runtime.now ?? (() => new Date()))().getTime();
    if (cached !== undefined && cached.expiresAt - RENEW_BEFORE_MS > now) return cached.token;
    let key: Record<string, unknown> | undefined;
    try {
      key = asRecord(JSON.parse(keyFile));
    } catch {
      key = undefined;
    }
    const email = key?.client_email;
    const privateKey = key?.private_key;
    if (typeof email !== "string" || typeof privateKey !== "string") {
      throw misconfigured(
        service,
        "was given a service account key that is not Google's JSON file.",
      );
    }
    const issuedAt = Math.floor(now / 1000);
    const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
      JSON.stringify({
        iss: email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + TOKEN_LIFETIME_SECONDS,
      }),
    )}`;
    let signature: Buffer;
    try {
      signature = NodeCrypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey);
    } catch (cause) {
      throw new ProviderError(
        `${service} was given a service account key whose private key cannot be used. Check it in Settings, under Privacy.`,
        { kind: "misconfigured", cause },
      );
    }
    const response = await send({
      service: "Google sign-in",
      runtime,
      // A key Google does not know is answered with 400 `invalid_grant`.
      classify: (status) => (status === 400 ? "auth" : undefined),
      request: () => ({
        url: TOKEN_URL,
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: `${unsigned}.${base64Url(signature)}`,
        }).toString(),
      }),
    });
    const body = await readJson(response, "Google sign-in", TOKEN_URL);
    if (typeof body.access_token !== "string") {
      throw new ProviderError("Google sign-in answered without a token.", {
        kind: "unreadable",
        host: new URL(TOKEN_URL).host,
      });
    }
    const lifetime = typeof body.expires_in === "number" ? body.expires_in : TOKEN_LIFETIME_SECONDS;
    cached = { token: body.access_token, expiresAt: now + lifetime * 1000 };
    return cached.token;
  };

  return async () => {
    if (secrets.serviceAccountKey?.trim()) {
      return { authorization: `Bearer ${await exchange(secrets.serviceAccountKey)}` };
    }
    if (secrets.accessToken?.trim())
      return { authorization: `Bearer ${secrets.accessToken.trim()}` };
    if (secrets.apiKey?.trim()) return { "x-goog-api-key": secrets.apiKey.trim() };
    throw misconfigured(service, "needs a service account key, an API key or an access token.");
  };
};
