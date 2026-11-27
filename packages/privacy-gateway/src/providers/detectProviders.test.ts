import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import { DetectorUnavailableError } from "../detect.ts";
import { makeDetectProvider } from "./detectProviders.ts";
import { AWS_KEYS, json, recorded, timedOut } from "./testkit.ts";
import type { DetectProvider, DetectProviderConfig } from "./types.ts";

/** What a provider found in `text`, as the words it would mask. */
const found = async (provider: DetectProvider, text: string) => {
  const [entities = []] = await provider.detect([text]);
  return entities.map((entity) => [text.slice(entity.start, entity.end), entity.kind]);
};

const chat = (content: string, finishReason = "stop") =>
  json({
    choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });

describe("DoeDesk Cloud and a service of one's own", () => {
  it("speak DoeDesk's /v1/detect contract", async () => {
    const answer = json({ results: [{ entities: [{ start: 0, end: 4, kind: "PERSON" }] }] });
    const cloud = recorded(answer);
    const provider = makeDetectProvider(
      { provider: "doedeskCloud", settings: {}, secrets: { token: "cloud-token" } },
      cloud.runtime,
    );
    await expect(found(provider, "Sara called.")).resolves.toEqual([["Sara", "PERSON"]]);
    expect([cloud.calls[0]?.method, cloud.calls[0]?.url]).toEqual([
      "POST",
      "https://api.doedesk.com/v1/detect",
    ]);
    expect(cloud.calls[0]?.headers.get("authorization")).toBe("Bearer cloud-token");
    expect(cloud.calls[0]?.json).toEqual({ texts: ["Sara called."] });

    const own = recorded(answer);
    const custom = makeDetectProvider(
      { provider: "custom", settings: { endpoint: "http://detect.internal:9000/" }, secrets: {} },
      own.runtime,
    );
    await found(custom, "Sara called.");
    expect(own.calls[0]?.url).toBe("http://detect.internal:9000/v1/detect");
    expect(own.calls[0]?.headers.has("authorization")).toBe(false);
  });

  it("test the connection once and say what is wrong with it", async () => {
    const { calls, runtime } = recorded(new TypeError("fetch failed"));
    const provider = makeDetectProvider(
      { provider: "custom", settings: { endpoint: "http://detect.internal" }, secrets: {} },
      runtime,
    );
    await expect(provider.testConnection()).resolves.toMatchObject({
      ok: false,
      kind: "unreachable",
      host: "detect.internal",
    });
    expect(calls).toHaveLength(1);

    const unset = makeDetectProvider(
      { provider: "custom", settings: { endpoint: "not a url" }, secrets: {} },
      recorded().runtime,
    );
    await expect(unset.testConnection()).resolves.toMatchObject({
      ok: false,
      kind: "misconfigured",
    });
    await expect(unset.detect(["Sara"])).rejects.toBeInstanceOf(DetectorUnavailableError);
  });
});

