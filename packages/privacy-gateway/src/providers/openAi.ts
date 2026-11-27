/**
 * What the worker and the model-based detector share: how an OpenAI-compatible server is given
 * its key, and how Azure OpenAI is given the `api-version` that an endpoint's address cannot carry.
 */

import type { WorkerEndpoint } from "../worker/client.ts";
import type { OpenAiAuthScheme } from "./types.ts";

export const openAiCredentials = (
  authScheme: OpenAiAuthScheme | undefined,
  secrets: {
    readonly apiKey?: string | undefined;
    readonly headers?: Readonly<Record<string, string>> | undefined;
  },
): Pick<WorkerEndpoint, "apiKey" | "headers"> => {
  const apiKey = secrets.apiKey?.trim() || undefined;
  if (authScheme === "apiKey" && apiKey !== undefined) {
    return { headers: { ...secrets.headers, "api-key": apiKey } };
  }
  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(secrets.headers === undefined ? {} : { headers: secrets.headers }),
  };
};

export const withApiVersion = (
  inner: typeof fetch,
  apiVersion: string | undefined,
): typeof fetch => {
  const version = apiVersion?.trim();
  if (!version) return inner;
  return (input, init) => {
    if (typeof input !== "string" && !(input instanceof URL)) return inner(input, init);
    const url = new URL(input);
    url.searchParams.set("api-version", version);
    return inner(url.toString(), init);
  };
};
