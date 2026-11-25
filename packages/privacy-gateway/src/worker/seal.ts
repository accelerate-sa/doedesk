import * as NodeCrypto from "node:crypto";

import { type EntityKind, PLACEHOLDER_SOURCE } from "../placeholders.ts";
import type { Vault } from "../vault.ts";
import type { FieldAnswer, FieldSpec } from "./fields.ts";
import type { JobResult } from "./job.ts";
import {
  choiceCost,
  costOf,
  type ProgramLeaf,
  type ProgramOutput,
  type ProgramRun,
  shapeOf,
} from "./program.ts";
import { canonicalText, digitCount, isReferenceLike, plainDigits } from "./values.ts";

/** What a sealed value is filed under for filling files: `DOC_1.fee_amount`, `calc.total`. */
export const ledgerKey = (handle: string, field: string): string => `${handle}.${field}`;

/** A computed number written the way a deliverable would write it. */
export const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) return String(value);
  const rounded =
    Math.abs(value) >= 100 ? Math.round(value * 100) / 100 : Number(value.toPrecision(6));
  const [whole = "0", fraction] = Math.abs(rounded).toString().split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${rounded < 0 ? "-" : ""}${grouped}${fraction === undefined ? "" : `.${fraction}`}`;
};

/**
 * `sealed`: choices are shown; a number, date or identifier comes back as a stand-in that is
 * restored only where the person reads it, never in what a tool is run with. Quotes never leave.
 * `masked`: values and quotes are returned; the gateway masks them like any tool result.
 */
export type SealMode = "sealed" | "masked";

export interface SealPolicy {
  /**
   * Answers about one document that may be given in clear, in all: every answer that is not a
   * stand-in. It stops a document being read out wholesale and nothing finer.
   */
  readonly clearAnswersPerDocument: number;
  /**
   * Whether the worker may answer in its own words about a sealed document. Prose is the one
   * answer that is neither checked nor sealed, so it is off unless the person turns it on.
   */
  readonly text: boolean;
  /** Characters of such prose about each document that may be returned, in all. */
  readonly textCharsPerDocument: number;
}

export const DEFAULT_SEAL_POLICY: SealPolicy = {
  clearAnswersPerDocument: 100,
  text: false,
  textCharsPerDocument: 600,
};

/** What has been revealed so far. The caller keeps it between calls. */
export interface SealLedger {
  /** Answers given in clear so far, by document handle. */
  clearAnswers: Record<string, number>;
  documentChars: Record<string, number>;
  /** Answers already shown: the same answer to the same question tells nothing new. */
  asked: Record<string, true>;
}

export const emptyLedger = (): SealLedger => ({ clearAnswers: {}, documentChars: {}, asked: {} });

/**
 * One answer the remote model was given in clear, kept for the person. `yes`, `no`: a boolean.
 * `value`: a choice, prose, or the size of a list. `notStated`, `unchecked`: the document does
 * not state it, or no answer passed the check.
 */
export interface ClearAnswer {
  readonly at: string;
  /** The document it is about, or several joined by ", " for a result computed across them. */
  readonly handle: string;
  /** The question as the remote model put it. */
  readonly asked: string;
  /**
   * `ran`, `failed`: a program was run over the documents. `asked` is its text and `value` what
   * it showed, or why it failed, which the remote model is never told.
   */
  readonly kind: "yes" | "no" | "value" | "notStated" | "unchecked" | "ran" | "failed";
  readonly value: string | null;
}

/** A sealed value as a deliverable would write it, kept on this machine for filling files. */
export interface SealedValue {
  /** As the document writes it, or for a computed number as `formatNumber` writes it. */
  readonly written: string;
  /** number: plain digits, such as `1284500.75`. */
  readonly number?: string;
  /** date: the Gregorian day as `YYYY-MM-DD`. */
  readonly iso?: string;
  /** A yes or no, or nothing: what a data file holds in its place, unquoted. */
  readonly literal?: "true" | "false" | "null";
  /** Its stand-in, so a file is filled with this value and not another written the same way. */
  readonly token?: string;
  /** A program's `sealed_list()`: `written` is its Markdown, and a file can ask for other forms. */
  readonly table?: SealedTable;
}

/** One value in a sealed list. */
export type SealedCell = Pick<SealedValue, "written" | "number" | "iso" | "literal">;

export interface SealedTable {
  /** Null for a list of plain values, or for an empty list whose program named no columns. */
  readonly columns: ReadonlyArray<string> | null;
  /** Each row's cells in column order; one cell a row when `columns` is null. */
  readonly rows: ReadonlyArray<ReadonlyArray<SealedCell>>;
}

/** What one field looks like to the remote model. */
export type ShownField = Record<string, unknown>;

export interface SealedBatch {
  /** The tool result: JSON the remote model reads. Holds no sealed value and no quote. */
  readonly payload: {
    readonly documents: ReadonlyArray<{
      readonly handle: string;
      readonly status: JobResult["status"];
      readonly fields: Record<string, ShownField>;
      readonly problem?: string;
    }>;
    /** The result of the program: `result`, or `error`, or `note` when it is withheld. */
    readonly program?: Record<string, unknown>;
  };
  /** Every sealed value of this call by reference (`DOC_1.fee_amount`), for filling files. */
  readonly values: Record<string, SealedValue>;
  /** The answers this call gave in clear for the first time, for the person's record. */
  readonly clear: ReadonlyArray<ClearAnswer>;
}

/**
 * Whether a value is distinctive enough to be looked for in what tools return and the person
 * types. A value that ordinary text also contains ("60", "2024", "2.5%") is not: looking for it
 * would replace it in the wrong places. It still gets a stand-in, which is only restored.
 */
export const isVaultSafe = (surface: string, type: FieldAnswer["type"]): boolean => {
  const trimmed = surface.trim();
  if (trimmed.length < 4) return false;
  if (type === "number") {
    const digits = digitCount(trimmed);
    return digits >= 5 || (digits === 4 && trimmed.length >= 7);
  }
  if (type === "date") return trimmed.length >= 8;
  return true;
};

/** The vault kind a sealed value is filed under. A value the vault already holds keeps its own. */
const kindFor = (type: FieldAnswer["type"], surface: string): EntityKind => {
  if (type === "number") return "AMOUNT";
  if (type === "date") return "DATE";
  return isReferenceLike(surface) ? "ID" : "OTHER";
};

const questionKey = (handle: string, field: FieldSpec): string =>
  JSON.stringify([
    handle,
    field.name,
    field.type,
    field.description,
    field.options ?? [],
    ...(field.columns === undefined ? [] : [field.columns]),
  ]);

const charge = (
  book: Record<string, number>,
  key: string,
  amount: number,
  limit: number,
): boolean => {
  const next = (book[key] ?? 0) + amount;
  if (next > limit) return false;
  book[key] = next;
  return true;
};

const LIMIT_NOTE =
  "withheld: this document has given all the answers in clear it may. The person can reset the limit in Settings, under Privacy.";

/** One answer on its way to the remote model: what was asked, and what it tells in clear. */
interface Shown {
  /** The question and the answer together: the same pair is counted once. */
  readonly key: string;
  readonly asked: string;
  /** Null for a stand-in, which tells nothing and is free. */
  readonly given: Pick<ClearAnswer, "kind" | "value"> | null;
  /** Clear answers it is charged: 1, or for a choice as many as `choiceCost` says. */
  readonly cost?: number;
}

/**
 * All the remote model is told when a program fails while running. Which fault it was can
 * depend on a value, so the fault goes to the person's record and never to the model.
 */
export const PROGRAM_FAILED =
  "The program failed on the documents' values. The reason is not shown, because it could depend on a value. Usual causes: the keys of `result` or the length of a list in it depended on a value (key by d.handle and put the condition in the value, or put a filtered list in sealed_list(...)), a value matched none of reveal()'s answers, or a value was zero.";

const describeQuestion = (
  field: Pick<FieldSpec, "name" | "description" | "type" | "options">,
): string =>
  `${field.name}: ${field.description}${field.type === "enum" ? ` (${(field.options ?? []).join(" | ")})` : ""}`;

const answerKind = (value: unknown): Pick<ClearAnswer, "kind" | "value"> =>
  typeof value === "boolean"
    ? { kind: value ? "yes" : "no", value: null }
    : { kind: "value", value: Array.isArray(value) ? value.join(", ") : String(value) };

const NONE_LEAF: ProgramLeaf = { type: "none", value: null, shown: false };
const leafOf = (output: ProgramOutput): ProgramLeaf => ("leaf" in output ? output.leaf : NONE_LEAF);

/** A value of a program's result as a deliverable would write it. */
const leafCell = (leaf: ProgramLeaf): SealedCell => {
  switch (leaf.type) {
    case "number": {
      const value = Number(leaf.value);
      return { written: leaf.written ?? formatNumber(value), number: plainDigits(value) };
    }
    case "date":
      return { written: leaf.written ?? String(leaf.value), iso: String(leaf.value) };
    case "boolean":
      return {
        written: String(leaf.value === true),
        literal: leaf.value === true ? "true" : "false",
      };
    case "none":
      return { written: "null", literal: "null" };
    default:
      return { written: leaf.written ?? String(leaf.value) };
  }
};

/** The forms a sealed list can be written in: `{{calc.flagged|csv}}`. */
const TABLE_FORMS = ["markdown", "csv", "tsv", "json", "lines"] as const;
type TableForm = (typeof TABLE_FORMS)[number];
const isTableForm = (form: string | undefined): form is TableForm =>
  (TABLE_FORMS as ReadonlyArray<string | undefined>).includes(form);

const NULL_CELL: SealedCell = { written: "null", literal: "null" };

/** A cell as text reads it: nothing for None. */
const cellText = (cell: SealedCell): string => (cell.literal === "null" ? "" : cell.written);

const csvCell = (text: string): string =>
  /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
const markdownCell = (text: string): string =>
  text.replaceAll("\\", "\\\\").replaceAll("|", "\\|").replace(/\r?\n/g, " ");

/**
 * A sealed list written out. `markdown`: a table, or a line a value for plain values; `csv` and
 * `tsv`: a header and plain digits and ISO days; `json`: an array; `lines`: a line a row.
 */
export const tableText = (table: SealedTable, form: TableForm): string => {
  const { columns, rows } = table;
  switch (form) {
    case "json":
      return `[${rows
        .map((row) =>
          columns === null
            ? jsonForm(row[0] ?? NULL_CELL)
            : `{${columns.map((name, index) => `${JSON.stringify(name)}:${jsonForm(row[index] ?? NULL_CELL)}`).join(",")}}`,
        )
        .join(",")}]`;
    case "csv":
    case "tsv": {
      const cell = form === "csv" ? csvCell : (text: string) => text.replace(/[\t\r\n]+/g, " ");
      const line = (cells: ReadonlyArray<string>) =>
        cells.map(cell).join(form === "csv" ? "," : "\t");
      return [
        ...(columns === null ? [] : [line(columns)]),
        ...rows.map((row) => line(row.map((cell) => plainForm(cell)))),
      ].join("\n");
    }
    case "markdown":
    case "lines": {
      if (form === "lines" || columns === null) {
        return rows.map((row) => row.map(cellText).join("; ")).join("\n");
      }
      const line = (cells: ReadonlyArray<string>) => `| ${cells.map(markdownCell).join(" | ")} |`;
      return [
        line(columns),
        `|${columns.map(() => " --- ").join("|")}|`,
        ...rows.map((row) => line(row.map(cellText))),
      ].join("\n");
    }
  }
};

export interface SealOptions {
  readonly mode: SealMode;
  readonly vault: Vault;
  readonly ledger: SealLedger;
  readonly policy?: SealPolicy | undefined;
  /** The time written on the record of clear answers. */
  readonly now?: (() => Date) | undefined;
  /**
   * The program to run over these answers, here and only if it may be: `trial` over made-up
   * values (`sealedRuns` in program.ts), then `run` over the documents' own.
   */
  readonly program?:
    | {
        readonly source: string;
        readonly trial: () => ProgramRun;
        readonly run: () => ProgramRun;
      }
    | undefined;
}

/**
 * A number or a date is filed under its value, so one value has one stand-in however each
 * document writes it. `filedAs` overrides that for a computed result.
 */
const sealedToken = (
  vault: Vault,
  type: FieldAnswer["type"],
  surface: string,
  value: FieldAnswer["value"],
  filedAs?: string,
): string =>
  vault.sealedTokenFor(
    kindFor(type, surface),
    surface,
    isVaultSafe(surface, type),
    filedAs ??
      (type === "number" || type === "date"
        ? `${type}:${String(value)}`
        : // As a program compares text, so a trial run keeps no equality the stand-ins do not show.
          type === "identifier"
          ? `identifier:${canonicalText(surface)}`
          : undefined),
  );

/** The stand-in a stated identifier gets, for a caller that meets the same value elsewhere. */
export const sealedIdentifierToken = (vault: Vault, surface: string): string =>
  sealedToken(vault, "identifier", surface, surface);

/**
 * Turns checked answers and a program's result into the tool result. In `sealed` mode every
 * answer that is not a stand-in is counted against its document and recorded for the person
 * first; past the document's limit, anything not shown before is withheld.
 */
export const sealBatch = (
  results: ReadonlyArray<JobResult>,
  fields: ReadonlyArray<FieldSpec>,
  options: SealOptions,
): SealedBatch => {
  const { mode, vault, ledger } = options;
  const policy = options.policy ?? DEFAULT_SEAL_POLICY;
  const specs = new Map(fields.map((field) => [field.name, field]));
  const values: Record<string, SealedValue> = {};
  const clear: Array<ClearAnswer> = [];
  const at = (options.now?.() ?? new Date()).toISOString();
  /** A field of this call was withheld at the limit: the model lacks an answer a trial keeps. */
  let withheld = false;

  /**
   * Whether an answer may be shown. `given` is what it tells in clear, or null for a stand-in,
   * which is free. Past the limit even a stand-in for a new question is withheld: a stand-in
   * where "not stated" would be refused says the value is there.
   */
  const allowAll = (handles: ReadonlyArray<string>, answers: ReadonlyArray<Shown>): boolean => {
    if (mode !== "sealed") return true;
    const fresh = answers.filter((answer) => ledger.asked[answer.key] !== true);
    if (fresh.length === 0) return true;
    const limit = policy.clearAnswersPerDocument;
    const counted = fresh.reduce(
      (total, answer) => total + (answer.given === null ? 0 : (answer.cost ?? 1)),
      0,
    );
    const full = (handle: string) => {
      const used = ledger.clearAnswers[handle] ?? 0;
      return used >= limit || used + counted > limit;
    };
    if (handles.some(full)) {
      withheld = true;
      return false;
    }
    for (const { key, asked, given, cost = 1 } of fresh) {
      if (given !== null) {
        for (const handle of handles) charge(ledger.clearAnswers, handle, cost, limit);
        clear.push({ at, handle: handles.join(", "), asked, ...given });
      }
      ledger.asked[key] = true;
    }
    return true;
  };
  const allow = (
    handles: ReadonlyArray<string>,
    key: string,
    asked: string,
    given: Shown["given"],
    cost?: number,
  ): boolean => allowAll(handles, [{ key, asked, given, ...(cost === undefined ? {} : { cost }) }]);

  /**
   * Kept under its name and under its stand-in: a later call may reuse the name for another
   * value, and a file written with the earlier stand-in must still get the earlier one.
   */
  const file = (reference: string, value: SealedValue & { readonly token: string }): void => {
    values[reference] = value;
    values[value.token] = value;
  };

  /** Files a stated value for filling files and gives its stand-in. */
  const sealStated = (reference: string, answer: FieldAnswer): string => {
    const surface = answer.surface ?? String(answer.value);
    const filedAs =
      answer.type === "number" && answer.percent === true ? `percent:${answer.value}` : undefined;
    const token = sealedToken(vault, answer.type, surface, answer.value, filedAs);
    file(reference, {
      written: surface,
      ...(answer.type === "number" ? { number: String(answer.value) } : {}),
      ...(answer.type === "date" ? { iso: String(answer.value) } : {}),
      token,
    });
    return token;
  };

  /**
   * A stand-in that is new every time and looks the same whatever it holds. One that stayed the
   * same would let a model match a result against others, and one that showed its kind would
   * let a program tell a yes from a no by returning a number for one and a date for the other.
   */
  const sealFresh = (reference: string, value: Omit<SealedValue, "token">): string => {
    const token = vault.sealedTokenFor(
      "OTHER",
      value.written,
      false,
      `computed:${NodeCrypto.randomUUID()}`,
    );
    file(reference, { ...value, token });
    return token;
  };
  const sealChoice = (reference: string, value: boolean | string): string =>
    sealFresh(reference, {
      written: String(value),
      ...(typeof value === "boolean" ? { literal: value ? "true" : "false" } : {}),
    });

  /**
   * A list as the remote model sees it: its rows, with a stand-in in every cell that holds a
   * stated value. The number of rows and which cells are empty are visible, and counted as one
   * answer; each yes-or-no or choice in a row is one more. Shown whole or not at all.
   */
  const showList = (handle: string, spec: FieldSpec, answer: FieldAnswer): ShownField => {
    const rows = answer.rows ?? [];
    const question = questionKey(handle, spec);
    const columns = new Map((spec.columns ?? []).map((column) => [column.name, column]));
    const isClear = (cell: FieldAnswer) =>
      cell.status === "ok" && (cell.type === "boolean" || cell.type === "enum");
    const shape = rows.map((cells) => cells.map((cell) => cell.status === "ok"));
    const answers: Array<Shown> = [
      {
        key: JSON.stringify([question, "rows", shape]),
        asked: `${describeQuestion(spec)} [number of rows]`,
        given: { kind: "value", value: String(rows.length) },
      },
      ...rows.flatMap((cells, index) =>
        cells.filter(isClear).map((cell) => {
          const column = columns.get(cell.name);
          return {
            key: JSON.stringify([question, index, cell.name, cell.value]),
            asked: `${spec.name}[${index}].${column === undefined ? cell.name : describeQuestion({ ...column, description: column.description ?? "" })}`,
            given: answerKind(cell.value),
            ...(cell.type === "enum" ? { cost: choiceCost(column?.options?.length ?? 2) } : {}),
          };
        }),
      ),
    ];
    if (!allowAll([handle], answers)) return { note: LIMIT_NOTE };
    return {
      value: rows.map((cells, index) =>
        Object.fromEntries(
          cells.map((cell) => [
            cell.name,
            cell.status !== "ok"
              ? null
              : isClear(cell)
                ? cell.value
                : mode === "masked"
                  ? cell.type === "identifier"
                    ? (cell.surface ?? cell.value)
                    : cell.value
                  : sealStated(`${ledgerKey(handle, spec.name)}[${index}].${cell.name}`, cell),
          ]),
        ),
      ),
    };
  };

  const showField = (handle: string, answer: FieldAnswer): ShownField => {
    const spec = specs.get(answer.name);
    // Kept for the program alone. Whether the document states it at all is kept too: the
    // answer looks the same either way, and past the limit it is withheld either way.
    const kept =
      spec?.sealed === true &&
      mode === "sealed" &&
      answer.status !== "unverified" &&
      (answer.type === "boolean" || answer.type === "enum" || spec.type === "list");
    if (spec !== undefined && kept) {
      const key = JSON.stringify([questionKey(handle, spec), "kept"]);
      if (!allow([handle], key, describeQuestion(spec), null)) return { note: LIMIT_NOTE };
      if (spec.type === "list") return { sealed: true };
      const reference = ledgerKey(handle, answer.name);
      return {
        value:
          answer.status === "absent"
            ? sealFresh(reference, { written: "null", literal: "null" })
            : sealChoice(reference, answer.value as boolean | string),
      };
    }
    if (spec !== undefined && answer.type === "list" && answer.status === "ok") {
      return showList(handle, spec, answer);
    }
    // "Not stated" and "could not be checked" are answers too: a question can be worded so
    // that which of them comes back spells out a sealed value.
    const given: Pick<ClearAnswer, "kind" | "value"> | null =
      answer.status === "absent"
        ? { kind: "notStated", value: null }
        : answer.status === "unverified"
          ? { kind: "unchecked", value: null }
          : answer.type === "boolean" || answer.type === "enum"
            ? answerKind(answer.value)
            : null;
    // Prose is counted below, by its length as well.
    if (spec !== undefined && !(answer.type === "text" && given === null)) {
      const key = JSON.stringify([questionKey(handle, spec), given ?? "stand-in"]);
      // A choice among many tells as much as reveal() choosing among as many.
      const cost =
        answer.status === "ok" && answer.type === "enum"
          ? choiceCost(spec.options?.length ?? 2)
          : undefined;
      if (!allow([handle], key, describeQuestion(spec), given, cost)) return { note: LIMIT_NOTE };
    }
    if (answer.status === "absent") return { found: false };
    if (answer.status === "unverified") {
      return {
        verified: false,
        note: "the worker gave no answer that could be checked against the document",
      };
    }
    if (mode === "masked") {
      return {
        value:
          answer.type === "number" || answer.type === "date"
            ? answer.value
            : (answer.surface ?? answer.value),
        ...(answer.surface !== null && answer.type !== "identifier"
          ? { written: answer.surface }
          : {}),
        ...(answer.evidence === null ? {} : { quote: answer.evidence.quote }),
        ...(answer.evidence === null ? {} : { at: `L${answer.evidence.line}` }),
      };
    }
    // No line number in sealed mode: the worker chooses the passage, so where it stands can
    // be made to carry a value.
    switch (answer.type) {
      case "boolean":
      case "enum":
        return { value: answer.value };
      case "text": {
        // Prose can name a value that is sealed elsewhere: those become stand-ins again.
        const text = vault.maskKnown(String(answer.value), true);
        const key = JSON.stringify([
          spec === undefined ? answer.name : questionKey(handle, spec),
          text,
        ]);
        const asked = spec === undefined ? answer.name : describeQuestion(spec);
        if (
          ledger.asked[key] !== true &&
          ((ledger.documentChars[handle] ?? 0) + text.length > policy.textCharsPerDocument ||
            !allow([handle], key, asked, { kind: "value", value: String(answer.value) }))
        ) {
          withheld = true;
          return { note: LIMIT_NOTE };
        }
        charge(ledger.documentChars, handle, text.length, Number.POSITIVE_INFINITY);
        return { value: text };
      }
      default:
        return { value: sealStated(ledgerKey(handle, answer.name), answer) };
    }
  };

  /** The value of one leaf of a program's result with nothing sealed: for files the model can read. */
  const plainLeaf = (leaf: ProgramLeaf): unknown => leaf.value;

  const sealLeaf = (reference: string, leaf: ProgramLeaf): unknown =>
    leaf.shown ? leaf.value : sealFresh(reference, leafCell(leaf));

  const shape = (output: ProgramOutput, path: string, shown: Array<string>): unknown => {
    if ("sealedList" in output) {
      const { columns, rows } = output.sealedList;
      const cells = rows.map((row) =>
        "leaf" in row ? [row.leaf] : "dict" in row ? row.dict.map(([, item]) => leafOf(item)) : [],
      );
      if (mode === "masked") {
        return cells.map((row) =>
          columns === null
            ? plainLeaf(row[0] ?? NONE_LEAF)
            : Object.fromEntries(
                columns.map((name, index) => [name, plainLeaf(row[index] ?? NONE_LEAF)]),
              ),
        );
      }
      const table: SealedTable = { columns, rows: cells.map((row) => row.map(leafCell)) };
      // One stand-in, new every time, whatever the rows: how many there are is not shown.
      return sealFresh(ledgerKey("calc", path), { written: tableText(table, "markdown"), table });
    }
    if ("list" in output) {
      return output.list.map((item, index) => shape(item, `${path}[${index}]`, shown));
    }
    if ("dict" in output) {
      return Object.fromEntries(
        output.dict.map(([key, item]) => [
          key,
          shape(item, path === "" ? key : `${path}.${key}`, shown),
        ]),
      );
    }
    const { leaf } = output;
    if (leaf.shown) shown.push(`${path === "" ? "result" : path} = ${String(leaf.value)}`);
    return mode === "masked" ? plainLeaf(leaf) : sealLeaf(ledgerKey("calc", path), leaf);
  };

  /**
   * A run's shape (keys, lengths, which values it reveals) is the trial's, which no value
   * decided; a real run of another shape fails. So what a run tells is whether it worked and
   * what it reveals: `costOf`, charged to every document of the call before the real run,
   * whatever happens. A fault of the trial depends on nothing the model lacks and is told.
   */
  const showProgram = (program: NonNullable<SealOptions["program"]>): Record<string, unknown> => {
    if (mode !== "sealed") {
      const outcome = program.run();
      return outcome.ok ? { result: shape(outcome.output, "", []) } : { error: PROGRAM_FAILED };
    }
    const limit = policy.clearAnswersPerDocument;
    const used = (handle: string) => ledger.clearAnswers[handle] ?? 0;
    if (withheld || results.some((result) => used(result.handle) >= limit)) {
      return { note: LIMIT_NOTE };
    }
    const trial = program.trial();
    if (!trial.ok) {
      return {
        error: `Program, ${trial.detail} Found in a trial run on made-up numbers, dates and identifiers, before any value of the documents was read: it cost nothing.`,
      };
    }
    const cost = costOf(trial.output);
    if (results.some((result) => used(result.handle) + cost > limit)) return { note: LIMIT_NOTE };
    const outcome = program.run();
    const handles = [...new Set(results.map((result) => result.handle))];
    for (const handle of handles) ledger.clearAnswers[handle] = used(handle) + cost;
    const record = (given: Pick<ClearAnswer, "kind" | "value">) =>
      clear.push({ at, handle: handles.join(", "), asked: program.source, ...given });
    if (!outcome.ok) {
      record({ kind: "failed", value: outcome.detail });
      return { error: PROGRAM_FAILED };
    }
    if (shapeOf(outcome.output) !== shapeOf(trial.output)) {
      record({
        kind: "failed",
        value:
          "The keys or lengths of its result, or what it revealed, depended on the documents' values.",
      });
      return { error: PROGRAM_FAILED };
    }
    const shown: Array<string> = [];
    const result = shape(outcome.output, "", shown);
    record({ kind: "ran", value: shown.length === 0 ? null : shown.join("; ") });
    return { result };
  };

  const shownDocuments = results.map((result) => ({
    handle: result.handle,
    status: result.status,
    fields: Object.fromEntries(
      result.fields.map((answer) => [answer.name, showField(result.handle, answer)]),
    ),
    ...(result.problem === null ? {} : { problem: result.problem }),
  }));
  // After the fields: a trial keeps the answers the model is given, so it must be given them.
  const programShown = options.program === undefined ? undefined : showProgram(options.program);

  return {
    payload: {
      documents: shownDocuments,
      ...(programShown === undefined ? {} : { program: programShown }),
    },
    values,
    clear,
  };
};

/**
 * A sealed value as a data file holds it: plain digits, the ISO day, or the text itself. A
 * sealed list is rows of comma-separated values, or of tab-separated ones in a `.tsv`.
 */
export const plainForm = (value: SealedValue, data: DataFile = "csv"): string =>
  value.table !== undefined
    ? tableText(value.table, data)
    : (value.number ??
      value.iso ??
      (value.literal === "null" ? "" : value.literal) ??
      value.written);

/** A file whose values are written plain: `csv` is also what a JSON string holds. */
export type DataFile = "csv" | "tsv";

const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/** A sealed value as JSON writes it: a number, true, false or null bare, anything else quoted. */
const jsonForm = (value: SealedValue): string =>
  value.table !== undefined
    ? tableText(value.table, "json")
    : value.number !== undefined && JSON_NUMBER.test(value.number)
      ? value.number
      : (value.literal ?? JSON.stringify(value.number ?? value.iso ?? value.written));

/**
 * Anything between double braces that starts like a name is a marker, so one that names no
 * value is named back and never left in a file called finished. The reference is looked up as
 * written: a program's result has the keys the program gave it (`calc.pay_DOC_1`).
 */
const REFERENCE = String.raw`[\p{L}_][^{}|\n]*?`;
const MARKER_SOURCE = String.raw`\{\{\s*${REFERENCE}\s*(?:\|[^{}|\n]*)?\}\}`;
const MARKER_PARTS = new RegExp(
  String.raw`^\{\{\s*(${REFERENCE})\s*(?:\|\s*([^{}|\n]*?)\s*)?\}\}$`,
  "u",
);

const readMarker = (marker: string): { reference: string; form: string | undefined } => {
  const [, reference = "", form] = MARKER_PARTS.exec(marker) ?? [];
  return { reference, form };
};

/**
 * The value a marker names, or undefined when it names none or asks for a form the value has
 * not. The model asked for a field's type itself, so a wrong form is its mistake to hear of. It
 * does not know what a program returned: there, a form that does not fit says nothing.
 */
const markerValue = (
  values: Readonly<Record<string, SealedValue>>,
  reference: string,
  form: string | undefined,
): SealedValue | undefined => {
  if (!Object.hasOwn(values, reference)) return undefined;
  const value = values[reference];
  if (value === undefined || form === undefined || form === "written") return value;
  if (isTableForm(form)) {
    return value.table !== undefined || reference.startsWith("calc.") ? value : undefined;
  }
  if (form !== "number" && form !== "iso") return undefined;
  return value[form] !== undefined || reference.startsWith("calc.") ? value : undefined;
};

/** What a marker is written as in text. `data`: with no form, plain digits or the ISO day. */
const markerText = (
  value: SealedValue,
  form: string | undefined,
  data: DataFile | false,
): string => {
  if (isTableForm(form)) {
    // A program's value that is not a list takes a list's form as no form at all.
    return value.table === undefined
      ? markerText(value, undefined, data)
      : tableText(value.table, form);
  }
  return form === "number" || form === "iso"
    ? (value[form] ?? plainForm(value, data || "csv"))
    : form === undefined && data !== false
      ? plainForm(value, data)
      : value.written;
};

/** A marker that is a JSON value of its own: `|written` and a date are strings, a yes is `true`. */
const markerJson = (value: SealedValue, form: string | undefined): string =>
  isTableForm(form)
    ? value.table === undefined || form === "json"
      ? jsonForm(value)
      : JSON.stringify(tableText(value.table, form))
    : form === "written"
      ? (value.literal ?? JSON.stringify(value.written))
      : form === "iso" && value.iso !== undefined
        ? JSON.stringify(value.iso)
        : jsonForm(value);

export interface FilledText {
  readonly text: string;
  readonly filled: number;
  /** Markers and stand-ins that name no sealed value, as written. */
  readonly unknown: ReadonlyArray<string>;
}

const JSON_ITEM_SOURCE = `${MARKER_SOURCE}|${PLACEHOLDER_SOURCE}`;
const JSON_PART = new RegExp(`"(?:[^"\\\\]|\\\\.)*"|${JSON_ITEM_SOURCE}`, "gu");
const JSON_ITEM = new RegExp(JSON_ITEM_SOURCE, "gu");
const JSON_ITEM_ALONE = new RegExp(`^(?:${JSON_ITEM_SOURCE})$`, "u");

