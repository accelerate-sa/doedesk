import { describe, expect, it } from "vite-plus/test";

import { parseLayout } from "../redaction/layout.ts";
import { decodeImage } from "../redaction/raster.ts";
import { makeOcrProvider } from "./ocrProviders.ts";
import { AWS_KEYS, json, pngOfSize, recorded, timedOut, uploadedFile } from "./testkit.ts";
import { type OcrProviderConfig, ProviderError } from "./types.ts";

const PNG = pngOfSize(1000, 500);
const PDF = Buffer.from("%PDF-1.7 test");

/** The words of a layout as redaction will see them, after its own checks. */
const checkedWords = (answer: { readonly text: string; readonly layout: unknown }) =>
  parseLayout(answer.text, answer.layout).pages.flatMap((page) =>
    page.words.map((word) => [word.text, word.polygon]),
  );

describe("DoeDesk Cloud and a service of one's own", () => {
  it("speak DoeDesk's /v1/ocr contract", async () => {
    const cloud = recorded(json({ text: "Hello", pages: 1 }), json({ text: "Hi", pages: 1 }));
    const provider = makeOcrProvider(
      { provider: "doedeskCloud", settings: {}, secrets: { token: "cloud-token" } },
      cloud.runtime,
    );
    await expect(provider.read(PNG, "image/png")).resolves.toBe("Hello");
    expect(cloud.calls[0]?.url).toBe("https://api.doedesk.com/v1/ocr");
    expect(cloud.calls[0]?.headers.get("authorization")).toBe("Bearer cloud-token");
    expect(cloud.calls[0]?.headers.get("content-type")).toBe("image/png");
    await provider.readLayout?.(PNG, "image/png");
    expect(cloud.calls[1]?.url).toBe("https://api.doedesk.com/v1/ocr?layout=1");

    const own = recorded(json({ text: "Mine" }));
    const custom = makeOcrProvider(
      { provider: "custom", settings: { endpoint: "http://ocr.internal:8080/" }, secrets: {} },
      own.runtime,
    );
    await expect(custom.read(PDF, "application/pdf")).resolves.toBe("Mine");
    expect(own.calls[0]?.url).toBe("http://ocr.internal:8080/v1/ocr");
    expect(own.calls[0]?.headers.has("authorization")).toBe(false);
  });

  it("test the connection by reading a blank page", async () => {
    const { calls, runtime } = recorded(json({ text: "" }), new Response("no", { status: 401 }));
    const provider = makeOcrProvider(
      { provider: "custom", settings: { endpoint: "http://ocr.internal" }, secrets: {} },
      runtime,
    );
    await expect(provider.testConnection()).resolves.toMatchObject({ ok: true, kind: "ok" });
    expect(calls[0]?.headers.get("content-type")).toBe("image/png");
    await expect(provider.testConnection()).resolves.toMatchObject({ ok: false });
  });
});

