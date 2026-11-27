/**
 * Document reading by the service an organisation chose. Every adapter is a `Reader`. A service
 * that places words some other way than in pixels of the picture it was sent gives no layout:
 * the image is then withheld, which is what an unchecked position must lead to.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import { makeRemoteReader, type Reader, type ReaderUsage } from "../reader.ts";
import type { LayoutLine, LayoutWord, OcrLayout, Polygon } from "../redaction/layout.ts";
import { sanitizeIngestedText } from "../worker/sanitize.ts";
import { callAwsJson } from "./awsSigV4.ts";
import { makeGoogleAuth } from "./googleAuth.ts";
import {
  asArray,
  asRecord,
  checkHealth,
  finite,
  hostOf,
  readJson,
  recordsOf,
  requireUrl,
  send,
  sleepOf,
  unreadable,
} from "./http.ts";
import { type ImageSize, imageSize } from "./imageSize.ts";
import { codePointsToUtf16 } from "./offsets.ts";
import {
  type OcrProvider,
  type OcrProviderConfig,
  ProviderError,
  type ProviderRuntime,
} from "./types.ts";

export const DOEDESK_CLOUD_URL = "https://api.doedesk.com";
const DEEP_SA_URL = "https://alapi.deep.sa/v1";
const REDUCTO_URL = "https://platform.reducto.ai";
const MISTRAL_URL = "https://api.mistral.ai/v1";
const MISTRAL_OCR_MODEL = "mistral-ocr-latest";
const AZURE_API_VERSION = "2024-11-30";

/** A file is read for this long at most by a service that answers when it is done. */
const READ_TIMEOUT_MS = 120_000;
/** A service that is asked again until it is done is asked for about five minutes. */
const MAX_POLLS = 150;

type ChoiceOf<Id extends OcrProviderConfig["provider"]> = Extract<
  OcrProviderConfig,
  { readonly provider: Id }
>;

interface ReadResult {
  readonly text: string;
  readonly pages: number;
  /** Absent when the service gave no word positions that can be checked. */
  readonly layout?: unknown;
}

type Read = (bytes: Buffer, mediaType: string, layout: boolean) => Promise<ReadResult>;

/** What a reader is given besides its choice. */
export interface OcrRuntime extends ProviderRuntime {
  /** Told about each file a service read, for the record of what was sent where. */
  readonly onRead?: ((read: ReaderUsage) => void) | undefined;
}

/** Only plain reading is cleaned: a layout's word positions are offsets into its text as sent. */
const readerOf = (runtime: OcrRuntime, read: Read, layout: boolean): Reader => {
  const told = async (bytes: Buffer, mediaType: string, wantLayout: boolean) => {
    const answer = await read(bytes, mediaType, wantLayout);
    runtime.onRead?.({
      mediaType,
      bytes: bytes.length,
      characters: answer.text.length,
      pages: answer.pages,
    });
    return answer;
  };
  return {
    read: async (bytes, mediaType) =>
      sanitizeIngestedText((await told(bytes, mediaType, false)).text),
    ...(layout
      ? {
          readLayout: async (bytes, mediaType) => {
            const answer = await told(bytes, mediaType, true);
            return { text: answer.text, pages: answer.pages, layout: answer.layout };
          },
        }
      : {}),
  };
};

const EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/tiff": "tiff",
  "image/bmp": "bmp",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
};

const uploadForm = (bytes: Buffer, mediaType: string): FormData => {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: mediaType }),
    `document.${EXTENSIONS[mediaType] ?? "bin"}`,
  );
  return form;
};

