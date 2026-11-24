import {
  type IndexedDocument,
  locateQuote,
  locateValue,
  longestCopiedRun,
  quoteText,
} from "./evidence.ts";
import { bracketsAreSign, parseDate, parseNumber, withoutNoise } from "./values.ts";

/**
 * What one field of an answer may hold. The types are closed on purpose: a boolean, a choice
 * from a list, or a value copied from the document can be checked; free prose cannot.
 */
export const FIELD_TYPES = [
  "boolean",
  "enum",
  "number",
  "date",
  "identifier",
  "text",
  "list",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/** What a column of a `list` field may hold: the checked types, and no prose. */
export const COLUMN_TYPES = ["boolean", "enum", "number", "date", "identifier"] as const;

export interface ColumnSpec {
  readonly name: string;
  readonly type: (typeof COLUMN_TYPES)[number];
  /** What the column holds, written for the worker. */
  readonly description?: string | undefined;
  /** `enum` only: the answers allowed. */
  readonly options?: ReadonlyArray<string> | undefined;
}

export interface FieldSpec {
  readonly name: string;
  readonly type: FieldType;
  /** What to look for, written for the worker. */
  readonly description: string;
  /** `enum` only: the answers allowed. */
  readonly options?: ReadonlyArray<string> | undefined;
  /** `list` only: what each row holds. */
  readonly columns?: ReadonlyArray<ColumnSpec> | undefined;
  /**
   * `boolean`, `enum`, `list`: the answer is kept from the remote model, for a program to use.
   * A yes or no, or a choice, then comes back as a stand-in; a list comes back as held.
   */
  readonly sealed?: boolean | undefined;
}

export const MAX_FIELDS = 24;
export const MAX_OPTIONS = 16;
export const MAX_COLUMNS = 8;
/** A longer list is not answered: a part of a list would be summed as if it were the whole. */
export const MAX_ROWS = 60;
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** Names a row uses itself. */
const ROW_KEYS = new Set(["quote", "scale"]);

const optionsProblem = (label: string, options: ReadonlyArray<string>): string | null => {
  if (options.length < 2 || options.length > MAX_OPTIONS) {
    return `${label} needs between 2 and ${MAX_OPTIONS} options.`;
  }
  if (options.some((option) => option.trim().length === 0 || option.length > 60)) {
    return `${label} has an empty option or one longer than 60 characters.`;
  }
  return null;
};

/** Why a list of fields cannot be used, or null. Written for the model that sent it. */
export const fieldSpecProblem = (fields: ReadonlyArray<FieldSpec>): string | null => {
  if (fields.length === 0) return "Give at least one field.";
  if (fields.length > MAX_FIELDS) return `Give at most ${MAX_FIELDS} fields in one call.`;
  const seen = new Set<string>();
  for (const field of fields) {
    if (!NAME.test(field.name)) {
      return `Field name "${field.name}" must be lower case letters, digits and underscores, starting with a letter, at most 40 characters.`;
    }
    if (seen.has(field.name)) return `Field name "${field.name}" is used twice.`;
    seen.add(field.name);
    if (field.type === "enum") {
      const problem = optionsProblem(`Field "${field.name}"`, field.options ?? []);
      if (problem !== null) return problem;
    }
    if (
      field.sealed === true &&
      field.type !== "boolean" &&
      field.type !== "enum" &&
      field.type !== "list"
    ) {
      return `Field "${field.name}": only a boolean, an enum or a list takes sealed; a ${field.type} is sealed already.`;
    }
    if (field.type !== "list") continue;
    const columns = field.columns ?? [];
    if (columns.length === 0 || columns.length > MAX_COLUMNS) {
      return `List field "${field.name}" needs between 1 and ${MAX_COLUMNS} columns.`;
    }
    const names = new Set<string>();
    for (const column of columns) {
      const label = `Column "${column.name}" of "${field.name}"`;
      if (!NAME.test(column.name) || ROW_KEYS.has(column.name)) {
        return `${label} must be lower case letters, digits and underscores, starting with a letter, and not "quote" or "scale".`;
      }
      if (names.has(column.name)) return `${label} is used twice.`;
      names.add(column.name);
      if (!(COLUMN_TYPES as ReadonlyArray<string>).includes(column.type)) {
        return `${label} must be one of: ${COLUMN_TYPES.join(", ")}.`;
      }
      if (column.type === "enum") {
        const problem = optionsProblem(label, column.options ?? []);
        if (problem !== null) return problem;
      }
    }
  }
  return null;
};

/** A column read as a field of its own, so one row's cell is checked like any single answer. */
const columnAsField = (column: ColumnSpec): FieldSpec => ({
  name: column.name,
  type: column.type,
  description: column.description ?? "",
  options: column.options,
});

type JsonSchema = Record<string, unknown>;

/** A multiplier a heading or note applies to a figure, such as a table "in thousands". */
export const NUMBER_SCALES = { none: 1, thousand: 1e3, million: 1e6, billion: 1e9 } as const;

const scaleSchema: JsonSchema = { type: "string", enum: Object.keys(NUMBER_SCALES) };

/** One object per row: the row's own passage, a value per column, and one scale for its numbers. */
const rowsSchema = (columns: ReadonlyArray<ColumnSpec>): JsonSchema => {
  const scaled = columns.some((column) => column.type === "number");
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        quote: { type: "string" },
        ...Object.fromEntries(
          columns.map((column) => [column.name, valueSchema(columnAsField(column))]),
        ),
        ...(scaled ? { scale: scaleSchema } : {}),
      },
      required: ["quote", ...columns.map((column) => column.name), ...(scaled ? ["scale"] : [])],
      additionalProperties: false,
    },
  };
};