/**
 * Puts values in place of the markers and stand-ins of a JSON file, in one pass, so a value
 * filled in is never read again. One that is a value of its own, bare or alone between quotes,
 * becomes that value's JSON: the model that wrote the file knows a stand-in, not whether it
 * holds a number, a yes or a name. One inside a longer string is written into the string.
 */
const fillJsonWith = (
  source: string,
  marker: (reference: string, form: string | undefined) => SealedValue | undefined,
  standIn: (token: string) => SealedValue | undefined,
): FilledText => {
  let filled = 0;
  const unknown: Array<string> = [];
  const read = (item: string): { readonly json: string; readonly text: string } | undefined => {
    const isMarker = item.startsWith("{{");
    const { reference, form } = readMarker(item);
    const value = isMarker ? marker(reference, form) : standIn(item);
    if (value === undefined) {
      unknown.push(item);
      return undefined;
    }
    filled += 1;
    return isMarker
      ? { json: markerJson(value, form), text: markerText(value, form, "csv") }
      : { json: jsonForm(value), text: plainForm(value) };
  };
  const text = source.replace(JSON_PART, (match: string, offset: number) => {
    const quoted = match.startsWith('"');
    const inner = quoted ? match.slice(1, -1) : match;
    if (quoted && !JSON_ITEM_ALONE.test(inner)) {
      return match.replace(JSON_ITEM, (item) => {
        const value = read(item);
        return value === undefined ? item : JSON.stringify(value.text).slice(1, -1);
      });
    }
    const value = read(inner);
    if (value === undefined) return match;
    // The name of an object's member is a string whatever the value is.
    const isName = /^\s*:/.test(source.slice(offset + match.length, offset + match.length + 8));
    return isName ? JSON.stringify(value.text) : value.json;
  });
  return { text, filled, unknown };
};

