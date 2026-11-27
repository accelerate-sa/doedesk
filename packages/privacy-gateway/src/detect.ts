import * as NodeCrypto from "node:crypto";

import {
  type DetectedEntity,
  findFixedFormats,
  isReferenceNumber,
  numberContexts,
  toLatinDigits,
} from "./fixedFormats.ts";
import { findLabelledValues } from "./labelDetector.ts";
import { isEntityKind } from "./placeholders.ts";
import { ProxyError } from "./upstream.ts";

export type { DetectedEntity };

export interface Detector {
  /** One result list per input text, in order. Rejects when the text could not be checked. */
  readonly detect: (
    texts: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<ReadonlyArray<DetectedEntity>>>;
}

/** Why a detection service gave no answer, for an app that words the failure itself. */
export interface DetectorProblem {
  readonly kind:
    | "unreachable"
    | "timeout"
    | "busy"
    | "allowance"
    | "failing"
    | "signIn"
    | "refused"
    | "unreadable";
  readonly host: string;
  readonly status?: number;
}

export class DetectorUnavailableError extends Error {
  override readonly name = "DetectorUnavailableError";
  readonly problem: DetectorProblem | undefined;
  constructor(message: string, options?: ErrorOptions & { readonly problem?: DetectorProblem }) {
    super(message, options);
    this.problem = options?.problem;
  }
}

/**
 * Structured identifiers that follow a fixed format, and the values a form's labels point at.
 * Runs on the machine, with no network. Payment card numbers have no rule here, with a right
 * check digit or a wrong one: they are left to the detection service, as thirteen to nineteen
 * digits alone are as often a timestamp or a key.
 */
export const patternDetector: Detector = {
  detect: (texts) =>
    Promise.resolve(texts.map((text) => [...findFixedFormats(text), ...findLabelledValues(text)])),
};

export interface RemoteDetectorOptions {
  /** Base URL of a DoeDesk Cloud or self-hosted detection service. */
  readonly endpoint: string;
  readonly token?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  /** Waits between tries. Tests pass one that does not wait. */
  readonly sleep?: ((milliseconds: number) => Promise<void>) | undefined;
  /** The person runs this service themselves: the advice says to check it, not the connection. */
  readonly ownService?: boolean | undefined;
  /** False for a connection test, which should say at once that the service is not there. */
  readonly retry?: boolean | undefined;
}

/**
 * How long to wait before each further try when the service could not be reached or answered
 * that it is overloaded: six seconds in all, which covers a dropped connection, a laptop waking
 * up and a service restarting. The request is refused after the last one; nothing is sent unmasked.
 */
const RETRY_WAITS_MS = [500, 1500, 4000];
/** A try that ran into the time limit already cost half a minute: one more, not three. */
const MAX_TRIES_AFTER_TIMEOUT = 2;
/** Answers that say "not now": a wait can change them. Any other refusal stands. */
const TRANSIENT_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
/**
 * DoeDesk Cloud's codes for an allowance that is used up. It answers them with 429, but no wait
 * of seconds changes them, so they are not tried again.
 */
export const ALLOWANCE_ENDED_CODES: ReadonlySet<string> = new Set([
  "quota_exceeded",
  "org_allowance_ended",
]);

/** One failed call: what happened, what the person can do, and whether trying again could help. */
interface FailedAttempt {
  readonly kind: DetectorProblem["kind"];
  readonly status?: number;
  readonly happened: string;
  readonly advice: string;
  readonly transient: boolean;
  readonly timedOut?: boolean;
  readonly cause?: unknown;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/** Longest text sent in one piece. Longer texts are split at line or word boundaries. */
const MAX_CHUNK_LENGTH = 4000;
const MAX_CHUNKS_PER_REQUEST = 25;
/** Calls open at once for one long text. More would only queue at the service. */
const MAX_CALLS_AT_ONCE = 4;

const splitIntoChunks = (
  text: string,
): ReadonlyArray<{ readonly offset: number; readonly text: string }> => {
  if (text.length <= MAX_CHUNK_LENGTH) return [{ offset: 0, text }];
  const chunks: Array<{ offset: number; text: string }> = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + MAX_CHUNK_LENGTH, text.length);
    if (end < text.length) {
      const window = text.slice(offset, end);
      const lineBreak = window.lastIndexOf("\n");
      const space = window.lastIndexOf(" ");
      const cut =
        lineBreak > MAX_CHUNK_LENGTH / 2 ? lineBreak : space > MAX_CHUNK_LENGTH / 2 ? space : -1;
      if (cut !== -1) end = offset + cut + 1;
    }
    chunks.push({ offset, text: text.slice(offset, end) });
    offset = end;
  }
  return chunks;
};