describe("Microsoft Presidio", () => {
  const config: DetectProviderConfig = {
    provider: "presidio",
    settings: { endpoint: "http://presidio:5002/" },
    secrets: {},
  };

  it("posts to /analyze and turns code points into UTF-16 units", async () => {
    // Python counts the emoji as one: "Sara Ahmed" is 3..13 there and 4..14 here.
    const text = "🙂: Sara Ahmed, sara@example.com, +966 55 123 4567";
    const { calls, runtime } = recorded(
      json([
        { entity_type: "PERSON", start: 3, end: 13, score: 0.85 },
        { entity_type: "EMAIL_ADDRESS", start: 15, end: 31, score: 1 },
        { entity_type: "PHONE_NUMBER", start: 33, end: 49, score: 0.75 },
        { entity_type: "PERSON", start: 40, end: 400, score: 0.5 },
      ]),
    );
    await expect(found(makeDetectProvider(config, runtime), text)).resolves.toEqual([
      ["Sara Ahmed", "PERSON"],
      ["sara@example.com", "EMAIL"],
      ["+966 55 123 4567", "PHONE"],
    ]);
    expect([calls[0]?.method, calls[0]?.url]).toEqual(["POST", "http://presidio:5002/analyze"]);
    expect(calls[0]?.headers.has("authorization")).toBe(false);
    expect(calls[0]?.json).toEqual({ text, language: "en" });
  });

  it("sends the language, entity types, threshold and key that were set", async () => {
    const settings = {
      endpoint: "http://presidio:5002",
      language: "ar",
      entities: ["PERSON", "IBAN_CODE"],
      scoreThreshold: 0.6,
    };
    const bearer = recorded(json([]));
    await found(
      makeDetectProvider(
        { provider: "presidio", settings, secrets: { apiKey: "p-key" } },
        bearer.runtime,
      ),
      "نص",
    );
    expect(bearer.calls[0]?.json).toEqual({
      text: "نص",
      language: "ar",
      entities: ["PERSON", "IBAN_CODE"],
      score_threshold: 0.6,
    });
    expect(bearer.calls[0]?.headers.get("authorization")).toBe("Bearer p-key");

    const header = recorded(json([]));
    await found(
      makeDetectProvider(
        {
          provider: "presidio",
          settings: { ...settings, apiKeyHeader: "X-Api-Key" },
          secrets: { apiKey: "p-key" },
        },
        header.runtime,
      ),
      "نص",
    );
    expect(header.calls[0]?.headers.get("x-api-key")).toBe("p-key");
    expect(header.calls[0]?.headers.has("authorization")).toBe(false);
  });

  it("maps every service's categories to DoeDesk's kinds", async () => {
    const categories: ReadonlyArray<readonly [string, string]> = [
      ["PERSON", "PERSON"],
      ["NAME", "PERSON"],
      ["PERSON_NAME", "PERSON"],
      ["Organization", "ORG"],
      ["ORGANIZATION_NAME", "ORG"],
      ["LOCATION", "LOCATION"],
      ["Address", "ADDRESS"],
      ["STREET_ADDRESS", "ADDRESS"],
      ["PhoneNumber", "PHONE"],
      ["EMAIL_ADDRESS", "EMAIL"],
      ["URL", "URL"],
      ["DATE_TIME", "DATE"],
      ["IBAN_CODE", "IBAN"],
      ["InternationalBankingAccountNumber", "IBAN"],
      ["INTERNATIONAL_BANK_ACCOUNT_NUMBER", "IBAN"],
      ["CREDIT_CARD", "ACCOUNT"],
      ["CREDIT_DEBIT_NUMBER", "ACCOUNT"],
      ["BANK_ROUTING", "ACCOUNT"],
      ["SWIFTCode", "ACCOUNT"],
      ["US_SSN", "ID"],
      ["USSocialSecurityNumber", "ID"],
      ["PASSPORT_NUMBER", "ID"],
      ["DRIVER_ID", "ID"],
      ["SAUDI_ARABIA_NATIONAL_ID", "ID"],
      ["LICENSE_PLATE", "OTHER"],
      ["IP_ADDRESS", "OTHER"],
      ["NRP", "OTHER"],
      ["SOMETHING_NEW", "OTHER"],
    ];
    const text = "x".repeat(categories.length * 2);
    const { runtime } = recorded(
      json(
        categories.map(([category], index) => ({
          entity_type: category,
          start: index * 2,
          end: index * 2 + 2,
        })),
      ),
    );
    const [entities = []] = await makeDetectProvider(config, runtime).detect([text]);
    expect(entities.map((entity, index) => [categories[index]?.[0], entity.kind])).toEqual(
      categories,
    );
  });

  it("refuses the text when the answer is not Presidio's", async () => {
    const { runtime } = recorded(json({ error: "No matching recognizers" }));
    const failure = await makeDetectProvider(config, runtime)
      .detect(["Sara"])
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(DetectorUnavailableError);
    expect(failure).toMatchObject({ problem: { kind: "unreadable", host: "presidio:5002" } });
  });
});