describe("Azure AI Document Intelligence", () => {
  const config: OcrProviderConfig = {
    provider: "azureDocumentIntelligence",
    settings: { endpoint: "https://contoso.cognitiveservices.azure.com/" },
    secrets: { apiKey: "azure-key" },
  };
  const operation =
    "https://contoso.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-read/analyzeResults/op-1?api-version=2024-11-30";
  const started = () =>
    new Response(null, { status: 202, headers: { "operation-location": operation } });
  // "Pay 🙂 Sara" in UTF-16 units: the emoji is two, so "Sara" starts at 7.
  const result = {
    status: "succeeded",
    analyzeResult: {
      content: "Pay 🙂 Sara\nRiyadh",
      pages: [
        {
          pageNumber: 1,
          angle: 0.5,
          width: 1000,
          height: 500,
          unit: "pixel",
          words: [
            {
              content: "Pay",
              polygon: [10, 10, 50, 10, 50, 30, 10, 30],
              confidence: 0.99,
              span: { offset: 0, length: 3 },
            },
            {
              content: "🙂",
              polygon: [60, 10, 80, 10, 80, 30, 60, 30],
              confidence: 0.8,
              span: { offset: 4, length: 2 },
            },
            {
              content: "Sara",
              polygon: [90, 10, 150, 10, 150, 30, 90, 30],
              confidence: 0.98,
              span: { offset: 7, length: 4 },
            },
            {
              content: "Riyadh",
              polygon: [10, 40, 90, 40, 90, 60, 10, 60],
              confidence: 0.97,
              span: { offset: 12, length: 6 },
            },
          ],
          lines: [
            {
              content: "Pay 🙂 Sara",
              polygon: [10, 10, 150, 10, 150, 30, 10, 30],
              spans: [{ offset: 0, length: 11 }],
            },
            {
              content: "Riyadh",
              polygon: [10, 40, 90, 40, 90, 60, 10, 60],
              spans: [{ offset: 12, length: 6 }],
            },
          ],
        },
      ],
      styles: [
        { isHandwritten: true, confidence: 0.9, spans: [{ offset: 7, length: 4 }] },
        { isHandwritten: false, confidence: 0.9, spans: [{ offset: 0, length: 3 }] },
      ],
    },
  };

  it("starts an analysis, follows the operation and maps words to the layout", async () => {
    const { calls, waits, runtime } = recorded(
      started(),
      json({ status: "notStarted" }),
      json({ status: "running" }, { headers: { "retry-after": "2" } }),
      json(result),
    );
    const answer = await makeOcrProvider(config, runtime).readLayout?.(PNG, "image/png");

    const [start, ...polls] = calls;
    expect(start?.url).toBe(
      "https://contoso.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30&stringIndexType=utf16CodeUnit",
    );
    expect(start?.method).toBe("POST");
    expect(start?.headers.get("Ocp-Apim-Subscription-Key")).toBe("azure-key");
    expect(start?.json).toEqual({ base64Source: PNG.toString("base64") });
    expect(polls.map((poll) => [poll.method, poll.url])).toEqual(
      Array.from({ length: 3 }, () => ["GET", operation]),
    );
    expect(
      polls.every((poll) => poll.headers.get("Ocp-Apim-Subscription-Key") === "azure-key"),
    ).toBe(true);
    expect(waits).toEqual([1000, 2000]);

    expect(answer?.text).toBe("Pay 🙂 Sara\nRiyadh");
    expect(answer?.pages).toBe(1);
    const layout = parseLayout(answer?.text ?? "", answer?.layout);
    expect(layout.pages[0]).toMatchObject({
      page: 1,
      width: 1000,
      height: 500,
      unit: "pixel",
      angle: 0.5,
    });
    expect(layout.pages[0]?.words[2]).toEqual({
      text: "Sara",
      polygon: [90, 10, 150, 10, 150, 30, 90, 30],
      confidence: 0.98,
      offset: 7,
      length: 4,
    });
    expect(layout.pages[0]?.lines).toEqual([
      { polygon: [10, 10, 150, 10, 150, 30, 10, 30], offset: 0, length: 11 },
      { polygon: [10, 40, 90, 40, 90, 60, 10, 60], offset: 12, length: 6 },
    ]);
    expect(layout.handwritten).toEqual([{ offset: 7, length: 4, confidence: 0.9 }]);
  });

  it("reads plain text with the model that was chosen, and says what it read", async () => {
    const { calls, runtime } = recorded(started(), json(result));
    const reads: Array<unknown> = [];
    const provider = makeOcrProvider(
      { ...config, settings: { ...config.settings, model: "prebuilt-layout" } },
      { ...runtime, onRead: (read) => reads.push(read) },
    );
    await expect(provider.read(PDF, "application/pdf")).resolves.toBe("Pay 🙂 Sara\nRiyadh");
    expect(calls[0]?.url).toContain("/documentModels/prebuilt-layout:analyze?");
    expect(reads).toEqual([
      { mediaType: "application/pdf", bytes: PDF.length, characters: 18, pages: 1 },
    ]);
  });

  it("rejects a failed analysis and never sends the key to another host", async () => {
    const failed = recorded(
      started(),
      json({
        status: "failed",
        error: { code: "InvalidRequest", message: "The file is corrupted." },
      }),
    );
    await expect(makeOcrProvider(config, failed.runtime).read(PNG, "image/png")).rejects.toThrow(
      "Azure Document Intelligence could not read the file (The file is corrupted.).",
    );

    const elsewhere = recorded(
      new Response(null, {
        status: 202,
        headers: { "operation-location": "https://evil.example/op" },
      }),
    );
    await expect(
      makeOcrProvider(config, elsewhere.runtime).read(PNG, "image/png"),
    ).rejects.toMatchObject({
      kind: "unreadable",
    });
    expect(elsewhere.calls).toHaveLength(1);
  });

  it("tests the connection with the resource's free info call", async () => {
    const { calls, runtime } = recorded(json({ customDocumentModels: { count: 0, limit: 500 } }));
    await expect(makeOcrProvider(config, runtime).testConnection()).resolves.toMatchObject({
      ok: true,
      host: "contoso.cognitiveservices.azure.com",
    });
    expect(calls[0]?.url).toBe(
      "https://contoso.cognitiveservices.azure.com/documentintelligence/info?api-version=2024-11-30",
    );
    expect(calls[0]?.headers.get("Ocp-Apim-Subscription-Key")).toBe("azure-key");
  });
});