/** A white square: a file every reading service takes, with nothing in it to read. */
const blankPng = (): Buffer => {
  const side = 64;
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const framed = Buffer.alloc(body.length + 8);
    framed.writeUInt32BE(data.length, 0);
    body.copy(framed, 4);
    framed.writeUInt32BE(NodeZlib.crc32(body), body.length + 4);
    return framed;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.writeUInt8(8, 8);
  const row = Buffer.alloc(side + 1, 0xff);
  row.writeUInt8(0, 0);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(Buffer.concat(Array.from({ length: side }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

const accepted = (service: string, host: string | undefined): string =>
  `${service}${host === undefined ? "" : ` at ${host}`} answered and accepted the key.`;

/** Four corners as the eight numbers a layout keeps. */
const polygonOf = (corners: ReadonlyArray<readonly [number, number]>): Polygon | undefined => {
  const flat = corners.flat();
  return flat.length === 8 && flat.every(Number.isFinite)
    ? (flat as unknown as Polygon)
    : undefined;
};

const boxPolygon = (
  left: number,
  top: number,
  right: number,
  bottom: number,
  quarterTurns = 0,
): Polygon => {
  const corners = [left, top, right, top, right, bottom, left, bottom];
  // A word turned counterclockwise has its own top left at the picture's bottom left, and so on.
  const first = ((((4 - quarterTurns) % 4) + 4) % 4) * 2;
  return [...corners.slice(first), ...corners.slice(0, first)] as unknown as Polygon;
};

interface PlacedWord {
  readonly text: string;
  readonly polygon: Polygon;
  readonly confidence: number;
  readonly handwritten?: boolean | undefined;
}

/** The box around a line's words, for a service that did not place the line itself. */
const around = (words: ReadonlyArray<PlacedWord>): Polygon => {
  const xs = words.flatMap(({ polygon }) => [polygon[0], polygon[2], polygon[4], polygon[6]]);
  const ys = words.flatMap(({ polygon }) => [polygon[1], polygon[3], polygon[5], polygon[7]]);
  return boxPolygon(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
};

/**
 * Writes lines of placed words out as one text and says where in it each word stands. For a
 * service that gives words and places but no text with positions of its own.
 */
const composeLayout = (
  size: ImageSize,
  lines: ReadonlyArray<{
    readonly polygon?: Polygon | undefined;
    readonly words: ReadonlyArray<PlacedWord>;
  }>,
): { readonly text: string; readonly layout: OcrLayout } => {
  let text = "";
  const words: Array<LayoutWord> = [];
  const placedLines: Array<LayoutLine> = [];
  const handwritten: Array<OcrLayout["handwritten"][number]> = [];
  for (const line of lines) {
    const kept = line.words.filter((word) => word.text !== "");
    if (kept.length === 0) continue;
    if (text !== "") text += "\n";
    const lineOffset = text.length;
    kept.forEach((word, index) => {
      if (index > 0) text += " ";
      const span = { offset: text.length, length: word.text.length };
      words.push({ text: word.text, polygon: word.polygon, confidence: word.confidence, ...span });
      if (word.handwritten === true) handwritten.push({ ...span, confidence: word.confidence });
      text += word.text;
    });
    placedLines.push({
      polygon: line.polygon ?? around(kept),
      offset: lineOffset,
      length: text.length - lineOffset,
    });
  }
  return {
    text,
    layout: {
      pages: [{ page: 1, ...size, unit: "pixel", angle: 0, words, lines: placedLines }],
      handwritten,
    },
  };
};

const doedeskService = (
  id: "doedeskCloud" | "custom",
  endpoint: string,
  token: string | undefined,
  runtime: OcrRuntime,
): OcrProvider => {
  const reader = makeRemoteReader({
    endpoint,
    token,
    fetch: runtime.fetch,
    onRead: runtime.onRead,
  });
  return {
    id,
    ...reader,
    testConnection: () =>
      checkHealth(async () => {
        await reader.read(blankPng(), "image/png");
        return `The reading service at ${hostOf(endpoint) ?? endpoint} answered.`;
      }, hostOf(endpoint)),
  };
};

/**
 * Azure AI Document Intelligence, v4.0.
 * https://learn.microsoft.com/rest/api/aiservices/document-models/analyze-document
 */
const azureDocumentIntelligence = (
  { settings, secrets }: ChoiceOf<"azureDocumentIntelligence">,
  runtime: OcrRuntime,
): OcrProvider => {
  const service = "Azure Document Intelligence";
  const headers = { "ocp-apim-subscription-key": secrets.apiKey };
  const sleep = sleepOf(runtime);

  const analyze = async (bytes: Buffer): Promise<Record<string, unknown>> => {
    const base = `${requireUrl(service, settings.endpoint)}/documentintelligence`;
    // Without `stringIndexType` Azure counts in text elements, and every span would be off.
    const url = `${base}/documentModels/${settings.model ?? "prebuilt-read"}:analyze?api-version=${AZURE_API_VERSION}&stringIndexType=utf16CodeUnit`;
    const started = await send({
      service,
      runtime,
      timeoutMs: READ_TIMEOUT_MS,
      request: () => ({
        url,
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ base64Source: bytes.toString("base64") }),
      }),
    });
    const operation = started.headers.get("operation-location");
    // The key is only ever sent back to the resource it belongs to.
    if (operation === null || hostOf(operation) !== hostOf(url)) {
      throw unreadable(service, url, "it did not say where the result will be");
    }
    for (let polls = 0; polls < MAX_POLLS; polls += 1) {
      const response = await send({
        service,
        runtime,
        request: () => ({ url: operation, headers }),
      });
      const body = await readJson(response, service, operation);
      if (body.status === "succeeded") {
        const result = asRecord(body.analyzeResult);
        if (result === undefined) throw unreadable(service, operation);
        return result;
      }
      if (body.status !== "running" && body.status !== "notStarted") {
        const said = asRecord(body.error)?.message;
        throw new ProviderError(
          `${service} could not read the file${typeof said === "string" ? ` (${said.slice(0, 300)})` : ""}.`,
          { kind: "refused", host: hostOf(url) },
        );
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : 1000);
    }
    throw new ProviderError(`${service} was still reading the file after several minutes.`, {
      kind: "timeout",
      host: hostOf(url),
    });
  };

  /** DoeDesk's layout is Azure's with shorter names: values pass through and are checked later. */
  const layoutOf = (result: Record<string, unknown>) => ({
    pages: recordsOf(result.pages).map((page) => ({
      page: page.pageNumber,
      width: page.width,
      height: page.height,
      unit: page.unit,
      angle: page.angle,
      words: recordsOf(page.words).map((word) => ({
        text: word.content,
        polygon: word.polygon,
        confidence: word.confidence,
        ...asRecord(word.span),
      })),
      lines: recordsOf(page.lines).map((line) => ({
        polygon: line.polygon,
        ...recordsOf(line.spans)[0],
      })),
    })),
    handwritten: recordsOf(result.styles)
      .filter((style) => style.isHandwritten === true)
      .flatMap((style) =>
        recordsOf(style.spans).map((span) => ({ ...span, confidence: style.confidence })),
      ),
  });

  return {
    id: "azureDocumentIntelligence",
    ...readerOf(
      runtime,
      async (bytes) => {
        const result = await analyze(bytes);
        if (typeof result.content !== "string") {
          throw unreadable(service, settings.endpoint, "it gave no text");
        }
        const pages = asArray(result.pages);
        return {
          text: result.content,
          pages: Math.max(1, pages.length),
          ...(pages.length > 0 ? { layout: layoutOf(result) } : {}),
        };
      },
      true,
    ),
    testConnection: () =>
      checkHealth(async () => {
        const url = `${requireUrl(service, settings.endpoint)}/documentintelligence/info?api-version=${AZURE_API_VERSION}`;
        await send({
          service,
          runtime: { ...runtime, retry: false },
          request: () => ({ url, headers }),
        });
        return accepted(service, hostOf(url));
      }, hostOf(settings.endpoint)),
  };
};

/**
 * DEEP.SA's alOCR: a file is uploaded, then its job is asked for until it is done.
 * https://alapi.deep.sa/docs/ocr
 *
 * It places lines, not words, and does not document the unit of a line's box, so it gives text
 * only. The job is deleted once read: DEEP.SA otherwise keeps the document for thirty days.
 */
const deepSa = ({ settings, secrets }: ChoiceOf<"deepSa">, runtime: OcrRuntime): OcrProvider => {
  const service = "DEEP.SA alOCR";
  const headers = { authorization: `Bearer ${secrets.apiKey}` };
  const sleep = sleepOf(runtime);
  const base = () => requireUrl(service, settings.baseUrl ?? DEEP_SA_URL);

  const finished = async (jobUrl: string): Promise<Record<string, unknown>> => {
    for (let polls = 0; polls < MAX_POLLS; polls += 1) {
      const response = await send({ service, runtime, request: () => ({ url: jobUrl, headers }) });
      const job = await readJson(response, service, jobUrl);
      if (job.status === "done") return job;
      if (job.status === "failed") {
        const said = typeof job.error === "string" ? job.error : asRecord(job.error)?.message;
        throw new ProviderError(
          `${service} could not read the file${typeof said === "string" ? ` (${said.slice(0, 300)})` : ""}.`,
          { kind: "refused", host: hostOf(jobUrl) },
        );
      }
      await sleep(2000);
    }
    throw new ProviderError(`${service} was still reading the file after several minutes.`, {
      kind: "timeout",
      host: hostOf(jobUrl),
    });
  };

  return {
    id: "deepSa",
    ...readerOf(
      runtime,
      async (bytes, mediaType) => {
        const uploadUrl = `${base()}/ocr/upload`;
        // An upload that is tried again must not start, and be charged as, a second job.
        const once = { ...headers, "idempotency-key": NodeCrypto.randomUUID() };
        const upload = await readJson(
          await send({
            service,
            runtime,
            timeoutMs: READ_TIMEOUT_MS,
            request: () => ({
              url: uploadUrl,
              method: "POST",
              headers: once,
              body: uploadForm(bytes, mediaType),
            }),
          }),
          service,
          uploadUrl,
        );
        if (typeof upload.token !== "string" || upload.token === "") {
          throw unreadable(service, uploadUrl, "it gave no job to follow");
        }
        const jobUrl = `${base()}/ocr/jobs/${encodeURIComponent(upload.token)}`;
        try {
          const job = await finished(jobUrl);
          if (!Array.isArray(job.pages)) throw unreadable(service, jobUrl, "it gave no pages");
          const pages = recordsOf(job.pages).toSorted(
            (left, right) => (finite(left.page_num) ?? 0) - (finite(right.page_num) ?? 0),
          );
          // A page left out would pass for the whole document: the file is not read in part.
          const unread = pages.find(
            (page) => typeof page.text !== "string" || (page.error ?? null) !== null,
          );
          if (unread !== undefined) {
            const which =
              finite(unread.page_num) === undefined ? "a page" : `page ${unread.page_num}`;
            throw new ProviderError(`${service} could not read ${which} of the file.`, {
              kind: "refused",
              host: hostOf(jobUrl),
            });
          }
          return {
            text: pages.map((page) => page.text).join("\n\n"),
            pages: Math.max(1, finite(job.total_pages) ?? pages.length),
          };
        } finally {
          await send({
            service,
            runtime: { ...runtime, retry: false },
            request: () => ({ url: jobUrl, method: "DELETE", headers }),
          }).catch(() => undefined);
        }
      },
      false,
    ),
    testConnection: () =>
      checkHealth(
        async () => {
          // A job that was never made: a key that may read documents is answered "not found".
          const url = `${base()}/ocr/jobs/doedesk-connection-test`;
          await send({
            service,
            runtime: { ...runtime, retry: false },
            accept: (status) => status === 404,
            request: () => ({ url, headers }),
          });
          return accepted(service, hostOf(url));
        },
        hostOf(settings.baseUrl ?? DEEP_SA_URL),
      ),
  };
};

const unitBox = (
  value: unknown,
):
  | {
      readonly left: number;
      readonly top: number;
      readonly right: number;
      readonly bottom: number;
      readonly page: number;
    }
  | undefined => {
  const box = asRecord(value);
  const left = finite(box?.left);
  const top = finite(box?.top);
  const width = finite(box?.width);
  const height = finite(box?.height);
  if (left === undefined || top === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  const inUnit = (edge: number) => edge >= -0.001 && edge <= 1.001;
  if (![left, top, left + width, top + height].every(inUnit)) return undefined;
  return { left, top, right: left + width, bottom: top + height, page: finite(box?.page) ?? 1 };
};

/**
 * Reducto: upload, then parse.
 * https://docs.reducto.ai/api-reference/upload and https://docs.reducto.ai/api-reference/parse
 */
const reducto = ({ settings, secrets }: ChoiceOf<"reducto">, runtime: OcrRuntime): OcrProvider => {
  const service = "Reducto";
  const headers = { authorization: `Bearer ${secrets.apiKey}` };
  const base = () => requireUrl(service, settings.baseUrl ?? REDUCTO_URL);

  /** Reducto places words as fractions of the page: a picture's size turns them into pixels. */
  const layoutOf = (ocr: unknown, size: ImageSize) => {
    const lineBoxes = recordsOf(asRecord(ocr)?.lines).map((line) => unitBox(line.bbox));
    const lines: Array<{ polygon?: Polygon; words: Array<PlacedWord> }> = [];
    const lineOf = new Map<number, number>();
    for (const word of recordsOf(asRecord(ocr)?.words)) {
      const box = unitBox(word.bbox);
      // One word without a usable place leaves text that cannot be covered: no layout at all.
      if (box === undefined || box.page !== 1 || typeof word.text !== "string") return undefined;
      const placed: PlacedWord = {
        text: word.text.trim(),
        polygon: boxPolygon(
          box.left * size.width,
          box.top * size.height,
          box.right * size.width,
          box.bottom * size.height,
          Math.round((finite(word.rotation) ?? 0) / 90),
        ),
        confidence: finite(word.confidence) ?? 0,
      };
      const centreX = (box.left + box.right) / 2;
      const centreY = (box.top + box.bottom) / 2;
      const within = lineBoxes.findIndex(
        (line) =>
          line !== undefined &&
          line.page === 1 &&
          centreX >= line.left &&
          centreX <= line.right &&
          centreY >= line.top &&
          centreY <= line.bottom,
      );
      const existing = within === -1 ? undefined : lineOf.get(within);
      if (existing !== undefined) {
        lines[existing]?.words.push(placed);
        continue;
      }
      if (within !== -1) lineOf.set(within, lines.length);
      lines.push({ words: [placed] });
    }
    return composeLayout(size, lines);
  };

  return {
    id: "reducto",
    ...readerOf(
      runtime,
      async (bytes, mediaType, wantLayout) => {
        const uploadUrl = `${base()}/upload`;
        const upload = await readJson(
          await send({
            service,
            runtime,
            timeoutMs: READ_TIMEOUT_MS,
            request: () => ({
              url: uploadUrl,
              method: "POST",
              headers,
              body: uploadForm(bytes, mediaType),
            }),
          }),
          service,
          uploadUrl,
        );
        const fileId = upload.file_id;
        if (typeof fileId !== "string" || fileId === "") {
          throw unreadable(service, uploadUrl, "it gave no file to parse");
        }
        const size = wantLayout ? imageSize(bytes) : undefined;
        const parseUrl = `${base()}/parse`;
        const parsed = await readJson(
          await send({
            service,
            runtime,
            timeoutMs: READ_TIMEOUT_MS,
            request: () => ({
              url: parseUrl,
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({
                input: fileId.startsWith("reducto://") ? fileId : `reducto://${fileId}`,
                ...(size === undefined ? {} : { settings: { return_ocr_data: true } }),
              }),
            }),
          }),
          service,
          parseUrl,
        );
        let result: unknown = parsed.result;
        const link = asRecord(result);
        // A long result is kept at a signed address of its own. The key is not sent there.
        if (link?.type === "url") {
          if (typeof link.url !== "string" || !link.url.startsWith("https://")) {
            throw unreadable(service, parseUrl, "it gave no result");
          }
          const resultUrl = link.url;
          result = await (
            await send({
              service,
              runtime,
              timeoutMs: READ_TIMEOUT_MS,
              request: () => ({ url: resultUrl }),
            })
          )
            .json()
            .catch(() => undefined);
        }
        const chunks = Array.isArray(result) ? result : asRecord(result)?.chunks;
        if (!Array.isArray(chunks)) throw unreadable(service, parseUrl, "it gave no text");
        const pages = Math.max(1, finite(asRecord(parsed.usage)?.num_pages) ?? 1);
        const composed =
          size === undefined || pages !== 1 ? undefined : layoutOf(asRecord(result)?.ocr, size);
        if (composed !== undefined && composed.text !== "") return { ...composed, pages };
        return {
          text: recordsOf(chunks)
            .map((chunk) => (typeof chunk.content === "string" ? chunk.content : ""))
            .filter((content) => content !== "")
            .join("\n\n"),
          pages,
        };
      },
      true,
    ),
    testConnection: () =>
      checkHealth(
        async () => {
          // A job that was never made: a key Reducto knows is answered "not found", not "unauthorized".
          const url = `${base()}/job/doedesk-connection-test`;
          await send({
            service,
            runtime: { ...runtime, retry: false },
            accept: (status) => status === 404 || status === 422 || status === 400,
            request: () => ({ url, headers }),
          });
          return accepted(service, hostOf(url));
        },
        hostOf(settings.baseUrl ?? REDUCTO_URL),
      ),
  };
};

/**
 * Mistral OCR. It gives each page as Markdown and places no words.
 * https://docs.mistral.ai/api/#tag/ocr
 */
const mistralOcr = (
  { settings, secrets }: ChoiceOf<"mistralOcr">,
  runtime: OcrRuntime,
): OcrProvider => {
  const service = "Mistral OCR";
  const headers = { authorization: `Bearer ${secrets.apiKey}` };
  const base = () => requireUrl(service, settings.baseUrl ?? MISTRAL_URL);
  return {
    id: "mistralOcr",
    ...readerOf(
      runtime,
      async (bytes, mediaType) => {
        const url = `${base()}/ocr`;
        const data = `data:${mediaType};base64,${bytes.toString("base64")}`;
        const body = await readJson(
          await send({
            service,
            runtime,
            timeoutMs: READ_TIMEOUT_MS,
            request: () => ({
              url,
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({
                model: settings.model?.trim() || MISTRAL_OCR_MODEL,
                document: mediaType.startsWith("image/")
                  ? { type: "image_url", image_url: data }
                  : { type: "document_url", document_url: data },
                include_image_base64: false,
              }),
            }),
          }),
          service,
          url,
        );
        if (!Array.isArray(body.pages)) throw unreadable(service, url, "it gave no pages");
        const pages = recordsOf(body.pages).toSorted(
          (left, right) => (finite(left.index) ?? 0) - (finite(right.index) ?? 0),
        );
        return {
          text: pages
            .map((page) => (typeof page.markdown === "string" ? page.markdown : ""))
            .join("\n\n"),
          pages: Math.max(1, finite(asRecord(body.usage_info)?.pages_processed) ?? pages.length),
        };
      },
      false,
    ),
    testConnection: () =>
      checkHealth(
        async () => {
          const url = `${base()}/models`;
          await send({
            service,
            runtime: { ...runtime, retry: false },
            request: () => ({ url, headers }),
          });
          return accepted(service, hostOf(url));
        },
        hostOf(settings.baseUrl ?? MISTRAL_URL),
      ),
  };
};

/**
 * Google Cloud Document AI, `processors.process`.
 * https://cloud.google.com/document-ai/docs/reference/rest/v1/projects.locations.processors/process
 */
const googleDocumentAi = (
  { settings, secrets }: ChoiceOf<"googleDocumentAi">,
  runtime: OcrRuntime,
): OcrProvider => {
  const service = "Google Document AI";
  const auth = makeGoogleAuth(service, secrets, runtime);
  const processor = () => {
    const { projectId, location, processorId } = settings;
    if (![projectId, location, processorId].every((part) => /^[\w-]+$/.test(part))) {
      throw new ProviderError(
        `${service} needs a project, a location and a processor ID. Check them in Settings, under Privacy.`,
        { kind: "misconfigured" },
      );
    }
    const root = settings.endpoint?.trim()
      ? requireUrl(service, settings.endpoint)
      : `https://${location}-documentai.googleapis.com`;
    return `${root}/v1/projects/${projectId}/locations/${location}/processors/${processorId}`;
  };

  /** Proto3 JSON writes a 64-bit number as a string and leaves a zero out. */
  const count = (value: unknown): number => (value === undefined ? 0 : Number(value));

  const layoutOf = (text: string, pages: ReadonlyArray<Record<string, unknown>>) => {
    const toUnits = codePointsToUtf16(text);
    /** Where a layout's text stands, without the space or line break Google counts with it. */
    const spanOf = (layout: Record<string, unknown> | undefined) => {
      const segments = recordsOf(asRecord(layout?.textAnchor)?.textSegments);
      let start = toUnits(Math.min(...segments.map((segment) => count(segment.startIndex))));
      let end = toUnits(Math.max(...segments.map((segment) => count(segment.endIndex))));
      if (start === undefined || end === undefined) return undefined;
      while (start < end && /\s/u.test(text[start] ?? "")) start += 1;
      while (end > start && /\s/u.test(text[end - 1] ?? "")) end -= 1;
      return end > start ? { offset: start, length: end - start } : undefined;
    };
    const placeOf = (layout: Record<string, unknown> | undefined, size: ImageSize) => {
      const poly = asRecord(layout?.boundingPoly);
      const pixels = recordsOf(poly?.vertices);
      const fractions = recordsOf(poly?.normalizedVertices);
      const corners =
        pixels.length === 4
          ? pixels.map((vertex) => [count(vertex.x), count(vertex.y)])
          : fractions.length === 4
            ? fractions.map((vertex) => [
                count(vertex.x) * size.width,
                count(vertex.y) * size.height,
              ])
            : undefined;
      return corners?.flat();
    };
    const handwritten: Array<Record<string, unknown>> = [];
    const placed = pages.map((page) => {
      const dimension = asRecord(page.dimension);
      const size = { width: count(dimension?.width), height: count(dimension?.height) };
      return {
        page: page.pageNumber,
        ...size,
        unit: dimension?.unit === "pixels" ? "pixel" : dimension?.unit,
        angle: 0,
        words: recordsOf(page.tokens).flatMap((token) => {
          const layout = asRecord(token.layout);
          const span = spanOf(layout);
          if (span === undefined) return [];
          const confidence = finite(layout?.confidence) ?? 0;
          if (asRecord(token.styleInfo)?.handwritten === true)
            handwritten.push({ ...span, confidence });
          return [
            {
              text: text.substr(span.offset, span.length),
              polygon: placeOf(layout, size),
              confidence,
              ...span,
            },
          ];
        }),
        lines: recordsOf(page.lines).flatMap((line) => {
          const layout = asRecord(line.layout);
          const span = spanOf(layout);
          return span === undefined ? [] : [{ polygon: placeOf(layout, size), ...span }];
        }),
      };
    });
    return { pages: placed, handwritten };
  };

  return {
    id: "googleDocumentAi",
    ...readerOf(
      runtime,
      async (bytes, mediaType, wantLayout) => {
        const base = processor();
        const url = `${
          settings.processorVersion?.trim()
            ? `${base}/processorVersions/${encodeURIComponent(settings.processorVersion.trim())}`
            : base
        }:process`;
        const body = await readJson(
          await send({
            service,
            runtime,
            timeoutMs: READ_TIMEOUT_MS,
            request: async () => ({
              url,
              method: "POST",
              headers: { ...(await auth()), "content-type": "application/json" },
              body: JSON.stringify({
                rawDocument: { content: bytes.toString("base64"), mimeType: mediaType },
                skipHumanReview: true,
                fieldMask: wantLayout
                  ? "text,pages.pageNumber,pages.dimension,pages.transforms,pages.tokens,pages.lines"
                  : "text,pages.pageNumber",
              }),
            }),
          }),
          service,
          url,
        );
        const document = asRecord(body.document);
        if (document === undefined) throw unreadable(service, url, "it gave no document");
        const text = typeof document.text === "string" ? document.text : "";
        const pages = recordsOf(document.pages);
        // A page Google straightened is no longer the picture that was sent: its places do not apply.
        const usable = wantLayout && pages.every((page) => asArray(page.transforms).length === 0);
        return {
          text,
          pages: Math.max(1, pages.length),
          ...(usable && pages.length > 0 ? { layout: layoutOf(text, pages) } : {}),
        };
      },
      true,
    ),
    testConnection: () =>
      checkHealth(
        async () => {
          const url = processor();
          const headers = await auth();
          await send({
            service,
            runtime: { ...runtime, retry: false },
            request: () => ({ url, headers }),
          });
          return accepted(service, hostOf(url));
        },
        hostOf(
          settings.endpoint?.trim() || `https://${settings.location}-documentai.googleapis.com`,
        ),
      ),
  };
};

/**
 * AWS Textract, `DetectDocumentText`: an image or a one-page PDF, answered at once.
 * https://docs.aws.amazon.com/textract/latest/dg/API_DetectDocumentText.html
 */
const awsTextract = (
  { settings, secrets }: ChoiceOf<"awsTextract">,
  runtime: OcrRuntime,
): OcrProvider => {
  const service = "AWS Textract";
  const host = hostOf(
    settings.endpoint?.trim() || `https://textract.${settings.region}.amazonaws.com`,
  );
  const detect = (bytes: Buffer) =>
    callAwsJson({
      service,
      runtime,
      region: settings.region,
      signingName: "textract",
      endpoint: settings.endpoint,
      credentials: { accessKeyId: settings.accessKeyId, ...secrets },
      target: "Textract.DetectDocumentText",
      body: { Document: { Bytes: bytes.toString("base64") } },
      timeoutMs: READ_TIMEOUT_MS,
    });

  /** Textract places a word as fractions of the page, clockwise from the word's own top left. */
  const placeOf = (block: Record<string, unknown>, size: ImageSize): Polygon | undefined => {
    const geometry = asRecord(block.Geometry);
    const points = recordsOf(geometry?.Polygon).map(
      (point) => [Number(point.X) * size.width, Number(point.Y) * size.height] as const,
    );
    const polygon = points.length === 4 ? polygonOf(points) : undefined;
    if (polygon !== undefined) return polygon;
    const box = asRecord(geometry?.BoundingBox);
    const left = finite(box?.Left);
    const top = finite(box?.Top);
    const width = finite(box?.Width);
    const height = finite(box?.Height);
    return left === undefined || top === undefined || width === undefined || height === undefined
      ? undefined
      : boxPolygon(
          left * size.width,
          top * size.height,
          (left + width) * size.width,
          (top + height) * size.height,
        );
  };

  const layoutOf = (blocks: ReadonlyArray<Record<string, unknown>>, size: ImageSize) => {
    const byId = new Map(blocks.map((block) => [block.Id, block]));
    const lines: Array<{ polygon?: Polygon | undefined; words: Array<PlacedWord> }> = [];
    for (const line of blocks.filter((block) => block.BlockType === "LINE")) {
      const words: Array<PlacedWord> = [];
      const children = recordsOf(line.Relationships)
        .filter((relationship) => relationship.Type === "CHILD")
        .flatMap((relationship) => asArray(relationship.Ids));
      for (const id of children) {
        const word = byId.get(id);
        if (word?.BlockType !== "WORD" || typeof word.Text !== "string") continue;
        const polygon = placeOf(word, size);
        // A word that was read and has no place cannot be covered: no layout at all.
        if (polygon === undefined) return undefined;
        words.push({
          text: word.Text.trim(),
          polygon,
          confidence: (finite(word.Confidence) ?? 0) / 100,
          handwritten: word.TextType === "HANDWRITING",
        });
      }
      lines.push({ polygon: placeOf(line, size), words });
    }
    return composeLayout(size, lines);
  };

  return {
    id: "awsTextract",
    ...readerOf(
      runtime,
      async (bytes, _mediaType, wantLayout) => {
        const body = await detect(bytes);
        if (!Array.isArray(body.Blocks)) {
          throw unreadable(
            service,
            `https://textract.${settings.region}.amazonaws.com`,
            "it gave no blocks",
          );
        }
        const blocks = recordsOf(body.Blocks);
        const pages = Math.max(1, finite(asRecord(body.DocumentMetadata)?.Pages) ?? 1);
        const size = wantLayout && pages === 1 ? imageSize(bytes) : undefined;
        const composed = size === undefined ? undefined : layoutOf(blocks, size);
        if (composed !== undefined) return { ...composed, pages };
        return {
          text: blocks
            .filter((block) => block.BlockType === "LINE" && typeof block.Text === "string")
            .map((block) => block.Text)
            .join("\n"),
          pages,
        };
      },
      true,
    ),
    // Textract has no call that only checks a key: a blank page is read, which AWS bills as one.
    testConnection: () =>
      checkHealth(async () => {
        await callAwsJson({
          service,
          runtime: { ...runtime, retry: false },
          region: settings.region,
          signingName: "textract",
          endpoint: settings.endpoint,
          credentials: { accessKeyId: settings.accessKeyId, ...secrets },
          target: "Textract.DetectDocumentText",
          body: { Document: { Bytes: blankPng().toString("base64") } },
        });
        return accepted(service, host);
      }, host),
  };
};

/** The reader for an organisation's choice. Nothing is sent until it is asked to read. */
export const makeOcrProvider = (
  config: OcrProviderConfig,
  runtime: OcrRuntime = {},
): OcrProvider => {
  switch (config.provider) {
    case "doedeskCloud":
      return doedeskService(
        "doedeskCloud",
        config.settings.endpoint ?? DOEDESK_CLOUD_URL,
        config.secrets.token,
        runtime,
      );
    case "custom":
      return doedeskService("custom", config.settings.endpoint, config.secrets.token, runtime);
    case "azureDocumentIntelligence":
      return azureDocumentIntelligence(config, runtime);
    case "deepSa":
      return deepSa(config, runtime);
    case "reducto":
      return reducto(config, runtime);
    case "mistralOcr":
      return mistralOcr(config, runtime);
    case "googleDocumentAi":
      return googleDocumentAi(config, runtime);
    case "awsTextract":
      return awsTextract(config, runtime);
  }
};