/** `lookup` gives the value of a stand-in, or undefined for one it does not know. */
export const fillJson = (
  source: string,
  values: Readonly<Record<string, SealedValue>>,
  lookup: (token: string) => SealedValue | undefined,
): FilledText =>
  fillJsonWith(source, (reference, form) => markerValue(values, reference, form), lookup);

/** Whether a text is JSON, or with `lines` a JSON value on every line that is not blank. */
export const parsesAsJson = (text: string, lines = false): boolean => {
  try {
    for (const part of lines ? text.split("\n").filter((line) => line.trim() !== "") : [text]) {
      JSON.parse(part);
    }
    return true;
  } catch {
    return false;
  }
};

/**
 * Whether a JSON file's text is JSON once filled, judged from the text alone: it is filled with
 * the same made-up string for every marker and stand-in. A string fits only where any value
 * does, so a text that passes is JSON whatever the values are, and one that fails is refused
 * whatever they are (`-[X]` would be JSON only when X is a number that is not negative).
 */
export const isJsonTemplate = (template: string, lines = false): boolean => {
  const madeUp = () => ({ written: "x" });
  return parsesAsJson(fillJsonWith(template, madeUp, madeUp).text, lines);
};

const DIGIT = "\\d\u0660-\u0669";
const UNIT_AFTER = new RegExp(`^(.*[${DIGIT})])\\s*([^${DIGIT}\\s][^${DIGIT}]*)$`, "su");
const UNIT_BEFORE = new RegExp(`^([^${DIGIT}]*[^${DIGIT}\\s])\\s*([${DIGIT}(-].*)$`, "su");
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * The spellings of one unit, after `canonicalText`: a document writes "ر.س" where a letter's
 * text writes "SAR". Any other unit is the same only when it is spelled the same.
 */
