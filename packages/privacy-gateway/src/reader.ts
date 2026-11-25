import * as NodeCrypto from "node:crypto";

import { sanitizeIngestedText } from "./worker/sanitize.ts";

/** Turns an image or PDF into the text written in it. */
export interface Reader {
  readonly read: (bytes: Buffer, mediaType: string) => Promise<string>;
  /**
   * The text of an image together with where each word of it is. A reader without this cannot
   * support sending a redacted image; `layout` is checked by the caller (redaction/layout.ts).
   */
  readonly readLayout?: (bytes: Buffer, mediaType: string) => Promise<ReaderLayoutAnswer>;
}

export interface ReaderLayoutAnswer {
  readonly text: string;
  readonly pages: number;
  /** Absent when the service gave no word positions. */
  readonly layout: unknown;
}

export interface RemoteReaderOptions {
  /** Base URL of a DoeDesk Cloud or self-hosted service. */
  readonly endpoint: string;
  readonly token?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  /** Told about each file the service read: its size, and the page count when the service says. */
  readonly onRead?: ((read: ReaderUsage) => void) | undefined;
}

export interface ReaderUsage {
  readonly mediaType: string;
  readonly bytes: number;
  readonly characters: number;
  readonly pages: number | undefined;
}

/**
 * Reading by a service: DoeDesk Cloud, or one the user hosts.
 *
 * Contract: `POST {endpoint}/v1/ocr` with the file as the body and its media type as
 * `content-type` answers `{ "text": string }`, optionally with `"pages": number`. With
 * `?layout=1` a service that can say where each word is adds `"layout"` (redaction/layout.ts).
 */
export const makeRemoteReader = (options: RemoteReaderOptions): Reader => {
  const fetchImpl = options.fetch ?? fetch;
  const url = `${options.endpoint.replace(/\/+$/, "")}/v1/ocr`;
  const call = async (bytes: Buffer, mediaType: string, layout: boolean) => {
    const response = await fetchImpl(layout ? `${url}?layout=1` : url, {
      method: "POST",
      headers: {
        "content-type": mediaType,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      readonly text?: unknown;
      readonly pages?: unknown;
      readonly layout?: unknown;
      readonly error?: { readonly message?: unknown };
    };
    if (!response.ok || typeof body.text !== "string") {
      throw new Error(
        typeof body.error?.message === "string"
          ? body.error.message
          : `The reading service answered ${response.status}.`,
      );
    }
    const pages = typeof body.pages === "number" ? body.pages : undefined;
    options.onRead?.({ mediaType, bytes: bytes.length, characters: body.text.length, pages });
    return { text: body.text, pages: pages ?? 1, layout: body.layout };
  };
  return {
    // Only plain reading is cleaned: a layout's word positions are offsets into its text as sent.
    read: async (bytes, mediaType) =>
      sanitizeIngestedText((await call(bytes, mediaType, false)).text),
    readLayout: (bytes, mediaType) => call(bytes, mediaType, true),
  };
};

/** A conversation resends its attachments every turn; read each file once. */
export const cacheReader = (inner: Reader, maxEntries = 200): Reader => {
  const remember = <T>(read: (bytes: Buffer, mediaType: string) => Promise<T>) => {
    const cache = new Map<string, T>();
    return async (bytes: Buffer, mediaType: string): Promise<T> => {
      const key = NodeCrypto.createHash("sha256").update(bytes).digest("base64");
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const answer = await read(bytes, mediaType);
      cache.set(key, answer);
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
      return answer;
    };
  };
  const readLayout = inner.readLayout;
  return {
    read: remember(inner.read),
    ...(readLayout === undefined ? {} : { readLayout: remember(readLayout) }),
  };
};