describe("Azure AI Language PII", () => {
  const config: DetectProviderConfig = {
    provider: "azureLanguagePii",
    settings: {
      endpoint: "https://contoso.cognitiveservices.azure.com",
      language: "ar",
      domain: "phi",
    },
    secrets: { apiKey: "azure-key" },
  };
  const documents = (entities: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) =>
    json({
      kind: "PiiEntityRecognitionResults",
      results: {
        // Azure does not promise the order the documents went in.
        documents: entities
          .map((list, index) => ({ id: String(index), entities: list }))
          .toReversed(),
        errors: [],
        modelVersion: "2023-09-01",
      },
    });

  it("asks for UTF-16 positions and maps each document back by its id", async () => {
    const { calls, runtime } = recorded(
      documents([
        [{ text: "Sara", category: "Person", offset: 0, length: 4, confidenceScore: 0.99 }],
        [
          {
            text: "0551234567",
            category: "PhoneNumber",
            offset: 5,
            length: 10,
            confidenceScore: 0.8,
          },
        ],
      ]),
    );
    const results = await makeDetectProvider(config, runtime).detect([
      "Sara called.",
      "Call 0551234567",
    ]);
    expect(results).toEqual([
      [{ start: 0, end: 4, kind: "PERSON" }],
      [{ start: 5, end: 15, kind: "PHONE" }],
    ]);
    expect([calls[0]?.method, calls[0]?.url]).toEqual([
      "POST",
      "https://contoso.cognitiveservices.azure.com/language/:analyze-text?api-version=2023-04-01",
    ]);
    expect(calls[0]?.headers.get("Ocp-Apim-Subscription-Key")).toBe("azure-key");
    expect(calls[0]?.json).toEqual({
      kind: "PiiEntityRecognition",
      parameters: {
        modelVersion: "latest",
        stringIndexType: "Utf16CodeUnit",
        loggingOptOut: true,
        domain: "phi",
      },
      analysisInput: {
        documents: [
          { id: "0", language: "ar", text: "Sara called." },
          { id: "1", language: "ar", text: "Call 0551234567" },
        ],
      },
    });
  });

  it("sends five documents a request, and long texts in pieces", async () => {
    const empty = (call: { readonly json: Record<string, unknown> }) => {
      const sent = (
        call.json.analysisInput as { documents: ReadonlyArray<{ id: string; text: string }> }
      ).documents;
      return documents(
        sent.map((document) => {
          const at = document.text.indexOf("Sara");
          return at === -1 ? [] : [{ category: "Person", offset: at, length: 4 }];
        }),
      );
    };
    const { calls, runtime } = recorded(empty, empty, empty);
    const long = `${"word ".repeat(1000)}Sara`;
    const texts = [...Array.from({ length: 6 }, (_, index) => `text ${index}`), long, "   "];
    const results = await makeDetectProvider(config, runtime).detect(texts);
    const sizes = calls.map(
      (call) => (call.json.analysisInput as { documents: ReadonlyArray<unknown> }).documents.length,
    );
    // Six short texts and two pieces of the long one. The blank text is not sent.
    expect(sizes.toSorted()).toEqual([3, 5]);
    expect(results[6]).toEqual([{ start: 5000, end: 5004, kind: "PERSON" }]);
    expect(results[7]).toEqual([]);
  });

  it("refuses the text when Azure could not check one document", async () => {
    const { runtime } = recorded(
      json({
        results: {
          documents: [],
          errors: [
            { id: "0", error: { code: "InvalidArgument", message: "Invalid language code." } },
          ],
        },
      }),
    );
    await expect(makeDetectProvider(config, runtime).detect(["Sara"])).rejects.toThrow(
      "could not check a text (Invalid language code)",
    );
  });
});