const UNIT_SPELLINGS: ReadonlyArray<readonly [name: string, spellings: string]> = [
  [
    "SAR",
    String.raw`sar|sr|s\.r\.?|ر\.س\.?|ر س|ر[يی]ال(?:ا|ات)?(?: سعودي(?:ه|ا)?)?|(?:saudi )?riyals?`,
  ],
  ["USD", String.raw`usd|us\$|\$|(?:us |u\.s\. )?dollars?|دولار(?:ا|ات)?(?: امريكي(?:ه|ا)?)?`],
  ["EUR", String.raw`eur|€|euros?|يورو`],
  ["GBP", String.raw`gbp|£|pounds? sterling|جنيه استرليني`],
  ["AED", String.raw`aed|د\.ا\.?|dirhams?|درهم(?: اماراتي)?|دراهم`],
  ["percent", String.raw`%|٪|percent|per cent|بالمئه|بالمائه|في المئه|في المائه`],
];
const unitPatterns = (wrap: (spellings: string) => string) =>
  UNIT_SPELLINGS.map(([name, spellings]) => [name, new RegExp(wrap(spellings), "u")] as const);
const UNIT_WHOLE = unitPatterns((spellings) => `^(?:${spellings})$`);
const UNIT_AT_END = unitPatterns((spellings) => `(?<![\\p{L}\\p{N}])(?:${spellings})$`);
const UNIT_AT_START = unitPatterns((spellings) => `^(?:${spellings})(?![\\p{L}\\p{N}])`);
/** A currency's three-letter code names itself: "KWD" beside "KWD". */
const CODE_WHOLE = /^[A-Z]{3}$/;
const CODE_AT_END = /(?<![\p{L}\p{N}])[A-Z]{3}$/u;
const CODE_AT_START = /^[A-Z]{3}(?![\p{L}\p{N}])/u;