describe("DEEP.SA alOCR", () => {
  const config: OcrProviderConfig = {
    provider: "deepSa",
    settings: {},
    secrets: { apiKey: "deep-key" },
  };
  const done = {
    status: "done",
    total_pages: 2,
    pages: [
      { page_num: 2, text: "الصفحة الثانية" },
      { page_num: 1, text: "الصفحة الأولى" },
    ],
  };

  it("uploads the file, follows the job, and deletes it once read", async () => {
    const { calls, waits, runtime } = recorded(
      json({ token: "job/1", status: "queued", progress: 0 }),
      json({ status: "pending" }),
      json({ status: "processing" }),
      json(done),
      json({ status: "deleted" }),
    );
    const provider = makeOcrProvider(config, runtime);
    await expect(provider.read(PDF, "application/pdf")).resolves.toBe(
      "الصفحة الأولى\n\nالصفحة الثانية",
    );

    const [upload, ...rest] = calls;
    expect(upload?.url).toBe("https://alapi.deep.sa/v1/ocr/upload");
    expect(upload?.method).toBe("POST");
    expect(upload?.headers.get("authorization")).toBe("Bearer deep-key");
    expect(upload?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    const file = uploadedFile(upload);
    expect([file.name, file.type]).toEqual(["document.pdf", "application/pdf"]);
    expect(Buffer.from(await file.arrayBuffer()).equals(PDF)).toBe(true);
    expect(rest.map((call) => [call.method, call.url])).toEqual([
      ["GET", "https://alapi.deep.sa/v1/ocr/jobs/job%2F1"],
      ["GET", "https://alapi.deep.sa/v1/ocr/jobs/job%2F1"],
      ["GET", "https://alapi.deep.sa/v1/ocr/jobs/job%2F1"],
      ["DELETE", "https://alapi.deep.sa/v1/ocr/jobs/job%2F1"],
    ]);
    expect(rest.every((call) => call.headers.get("authorization") === "Bearer deep-key")).toBe(
      true,
    );
    expect(waits).toEqual([2000, 2000]);
    // It places lines in a unit it does not document: no layout is made of them.
    expect(provider.readLayout).toBeUndefined();
  });

  it("tries a failed upload again as the same upload", async () => {
    const { calls, runtime } = recorded(
      new Response("bad gateway", { status: 502 }),
      json({ token: "t", status: "queued" }),
      json({ status: "done", total_pages: 1, pages: [{ page_num: 1, text: "ok" }] }),
      json({ status: "deleted" }),
    );
    await expect(makeOcrProvider(config, runtime).read(PDF, "application/pdf")).resolves.toBe("ok");
    expect(calls[1]?.headers.get("idempotency-key")).toBe(calls[0]?.headers.get("idempotency-key"));
  });

  it("rejects a failed job or an unread page, and still deletes the job", async () => {
    const failed = recorded(
      json({ token: "t", status: "queued" }),
      json({ status: "failed", error: "unsupported file" }),
      json({ status: "deleted" }),
    );
    await expect(
      makeOcrProvider(config, failed.runtime).read(PDF, "application/pdf"),
    ).rejects.toThrow("DEEP.SA alOCR could not read the file (unsupported file).");
    expect(failed.calls.at(-1)?.method).toBe("DELETE");

    const unread = recorded(
      json({ token: "t", status: "queued" }),
      json({
        status: "done",
        pages: [
          { page_num: 1, text: "ok" },
          { page_num: 2, error: "blurry" },
        ],
      }),
      new Response("gone", { status: 410 }),
    );
    await expect(
      makeOcrProvider(config, unread.runtime).read(PDF, "application/pdf"),
    ).rejects.toThrow("DEEP.SA alOCR could not read page 2 of the file.");
  });

  it("tests the connection with a job that was never made", async () => {
    const { calls, runtime } = recorded(
      new Response("not found", { status: 404 }),
      json({ error: "wrong scope" }, { status: 403 }),
    );
    const provider = makeOcrProvider(
      { ...config, settings: { baseUrl: "https://ocr.gov.example/v1/" } },
      runtime,
    );
    await expect(provider.testConnection()).resolves.toMatchObject({ ok: true });
    expect(calls[0]?.url).toBe("https://ocr.gov.example/v1/ocr/jobs/doedesk-connection-test");
    await expect(provider.testConnection()).resolves.toMatchObject({
      ok: false,
      kind: "auth",
      status: 403,
    });
  });
});

describe("Reducto", () => {
  const config: OcrProviderConfig = {
    provider: "reducto",
    settings: {},
    secrets: { apiKey: "reducto-key" },
  };
  const box = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    width,
    height,
    page: 1,
  });
  const ocr = {
    lines: [
      { text: "Sara Ahmed", bbox: box(0.1, 0.1, 0.4, 0.1) },
      { text: "Riyadh", bbox: box(0.125, 0.5, 0.25, 0.125) },
    ],
    words: [
      { text: "Sara", bbox: box(0.1, 0.1, 0.15, 0.1), confidence: 0.99 },
      { text: "Ahmed", bbox: box(0.3, 0.1, 0.2, 0.1), confidence: 0.95 },
      { text: "Riyadh", bbox: box(0.125, 0.5, 0.25, 0.125), confidence: 0.9, rotation: 90 },
    ],
  };
  const parsed = (result: unknown) =>
    json({ job_id: "job-1", duration: 1.2, usage: { num_pages: 1, credits: 1 }, result });
  const chunks = [
    { content: "# Letter", embed: "", blocks: [] },
    { content: "Sara Ahmed", embed: "", blocks: [] },
  ];

  it("uploads, then parses the upload, and reads the chunks", async () => {
    const { calls, runtime } = recorded(
      json({ file_id: "reducto://abc123" }),
      parsed({ type: "full", chunks }),
    );
    await expect(makeOcrProvider(config, runtime).read(PDF, "application/pdf")).resolves.toBe(
      "# Letter\n\nSara Ahmed",
    );
    const [upload, parse] = calls;
    expect([upload?.method, upload?.url]).toEqual(["POST", "https://platform.reducto.ai/upload"]);
    expect(upload?.headers.get("authorization")).toBe("Bearer reducto-key");
    expect(uploadedFile(upload).name).toBe("document.pdf");
    expect([parse?.method, parse?.url]).toEqual(["POST", "https://platform.reducto.ai/parse"]);
    expect(parse?.headers.get("authorization")).toBe("Bearer reducto-key");
    expect(parse?.json).toEqual({ input: "reducto://abc123" });
  });

  it("asks for word boxes for a picture and turns them into pixels", async () => {
    const { calls, runtime } = recorded(
      json({ file_id: "abc123" }),
      parsed({ type: "full", chunks, ocr }),
    );
    const answer = await makeOcrProvider(config, runtime).readLayout?.(PNG, "image/png");
    expect(calls[1]?.json).toEqual({
      input: "reducto://abc123",
      settings: { return_ocr_data: true },
    });
    expect(answer?.text).toBe("Sara Ahmed\nRiyadh");
    expect(checkedWords(answer ?? { text: "", layout: undefined })).toEqual([
      ["Sara", [100, 50, 250, 50, 250, 100, 100, 100]],
      ["Ahmed", [300, 50, 500, 50, 500, 100, 300, 100]],
      // Turned a quarter counterclockwise: the word's own top left is the box's bottom left.
      ["Riyadh", [125, 312.5, 125, 250, 375, 250, 375, 312.5]],
    ]);
    const layout = parseLayout(answer?.text ?? "", answer?.layout);
    expect(layout.pages[0]).toMatchObject({ width: 1000, height: 500, unit: "pixel" });
    expect(layout.pages[0]?.lines.map((line) => [line.offset, line.length])).toEqual([
      [0, 10],
      [11, 6],
    ]);
  });

  it("fetches a long result from its own address without the key", async () => {
    const { calls, runtime } = recorded(
      json({ file_id: "abc123" }),
      parsed({ type: "url", url: "https://results.example/r.json", result_id: "r" }),
      json({ type: "full", chunks }),
    );
    await expect(makeOcrProvider(config, runtime).read(PDF, "application/pdf")).resolves.toBe(
      "# Letter\n\nSara Ahmed",
    );
    expect(calls[2]?.url).toBe("https://results.example/r.json");
    expect(calls[2]?.headers.has("authorization")).toBe(false);
  });

  it("gives no layout for boxes that are not fractions of the page, or for a PDF", async () => {
    const pixels = recorded(
      json({ file_id: "abc123" }),
      parsed({
        type: "full",
        chunks,
        ocr: { lines: [], words: [{ text: "Sara", bbox: box(100, 50, 150, 50) }] },
      }),
    );
    const answer = await makeOcrProvider(config, pixels.runtime).readLayout?.(PNG, "image/png");
    expect(answer).toEqual({ text: "# Letter\n\nSara Ahmed", pages: 1, layout: undefined });

    const pdf = recorded(json({ file_id: "abc123" }), parsed({ type: "full", chunks }));
    const fromPdf = await makeOcrProvider(config, pdf.runtime).readLayout?.(PDF, "application/pdf");
    expect(pdf.calls[1]?.json).toEqual({ input: "reducto://abc123" });
    expect(fromPdf?.layout).toBeUndefined();
  });

  it("tests the connection with a job that was never made", async () => {
    const { calls, runtime } = recorded(
      new Response("not found", { status: 404 }),
      new Response("unauthorized", { status: 401 }),
    );
    const provider = makeOcrProvider(config, runtime);
    await expect(provider.testConnection()).resolves.toMatchObject({ ok: true });
    expect(calls[0]?.url).toBe("https://platform.reducto.ai/job/doedesk-connection-test");
    await expect(provider.testConnection()).resolves.toMatchObject({ ok: false, kind: "auth" });
  });
});