describe("AWS Comprehend PII", () => {
  const config: DetectProviderConfig = { provider: "awsComprehendPii", ...AWS_KEYS };

  it("signs DetectPiiEntities and turns code points into UTF-16 units", async () => {
    const text = "🙂 Sara Ahmed, SSN 123-45-6789";
    const { calls, runtime } = recorded(
      json({
        Entities: [
          { Type: "NAME", Score: 0.99, BeginOffset: 2, EndOffset: 12 },
          { Type: "SSN", Score: 0.99, BeginOffset: 18, EndOffset: 29 },
        ],
      }),
    );
    await expect(found(makeDetectProvider(config, runtime), text)).resolves.toEqual([
      ["Sara Ahmed", "PERSON"],
      ["123-45-6789", "ID"],
    ]);
    const [sent] = calls;
    expect([sent?.method, sent?.url]).toEqual([
      "POST",
      "https://comprehend.me-central-1.amazonaws.com/",
    ]);
    expect(sent?.headers.get("x-amz-target")).toBe("Comprehend_20171127.DetectPiiEntities");
    expect(sent?.headers.get("content-type")).toBe("application/x-amz-json-1.1");
    expect(sent?.headers.get("authorization")).toContain(
      "Credential=AKIDEXAMPLE/20261127/me-central-1/comprehend/aws4_request",
    );
    expect(sent?.json).toEqual({ Text: text, LanguageCode: "en" });
  });

  it("waits out a throttled call, and refuses the text when the key is not accepted", async () => {
    const throttled = json(
      { __type: "ThrottlingException", message: "Rate exceeded" },
      { status: 400 },
    );
    const busy = recorded(throttled, json({ Entities: [] }));
    await expect(makeDetectProvider(config, busy.runtime).detect(["Sara"])).resolves.toEqual([[]]);
    expect(busy.waits).toEqual([500]);

    const denied = recorded(
      json({ __type: "InvalidSignatureException", message: "bad signature" }, { status: 403 }),
    );
    const failure = await makeDetectProvider(config, denied.runtime)
      .detect(["Sara"])
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(DetectorUnavailableError);
    expect(failure).toMatchObject({
      problem: { kind: "signIn", host: "comprehend.me-central-1.amazonaws.com", status: 403 },
    });
  });
});

