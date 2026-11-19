import * as NodeCrypto from "node:crypto";

import { type EntityKind, isEntityKind } from "./placeholders.ts";

/** A span of personal data inside one text. Offsets are UTF-16 code units, as in JS strings. */
export interface DetectedEntity {
  readonly start: number;
  readonly end: number;
  readonly kind: EntityKind;
}

export interface Detector {
  /** One result list per input text, in order. Rejects when the text could not be checked. */
  readonly detect: (
    texts: ReadonlyArray<string>,
  ) => Promise<ReadonlyArray<ReadonlyArray<DetectedEntity>>>;
}

export class DetectorUnavailableError extends Error {
  override readonly name = "DetectorUnavailableError";
}

const DIGIT = "[0-9٠-٩]";
const SEPARATOR = "[\\s.-]?";

const PATTERNS: ReadonlyArray<{ readonly kind: EntityKind; readonly source: string }> = [
  { kind: "EMAIL", source: "[\\p{L}\\p{N}._%+-]+@[\\p{L}\\p{N}.-]+\\.[\\p{L}]{2,}" },
  // Saudi mobile numbers in local and international form.
  {
    kind: "PHONE",
    source: `(?<!${DIGIT})(?:\\+|00)?(?:966|٩٦٦)${SEPARATOR}5${DIGIT}${SEPARATOR}${DIGIT}{3}${SEPARATOR}${DIGIT}{4}(?!${DIGIT})`,
  },
  {
    kind: "PHONE",
    source: `(?<!${DIGIT})[0٠][5٥]${DIGIT}${SEPARATOR}${DIGIT}{3}${SEPARATOR}${DIGIT}{4}(?!${DIGIT})`,
  },
  {
    kind: "PHONE",
    source: `(?<![\\p{L}${DIGIT.slice(1, -1)}])\\+${DIGIT}{1,3}(?:${SEPARATOR}${DIGIT}{2,4}){2,4}(?!${DIGIT})`,
  },
];

const toLatinDigits = (value: string): string =>
  value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));

/**
 * An IBAN written whole or in groups of four. Groups are split by one space only, never by a tab
 * or a line break: in a table the next cell is another value, not more of the account.
 */
const IBAN_CANDIDATE =
  /(?<![\p{L}\p{N}])[A-Z]{2}[0-9٠-٩]{2}[0-9٠-٩A-Z]*(?:[ \u00A0][0-9٠-٩A-Z]+)*(?![\p{L}\p{N}])/gu;
const IBAN_MIN_LENGTH = 15;
const IBAN_MAX_LENGTH = 34;

const ibanChecks = (compact: string): boolean => {
  let remainder = 0;
  for (const character of compact.slice(4) + compact.slice(0, 4)) {
    const value = Number.parseInt(character, 36);
    remainder = (remainder * (value > 9 ? 100 : 10) + value) % 97;
  }
  return remainder === 1;
};

/**
 * IBANs whose check digits are right. A candidate that runs on into a following number (an
 * amount after a space) is cut back to the longest run of its groups that checks.
 */
const findIbans = (text: string): ReadonlyArray<DetectedEntity> => {
  const found: Array<DetectedEntity> = [];
  for (const match of text.matchAll(IBAN_CANDIDATE)) {
    const groups = [...match[0].matchAll(/[^ \u00A0]+/g)];
    let compact = "";
    const ends: Array<{ readonly length: number; readonly end: number }> = [];
    for (const group of groups) {
      compact += toLatinDigits(group[0]);
      ends.push({ length: compact.length, end: match.index + group.index + group[0].length });
    }
    const longest = ends.findLast(
      ({ length }) =>
        length >= IBAN_MIN_LENGTH &&
        length <= IBAN_MAX_LENGTH &&
        ibanChecks(compact.slice(0, length)),
    );
    if (longest !== undefined) found.push({ start: match.index, end: longest.end, kind: "IBAN" });
  }
  return found;
};

/*
 * A ten-digit number starting with 1 or 2 has the shape of a Saudi ID, and so do many amounts and
 * references: the words of its clause, a currency after it, or its column's header decide. The
 * check digit is not used: people's documents carry IDs with a wrong one, and they are still IDs.
 */