/** The unit a value carries, by name. */
const unitNamed = (unit: string): string | undefined =>
  UNIT_WHOLE.find(([, pattern]) => pattern.test(canonicalText(unit)))?.[0] ??
  CODE_WHOLE.exec(unit.trim())?.[0];

const ITEM_AT_END = new RegExp(`(${MARKER_SOURCE}|${PLACEHOLDER_SOURCE})(\\s*)$`, "u");
const ITEM_AT_START = new RegExp(`^(\\s*)(${MARKER_SOURCE}|${PLACEHOLDER_SOURCE})`, "u");
/** A number, or a marker or stand-in that may hold one: the unit next to it is its own. */
const NUMBER_AT_END = new RegExp(`[${DIGIT}\\]}\u0000]$`, "u");
const NUMBER_AT_START = new RegExp(`^[${DIGIT}\\[{\u0000]`, "u");

/**
 * The text that touches a value on one side: no space or emphasis mark between, and a marker
 * or stand-in next to the value read as what it is written as, when `written` knows it.
 */
const touching = (
  text: string,
  side: "before" | "after",
  written: ((item: string) => string | undefined) | undefined,
): string => {
  if (side === "before") {
    const filled = text.replace(ITEM_AT_END, (whole, item: string) => written?.(item) ?? whole);
    return filled.replace(/[\s*_]+$/u, "");
  }
  const filled = text.replace(
    ITEM_AT_START,
    (whole, _gap, item: string) => written?.(item) ?? whole,
  );
  return filled.replace(/^[\s*_]+/u, "");
};

