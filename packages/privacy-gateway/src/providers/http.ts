/** What every adapter shares: one way to call a service and one way to say why it did not answer. */

import { DetectorUnavailableError } from "../detect.ts";
import { ProxyError } from "../upstream.ts";
import {
  ProviderError,
  type ProviderHealthResult,
  type ProviderProblemKind,
  type ProviderRuntime,
} from "./types.ts";

const trimSlashes = (address: string): string => address.trim().replace(/\/+$/, "");

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const asArray = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

/** The records of a list, leaving out whatever else a service put in it. */
export const recordsOf = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  asArray(value).flatMap((entry) => {
    const record = asRecord(entry);
    return record === undefined ? [] : [record];
  });

export const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export const sleepOf = (runtime: ProviderRuntime) => runtime.sleep ?? wait;

/** The same waits as DoeDesk's own detection service gets: six seconds in all. */
const RETRY_WAITS_MS = [500, 1500, 4000];
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 30_000;

export interface ProviderRequest {
  readonly url: string;
  readonly method?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | Uint8Array<ArrayBuffer> | FormData | undefined;
}

export interface SendOptions {
  /** The service as a message names it, for example `Azure Document Intelligence`. */
  readonly service: string;
  readonly runtime: ProviderRuntime;
  /** Built again for every try: a signature carries the time it was made. */
  readonly request: () => ProviderRequest | Promise<ProviderRequest>;
  /** Statuses outside 2xx that are an answer here, such as a 404 for a job that was made up. */
  readonly accept?: ((status: number) => boolean) | undefined;
  /** A service's own word for what went wrong, where its status does not say. */
  readonly classify?:
    | ((status: number, body: string) => ProviderProblemKind | undefined)
    | undefined;
  readonly timeoutMs?: number | undefined;
}

/** The sentence a service gave for its refusal, wherever its error format keeps it. */
const detailOf = (body: string): string => {
  let said: unknown;
  try {
    const parsed = asRecord(JSON.parse(body));
    const error = parsed?.error;
    said =
      asRecord(error)?.message ??
      (typeof error === "string" ? error : undefined) ??
      parsed?.message ??
      parsed?.Message ??
      (typeof parsed?.detail === "string" ? parsed.detail : undefined);
  } catch {
    said = undefined;
  }
  return (typeof said === "string" ? said : body).trim().slice(0, 300).replace(/\.$/, "");
};

const kindOfStatus = (status: number): ProviderProblemKind =>
  status === 401 || status === 403
    ? "auth"
    : status === 429
      ? "busy"
      : TRANSIENT_STATUSES.has(status) || status >= 500
        ? "failing"
        : "refused";

const describe = (
  service: string,
  host: string,
  kind: ProviderProblemKind,
  status: number | undefined,
  detail: string,
): string => {
  const answered =
    status === undefined ? "" : ` (it answered ${status}${detail ? `: ${detail}` : ""})`;
  const where = `${service} at ${host}`;
  switch (kind) {
    case "auth":
      return `${where} did not accept the key it was given${answered}. Check the key in Settings, under Privacy.`;
    case "busy":
      return `${where} is receiving too many requests${answered}. Wait a minute, then try again.`;
    case "failing":
      return `${where} has a problem of its own${answered}. Wait a minute, then try again.`;
    case "timeout":
      return `${where} did not answer in time. Wait a minute, then try again.`;
    case "unreachable":
      return `${where} could not be reached. Check its address in Settings, under Privacy, and that this computer can reach it.`;
    case "unreadable":
      return `${where} returned an answer DoeDesk could not read${detail ? ` (${detail})` : ""}.`;
    default:
      return `${where} refused the request${answered}. Check the service in Settings, under Privacy.`;
  }
};

/** An answer that is not what the service documents. Nothing is made of it. */
export const unreadable = (service: string, url: string, detail = ""): ProviderError => {
  const host = hostOf(url) ?? url;
  return new ProviderError(describe(service, host, "unreadable", undefined, detail), {
    kind: "unreadable",
    host,
  });
};