const IDENTIFIER_WORDS = new RegExp(
  [
    "هوي[ةته]",
    "[إا]قام[ةته]",
    "سجل(?:ه|ها)? المدني",
    "سجل مدني",
    "الحدود",
    "سجل(?:ها|ه)? تجاري",
    "السجل التجاري",
    "س\\s?\\.\\s?ت",
    "ضريبي",
    "القيمة المضافة",
    "الوطني الموحد",
    "بطاق[ةته]",
    "(?<![a-z])(?:national|civil|resident|residence|identity|iqama|id|border|commercial|registration|unified national|c\\.\\s?r|cr|vat|trn|tin|tax)(?![a-z])",
  ].join("|"),
  "giu",
);
const READABLE_WORDS = new RegExp(
  [
    "ريال",
    "ر\\s?\\.\\s?س",
    "مبلغ",
    "قيم[ةته]",
    "رأس ?مال",
    "رصيد",
    "إجمالي",
    "اجمالي",
    "سعر",
    "فاتور[ةه]",
    "حوال[ةه]",
    "تحويل",
    "مرجع",
    "أمر (?:ال)?(?:شراء|صرف|عمل)",
    "طلب",
    "عقد",
    "إيجار",
    "شحن[ةه]",
    "دعوى",
    "قضي[ةه]",
    "صك",
    "كشف حساب",
    "العميل",
    "عملي[ةه]",
    "معامل[ةه]",
    "سند",
    "بوليص[ةه]",
    "(?<![a-z])(?:amount|value|total|balance|price|capital|sar|sr|riyals?|usd|invoice|inv|transfer|transaction|reference|ref|order|po|purchase|receipt|contract|case|shipment|tracking|statement|customer|payment|deed|policy|ticket)(?![a-z])",
  ].join("|"),
  "giu",
);
/** Words for a way to reach someone: the number after them is a phone number, never readable. */
const CONTACT_WORDS =
  /جوال|هاتف|تواصل|اتصال|واتس|فاكس|(?<![a-z])(?:phone|mobile|tel|call|fax|whatsapp|contact)(?![a-z])/giu;
const CURRENCY_AFTER = /^\s*(?:ريال|ر\s?\.\s?س|SAR|SR|riyals?|USD|dollars?)(?![a-z])/iu;
const CONTEXT_REACH = 48;

type NumberContext = "identifier" | "contact" | "readable" | undefined;

const lastMatchEnd = (pattern: RegExp, text: string): number => {
  let end = -1;
  for (const match of text.matchAll(pattern)) end = match.index + match[0].length;
  return end;
};

const contextOfWords = (words: string): NumberContext => {
  const nearest = (
    [
      ["identifier", lastMatchEnd(IDENTIFIER_WORDS, words)],
      ["contact", lastMatchEnd(CONTACT_WORDS, words)],
      ["readable", lastMatchEnd(READABLE_WORDS, words)],
    ] as const
  ).reduce((best, next) => (next[1] > best[1] ? next : best));
  // The nearer word wins: "transfer to the holder of ID 1…" is an ID.
  return nearest[1] === -1 ? undefined : nearest[0];
};

/** What a text says about the numbers in it. Each table column's header is looked up once. */
const numberContexts = (text: string) => {
  // Keyed by the end of a line and a column: the header found above that line, if any.
  const headers = new Map<string, string | undefined>();
  const headerOfColumn = (lineStart: number, column: number): string | undefined => {
    const visited: Array<string> = [];
    let header: string | undefined;
    for (let end = lineStart - 1; end > 0;) {
      const key = `${end}:${column}`;
      if (headers.has(key)) {
        header = headers.get(key);
        break;
      }
      visited.push(key);
      const start = text.lastIndexOf("\n", end - 1) + 1;
      const line = text.slice(start, end);
      if (!line.includes("\t")) break;
      const cell = line.split("\t")[column]?.trim() ?? "";
      if (/\p{L}/u.test(cell) && !/[0-9٠-٩]/.test(cell)) {
        header = cell;
        break;
      }
      end = start - 1;
    }
    for (const key of visited) headers.set(key, header);
    return header;
  };

  return (start: number, end: number): NumberContext => {
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    const lineBreak = text.indexOf("\n", end);
    const lineEnd = lineBreak === -1 ? text.length : lineBreak;
    const cellStart = Math.max(lineStart, text.lastIndexOf("\t", start - 1) + 1);
    // The words of the number's own clause: a comma ends what an earlier word can say about it.
    const clause = text.slice(Math.max(cellStart, start - CONTEXT_REACH), start).split(/[,،;؛]/u);
    const before = contextOfWords(clause[clause.length - 1] ?? "");
    if (before !== undefined) return before;
    const tab = text.indexOf("\t", end);
    const after = text.slice(end, tab === -1 || tab > lineEnd ? lineEnd : tab);
    if (CURRENCY_AFTER.test(after)) return "readable";
    const cells = text.slice(lineStart, lineEnd).split("\t");
    if (cells.length === 1) return undefined;
    const column = text.slice(lineStart, start).split("\t").length - 1;
    // A two-cell row is a label and its value ("Customer no. <tab> 1…"); a wider row is a record
    // under a header row.
    if (cells.length === 2 && column === 1) return contextOfWords(cells[0] ?? "");
    const header = headerOfColumn(lineStart, column);
    return header === undefined ? undefined : contextOfWords(header);
  };
};