const valueSchema = (field: FieldSpec): JsonSchema => {
  switch (field.type) {
    case "boolean":
      return { type: ["boolean", "null"] };
    case "enum":
      return { type: ["string", "null"], enum: [...(field.options ?? []), null] };
    default:
      return { type: ["string", "null"] };
  }
};

/**
 * The JSON schema the worker's answer has to follow: for each field a quote, then a value. A
 * number also says which multiplier the document applies to it from elsewhere on the page.
 */
export const answerSchema = (fields: ReadonlyArray<FieldSpec>): JsonSchema => ({
  type: "object",
  properties: Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.type === "list"
        ? rowsSchema(field.columns ?? [])
        : field.type === "number"
          ? {
              type: "object",
              properties: {
                quote: { type: "string" },
                value: valueSchema(field),
                scale: scaleSchema,
              },
              required: ["quote", "value", "scale"],
              additionalProperties: false,
            }
          : {
              type: "object",
              properties: { quote: { type: "string" }, value: valueSchema(field) },
              required: ["quote", "value"],
              additionalProperties: false,
            },
    ]),
  ),
  required: fields.map((field) => field.name),
  additionalProperties: false,
});

export type FieldStatus =
  /** A value that passed every check asked of it. */
  | "ok"
  /** The worker says the document does not state it. */
  | "absent"
  /** A value was given but a check failed: the quote is not in the document, or it does not parse. */
  | "unverified";

/** One field's answer, with real values. It stays inside the trust boundary. */
export interface FieldAnswer {
  readonly name: string;
  readonly type: FieldType;
  readonly status: FieldStatus;
  /**
   * boolean: the boolean. enum: the option. number: the number. date: the Gregorian day as
   * `YYYY-MM-DD`. identifier: the value as the document spells it. text: the worker's words.
   * list: the number of rows.
   */
  readonly value: boolean | string | number | null;
  /** number, date, identifier: the value exactly as the document writes it. */
  readonly surface: string | null;
  /** number: the document writes it as a percentage. */
  readonly percent?: boolean;
  /** date: the calendar the document wrote it in. */
  readonly calendar?: "gregorian" | "hijri";
  /** list: the rows in the document's order, each with one answer per column. */
  readonly rows?: ReadonlyArray<ReadonlyArray<FieldAnswer>>;
  /** Where the supporting quote stands in the document. Null when it was not found or not asked. */
  readonly evidence: {
    readonly quote: string;
    readonly start: number;
    readonly end: number;
    readonly line: number;
  } | null;
  /** What failed, written for the worker's next attempt. Empty when `status` is not `unverified`. */
  readonly problems: ReadonlyArray<string>;
}

