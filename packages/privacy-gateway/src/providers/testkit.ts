/** A recorded `fetch` for contract tests: it answers in order and keeps what it was sent. */

import type { ProviderRuntime } from "./types.ts";

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly body: unknown;
  /** The body parsed as JSON. */
  readonly json: Record<string, unknown>;
}

type Answer = Response | Error | ((call: RecordedCall) => Response);

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });

export const timedOut = (): Error => new DOMException("The operation timed out.", "TimeoutError");

/** Answers each call with the next answer. A call past the last answer fails the test. */
export const recorded = (...answers: ReadonlyArray<Answer>) => {
  const calls: Array<RecordedCall> = [];
  const waits: Array<number> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    const call: RecordedCall = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body,
      get json() {
        return JSON.parse(typeof body === "string" ? body : "{}") as Record<string, unknown>;
      },
    };
    const answer = answers[calls.length];
    calls.push(call);
    if (answer === undefined) throw new Error(`Unexpected call ${calls.length}: ${call.url}`);
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(call) : answer.clone();
  }) as typeof fetch;
  const runtime: ProviderRuntime = {
    fetch: fetchImpl,
    sleep: (milliseconds) => {
      waits.push(milliseconds);
      return Promise.resolve();
    },
    now: () => new Date("2026-11-27T10:00:00.000Z"),
  };
  return { calls, waits, runtime };
};

/** The file a call uploaded as a multipart form. */
export const uploadedFile = (call: RecordedCall | undefined): File => {
  const file = call?.body instanceof FormData ? call.body.get("file") : null;
  if (!(file instanceof File)) throw new Error("No file was uploaded.");
  return file;
};

/** The first bytes of a PNG of this size: all that is read of a picture to learn its size. */
export const pngOfSize = (width: number, height: number): Buffer => {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
};

export const AWS_KEYS = {
  settings: { region: "me-central-1", accessKeyId: "AKIDEXAMPLE" },
  secrets: { secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
} as const;