/** The unit that text ends or starts with, by name, unless it is the unit of a number beyond it. */
const unitTouching = (text: string, side: "before" | "after"): string | undefined => {
  const canonical = canonicalText(text);
  for (const [name, pattern] of side === "before" ? UNIT_AT_END : UNIT_AT_START) {
    const found = pattern.exec(canonical);
    if (found === null) continue;
    const beyond =
      side === "before"
        ? NUMBER_AT_END.test(canonical.slice(0, found.index).trimEnd())
        : NUMBER_AT_START.test(canonical.slice(found[0].length).trimStart());
    return beyond ? undefined : name;
  }
  const code = (side === "before" ? CODE_AT_END : CODE_AT_START).exec(text);
  if (code === null) return undefined;
  const beyond =
    side === "before"
      ? NUMBER_AT_END.test(text.slice(0, code.index).trimEnd())
      : NUMBER_AT_START.test(text.slice(code[0].length).trimStart());
  return beyond ? undefined : code[0];
};

/**
 * The value without the unit that the text beside it already writes. A model knows a value only
 * as a stand-in, not whether it carries its unit, and writes one itself: "{{rate}}%" for "8.40%"
 * comes out with one percent sign, and "SAR {{cap}}" for "125,000.00 SAR", "SR 125,000.00" or
 * "١٢٥٬٠٠٠ ر.س" with one SAR: the same unit on either side, in any of its spellings.
 */