const attempt = async (
  options: SendOptions,
  request: ProviderRequest,
  host: string,
): Promise<Response | ProviderError> => {
  const { service, runtime } = options;
  let response: Response;
  try {
    response = await (runtime.fetch ?? fetch)(request.url, {
      method: request.method ?? "GET",
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: AbortSignal.timeout(runtime.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (cause) {
    // The person's proxy turned the call away: its own words say what to do, and a wait will not.
    if (cause instanceof ProxyError) {
      return new ProviderError(`${service} at ${host} could not be asked. ${cause.message}`, {
        kind: "unreachable",
        host,
        cause,
      });
    }
    const kind =
      cause instanceof Error && cause.name === "TimeoutError" ? "timeout" : "unreachable";
    return new ProviderError(describe(service, host, kind, undefined, ""), {
      kind,
      host,
      transient: true,
      cause,
    });
  }
  if (response.ok || options.accept?.(response.status) === true) return response;
  const body = await response.text().catch(() => "");
  const kind = options.classify?.(response.status, body) ?? kindOfStatus(response.status);
  return new ProviderError(describe(service, host, kind, response.status, detailOf(body)), {
    kind,
    host,
    status: response.status,
    transient: kind === "busy" || kind === "failing",
  });
};

/**
 * Calls a service and returns its answer. Rejects with a `ProviderError` after trying again
 * where a short wait can help.
 */
export const send = async (options: SendOptions): Promise<Response> => {
  const sleep = sleepOf(options.runtime);
  for (let tries = 1; ; tries += 1) {
    const request = await options.request();
    const host = hostOf(request.url);
    if (host === undefined) {
      throw new ProviderError(`${options.service} was given an address that cannot be called.`, {
        kind: "misconfigured",
      });
    }
    const result = await attempt(options, request, host);
    if (result instanceof Response) return result;
    const delay = RETRY_WAITS_MS[tries - 1];
    // A try that ran into the time limit already cost that long: one more, not three.
    const again =
      options.runtime.retry !== false &&
      result.transient &&
      delay !== undefined &&
      (result.kind !== "timeout" || tries < 2);
    if (!again) throw result;
    await sleep(delay);
  }
};

export const readJson = async (
  response: Response,
  service: string,
  url: string,
): Promise<Record<string, unknown>> => {
  const body = asRecord(await response.json().catch(() => undefined));
  if (body === undefined) throw unreadable(service, url);
  return body;
};

const DETECTOR_KINDS: Readonly<Record<string, ProviderProblemKind>> = {
  unreachable: "unreachable",
  timeout: "timeout",
  busy: "busy",
  failing: "failing",
  signIn: "auth",
  allowance: "refused",
  refused: "refused",
  unreadable: "unreadable",
};

/** Runs a connection test and reports how it went. Never rejects. */
export const checkHealth = async (
  probe: () => Promise<string>,
  host: string | undefined,
): Promise<ProviderHealthResult> => {
  const started = performance.now();
  const base = host === undefined ? {} : { host };
  try {
    const message = await probe();
    return { ...base, ok: true, kind: "ok", message, latencyMs: performance.now() - started };
  } catch (cause) {
    const latencyMs = performance.now() - started;
    if (cause instanceof ProviderError) {
      return {
        ok: false,
        kind: cause.kind,
        message: cause.message,
        host: cause.host ?? host,
        ...(cause.status === undefined ? {} : { status: cause.status }),
        latencyMs,
      };
    }
    if (cause instanceof DetectorUnavailableError) {
      const { problem } = cause;
      return {
        ok: false,
        kind: DETECTOR_KINDS[problem?.kind ?? ""] ?? "failing",
        message: cause.message,
        host: problem?.host ?? host,
        ...(problem?.status === undefined ? {} : { status: problem.status }),
        latencyMs,
      };
    }
    return {
      ...base,
      ok: false,
      kind: "failing",
      message: cause instanceof Error ? cause.message : String(cause),
      latencyMs,
    };
  }
};

/** The host of an address a person typed, or undefined when it is not an address. */
export const hostOf = (address: string): string | undefined => {
  try {
    return new URL(address).host;
  } catch {
    return undefined;
  }
};

/** Rejects a choice whose address cannot be called before anything is sent to it. */
export const requireUrl = (service: string, address: string): string => {
  const url = trimSlashes(address);
  if (hostOf(url) === undefined || !/^https?:\/\//i.test(url)) {
    throw new ProviderError(
      `${service} needs its address as a full URL, such as https://example.com. Check it in Settings, under Privacy.`,
      { kind: "misconfigured" },
    );
  }
  return url;
};

/** Runs `work` on every item, a few at a time, and keeps the answers in the items' order. */
export const mapConcurrent = async <Item, Answer>(
  items: ReadonlyArray<Item>,
  atOnce: number,
  work: (item: Item) => Promise<Answer>,
): Promise<Array<Answer>> => {
  const answers: Array<Answer> = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      answers[index] = await work(items[index] as Item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, () => worker()));
  return answers;
};