const TEN_DIGITS = new RegExp(`(?<!${DIGIT})${DIGIT}{10}(?!${DIGIT})`, "gu");
const FIFTEEN_DIGITS = new RegExp(`(?<!${DIGIT})${DIGIT}{15}(?!${DIGIT})`, "gu");
/** Digits in groups split by single spaces or dashes ("1087-654-321", "300 123 456 789 003"). */
const GROUPED_DIGITS = new RegExp(
  `(?<!${DIGIT}[ -]?)${DIGIT}+(?:[ -]${DIGIT}+)+(?![ -]?${DIGIT})`,
  "gu",
);

/**
 * National IDs and iqamas, commercial registration numbers (ten digits, any first digit, named
 * as such), VAT numbers (fifteen digits starting and ending with 3), and ten-digit numbers
 * written after a phone word.
 */
const findIdentifiers = (text: string): ReadonlyArray<DetectedEntity> => {
  const found: Array<DetectedEntity> = [];
  const contextOfNumber = numberContexts(text);
  for (const match of text.matchAll(TEN_DIGITS)) {
    const end = match.index + match[0].length;
    const context = contextOfNumber(match.index, end);
    const idShaped = /^[12]/.test(toLatinDigits(match[0]));
    if (context === "identifier" || (context === undefined && idShaped)) {
      found.push({ start: match.index, end, kind: "ID" });
    } else if (context === "contact") {
      found.push({ start: match.index, end, kind: "PHONE" });
    }
  }
  // Written in groups, an identifier is masked only where the text names it as one: grouped
  // digits are as often a phone number or an amount.
  for (const match of text.matchAll(GROUPED_DIGITS)) {
    const digits = match[0].replace(/[ -]/g, "").length;
    const end = match.index + match[0].length;
    if ((digits === 10 || digits === 15) && contextOfNumber(match.index, end) === "identifier") {
      found.push({ start: match.index, end, kind: "ID" });
    }
  }
  for (const match of text.matchAll(FIFTEEN_DIGITS)) {
    const end = match.index + match[0].length;
    const vatShaped = /^3[0-9]{13}3$/.test(toLatinDigits(match[0]));
    if (vatShaped || contextOfNumber(match.index, end) === "identifier") {
      found.push({ start: match.index, end, kind: "ID" });
    }
  }
  return found;
};

/** Structured identifiers that follow a fixed format. Runs on the machine, with no network. */
export const patternDetector: Detector = {
  detect: (texts) =>
    Promise.resolve(
      texts.map((text) => {
        const entities: Array<DetectedEntity> = [...findIbans(text), ...findIdentifiers(text)];
        for (const { kind, source } of PATTERNS) {
          for (const match of text.matchAll(new RegExp(source, "gu"))) {
            entities.push({ start: match.index, end: match.index + match[0].length, kind });
          }
        }
        return entities;
      }),
    ),
};

export interface RemoteDetectorOptions {
  /** Base URL of a DoeDesk Cloud or self-hosted detection service. */
  readonly endpoint: string;
  readonly token?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}

/** Longest text sent in one piece. Longer texts are split at line or word boundaries. */
const MAX_CHUNK_LENGTH = 4000;
const MAX_CHUNKS_PER_REQUEST = 25;

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

  const detectChunks = async (chunks: ReadonlyArray<string>) => {
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
      throw new DetectorUnavailableError(`The detection service could not be reached at ${url}.`, {
        cause,
      });
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw new DetectorUnavailableError(
        `The detection service answered ${response.status}${detail ? `: ${detail}` : "."}`,
      );
    }
    const body = (await response.json()) as {
      readonly results?: ReadonlyArray<{
        readonly entities?: ReadonlyArray<Record<string, unknown>>;
      }>;
    };
    if (!Array.isArray(body.results) || body.results.length !== chunks.length) {
      throw new DetectorUnavailableError("The detection service returned an unexpected answer.");
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
      const results: Array<Array<DetectedEntity>> = texts.map(() => []);
      for (let start = 0; start < pieces.length; start += MAX_CHUNKS_PER_REQUEST) {
        const batch = pieces.slice(start, start + MAX_CHUNKS_PER_REQUEST);
        const detected = await detectChunks(batch.map((piece) => piece.text));
        batch.forEach((piece, index) => {
          for (const entity of detected[index] ?? []) {
            results[piece.textIndex]?.push({
              start: entity.start + piece.offset,
              end: entity.end + piece.offset,
              kind: entity.kind,
            });
          }
        });
      }
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

/**
 * A number the text calls an amount or a reference is not personal data, whatever a detector took
 * it for (a phone, an ID, the tail of an account). Phone numbers (0 or + first) and VAT numbers
 * are left alone.
 */
const dropReadableNumbers = (
  text: string,
  entities: ReadonlyArray<DetectedEntity>,
): ReadonlyArray<DetectedEntity> => {
  const contextOfNumber = numberContexts(text);
  return entities.filter((entity) => {
    const surface = text.slice(entity.start, entity.end);
    if (!BARE_NUMBER.test(surface) || /^3[0-9]{13}3$/.test(toLatinDigits(surface))) return true;
    return contextOfNumber(entity.start, entity.end) !== "readable";
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