describe("Mistral OCR", () => {
  const config: OcrProviderConfig = {
    provider: "mistralOcr",
    settings: {},
    secrets: { apiKey: "mistral-key" },
  };
  const pages = {
    pages: [
      { index: 1, markdown: "Page two" },
      { index: 0, markdown: "# Page one" },
    ],
    model: "mistral-ocr-2505",
    usage_info: { pages_processed: 2, doc_size_bytes: 10 },
  };

  it("sends the file as a data URI and joins the pages", async () => {
    const { calls, runtime } = recorded(json(pages), json(pages));
    const provider = makeOcrProvider(config, runtime);
    await expect(provider.read(PDF, "application/pdf")).resolves.toBe("# Page one\n\nPage two");
    expect([calls[0]?.method, calls[0]?.url]).toEqual(["POST", "https://api.mistral.ai/v1/ocr"]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer mistral-key");
    expect(calls[0]?.json).toEqual({
      model: "mistral-ocr-latest",
      document: {
        type: "document_url",
        document_url: `data:application/pdf;base64,${PDF.toString("base64")}`,
      },
      include_image_base64: false,
    });
    await provider.read(PNG, "image/png");
    expect(calls[1]?.json.document).toEqual({
      type: "image_url",
      image_url: `data:image/png;base64,${PNG.toString("base64")}`,
    });
    expect(provider.readLayout).toBeUndefined();
  });

  it("says why the service did not answer", async () => {
    const cases: ReadonlyArray<
      readonly [ReadonlyArray<Response | Error>, { kind: string; status?: number }, number]
    > = [
      [[json({ message: "Unauthorized" }, { status: 401 })], { kind: "auth", status: 401 }, 1],
      [
        Array.from({ length: 4 }, () => new Response("slow down", { status: 429 })),
        { kind: "busy", status: 429 },
        4,
      ],
      [
        Array.from({ length: 4 }, () => new Response("oops", { status: 503 })),
        { kind: "failing", status: 503 },
        4,
      ],
      [[timedOut(), timedOut()], { kind: "timeout" }, 2],
      [Array.from({ length: 4 }, () => new TypeError("fetch failed")), { kind: "unreachable" }, 4],
      [[json({ detail: "Unprocessable" }, { status: 422 })], { kind: "refused", status: 422 }, 1],
      [[new Response("<html>", { status: 200 })], { kind: "unreadable" }, 1],
    ];
    for (const [answers, expected, tries] of cases) {
      const { calls, runtime } = recorded(...answers);
      const failure = await makeOcrProvider(config, runtime)
        .read(PNG, "image/png")
        .catch((cause: unknown) => cause);
      expect(failure, expected.kind).toBeInstanceOf(ProviderError);
      expect(failure, expected.kind).toMatchObject(expected);
      expect(calls, expected.kind).toHaveLength(tries);
      expect((failure as Error).message).not.toContain("mistral-key");
    }
  });

  it("tries again after a passing failure and then reads", async () => {
    const { calls, waits, runtime } = recorded(
      new Response("busy", { status: 429 }),
      new TypeError("fetch failed"),
      json(pages),
    );
    await expect(makeOcrProvider(config, runtime).read(PNG, "image/png")).resolves.toContain(
      "Page one",
    );
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 1500]);
  });

  it("tests the connection once, with the list of models", async () => {
    const { calls, runtime } = recorded(new Response("busy", { status: 429 }));
    await expect(makeOcrProvider(config, runtime).testConnection()).resolves.toMatchObject({
      ok: false,
      kind: "busy",
      host: "api.mistral.ai",
    });
    expect(calls.map((call) => call.url)).toEqual(["https://api.mistral.ai/v1/models"]);
  });
});