/**
 * Name and free-text detection by a service: DoeDesk Cloud, or one the user hosts.
 *
 * Contract: `POST {endpoint}/v1/detect` with `{ "texts": string[] }` answers
 * `{ "results": [{ "entities": [{ "start", "end", "kind" }] }] }`, one result per text.
 */
export const makeRemoteDetector = (options: RemoteDetectorOptions): Detector => {
  const fetchImpl = options.fetch ?? fetch;
  const url = `${options.endpoint.replace(/\/+$/, "")}/v1/detect`;

  const sleep = options.sleep ?? wait;
  const host = new URL(url).host;

  const sendAgain = "then send your message again";
  const attempt = async (chunks: ReadonlyArray<string>): Promise<Response | FailedAttempt> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify({ texts: chunks }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (cause) {
      // The person's proxy turned the call away: its own words say what to do, and a wait will not.
      if (cause instanceof ProxyError) {
        return {
          kind: "unreachable",
          happened: `The detection service at ${host} could not be asked. ${cause.message.replace(/\.$/, "")}`,
          advice: `Then send your message again.`,
          transient: false,
          cause,
        };
      }
      if (cause instanceof Error && cause.name === "TimeoutError") {
        return {
          kind: "timeout",
          happened: `The detection service at ${host} did not answer in time`,
          advice: `Wait a minute, ${sendAgain}.`,
          transient: true,
          timedOut: true,
          cause,
        };
      }
      return {
        kind: "unreachable",
        happened: `The detection service at ${host} could not be reached`,
        advice:
          options.ownService === true
            ? `Check that your detection service is running, ${sendAgain}.`
            : `Check your internet connection, ${sendAgain}.`,
        transient: true,
        cause,
      };
    }
    if (response.ok) return response;
    const { status } = response;
    if (status === 429) {
      const error = (
        (await response.json().catch(() => undefined)) as
          | { readonly error?: Record<string, unknown> }
          | undefined
      )?.error;
      if (typeof error?.code === "string" && ALLOWANCE_ENDED_CODES.has(error.code)) {
        const said =
          typeof error.message === "string" && error.message.trim() !== ""
            ? error.message.trim().slice(0, 300).replace(/\.$/, "")
            : undefined;
        const organization = error.code === "org_allowance_ended";
        return {
          kind: "allowance",
          status,
          happened:
            said ??
            (organization
              ? `Your organization's allowance at ${host} is used up`
              : `This account's allowance at ${host} is used up`),
          // The organization's own sentence already says who can add more.
          advice:
            organization && said !== undefined
              ? ""
              : organization
                ? "Your DoeDesk administrator can add more."
                : "Text can be checked again when the allowance renews next month.",
          transient: false,
        };
      }
    }
    if (TRANSIENT_STATUSES.has(status)) {
      return {
        kind: status === 429 ? "busy" : "failing",
        status,
        happened:
          status === 429
            ? `The detection service at ${host} is receiving too many requests (it answered 429)`
            : `The detection service at ${host} has a problem of its own (it answered ${status})`,
        advice: `Wait a minute, ${sendAgain}.`,
        transient: true,
      };
    }
    if (status === 401) {
      return {
        kind: "signIn",
        status,
        happened: `The detection service at ${host} no longer accepts this sign-in`,
        advice: "Open Settings, then Privacy, and sign in again.",
        transient: false,
      };
    }
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    return {
      kind: "refused",
      status,
      happened: `The detection service at ${host} refused the request (it answered ${status}${detail ? `: ${detail}` : ""})`,
      advice: "Check the service in Settings, under Privacy.",
      transient: false,
    };
  };

  /** Tries again after a failure that a short wait can cure, then gives up for good. */
  const reach = async (chunks: ReadonlyArray<string>): Promise<Response> => {
    for (let tries = 1; ; tries += 1) {
      const result = await attempt(chunks);
      if (result instanceof Response) return result;
      const delay = RETRY_WAITS_MS[tries - 1];
      const again =
        options.retry !== false &&
        result.transient &&
        delay !== undefined &&
        (result.timedOut !== true || tries < MAX_TRIES_AFTER_TIMEOUT);
      if (!again) {
        const counted = tries === 1 ? "" : ` after ${tries} tries`;
        const advice = result.advice === "" ? "" : ` ${result.advice}`;
        throw new DetectorUnavailableError(`${result.happened}${counted}.${advice}`, {
          cause: result.cause,
          problem: {
            kind: result.kind,
            host,
            ...(result.status === undefined ? {} : { status: result.status }),
          },
        });
      }
      await sleep(delay);
    }
  };

  const detectChunks = async (chunks: ReadonlyArray<string>) => {
    const response = await reach(chunks);
    const body = (await response.json().catch(() => ({}))) as {
      readonly results?: ReadonlyArray<{
        readonly entities?: ReadonlyArray<Record<string, unknown>>;
      }>;
    };
    if (!Array.isArray(body.results) || body.results.length !== chunks.length) {
      throw new DetectorUnavailableError(
        `The detection service at ${host} returned an answer DoeDesk could not read. If it is your own service, check that it follows the detection contract.`,
        { problem: { kind: "unreadable", host } },
      );
    }
    return body.results.map((result, index) => {
      const length = chunks[index]?.length ?? 0;
      const entities: Array<DetectedEntity> = [];
      for (const entity of result.entities ?? []) {
        const { start, end, kind } = entity;
        if (typeof start !== "number" || typeof end !== "number") continue;
        if (start < 0 || end > length || start >= end) continue;
        entities.push({ start, end, kind: isEntityKind(kind) ? kind : "OTHER" });
      }
      return entities;
    });
  };

  return {
    detect: async (texts) => {
      const pieces = texts.flatMap((text, textIndex) =>
        splitIntoChunks(text).map((chunk) => ({ ...chunk, textIndex })),
      );
      const batches: Array<typeof pieces> = [];
      for (let start = 0; start < pieces.length; start += MAX_CHUNKS_PER_REQUEST) {
        batches.push(pieces.slice(start, start + MAX_CHUNKS_PER_REQUEST));
      }
      // Each worker takes the next batch until none is left. One failure rejects the whole text.
      const detected: Array<Awaited<ReturnType<typeof detectChunks>>> = [];
      let next = 0;
      const worker = async () => {
        while (next < batches.length) {
          const index = next;
          next += 1;
          detected[index] = await detectChunks((batches[index] ?? []).map((piece) => piece.text));
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(MAX_CALLS_AT_ONCE, batches.length) }, () => worker()),
      );
      // Written out in the order of the text, whatever order the answers came in.
      const results: Array<Array<DetectedEntity>> = texts.map(() => []);
      batches.forEach((batch, batchIndex) => {
        batch.forEach((piece, index) => {
          for (const entity of detected[batchIndex]?.[index] ?? []) {
            results[piece.textIndex]?.push({
              start: entity.start + piece.offset,
              end: entity.end + piece.offset,
              kind: entity.kind,
            });
          }
        });
      });
      return results;
    },
  };
};

