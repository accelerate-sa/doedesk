import { describe, expect, it } from "vite-plus/test";

import { callWorker } from "../worker/client.ts";
import { json, recorded } from "./testkit.ts";
import type { WorkerProvider, WorkerProviderConfig } from "./types.ts";
import { makeWorkerProvider } from "./workerProviders.ts";

const chat = (content: string) =>
  json({
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });

/** One call through the provider, the way the sealed worker makes it. */
const ask = (provider: WorkerProvider) => {
  if (provider.endpoint === undefined) throw new Error("The worker is off.");
  return callWorker(
    provider.endpoint,
    {
      system: "Answer with JSON.",
      user: "What is the date?",
      schema: { type: "object" },
      maxOutputTokens: 100,
    },
    provider.fetch,
  );
};

const probeAnswer = chat(
  '{"word":{"quote":"the test word is heron","value":"heron","kind":"test"}}',
);

describe("the worker an organisation chose", () => {
  it("is nothing at all when it is off", async () => {
    const { calls, runtime } = recorded();
    const provider = makeWorkerProvider({ provider: "off", settings: {}, secrets: {} }, runtime);
    expect(provider.endpoint).toBeUndefined();
    await expect(provider.testConnection()).resolves.toMatchObject({ ok: true, kind: "ok" });
    expect(calls).toHaveLength(0);
  });

  it("calls DoeDesk Cloud's worker with the account's token and its queue", async () => {
    const { calls, runtime } = recorded(chat("{}"));
    const provider = makeWorkerProvider(
      {
        provider: "doedeskCloud",
        settings: { structured: "jsonObject", parallel: 4, maxWaitSeconds: 30 },
        secrets: { token: "cloud-token" },
      },
      runtime,
    );
    expect(provider.endpoint).toEqual({
      baseUrl: "https://api.doedesk.com/v1/worker",
      apiKey: "cloud-token",
      model: "doedesk-worker",
      driver: "chatCompletions",
      structured: "jsonObject",
      queue: { parallel: 4, maxWaitMs: 30_000 },
    });
    await ask(provider);
    expect(calls[0]?.url).toBe("https://api.doedesk.com/v1/worker/chat/completions");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer cloud-token");
  });

  it("calls any Chat Completions address with the model, key, headers and effort set", async () => {
    const { calls, runtime } = recorded(chat("{}"));
    const provider = makeWorkerProvider(
      {
        provider: "openaiCompatible",
        settings: {
          baseUrl: "http://ollama.internal:11434/v1/",
          model: " qwen3:32b ",
          reasoningEffort: "low",
        },
        secrets: { apiKey: "sk-local", headers: { "x-tenant": "legal" } },
      },
      runtime,
    );
    await ask(provider);
    const [sent] = calls;
    expect([sent?.method, sent?.url]).toEqual([
      "POST",
      "http://ollama.internal:11434/v1/chat/completions",
    ]);
    expect(sent?.headers.get("authorization")).toBe("Bearer sk-local");
    expect(sent?.headers.get("x-tenant")).toBe("legal");
    expect(sent?.json).toMatchObject({
      model: "qwen3:32b",
      reasoning_effort: "low",
      response_format: { type: "json_schema" },
    });
  });

  it("calls a Responses address, and one with no key at all", async () => {
    const { calls, runtime } = recorded(
      json({ output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }] }),
    );
    const provider = makeWorkerProvider(
      {
        provider: "openaiCompatible",
        settings: {
          baseUrl: "http://vllm.internal/v1",
          model: "m",
          driver: "responses",
          structured: "none",
        },
        secrets: {},
      },
      runtime,
    );
    await expect(ask(provider)).resolves.toMatchObject({ text: "{}" });
    expect(calls[0]?.url).toBe("http://vllm.internal/v1/responses");
    expect(calls[0]?.headers.has("authorization")).toBe(false);
    expect(calls[0]?.json).toMatchObject({ model: "m", store: false });
  });

  it("gives Azure OpenAI its `api-key` header and `api-version`", async () => {
    const { calls, runtime } = recorded(chat("{}"));
    const provider = makeWorkerProvider(
      {
        provider: "openaiCompatible",
        settings: {
          baseUrl: "https://contoso.openai.azure.com/openai/deployments/gpt-4o",
          model: "gpt-4o",
          authScheme: "apiKey",
          apiVersion: "2024-10-21",
        },
        secrets: { apiKey: "azure-openai-key", headers: { "x-ms-client-request-id": "abc" } },
      },
      runtime,
    );
    await ask(provider);
    expect(calls[0]?.url).toBe(
      "https://contoso.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21",
    );
    expect(calls[0]?.headers.get("api-key")).toBe("azure-openai-key");
    expect(calls[0]?.headers.get("x-ms-client-request-id")).toBe("abc");
    expect(calls[0]?.headers.has("authorization")).toBe(false);
  });
});