export const withoutRepeatedUnit = (
  value: string,
  before: string,
  after: string,
  /** What a marker or stand-in next to the value is written as, when the caller can tell. */
  written?: (item: string) => string | undefined,
): string => {
  const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
  const previous = touching(before, "before", written);
  const next = touching(after, "after", written);
  const trailing = UNIT_AFTER.exec(value);
  const unit = trailing?.[2]?.trim() ?? "";
  if (trailing?.[1] !== undefined && unit !== "" && same(next.slice(0, unit.length), unit)) {
    // "36 months" before " monthly" is not a repeat: a word unit must end where the word ends.
    const following = next.charAt(unit.length);
    if (!WORD_CHAR.test(unit.at(-1) ?? "") || !WORD_CHAR.test(following)) return trailing[1];
  }
  const leading = UNIT_BEFORE.exec(value);
  const prefix = leading?.[1]?.trim() ?? "";
  if (leading?.[2] !== undefined && prefix !== "" && same(previous.slice(-prefix.length), prefix)) {
    const preceding = previous.charAt(previous.length - prefix.length - 1);
    if (!WORD_CHAR.test(prefix.charAt(0)) || !WORD_CHAR.test(preceding)) return leading[2];
  }
  const beside = [unitTouching(previous, "before"), unitTouching(next, "after")];
  const repeats = (carried: string) => carried !== "" && beside.includes(unitNamed(carried) ?? "");
  if (trailing?.[1] !== undefined && repeats(unit)) return trailing[1];
  if (leading?.[2] !== undefined && repeats(prefix)) return leading[2];
  return value;
};