export interface CheckOptions {
  /** False skips the checks against the document: an ablation, never the product. */
  readonly evidence: boolean;
  /** Text fields: the most characters kept. */
  readonly maxTextChars: number;
  /** Text fields: the longest run of words that may be copied from the document. 0 allows any. */
  readonly maxCopiedWords: number;
  /**
   * Text fields: numbers are taken out. Prose is the one answer that is neither checked nor
   * sealed, so in a sealed document it may not carry figures, dates or reference numbers.
   */
  readonly textWithoutNumbers?: boolean | undefined;
  /** enum: accept a choice that comes with no quote. Set after the worker was asked for one. */
  readonly unquotedChoice?: boolean | undefined;
}

export const DEFAULT_CHECKS: CheckOptions = {
  evidence: true,
  maxTextChars: 240,
  maxCopiedWords: 0,
};

/** An identifier is a name or a reference. Longer than this, it is a passage. */
const MAX_IDENTIFIER_CHARS = 200;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Turns the worker's raw answer for one field into a checked one. `raw` is whatever the worker
 * wrote for that field; anything malformed counts as a failed check, never as a value.
 */
export const checkField = (
  field: FieldSpec,
  raw: unknown,
  document: IndexedDocument,
  checks: CheckOptions,
): FieldAnswer => {
  const base = { name: field.name, type: field.type } as const;
  const failed = (problem: string, extra: Partial<FieldAnswer> = {}): FieldAnswer => ({
    ...base,
    status: "unverified",
    value: null,
    surface: null,
    evidence: null,
    problems: [problem],
    ...extra,
  });
  if (field.type === "list") {
    if (!Array.isArray(raw)) return failed("The value must be an array with one object per row.");
    // No rows is the list's way of saying the document does not state any.
    if (raw.length === 0) {
      return {
        ...base,
        status: "absent",
        value: null,
        surface: null,
        evidence: null,
        problems: [],
      };
    }
    if (raw.length > MAX_ROWS) return failed(`The list has more than ${MAX_ROWS} rows.`);
    const columns = (field.columns ?? []).map(columnAsField);
    const rows = raw.map((row: unknown) => {
      const cells = asRecord(row) ?? {};
      return columns.map((column) =>
        checkField(
          column,
          { quote: cells.quote, value: cells[column.name], scale: cells.scale },
          document,
          checks,
        ),
      );
    });
    // One bad cell fails the list: a list with a row missing would be totalled as if whole.
    const problems = rows.flatMap((cells, index) =>
      cells.flatMap((cell) =>
        cell.status === "unverified"
          ? [`row ${index + 1}, ${cell.name}: ${cell.problems.join(" ")}`]
          : [],
      ),
    );
    if (problems.length > 0) return failed(problems.slice(0, 6).join(" "));
    return {
      ...base,
      status: "ok",
      value: rows.length,
      surface: null,
      evidence: null,
      problems: [],
      rows,
    };
  }
  const answer = asRecord(raw);
  if (answer === undefined) return failed("No answer was given for this field.");
  const rawValue = answer.value;
  const quote = typeof answer.quote === "string" ? answer.quote.trim() : "";
  if (rawValue === null || rawValue === undefined || rawValue === "") {
    return { ...base, status: "absent", value: null, surface: null, evidence: null, problems: [] };
  }

  const located = quote.length === 0 ? null : locateQuote(document, quote);
  const evidence = located === null ? null : { quote: quoteText(document, located), ...located };
  const quoteProblem =
    quote.length === 0
      ? "The quote is empty. Copy the passage that states the answer."
      : "The quote does not occur in the document. Copy it character for character.";

  switch (field.type) {
    case "boolean": {
      if (typeof rawValue !== "boolean") return failed("The value must be true, false or null.");
      // A "no" often has nothing to quote: the document is silent. A "yes" must show its passage.
      const silentNo = rawValue === false && quote.length === 0;
      if (checks.evidence && evidence === null && !silentNo) return failed(quoteProblem);
      return { ...base, status: "ok", value: rawValue, surface: null, evidence, problems: [] };
    }
    case "enum": {
      const option = (field.options ?? []).find((candidate) => candidate === rawValue);
      if (option === undefined)
        return failed("The value must be one of the listed options, or null.");
      // "none" or "other" has no passage either; asked once for one, the choice then stands.
      const unquoted = checks.unquotedChoice === true && quote.length === 0;
      if (checks.evidence && evidence === null && !unquoted) return failed(quoteProblem);
      return { ...base, status: "ok", value: option, surface: null, evidence, problems: [] };
    }
    case "text": {
      if (typeof rawValue !== "string") return failed("The value must be text or null.");
      const kept = rawValue.trim().slice(0, checks.maxTextChars);
      const text =
        checks.textWithoutNumbers === true
          ? kept.replace(/\p{Nd}[\p{Nd}.,٫٬/:-]*\p{Nd}|\p{Nd}/gu, "#")
          : kept;
      if (checks.maxCopiedWords > 0 && longestCopiedRun(document, text) > checks.maxCopiedWords) {
        return failed(
          `The text copies more than ${checks.maxCopiedWords} consecutive words from the document. Say it in your own words.`,
        );
      }
      // Prose is the worker's own, so there is nothing to find in the document.
      return { ...base, status: "ok", value: text, surface: null, evidence, problems: [] };
    }
    case "number":
    case "date":
    case "identifier": {
      if (typeof rawValue !== "string")
        return failed("The value must be copied from the document as text.");
      const written = rawValue.trim();
      const valueAt = locateValue(document, written, located);
      if (checks.evidence && valueAt === null) {
        return failed(
          "The value does not occur in the document as written. Copy it exactly, in the document's own digits and spelling.",
        );
      }
      if (checks.evidence && evidence === null) return failed(quoteProblem);
      const surface = valueAt === null ? written : quoteText(document, valueAt);
      const where = evidence ?? (valueAt === null ? null : { quote: surface, ...valueAt });
      if (field.type === "identifier") {
        if (surface.length > MAX_IDENTIFIER_CHARS) {
          return failed(
            "An identifier is a name or a reference number, not a passage. Copy only the name or number.",
          );
        }
        return { ...base, status: "ok", value: surface, surface, evidence: where, problems: [] };
      }
      if (field.type === "number") {
        const parsed = parseNumber(surface);
        if (parsed === null) return failed("The value holds no number that can be read.");
        // A scale word inside the copied value is already applied; a heading's is applied here.
        const unscaled = parseNumber(surface.replace(/[\p{L}]+/gu, " "));
        const scale =
          typeof answer.scale === "string" && answer.scale in NUMBER_SCALES
            ? NUMBER_SCALES[answer.scale as keyof typeof NUMBER_SCALES]
            : 1;
        // An amount written wholly in words states its full value: no heading scales it.
        const factor = unscaled === null || unscaled.value !== parsed.value ? 1 : scale;
        // Accounts write a negative figure in brackets. A worker that copies the digits and
        // leaves the brackets behind would turn a loss into a profit, so the page decides.
        const bracketed =
          valueAt !== null &&
          unscaled !== null &&
          parsed.value > 0 &&
          bracketsAreSign(document.text, valueAt.start, valueAt.end);
        return {
          ...base,
          status: "ok",
          value: withoutNoise(parsed.value * factor, 15) * (bracketed ? -1 : 1),
          surface,
          percent: parsed.percent,
          evidence: where,
          problems: [],
        };
      }
      const parsed = parseDate(surface);
      if (parsed === null) {
        return failed("The value is not a whole date (day, month and year) that can be read.");
      }
      return {
        ...base,
        status: "ok",
        value: parsed.iso,
        surface,
        calendar: parsed.calendar,
        evidence: where,
        problems: [],
      };
    }
  }
};

/** Parses the worker's reply. Null when it is not a JSON object. */
export const parseAnswer = (text: string): Record<string, unknown> | null => {
  const trimmed = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const tryParse = (candidate: string) => {
    try {
      return asRecord(JSON.parse(candidate)) ?? null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(trimmed);
  if (whole !== null) return whole;
  const open = trimmed.indexOf("{");
  const close = trimmed.lastIndexOf("}");
  return open !== -1 && close > open ? tryParse(trimmed.slice(open, close + 1)) : null;
};
