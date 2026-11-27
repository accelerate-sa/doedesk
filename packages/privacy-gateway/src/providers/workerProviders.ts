/**
 * The worker model an organisation chose: DoeDesk Cloud's, any server that speaks OpenAI's Chat
 * Completions or Responses format, or none. The result is what `callWorker` already takes, so
 * the sealed worker runs the same whichever is chosen and whether or not anyone is signed in.
 */

import { probeWorker, type WorkerEndpoint } from "../worker/client.ts";
import { checkHealth, hostOf, requireUrl } from "./http.ts";
import { DOEDESK_CLOUD_URL } from "./ocrProviders.ts";
import { openAiCredentials, withApiVersion } from "./openAi.ts";
import {
  ProviderError,
  type ProviderProblemKind,
  type ProviderRuntime,
  type WorkerHealthResult,
  type WorkerProvider,
  type WorkerProviderConfig,
} from "./types.ts";

/** DoeDesk Cloud sends the call on to the model of the account's region, which it alone knows. */
const HOSTED_WORKER_MODEL = "doedesk-worker";

/** `probeWorker` gives its reason as a sentence. This reads the kind of problem back out of it. */
const problemOf = (message: string): { kind: ProviderProblemKind; status?: number } => {
  const status = Number(/^The worker answered (\d{3})/.exec(message)?.[1]);
  if (Number.isFinite(status)) {
    const kind =
      status === 401 || status === 403
        ? "auth"
        : status === 429
          ? "busy"
          : status >= 500
            ? "failing"
            : "refused";
    return { kind, status };
  }
  if (message.includes("could not be reached")) return { kind: "unreachable" };
  if (message.includes("ran out of time")) return { kind: "timeout" };
  return { kind: "unreadable" };
};

const provider = (
  id: WorkerProvider["id"],
  address: string,
  build: () => WorkerEndpoint,
  fetchImpl: typeof fetch,
): WorkerProvider => {
  let endpoint: WorkerEndpoint | undefined;
  try {
    endpoint = build();
  } catch {
    // A choice that cannot be called has no endpoint, and its test says why.
    endpoint = undefined;
  }
  return {
    id,
    endpoint,
    fetch: fetchImpl,
    testConnection: async (): Promise<WorkerHealthResult> => {
      let found: Pick<WorkerHealthResult, "structured" | "reasoningEffort"> = {};
      const health = await checkHealth(async () => {
        const { structured: _structured, ...unprobed } = build();
        const probe = await probeWorker(unprobed, fetchImpl);
        if (!probe.ok) {
          const message = probe.message ?? "The worker did not answer.";
          throw new ProviderError(message, { ...problemOf(message), host: hostOf(address) });
        }
        found = {
          structured: probe.structured,
          ...(probe.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: probe.reasoningEffort }),
        };
        return `The worker at ${hostOf(address) ?? address} answered a test question.`;
      }, hostOf(address));
      return { ...health, ...found };
    },
  };
};

/** The worker for an organisation's choice. Nothing is sent until it is called or tested. */
export const makeWorkerProvider = (
  config: WorkerProviderConfig,
  runtime: ProviderRuntime = {},
): WorkerProvider => {
  const fetchImpl = runtime.fetch ?? fetch;
  switch (config.provider) {
    case "off":
      return {
        id: "off",
        endpoint: undefined,
        fetch: fetchImpl,
        testConnection: () =>
          checkHealth(() => Promise.resolve("The worker is off. Nothing is sent."), undefined),
      };
    case "doedeskCloud": {
      const { settings, secrets } = config;
      const cloud = settings.endpoint ?? DOEDESK_CLOUD_URL;
      return provider(
        "doedeskCloud",
        cloud,
        () => ({
          baseUrl: `${requireUrl("DoeDesk Cloud", cloud)}/v1/worker`,
          apiKey: secrets.token,
          model: HOSTED_WORKER_MODEL,
          driver: "chatCompletions",
          structured: settings.structured ?? "jsonSchema",
          // DoeDesk Cloud queues calls for everyone in the region and says how many it takes at once.
          ...(typeof settings.parallel === "number"
            ? {
                queue: {
                  parallel: settings.parallel,
                  maxWaitMs: (settings.maxWaitSeconds ?? 0) * 1000,
                },
              }
            : {}),
        }),
        fetchImpl,
      );
    }
    case "openaiCompatible": {
      const { settings, secrets } = config;
      return provider(
        "openaiCompatible",
        settings.baseUrl,
        () => {
          const model = settings.model.trim();
          if (model === "") {
            throw new ProviderError("Enter the worker model's name.", { kind: "misconfigured" });
          }
          return {
            baseUrl: requireUrl("The worker", settings.baseUrl),
            model,
            driver: settings.driver ?? "chatCompletions",
            structured: settings.structured ?? "jsonSchema",
            ...(settings.reasoningEffort?.trim()
              ? { reasoningEffort: settings.reasoningEffort.trim() }
              : {}),
            ...openAiCredentials(settings.authScheme, secrets),
          };
        },
        withApiVersion(fetchImpl, settings.apiVersion),
      );
    }
  }
};