describe("Google Cloud DLP", () => {
  const config: DetectProviderConfig = {
    provider: "googleCloudDlp",
    settings: { projectId: "my-project" },
    secrets: { apiKey: "AIza-key" },
  };
  /** A finding as Google writes it: positions in UTF-8 bytes, as strings, a zero left out. */
  const finding = (text: string, value: string, name: string) => {
    const start = Buffer.byteLength(text.slice(0, text.indexOf(value)));
    return {
      infoType: { name },
      likelihood: "LIKELY",
      location: {
        byteRange: {
          ...(start === 0 ? {} : { start: String(start) }),
          end: String(start + Buffer.byteLength(value)),
        },
      },
    };
  };

  it("inspects the text and turns UTF-8 byte positions into UTF-16 units", async () => {
    // Arabic letters are two bytes and one unit; the emoji is four bytes and two units.
    const text = "سارة أحمد 🙂 بريدها sara@example.com وجوالها ٠٥٥١٢٣٤٥٦٧";
    const { calls, runtime } = recorded(
      json({
        result: {
          findings: [
            finding(text, "سارة أحمد", "PERSON_NAME"),
            finding(text, "sara@example.com", "EMAIL_ADDRESS"),
            finding(text, "٠٥٥١٢٣٤٥٦٧", "PHONE_NUMBER"),
          ],
        },
      }),
    );
    await expect(found(makeDetectProvider(config, runtime), text)).resolves.toEqual([
      ["سارة أحمد", "PERSON"],
      ["sara@example.com", "EMAIL"],
      ["٠٥٥١٢٣٤٥٦٧", "PHONE"],
    ]);
    expect([calls[0]?.method, calls[0]?.url]).toEqual([
      "POST",
      "https://dlp.googleapis.com/v2/projects/my-project/content:inspect",
    ]);
    expect(calls[0]?.headers.get("x-goog-api-key")).toBe("AIza-key");
    expect(calls[0]?.json).toEqual({
      item: { value: text },
      inspectConfig: { includeQuote: false },
    });
  });

  it("widens a position inside a character to the whole character", async () => {
    const text = "a🙂b";
    const { runtime } = recorded(
      json({
        result: {
          findings: [
            {
              infoType: { name: "PERSON_NAME" },
              location: { byteRange: { start: "2", end: "4" } },
            },
          ],
        },
      }),
    );
    await expect(found(makeDetectProvider(config, runtime), text)).resolves.toEqual([
      ["🙂", "PERSON"],
    ]);
  });

  it("sends the location, infoTypes and likelihood that were set", async () => {
    const { calls, runtime } = recorded(json({ result: {} }));
    const provider = makeDetectProvider(
      {
        provider: "googleCloudDlp",
        settings: {
          projectId: "my-project",
          location: "me-central2",
          infoTypes: ["PERSON_NAME", "IBAN_CODE"],
          minLikelihood: "LIKELY",
        },
        secrets: { accessToken: "ya29.token" },
      },
      runtime,
    );
    await expect(provider.detect(["Sara"])).resolves.toEqual([[]]);
    expect(calls[0]?.url).toBe(
      "https://dlp.googleapis.com/v2/projects/my-project/locations/me-central2/content:inspect",
    );
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer ya29.token");
    expect(calls[0]?.json.inspectConfig).toEqual({
      infoTypes: [{ name: "PERSON_NAME" }, { name: "IBAN_CODE" }],
      minLikelihood: "LIKELY",
      includeQuote: false,
    });
  });

  it("refuses the text when Google left findings out", async () => {
    const { runtime } = recorded(json({ result: { findings: [], findingsTruncated: true } }));
    await expect(makeDetectProvider(config, runtime).detect(["Sara"])).rejects.toMatchObject({
      problem: { kind: "unreadable" },
    });
  });

  it("signs in with a service account key and keeps the token until it ends", async () => {
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const keyFile = JSON.stringify({
      type: "service_account",
      client_email: "doedesk@my-project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    });
    const { calls, runtime } = recorded(
      json({ access_token: "ya29.minted", expires_in: 3600, token_type: "Bearer" }),
      json({ result: {} }),
      json({ result: {} }),
    );
    const provider = makeDetectProvider(
      {
        provider: "googleCloudDlp",
        settings: { projectId: "my-project" },
        secrets: { serviceAccountKey: keyFile },
      },
      runtime,
    );
    await provider.detect(["Sara"]);
    await provider.detect(["Ahmed"]);

    const [exchange, first, second] = calls;
    expect([exchange?.method, exchange?.url]).toEqual([
      "POST",
      "https://oauth2.googleapis.com/token",
    ]);
    const form = new URLSearchParams(exchange?.body as string);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header = "", claims = "", signature = ""] = (form.get("assertion") ?? "").split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: "doedesk@my-project.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1795773600,
      exp: 1795777200,
    });
    expect(
      NodeCrypto.verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
    ).toBe(true);
    expect(first?.headers.get("authorization")).toBe("Bearer ya29.minted");
    expect(second?.headers.get("authorization")).toBe("Bearer ya29.minted");
  });

  it("says the service account key is wrong when Google does not know it", async () => {
    const bad = makeDetectProvider(
      {
        provider: "googleCloudDlp",
        settings: { projectId: "my-project" },
        secrets: { serviceAccountKey: "{}" },
      },
      recorded().runtime,
    );
    await expect(bad.testConnection()).resolves.toMatchObject({ ok: false, kind: "misconfigured" });

    const { privateKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { runtime } = recorded(
      json(
        { error: "invalid_grant", error_description: "Invalid JWT Signature." },
        { status: 400 },
      ),
    );
    const unknown = makeDetectProvider(
      {
        provider: "googleCloudDlp",
        settings: { projectId: "my-project" },
        secrets: {
          serviceAccountKey: JSON.stringify({
            client_email: "a@b.iam.gserviceaccount.com",
            private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
          }),
        },
      },
      runtime,
    );
    await expect(unknown.testConnection()).resolves.toMatchObject({
      ok: false,
      kind: "auth",
      host: "oauth2.googleapis.com",
    });
  });
});