describe("Google Cloud Document AI", () => {
  const settings = { projectId: "my-project", location: "eu", processorId: "abc123" };
  const config: OcrProviderConfig = {
    provider: "googleDocumentAi",
    settings,
    secrets: { accessToken: "ya29.token" },
  };
  const processor =
    "https://eu-documentai.googleapis.com/v1/projects/my-project/locations/eu/processors/abc123";
  const vertices = (left: number, top: number, right: number, bottom: number) => ({
    vertices: [
      // Proto3 JSON leaves a zero out.
      left === 0 ? { y: top } : { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      left === 0 ? { y: bottom } : { x: left, y: bottom },
    ],
  });
  // Google counts in code points and gives a token with the space after it: "Sara " is 3..8
  // there and "Sara" is 5..9 here.
  const document = {
    text: "🙂🙂 Sara Ahmed\n",
    pages: [
      {
        pageNumber: 1,
        dimension: { width: 1000, height: 500, unit: "pixels" },
        tokens: [
          {
            layout: {
              textAnchor: { textSegments: [{ endIndex: "3" }] },
              confidence: 0.9,
              boundingPoly: vertices(0, 10, 30, 40),
            },
          },
          {
            layout: {
              textAnchor: { textSegments: [{ startIndex: "3", endIndex: "8" }] },
              confidence: 0.98,
              boundingPoly: vertices(40, 10, 120, 40),
            },
            styleInfo: { handwritten: true },
          },
          {
            layout: {
              textAnchor: { textSegments: [{ startIndex: "8", endIndex: "14" }] },
              confidence: 0.97,
              boundingPoly: {
                normalizedVertices: [
                  { x: 0.13, y: 0.02 },
                  { x: 0.2, y: 0.02 },
                  { x: 0.2, y: 0.08 },
                  { x: 0.13, y: 0.08 },
                ],
              },
            },
          },
        ],
        lines: [
          {
            layout: {
              textAnchor: { textSegments: [{ endIndex: "14" }] },
              boundingPoly: vertices(0, 10, 200, 40),
            },
          },
        ],
      },
    ],
  };

  it("processes the raw document and maps tokens to words in UTF-16 units", async () => {
    const { calls, runtime } = recorded(json({ document }));
    const answer = await makeOcrProvider(config, runtime).readLayout?.(PNG, "image/png");
    expect([calls[0]?.method, calls[0]?.url]).toEqual(["POST", `${processor}:process`]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer ya29.token");
    expect(calls[0]?.json).toEqual({
      rawDocument: { content: PNG.toString("base64"), mimeType: "image/png" },
      skipHumanReview: true,
      fieldMask: "text,pages.pageNumber,pages.dimension,pages.transforms,pages.tokens,pages.lines",
    });
    const layout = parseLayout(answer?.text ?? "", answer?.layout);
    expect(layout.pages[0]).toMatchObject({ page: 1, width: 1000, height: 500, unit: "pixel" });
    expect(layout.pages[0]?.words).toEqual([
      {
        text: "🙂🙂",
        polygon: [0, 10, 30, 10, 30, 40, 0, 40],
        confidence: 0.9,
        offset: 0,
        length: 4,
      },
      {
        text: "Sara",
        polygon: [40, 10, 120, 10, 120, 40, 40, 40],
        confidence: 0.98,
        offset: 5,
        length: 4,
      },
      {
        text: "Ahmed",
        polygon: [130, 10, 200, 10, 200, 40, 130, 40],
        confidence: 0.97,
        offset: 10,
        length: 5,
      },
    ]);
    expect(layout.pages[0]?.lines).toEqual([
      { polygon: [0, 10, 200, 10, 200, 40, 0, 40], offset: 0, length: 15 },
    ]);
    expect(layout.handwritten).toEqual([{ offset: 5, length: 4, confidence: 0.98 }]);
  });

  it("reads text with an API key and a processor version, asking for the text alone", async () => {
    const { calls, runtime } = recorded(
      json({ document: { text: "Hello", pages: [{ pageNumber: 1 }] } }),
    );
    const provider = makeOcrProvider(
      {
        provider: "googleDocumentAi",
        settings: { ...settings, processorVersion: "pretrained-ocr-v2.0-2023-06-02" },
        secrets: { apiKey: "AIza-key" },
      },
      runtime,
    );
    await expect(provider.read(PDF, "application/pdf")).resolves.toBe("Hello");
    expect(calls[0]?.url).toBe(
      `${processor}/processorVersions/pretrained-ocr-v2.0-2023-06-02:process`,
    );
    expect(calls[0]?.headers.get("x-goog-api-key")).toBe("AIza-key");
    expect(calls[0]?.headers.has("authorization")).toBe(false);
    expect(calls[0]?.json.fieldMask).toBe("text,pages.pageNumber");
  });

  it("gives no layout for a page Google straightened", async () => {
    const straightened = {
      ...document,
      pages: [{ ...document.pages[0], transforms: [{ rows: 2, cols: 3, type: 6, data: "AAAA" }] }],
    };
    const { runtime } = recorded(json({ document: straightened }));
    const answer = await makeOcrProvider(config, runtime).readLayout?.(PNG, "image/png");
    expect(answer).toEqual({ text: "🙂🙂 Sara Ahmed\n", pages: 1, layout: undefined });
  });

  it("tests the connection by looking the processor up, and asks for sign-in first", async () => {
    const { calls, runtime } = recorded(json({ name: "processor", state: "ENABLED" }));
    await expect(makeOcrProvider(config, runtime).testConnection()).resolves.toMatchObject({
      ok: true,
    });
    expect([calls[0]?.method, calls[0]?.url]).toEqual(["GET", processor]);

    const none = recorded();
    await expect(
      makeOcrProvider({ ...config, secrets: {} }, none.runtime).testConnection(),
    ).resolves.toMatchObject({ ok: false, kind: "misconfigured" });
    expect(none.calls).toHaveLength(0);
  });
});

describe("AWS Textract", () => {
  const config: OcrProviderConfig = { provider: "awsTextract", ...AWS_KEYS };
  const geometry = (left: number, top: number, width: number, height: number) => ({
    BoundingBox: { Left: left, Top: top, Width: width, Height: height },
    Polygon: [
      { X: left, Y: top },
      { X: left + width, Y: top },
      { X: left + width, Y: top + height },
      { X: left, Y: top + height },
    ],
  });
  const blocks = {
    DocumentMetadata: { Pages: 1 },
    Blocks: [
      { BlockType: "PAGE", Id: "p", Relationships: [{ Type: "CHILD", Ids: ["l1", "l2"] }] },
      {
        BlockType: "LINE",
        Id: "l1",
        Text: "Sara Ahmed",
        Geometry: geometry(0.1, 0.1, 0.4, 0.1),
        Relationships: [{ Type: "CHILD", Ids: ["w1", "w2"] }],
      },
      {
        BlockType: "LINE",
        Id: "l2",
        Text: "Riyadh",
        Geometry: geometry(0.125, 0.5, 0.25, 0.125),
        Relationships: [{ Type: "CHILD", Ids: ["w3"] }],
      },
      {
        BlockType: "WORD",
        Id: "w1",
        Text: "Sara",
        Confidence: 99.5,
        TextType: "PRINTED",
        Geometry: geometry(0.1, 0.1, 0.15, 0.1),
      },
      {
        BlockType: "WORD",
        Id: "w2",
        Text: "Ahmed",
        Confidence: 98,
        TextType: "HANDWRITING",
        Geometry: geometry(0.3, 0.1, 0.2, 0.1),
      },
      {
        BlockType: "WORD",
        Id: "w3",
        Text: "Riyadh",
        Confidence: 90,
        TextType: "PRINTED",
        Geometry: { BoundingBox: { Left: 0.125, Top: 0.5, Width: 0.25, Height: 0.125 } },
      },
    ],
  };

  it("signs DetectDocumentText and maps LINE and WORD blocks to pixels", async () => {
    const { calls, runtime } = recorded(json(blocks));
    const answer = await makeOcrProvider(config, runtime).readLayout?.(PNG, "image/png");
    const [sent] = calls;
    expect([sent?.method, sent?.url]).toEqual([
      "POST",
      "https://textract.me-central-1.amazonaws.com/",
    ]);
    expect(sent?.headers.get("x-amz-target")).toBe("Textract.DetectDocumentText");
    expect(sent?.headers.get("content-type")).toBe("application/x-amz-json-1.1");
    expect(sent?.headers.get("authorization")).toContain(
      "Credential=AKIDEXAMPLE/20261127/me-central-1/textract/aws4_request",
    );
    expect(sent?.headers.get("authorization")).not.toContain(AWS_KEYS.secrets.secretAccessKey);
    expect(sent?.json).toEqual({ Document: { Bytes: PNG.toString("base64") } });

    expect(answer?.text).toBe("Sara Ahmed\nRiyadh");
    const layout = parseLayout(answer?.text ?? "", answer?.layout);
    expect(layout.pages[0]).toMatchObject({ page: 1, width: 1000, height: 500, unit: "pixel" });
    expect(layout.pages[0]?.words).toEqual([
      {
        text: "Sara",
        polygon: [100, 50, 250, 50, 250, 100, 100, 100],
        confidence: 0.995,
        offset: 0,
        length: 4,
      },
      {
        text: "Ahmed",
        polygon: [300, 50, 500, 50, 500, 100, 300, 100],
        confidence: 0.98,
        offset: 5,
        length: 5,
      },
      // No polygon given: the bounding box stands in.
      {
        text: "Riyadh",
        polygon: [125, 250, 375, 250, 375, 312.5, 125, 312.5],
        confidence: 0.9,
        offset: 11,
        length: 6,
      },
    ]);
    expect(layout.pages[0]?.lines).toEqual([
      { polygon: [100, 50, 500, 50, 500, 100, 100, 100], offset: 0, length: 10 },
      { polygon: [125, 250, 375, 250, 375, 312.5, 125, 312.5], offset: 11, length: 6 },
    ]);
    expect(layout.handwritten).toEqual([{ offset: 5, length: 5, confidence: 0.98 }]);
  });

  it("reads the lines as text, and gives no layout without the picture's size", async () => {
    const { runtime } = recorded(json(blocks), json(blocks));
    const provider = makeOcrProvider(
      { ...config, secrets: { ...config.secrets, sessionToken: "session" } },
      runtime,
    );
    await expect(provider.read(PNG, "image/png")).resolves.toBe("Sara Ahmed\nRiyadh");
    await expect(provider.readLayout?.(PDF, "application/pdf")).resolves.toEqual({
      text: "Sara Ahmed\nRiyadh",
      pages: 1,
      layout: undefined,
    });
  });

  it("tests the connection by reading a blank page, once", async () => {
    const { calls, runtime } = recorded(
      json({ __type: "AccessDeniedException", Message: "not allowed" }, { status: 400 }),
    );
    await expect(makeOcrProvider(config, runtime).testConnection()).resolves.toMatchObject({
      ok: false,
      kind: "auth",
      status: 400,
    });
    expect(calls).toHaveLength(1);
    // A file AWS can open: a white square with nothing written in it.
    const body = calls[0]?.json as { readonly Document: { readonly Bytes: string } } | undefined;
    const sent = Buffer.from(body?.Document.Bytes ?? "", "base64");
    const { raster } = await decodeImage(sent);
    expect([raster.width, raster.height]).toEqual([64, 64]);
    expect(raster.data.every((value) => value === 255)).toBe(true);
  });
});

describe("a choice that cannot be called", () => {
  it("is refused before anything is sent", async () => {
    const { calls, runtime } = recorded();
    const provider = makeOcrProvider(
      {
        provider: "azureDocumentIntelligence",
        settings: { endpoint: "contoso" },
        secrets: { apiKey: "k" },
      },
      runtime,
    );
    await expect(provider.read(PNG, "image/png")).rejects.toMatchObject({ kind: "misconfigured" });
    await expect(provider.testConnection()).resolves.toMatchObject({
      ok: false,
      kind: "misconfigured",
    });
    expect(calls).toHaveLength(0);
  });
});