/** How much of the text on either side of a value is looked at for a repeated unit. */
export const UNIT_REACH = 40;

/** Whether a value is a number written with a unit, which the text beside it may repeat. */
export const carriesUnit = (value: string): boolean =>
  new RegExp(`[${DIGIT}]`, "u").test(value) &&
  ((UNIT_AFTER.exec(value)?.[2]?.trim() ?? "") !== "" ||
    (UNIT_BEFORE.exec(value)?.[1]?.trim() ?? "") !== "");

const MARKER = new RegExp(MARKER_SOURCE, "gu");

/**
 * Puts sealed values into a text the remote model wrote with markers in their place:
 * `{{DOC_1.fee_amount}}` becomes the value as the document writes it, `{{DOC_1.fee_amount|number}}`
 * plain digits, `{{DOC_1.issue_date|iso}}` the day as `YYYY-MM-DD`. In a data file (`data`) a
 * marker with no form gives plain digits or the ISO day. A JSON file is filled by `fillJson`.
 */
export const fillMarkers = (
  text: string,
  values: Readonly<Record<string, SealedValue>>,
  data: DataFile | false = false,
  /** What a value is written as instead, to keep it out of a later pass (see `fill`). */
  hold: (value: string) => string = (value) => value,
): FilledText => {
  let filled = 0;
  const unknown: Array<string> = [];
  // A marker beside another: "{{DOC_1.currency}} {{DOC_1.total}}" where the total says SAR too.
  const writtenAs = (item: string): string | undefined => {
    const { reference, form } = readMarker(item);
    const value = markerValue(values, reference, form);
    return value === undefined ? undefined : markerText(value, form, data);
  };
  const result = text.replace(MARKER, (whole: string, offset: number) => {
    const { reference, form } = readMarker(whole);
    const value = markerValue(values, reference, form);
    if (value === undefined) {
      unknown.push(whole);
      return whole;
    }
    filled += 1;
    const chosen = markerText(value, form, data);
    // A form the model asked for, a data file's plain form, or a table, is written as it is.
    if (form !== undefined || data !== false || value.table !== undefined) return hold(chosen);
    return hold(
      withoutRepeatedUnit(
        chosen,
        text.slice(Math.max(0, offset - UNIT_REACH), offset),
        text.slice(offset + whole.length, offset + whole.length + UNIT_REACH),
        writtenAs,
      ),
    );
  });
  return { text: result, filled, unknown };
};