describe("an OpenAI-compatible model", () => {
  const config: DetectProviderConfig = {
    provider: "openaiCompatible",
    settings: { baseUrl: "http://vllm.internal:8000/v1/", model: "qwen3-32b" },
    secrets: { apiKey: "sk-local", headers: { "x-tenant": "legal" } },
  };

  it("asks for a JSON list of values and finds each one in the text itself", async () => {
    const text =
      "Sara Ahmed met Ahmed at Najd Trading.\nLater Sara\nAhmed signed. Ahmedabad was not named.";
    const { calls, runtime } = recorded(
      chat(
        JSON.stringify({
          entities: [
            { text: "Sara Ahmed", kind: "PERSON" },
            { text: "Najd Trading", kind: "ORG" },
            // Not in the text: the model made it up, and it masks nothing.
            { text: "Khalid Al-Otaibi", kind: "PERSON" },
            { text: "Ahmed", kind: "NOT_A_KIND" },
          ],
        }),
      ),
    );
    await expect(found(makeDetectProvider(config, runtime), text)).resolves.toEqual([
      ["Sara Ahmed", "PERSON"],
      // The model joined the line break with a space; the text's own span is what is masked.
      ["Sara\nAhmed", "PERSON"],
      ["Najd Trading", "ORG"],
      ["Ahmed", "OTHER"],
      ["Ahmed", "OTHER"],
      ["Ahmed", "OTHER"],
    ]);
    const [sent] = calls;
    expect([sent?.method, sent?.url]).toEqual([
      "POST",
      "http://vllm.internal:8000/v1/chat/completions",
    ]);
    expect(sent?.headers.get("authorization")).toBe("Bearer sk-local");
    expect(sent?.headers.get("x-tenant")).toBe("legal");
    expect(sent?.json).toMatchObject({
      model: "qwen3-32b",
      temperature: 0,
      response_format: { type: "json_object" },
    });
    const messages = sent?.json.messages as ReadonlyArray<{ role: string; content: string }>;
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages[1]?.content).toBe(`<text>\n${text}\n</text>`);
  });

  it("sends Azure OpenAI its key and API version the way Azure takes them", async () => {
    const { calls, runtime } = recorded(chat('{"entities":[]}'));
    const azure = makeDetectProvider(
      {
        provider: "openaiCompatible",
        settings: {
          baseUrl: "https://contoso.openai.azure.com/openai/deployments/gpt-4o",
          model: "gpt-4o",
          authScheme: "apiKey",
          apiVersion: "2024-10-21",
          structured: "jsonSchema",
        },
        secrets: { apiKey: "azure-openai-key" },
      },
      runtime,
    );
    await expect(azure.detect(["Sara"])).resolves.toEqual([[]]);
    expect(calls[0]?.url).toBe(
      "https://contoso.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21",
    );
    expect(calls[0]?.headers.get("api-key")).toBe("azure-openai-key");
    expect(calls[0]?.headers.has("authorization")).toBe(false);
    expect(calls[0]?.json.response_format).toMatchObject({ type: "json_schema" });
  });

  it("checks a long text in pieces and puts the spans back in place", async () => {
    const piece = (call: { readonly json: Record<string, unknown> }) => {
      const [, user] = call.json.messages as ReadonlyArray<{ content: string }>;
      return chat(
        JSON.stringify({
          entities: user?.content.includes("Sara") ? [{ text: "Sara", kind: "PERSON" }] : [],
        }),
      );
    };
    const { calls, runtime } = recorded(piece, piece);
    const text = `${"word ".repeat(1000)}Sara`;
    const [entities] = await makeDetectProvider(config, runtime).detect([text]);
    expect(calls).toHaveLength(2);
    expect(entities).toEqual([{ start: 5000, end: 5004, kind: "PERSON" }]);
  });

  it("refuses the text when the answer is cut off or is not the list", async () => {
    for (const answer of [
      chat('{"entities":[{"text":"Sa', "length"),
      chat("I found nothing."),
      chat('{"values":[]}'),
    ]) {
      const { runtime } = recorded(answer);
      await expect(makeDetectProvider(config, runtime).detect(["Sara"])).rejects.toMatchObject({
        problem: { kind: "unreadable", host: "vllm.internal:8000" },
      });
    }
  });

  it("says why the model did not answer", async () => {
    const cases: ReadonlyArray<readonly [ReadonlyArray<Response | Error>, string, number]> = [
      [[json({ error: { message: "Incorrect API key" } }, { status: 401 })], "signIn", 1],
      [
        Array.from({ length: 4 }, () => json({ error: { message: "slow down" } }, { status: 429 })),
        "busy",
        4,
      ],
      [Array.from({ length: 4 }, () => new Response("bad gateway", { status: 502 })), "failing", 4],
      [Array.from({ length: 4 }, () => new TypeError("fetch failed")), "unreachable", 4],
      [[json({ error: { message: "model not found" } }, { status: 404 })], "refused", 1],
    ];
    for (const [answers, kind, tries] of cases) {
      const { calls, runtime } = recorded(...answers);
      const failure = await makeDetectProvider(config, runtime)
        .detect(["Sara"])
        .catch((cause: unknown) => cause);
      expect(failure, kind).toBeInstanceOf(DetectorUnavailableError);
      expect(failure, kind).toMatchObject({ problem: { kind } });
      expect(calls, kind).toHaveLength(tries);
      expect((failure as Error).message).not.toContain("sk-local");
    }
  });
});