describe("testing a worker", () => {
  const config: WorkerProviderConfig = {
    provider: "openaiCompatible",
    settings: { baseUrl: "http://vllm.internal/v1", model: "m", reasoningEffort: "none" },
    secrets: { apiKey: "sk-local" },
  };

  it("finds the strictest way the server takes a request for JSON", async () => {
    const { calls, runtime } = recorded(
      json({ error: { message: "response_format json_schema is not supported" } }, { status: 400 }),
      probeAnswer,
    );
    await expect(makeWorkerProvider(config, runtime).testConnection()).resolves.toMatchObject({
      ok: true,
      kind: "ok",
      host: "vllm.internal",
      structured: "jsonObject",
    });
    expect(calls.map((call) => (call.json.response_format as { type: string }).type)).toEqual([
      "json_schema",
      "json_object",
    ]);
  });

  it("says which reasoning setting the server took in place of the one given", async () => {
    const { runtime } = recorded(
      json(
        { error: { message: "reasoning_effort must be one of low, medium, high" } },
        { status: 400 },
      ),
      json({ error: { message: "reasoning_effort is mandatory" } }, { status: 400 }),
      probeAnswer,
    );
    await expect(makeWorkerProvider(config, runtime).testConnection()).resolves.toMatchObject({
      ok: true,
      structured: "jsonSchema",
      reasoningEffort: "low",
    });
  });

  it("says why the worker did not answer", async () => {
    const cases: ReadonlyArray<readonly [Response | Error, Record<string, unknown>]> = [
      [
        json({ error: { message: "Incorrect API key" } }, { status: 401 }),
        { kind: "auth", status: 401 },
      ],
      [json({ error: { message: "slow down" } }, { status: 429 }), { kind: "busy", status: 429 }],
      [new Response("bad gateway", { status: 502 }), { kind: "failing", status: 502 }],
      [new TypeError("fetch failed"), { kind: "unreachable" }],
      [chat("I cannot answer that."), { kind: "unreadable" }],
    ];
    for (const [answer, expected] of cases) {
      // An answer that is not the JSON asked for is asked for again in each of the three ways.
      const { runtime } = recorded(answer, answer, answer);
      const health = await makeWorkerProvider(config, runtime).testConnection();
      expect(health, String(expected.kind)).toMatchObject({ ok: false, ...expected });
      expect(health.message).not.toContain("sk-local");
    }
  });

  it("refuses an address or a model that cannot be called, before anything is sent", async () => {
    const { calls, runtime } = recorded();
    const noAddress = makeWorkerProvider(
      { ...config, settings: { baseUrl: "vllm.internal", model: "m" } },
      runtime,
    );
    expect(noAddress.endpoint).toBeUndefined();
    await expect(noAddress.testConnection()).resolves.toMatchObject({
      ok: false,
      kind: "misconfigured",
    });
    const noModel = makeWorkerProvider(
      { ...config, settings: { baseUrl: "http://vllm.internal/v1", model: " " } },
      runtime,
    );
    await expect(noModel.testConnection()).resolves.toMatchObject({
      ok: false,
      kind: "misconfigured",
      message: "Enter the worker model's name.",
    });
    expect(calls).toHaveLength(0);
  });
});