const EDGE_NOISE = /^[\s()[\]{}<>.,;:،؛"'`|]+|[\s()[\]{}<>.,;:،؛"'`|]+$/g;
const MIN_PHONE_DIGITS = 9;

/**
 * Tidies what a detector reports so a span is safe to replace and restore.
 *
 * A span never crosses a line: detectors sometimes run a number into the next line, and
 * restoring that would write a stray line break into the user's files. Surrounding punctuation
 * is left outside the span, and a "phone number" too short to be one is dropped.
 */
export const normalizeSpans = (
  text: string,
  entities: ReadonlyArray<DetectedEntity>,
): ReadonlyArray<DetectedEntity> => {
  const normalized: Array<DetectedEntity> = [];
  for (const entity of entities) {
    let lineStart = entity.start;
    const surface = text.slice(entity.start, entity.end);
    // Tabs split too: file listings put a line number and a tab before each line.
    for (const line of surface.split(/[\n\t]/)) {
      const leading = line.length - line.replace(/^[\s()[\]{}<>.,;:،؛"'`|]+/, "").length;
      const trimmed = line.replace(EDGE_NOISE, "");
      const start = lineStart + leading;
      lineStart += line.length + 1;
      if (trimmed.length < 2) continue;
      if (entity.kind === "PHONE") {
        const digits = trimmed.match(/[0-9\u0660-\u0669]/g)?.length ?? 0;
        if (digits < MIN_PHONE_DIGITS) continue;
      }
      normalized.push({ start, end: start + trimmed.length, kind: entity.kind });
    }
  }
  return normalized;
};

const BARE_NUMBER = /^[1-9١-٩][0-9٠-٩]*(?:[,.٫٬][0-9٠-٩]+)*$/u;
/** Letters joined to the number, as in `POL-857713407`: a record's own number, never an amount. */
const LETTERS_BEFORE = /[A-Za-z]-?$/u;

/**
 * A number the text calls an amount, or a reference too short to point to anyone (an ordinal, a
 * year), is not personal data, whatever a detector took it for (a phone, an ID, the tail of an
 * account). Phone numbers (0 or + first) and VAT numbers are left alone, and so is the number part
 * of a lettered record number.
 */
const dropReadableNumbers = (
  text: string,
  entities: ReadonlyArray<DetectedEntity>,
): ReadonlyArray<DetectedEntity> => {
  const contextOfNumber = numberContexts(text);
  return entities.filter((entity) => {
    const surface = text.slice(entity.start, entity.end);
    if (!BARE_NUMBER.test(surface) || /^3[0-9]{13}3$/.test(toLatinDigits(surface))) return true;
    if (LETTERS_BEFORE.test(text.slice(Math.max(0, entity.start - 2), entity.start))) return true;
    const context = contextOfNumber(entity.start, entity.end);
    if (context === "reference") return isReferenceNumber(surface);
    return context !== "readable";
  });
};

/** Runs every detector and keeps the longest span where two overlap. */
export const combineDetectors = (detectors: ReadonlyArray<Detector>): Detector => ({
  detect: async (texts) => {
    const all = await Promise.all(detectors.map((detector) => detector.detect(texts)));
    return texts.map((text, textIndex) =>
      resolveOverlaps(
        dropReadableNumbers(
          text,
          normalizeSpans(
            text,
            all.flatMap((perDetector) => perDetector[textIndex] ?? []),
          ),
        ),
      ),
    );
  },
});

/**
 * Adds what a second detector finds to what the first found. The second runs only while
 * `second()` returns one, and it is not subject to the rule that drops numbers the text calls a
 * reference: references are what it is for.
 */
export const withSecondPass = (first: Detector, second: () => Detector | undefined): Detector => ({
  detect: async (texts) => {
    const extra = second();
    if (extra === undefined) return first.detect(texts);
    const [found, more] = await Promise.all([
      first.detect(texts),
      ignoreAppAuthoredBlocks(extra).detect(texts),
    ]);
    return texts.map((text, index) =>
      resolveOverlaps([...(found[index] ?? []), ...normalizeSpans(text, more[index] ?? [])]),
    );
  },
});

const APP_AUTHORED_BLOCK =
  /<(system-reminder|environment_context|permissions instructions)>[\s\S]*?<\/\1>/g;

/**
 * Blanks, in place, the instruction blocks agent programs write (`<system-reminder>` and the
 * like), whose tool names a name detector mistakes for people. Offsets stay valid, and the
 * pattern detector still reads the original text.
 */
export const ignoreAppAuthoredBlocks = (inner: Detector): Detector => ({
  detect: (texts) =>
    inner.detect(
      texts.map((text) => text.replace(APP_AUTHORED_BLOCK, (block) => " ".repeat(block.length))),
    ),
});

export const resolveOverlaps = (
  entities: ReadonlyArray<DetectedEntity>,
): ReadonlyArray<DetectedEntity> => {
  const byLength = entities.toSorted(
    (left, right) => right.end - right.start - (left.end - left.start) || left.start - right.start,
  );
  const kept: Array<DetectedEntity> = [];
  for (const entity of byLength) {
    if (kept.every((other) => entity.end <= other.start || entity.start >= other.end)) {
      kept.push(entity);
    }
  }
  return kept.toSorted((left, right) => left.start - right.start);
};

/**
 * Remembers what was found in a text. A conversation resends its whole history on every turn,
 * so without this each turn would pay to re-check everything already checked.
 */
export const cacheDetector = (inner: Detector, maxEntries = 5000): Detector => {
  const cache = new Map<string, ReadonlyArray<DetectedEntity>>();
  const keyOf = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("base64");
  return {
    detect: async (texts) => {
      const keys = texts.map(keyOf);
      const missing = new Map<string, string>();
      keys.forEach((key, index) => {
        if (!cache.has(key)) missing.set(key, texts[index] ?? "");
      });
      if (missing.size > 0) {
        const missingKeys = [...missing.keys()];
        const detected = await inner.detect([...missing.values()]);
        missingKeys.forEach((key, index) => {
          cache.set(key, detected[index] ?? []);
        });
        while (cache.size > maxEntries) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
      return keys.map((key) => cache.get(key) ?? []);
    },
  };
};