describe("local rules only", () => {
  it("finds fixed formats without a single call", async () => {
    const { calls, runtime } = recorded();
    const provider = makeDetectProvider(
      { provider: "localOnly", settings: {}, secrets: {} },
      runtime,
    );
    await expect(found(provider, "Write to sara@example.com today.")).resolves.toEqual([
      ["sara@example.com", "EMAIL"],
    ]);
    await expect(provider.testConnection()).resolves.toMatchObject({ ok: true, kind: "ok" });
    expect(calls).toHaveLength(0);
  });
});

describe("every network detector", () => {
  const configs: ReadonlyArray<DetectProviderConfig> = [
    { provider: "presidio", settings: { endpoint: "http://presidio:5002" }, secrets: {} },
    {
      provider: "azureLanguagePii",
      settings: { endpoint: "https://contoso.cognitiveservices.azure.com" },
      secrets: { apiKey: "k" },
    },
    { provider: "awsComprehendPii", ...AWS_KEYS },
    { provider: "googleCloudDlp", settings: { projectId: "my-project" }, secrets: { apiKey: "k" } },
  ];

  it("refuses the text, in words the app can show, when the service does not answer", async () => {
    const cases: ReadonlyArray<readonly [() => ReadonlyArray<Response | Error>, string, number]> = [
      [() => [new Response("denied", { status: 401 })], "signIn", 1],
      [
        () => Array.from({ length: 4 }, () => new Response("slow down", { status: 429 })),
        "busy",
        4,
      ],
      [() => Array.from({ length: 4 }, () => new Response("oops", { status: 500 })), "failing", 4],
      [() => [timedOut(), timedOut()], "timeout", 2],
    ];
    for (const config of configs) {
      for (const [answers, kind, tries] of cases) {
        const { calls, runtime } = recorded(...answers());
        const failure = await makeDetectProvider(config, runtime)
          .detect(["Sara Ahmed"])
          .catch((cause: unknown) => cause);
        const label = `${config.provider} ${kind}`;
        expect(failure, label).toBeInstanceOf(DetectorUnavailableError);
        expect(failure, label).toMatchObject({ problem: { kind } });
        expect(calls, label).toHaveLength(tries);
      }
    }
  });

  it("tests the connection with one test sentence and never rejects", async () => {
    for (const config of configs) {
      const down = recorded(new Response("oops", { status: 503 }));
      await expect(
        makeDetectProvider(config, down.runtime).testConnection(),
        config.provider,
      ).resolves.toMatchObject({
        ok: false,
        kind: "failing",
        status: 503,
      });
      expect(down.calls, config.provider).toHaveLength(1);
    }
    const up = recorded(json([]));
    await expect(
      makeDetectProvider(configs[0] as DetectProviderConfig, up.runtime).testConnection(),
    ).resolves.toMatchObject({
      ok: true,
      kind: "ok",
      host: "presidio:5002",
    });
    expect(up.calls[0]?.json.text).toContain("Connection test");
  });
});
