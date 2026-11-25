import * as NodeCrypto from "node:crypto";

import { placeholderPattern } from "../placeholders.ts";
import type { Vault } from "../vault.ts";
import { callWorker, type WorkerEndpoint, WorkerEndpointError } from "./client.ts";
import { type IndexedDocument, indexDocument } from "./evidence.ts";
import {
  type CheckOptions,
  checkField,
  type FieldAnswer,
  fieldSpecProblem,
  type FieldSpec,
} from "./fields.ts";
import { type JobResult, runBatch, WORKER_NOT_INCLUDED, type WorkerExchange } from "./job.ts";
import {
  parseProgram,
  type Program,
  type ProgramRun,
  ProgramSyntaxError,
  sealedRuns,
} from "./program.ts";
import {
  DEFAULT_SEAL_POLICY,
  emptyLedger,
  type FilledText,
  fillJson,
  fillMarkers,
  isJsonTemplate,
  parsesAsJson,
  type PlacedText,
  placedValue,
  replaceTracked,
  UNIT_REACH,
  withoutRepeatedUnit,
  plainForm,
  sealBatch,
  type SealMode,
  type SealPolicy,
} from "./seal.ts";
import type { KeptAnswer, SealedStore } from "./store.ts";
import { noteSealedAsk } from "./turnActivity.ts";

export const MAX_DOCUMENTS_PER_CALL = 64;
/** The same question about the same documents is answered twice; a third asking is refused. */
export const MAX_ROUNDS_PER_QUESTION = 2;
/** Checked answers held in memory, so one asked again in the session is not checked again either. */
const MAX_REMEMBERED_ANSWERS = 4_000;
/** Consecutive calls in which the endpoint answered nothing, after which it counts as down. */
const FAILURES_BEFORE_OPEN = 2;
/** How long a worker that is down is left alone before one call is let through to try it. */
const OPEN_FOR_MS = 20_000;

export interface AskRequest {
  /** The project whose sealed documents are meant. */
  readonly project: string;
  /** Who asks, for the per-question round cap: a thread. */
  readonly caller: string;
  /** Sealed handles (`DOC_3`). Empty means every sealed document of the project. */
  readonly handles: ReadonlyArray<string>;
  /** In place of handles: files the caller may read anyway, by the name it gave them. */
  readonly files?: ReadonlyArray<{ readonly name: string; readonly text: string }> | undefined;
  readonly instruction: string;
  readonly fields: ReadonlyArray<FieldSpec>;
  /** A program to run over the checked answers of this call. See `program.ts`. */
  readonly program?: string | undefined;
}

export type AskAnswer =
  | { readonly ok: true; readonly mode: SealMode; readonly payload: unknown }
  /** `message` is written for the model and never quotes a document. */
  | { readonly ok: false; readonly message: string };

export interface WorkerCallRecord {
  readonly mode: SealMode | "freetext";
  readonly documents: number;
  readonly fields: number;
  /** Whether a program was run, and how it went. Null when none was sent. */
  readonly program: { readonly failed: boolean; readonly read: number } | null;
  readonly ms: number;
  readonly jobs: ReadonlyArray<{
    readonly handle: string;
    readonly status: JobResult["status"];
    readonly ms: number;
    readonly calls: number;
    readonly endpointRetries: number;
    readonly endpointErrors: ReadonlyArray<number | null>;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly reasoningTokens: number;
    readonly characters: number;
    readonly unverified: number;
    readonly servedFrom: string | null;
  }>;
  /** Answers this call gave in clear, and the most any one document has given so far. */
  readonly clear: { readonly given: number; readonly mostOnOneDocument: number };
}

export interface SealedWorkerOptions {
  readonly store: SealedStore;
  readonly vault: () => Vault | undefined;
  /** The worker to call now. Undefined when none is connected. */
  readonly endpoint: () => WorkerEndpoint | undefined;
  /** Which worker that is, for the record of clear answers: a hosted region or `custom:<host>`. */
  readonly route?: (() => string | null) | undefined;
  /** The model that answers, where the endpoint's own name is one its server replaces. */
  readonly model?: (() => string | null) | undefined;
  readonly policy?: (() => SealPolicy) | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly concurrency?: number | undefined;
  /**
   * Tries again to read a sealed file that has no text because the reading service did not
   * answer when it was sealed.
   */
  readonly readLater?: ((project: string, handle: string) => Promise<void>) | undefined;
  /** DoeDesk Cloud refused a call because its worker is not included in the account. */
  readonly onNotIncluded?: (() => void) | undefined;
  /** True: the hosted worker is the one in use and its region has none. Nothing is sent then. */
  readonly notInRegion?: (() => Promise<boolean>) | undefined;
  /** Told about each call, with counts and times and no document text. */
  readonly onCall?: ((record: WorkerCallRecord) => void) | undefined;
  /** Evaluation only: receives what was sent to the worker and what it wrote back. */
  readonly onExchange?: ((exchange: WorkerExchange) => void) | undefined;
  /** Evaluation only: weaker checks, to measure what each check is worth. */
  readonly checks?: Partial<CheckOptions> | undefined;
}

export interface SealedWorker {
  /** False while the worker is not connected or has stopped answering. */
  /** A worker is set up. The tools are offered on this, so they do not vanish mid-task. */
  readonly connected: () => boolean;
  /** It is set up and has not just failed twice in a row. */
  readonly available: () => boolean;
  /**
   * The worker's server last said it was busy, with this many calls waiting in its region. A
   * busy worker is not a failed one. Null once a call is answered.
   */
  readonly busy: () => { readonly waiting: number } | null;
  /**
   * Another worker answers from now on: the answers remembered from the last one, in memory and
   * on disk, and its count of failures are dropped. Sealed documents and the record of clear
   * answers are untouched.
   */
  readonly reset: () => void;
  readonly ask: (request: AskRequest) => Promise<AskAnswer>;
  /**
   * Puts sealed values into text the model wrote with `{{DOC_1.field}}` markers and keeps the
   * result for the person. Nothing of the result is returned to the model.
   */
  readonly fill: (
    project: string,
    name: string,
    template: string,
  ) => {
    readonly filled: number;
    readonly unknown: ReadonlyArray<string>;
    readonly name: string;
    /** A `.json` or `.jsonl` file that is not JSON once filled. */
    readonly invalid: boolean;
  };
  /** Finished files whose draft, as the model wrote it for `fill`, is kept. */
  readonly drafts: (project: string) => ReadonlyArray<string>;
  /**
   * A finished file's draft with stand-ins and markers, for the model to revise and fill again.
   * Every known value in it, sealed ones too, is a stand-in. Undefined when none is kept.
   */
  readonly draft: (project: string, name: string) => string | undefined;
  /**
   * Evaluation only: the same question, but each document's answer is the worker's own prose,
   * returned unchecked and unsealed. Measures what the typed answers and the checks are worth.
   */
  readonly askFreeText: (request: AskRequest) => Promise<AskAnswer>;
}

/** Told to the agent about a sealed file that cannot be asked about yet. Never quotes the file. */
const unreadProblem = (reason: string): string =>
  `This file is sealed but cannot be asked about yet: ${reason} Tell the person, who can try reading it again in DoeDesk. Do not look for the file elsewhere.`;

const NOT_CONNECTED =
  "No worker is connected, so sealed documents cannot be asked about. The person can connect one in Settings, under Privacy.";
/** Not a fault, and nothing to retry: DoeDesk Cloud offers no worker in the account's region yet. */
const NOT_IN_REGION =
  "DoeDesk Cloud's worker is not available in this account's region yet, so sealed documents cannot be asked about now. Nothing is wrong and nothing was sent anywhere. Tell the person once: they can connect their own server in Settings, under Privacy. Do not ask again and do not look for the file elsewhere.";
const DOWN =
  "The worker did not answer. Sealed documents cannot be read any other way, so do not guess. If it fails again, tell the person the worker is unreachable.";
/** Written for the model: the worker is working, for other people, and will take this later. */
export const workerBusyMessage = (waiting: number, retryAfter: number | null): string =>
  `The worker is busy: ${waiting} ${waiting === 1 ? "call is" : "calls are"} waiting for it. Nothing is wrong with it, and sealed documents cannot be read any other way, so do not guess. Wait ${Math.max(5, Math.ceil(retryAfter ?? 5))} seconds and ask once more. If it is still busy, tell the person the worker is busy and to try again shortly.`;

export const makeSealedWorker = (options: SealedWorkerOptions): SealedWorker => {
  const rounds = new Map<string, number>();
  const remembered = new Map<string, FieldAnswer>();
  /** Answers being asked for now, by the key they will be remembered under. Never rejects. */
  const inFlight = new Map<string, Promise<void>>();
  let failures = 0;
  let openedAt = 0;
  let busy: { readonly waiting: number } | null = null;
  const sealedChecks: CheckOptions = {
    evidence: true,
    maxTextChars: 240,
    maxCopiedWords: 5,
    textWithoutNumbers: true,
    ...options.checks,
  };

  const endpointDown = () =>
    failures >= FAILURES_BEFORE_OPEN && Date.now() - openedAt < OPEN_FOR_MS;
  const noteOutcome = (answered: boolean) => {
    if (answered) failures = 0;
    else {
      failures += 1;
      if (failures >= FAILURES_BEFORE_OPEN) openedAt = Date.now();
    }
  };

  const ask = async (request: AskRequest): Promise<AskAnswer> => {
    const endpoint = options.endpoint();
    if (endpoint === undefined) return { ok: false, message: NOT_CONNECTED };
    if ((await options.notInRegion?.()) === true) return { ok: false, message: NOT_IN_REGION };
    if (endpointDown()) {
      // Said in seconds, so an agent waits it out instead of asking again at once and giving up.
      const seconds = Math.max(1, Math.ceil((OPEN_FOR_MS - (Date.now() - openedAt)) / 1000));
      return {
        ok: false,
        message: `${DOWN} Wait ${seconds} seconds and ask once more first.`,
      };
    }
    const vault = options.vault();
    if (vault === undefined) return { ok: false, message: "DoeDesk privacy is not active." };
    const problem = fieldSpecProblem(request.fields);
    if (problem !== null) return { ok: false, message: problem };
    // Read before the worker is asked anything: a fault in the program's text costs no call,
    // and can be said in full because no value has been read yet.
    let program: Program | undefined;
    if (request.program !== undefined && request.program.trim() !== "") {
      // A name that is a yes or no anywhere in the call is taken for one.
      const known = new Map<string, string>();
      for (const [name, type] of request.fields.flatMap((field) => [
        [field.name, field.type] as const,
        ...(field.columns ?? []).map((column) => [column.name, column.type] as const),
      ])) {
        if (known.get(name) !== "boolean") known.set(name, type);
      }
      try {
        program = parseProgram(request.program, known);
      } catch (cause) {
        if (!(cause instanceof ProgramSyntaxError)) throw cause;
        return { ok: false, message: `Program, line ${cause.line}: ${cause.message}` };
      }
    }
    if (request.instruction.trim().length === 0) {
      return { ok: false, message: "Give an instruction: what the fields are for." };
    }

    const mode: SealMode = request.files === undefined ? "sealed" : "masked";
    const policy = options.policy?.() ?? DEFAULT_SEAL_POLICY;
    if (
      mode === "sealed" &&
      !policy.text &&
      request.fields.some((field) => field.type === "text")
    ) {
      return {
        ok: false,
        message:
          "Text answers are switched off for sealed documents. Ask for a boolean, an enum, a number, a date or an identifier instead.",
      };
    }
    // Stand-ins of sealed values are not restored in a tool call on its way here, and the
    // worker is inside the boundary: it is told the real values. Not for a file the model can
    // read, whose answers go back in clear and would carry the value with them; and never in
    // an enum's options, which are what the answer is.
    const real = (text: string) => vault.unmask(text, false, mode === "sealed");
    const fields = request.fields.map((field) => ({
      ...field,
      description: real(field.description),
    }));
    const instruction = real(request.instruction);
    let documents: ReadonlyArray<{ readonly handle: string; readonly text: string }>;
    // Sealed files that are kept and have no text yet: named in the answer, and not asked.
    let unread: ReadonlyArray<{ readonly handle: string; readonly problem: string }> = [];
    if (request.files !== undefined) {
      documents = request.files.map((file) => ({ handle: file.name, text: file.text }));
    } else {
      const known = options.store.list(request.project);
      if (known.length === 0)
        return { ok: false, message: "This project has no sealed documents." };
      const wanted =
        request.handles.length === 0 ? known.map((info) => info.handle) : request.handles;
      const missing = wanted.filter((handle) => !known.some((info) => info.handle === handle));
      if (missing.length > 0) {
        return {
          ok: false,
          message: `No sealed document is called ${missing.join(", ")}. This project has ${known[0]?.handle} to ${known.at(-1)?.handle}.`,
        };
      }
      // A file sealed while the reading service was down is read now, when it is first needed.
      await Promise.all(
        known
          .filter((info) => wanted.includes(info.handle) && info.unread?.kind === "service")
          .map((info) => options.readLater?.(request.project, info.handle)),
      );
      documents = wanted.flatMap((handle) => {
        const text = options.store.read(request.project, handle);
        return text === undefined ? [] : [{ handle, text }];
      });
      const readable = new Set(documents.map((document) => document.handle));
      unread = options.store
        .list(request.project)
        .flatMap((info) =>
          wanted.includes(info.handle) && !readable.has(info.handle) && info.unread !== undefined
            ? [{ handle: info.handle, problem: unreadProblem(info.unread.message) }]
            : [],
        );
      if (documents.length === 0 && unread.length > 0) {
        return {
          ok: false,
          message: `${unread.map((document) => document.handle).join(", ")}: ${unread[0]?.problem}`,
        };
      }
    }
    if (documents.length === 0) return { ok: false, message: "No document could be read." };
    if (documents.length > MAX_DOCUMENTS_PER_CALL) {
      return {
        ok: false,
        message: `Ask about at most ${MAX_DOCUMENTS_PER_CALL} documents in one call.`,
      };
    }

    const signature = JSON.stringify([
      request.caller,
      documents.map((document) => document.handle),
      request.fields,
      request.program ?? "",
    ]);
    const asked = (rounds.get(signature) ?? 0) + 1;
    if (asked > MAX_ROUNDS_PER_QUESTION) {
      return {
        ok: false,
        message:
          "This exact question was already asked twice. Asking again will not change the answers: work with what came back, or ask a different question.",
      };
    }
    rounds.set(signature, asked);

    const started = performance.now();
    // An answer that passed its checks is kept, so the next program over the same fields, or a
    // call that adds one field, asks the worker only for what it has not answered yet.
    type Asked = (typeof documents)[number];
    const digests = new Map(
      documents.map((document) => [
        document,
        NodeCrypto.createHash("sha256").update(document.text).digest("base64"),
      ]),
    );
    // Another model, another server or another region is another worker: its answers are its own.
    const answering = JSON.stringify([
      options.route?.() ?? null,
      endpoint.model,
      endpoint.reasoningEffort ?? null,
      options.model?.() ?? null,
    ]);
    const memory = (document: Asked, field: FieldSpec): string =>
      JSON.stringify([request.project, digests.get(document), answering, instruction, field]);
    const keptKey = (field: FieldSpec): string =>
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify([instruction, field]))
        .digest("base64");
    // What an earlier session was answered, read once for each document of this call.
    const kept = new Map<Asked, Map<string, KeptAnswer>>();
    const indexed = new Map<Asked, IndexedDocument>();
    const known = (document: Asked, field: FieldSpec): FieldAnswer | undefined => {
      if (mode !== "sealed") return undefined;
      const key = memory(document, field);
      const held = remembered.get(key);
      if (held !== undefined) return held;
      let replies = kept.get(document);
      if (replies === undefined) {
        replies = new Map(
          options.store
            .keptAnswers(request.project, document.handle, answering, digests.get(document) ?? "")
            .map((answer) => [answer.key, answer]),
        );
        kept.set(document, replies);
      }
      const reply = replies.get(keptKey(field));
      if (reply === undefined) return undefined;
      // The worker's reply is put through the checks again, against the document as it is and
      // by the checks as they are: it is used only if a fresh reply of these words would be.
      let index = indexed.get(document);
      if (index === undefined) {
        index = indexDocument(document.text);
        indexed.set(document, index);
      }
      const answer = checkField(field, reply.raw, index, {
        ...sealedChecks,
        unquotedChoice: reply.unquotedChoice,
      });
      if (answer.status === "unverified") {
        replies.delete(keptKey(field));
        return undefined;
      }
      remembered.set(key, answer);
      return answer;
    };
    // Two questions at once about the same document and field share one call: the second
    // waits for the first one's answer and asks only for what is still missing then.
    while (mode === "sealed") {
      const waits = documents.flatMap((document) =>
        fields.flatMap((field) =>
          known(document, field) === undefined ? (inFlight.get(memory(document, field)) ?? []) : [],
        ),
      );
      if (waits.length === 0) break;
      await Promise.all(waits);
    }
    const missing = fields.filter((field) =>
      documents.some((document) => known(document, field) === undefined),
    );
    let results: ReadonlyArray<JobResult>;
    if (missing.length === 0) {
      results = documents.map((document) => ({
        handle: document.handle,
        status: "done",
        fields: fields.flatMap((field) => known(document, field) ?? []),
        attempts: [],
        ms: 0,
        problem: null,
        endpointRetries: 0,
        endpointErrors: [],
      }));
    } else {
      // Only documents that still lack an answer are sent: asking again goes on where it stopped.
      const pending = documents.filter((document) =>
        missing.some((field) => known(document, field) === undefined),
      );
      let settle: () => void = () => undefined;
      const settled = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const asking =
        mode === "sealed"
          ? pending.flatMap((document) =>
              missing.flatMap((field) =>
                known(document, field) === undefined ? [memory(document, field)] : [],
              ),
            )
          : [];
      for (const key of asking) inFlight.set(key, settled);
      try {
        const batch = await runBatch(pending, instruction, missing, {
          endpoint,
          checks:
            mode === "sealed"
              ? sealedChecks
              : {
                  ...sealedChecks,
                  maxCopiedWords: 0,
                  maxTextChars: 600,
                  textWithoutNumbers: false,
                },
          concurrency: options.concurrency ?? 16,
          fetch: options.fetch,
          onExchange: options.onExchange,
        });
        const answered = batch.some((result) => result.attempts.length > 0);
        const waiting = batch.find((result) => result.busy !== undefined)?.busy;
        busy = waiting === undefined ? null : { waiting: waiting.waiting };
        // A question with documents still waiting their turn may be put again: it is not used up.
        if (waiting !== undefined || batch.some((result) => result.notReached === true)) {
          rounds.set(signature, asked - 1);
        }
        if (batch.some((result) => result.notIncluded === true)) {
          // Not a failure of the worker's, and not worth another try: the account does not have it.
          options.onNotIncluded?.();
          return { ok: false, message: WORKER_NOT_INCLUDED };
        }
        if (!answered && waiting !== undefined) {
          // Busy is not down: it is not held against the worker.
          return { ok: false, message: workerBusyMessage(waiting.waiting, waiting.retryAfter) };
        }
        noteOutcome(answered);
        if (!answered) {
          return {
            ok: false,
            message: batch[0]?.problem === null ? DOWN : `${DOWN} (${batch[0]?.problem})`,
          };
        }
        const byDocument = new Map(pending.map((document, index) => [document, batch[index]]));
        results = documents.map((document): JobResult => {
          const result = byDocument.get(document);
          if (result === undefined) {
            return {
              handle: document.handle,
              status: "done",
              fields: fields.flatMap((field) => known(document, field) ?? []),
              attempts: [],
              ms: 0,
              problem: null,
              endpointRetries: 0,
              endpointErrors: [],
            };
          }
          const fresh = new Map(result.fields.map((answer) => [answer.name, answer]));
          if (mode === "sealed") {
            const replies: Array<KeptAnswer> = [];
            for (const field of missing) {
              const answer = fresh.get(field.name);
              if (answer !== undefined && answer.status !== "unverified") {
                remembered.set(memory(document, field), answer);
                const reply = result.replies?.get(field.name);
                if (reply !== undefined) replies.push({ key: keptKey(field), ...reply });
              }
            }
            options.store.keepAnswers(
              request.project,
              document.handle,
              answering,
              digests.get(document) ?? "",
              replies,
            );
          }
          return {
            ...result,
            // An answer remembered from an earlier asking stands where this one gave none.
            fields: fields.flatMap((field) => {
              const answer = fresh.get(field.name);
              return answer !== undefined && answer.status !== "unverified"
                ? answer
                : (known(document, field) ?? answer ?? []);
            }),
          };
        });
      } finally {
        for (const key of asking) inFlight.delete(key);
        settle();
      }
      while (remembered.size > MAX_REMEMBERED_ANSWERS) {
        const oldest = remembered.keys().next().value;
        if (oldest === undefined) break;
        remembered.delete(oldest);
      }
    }

    results = [
      ...results,
      ...unread.map((document): JobResult => ({
        handle: document.handle,
        status: "failed",
        fields: [],
        attempts: [],
        ms: 0,
        problem: document.problem,
        endpointRetries: 0,
        endpointErrors: [],
      })),
    ];

    let outcome: ProgramRun | undefined;
    const runs = program === undefined ? undefined : sealedRuns(program, results, fields);
    const run = runs === undefined ? undefined : { ...runs, run: () => (outcome = runs.run()) };
    const ledger = mode === "sealed" ? options.store.ledger(request.project) : emptyLedger();
    const sealed = sealBatch(results, fields, { mode, vault, ledger, policy, program: run });
    if (mode === "sealed") {
      options.store.saveLedger(request.project, ledger);
      options.store.mergeValues(request.project, sealed.values);
      noteSealedAsk(
        options.store,
        request.project,
        request.caller,
        documents.map((document) => document.handle),
        options.store.recordClearAnswers(request.project, sealed.clear, options.route?.() ?? null),
      );
    }
    options.onCall?.({
      mode,
      documents: documents.length,
      fields: request.fields.length,
      program:
        run === undefined
          ? null
          : {
              failed: sealed.payload.program?.result === undefined,
              read: outcome?.read.length ?? 0,
            },
      ms: Math.round(performance.now() - started),
      jobs: results.map((result, index) => ({
        handle: result.handle,
        status: result.status,
        ms: Math.round(result.ms),
        calls: result.attempts.length,
        endpointRetries: result.endpointRetries,
        endpointErrors: result.endpointErrors,
        inputTokens: result.attempts.reduce(
          (total, attempt) => total + attempt.usage.inputTokens,
          0,
        ),
        outputTokens: result.attempts.reduce(
          (total, attempt) => total + attempt.usage.outputTokens,
          0,
        ),
        reasoningTokens: result.attempts.reduce(
          (total, attempt) => total + attempt.usage.reasoningTokens,
          0,
        ),
        characters: documents[index]?.text.length ?? 0,
        unverified: result.fields.filter((field) => field.status === "unverified").length,
        servedFrom: result.attempts.at(-1)?.servedFrom ?? null,
      })),
      clear: {
        given: sealed.clear.length,
        mostOnOneDocument: Math.max(0, ...Object.values(ledger.clearAnswers)),
      },
    });
    return { ok: true, mode, payload: sealed.payload };
  };

  return {
    connected: () => options.endpoint() !== undefined,
    available: () => options.endpoint() !== undefined && !endpointDown(),
    busy: () => busy,
    reset: () => {
      remembered.clear();
      options.store.forgetAnswers();
      failures = 0;
      openedAt = 0;
      busy = null;
    },
    ask,
    fill: (project, name, template) => {
      const jsonLines = /\.(jsonl|ndjson)$/i.test(name);
      const json = jsonLines || /\.json$/i.test(name);
      const data = /\.tsv$/i.test(name) ? "tsv" : /\.csv$/i.test(name) ? "csv" : false;
      const values = options.store.values(project);
      // Stand-ins the model wrote into the file are finished here too, and only here.
      const vault = options.vault();
      // By stand-in first: two values can be written alike and differ in their plain form.
      const byToken = new Map(
        Object.values(values).flatMap((value) =>
          value.token === undefined ? [] : [[value.token, value] as const],
        ),
      );
      const byWritten = new Map(Object.values(values).map((value) => [value.written, value]));
      const typed = (token: string) => {
        const known = byToken.get(token);
        if (known !== undefined) return known;
        const written = vault?.resolve(token);
        return written === undefined ? undefined : (byWritten.get(written) ?? { written });
      };
      const fillText = (): FilledText => {
        // A value filled in is not read for stand-ins: a program's text can spell made-up ones,
        // and what is unknown or how many were filled goes back to the model.
        const nonce = NodeCrypto.randomUUID();
        const held: Array<PlacedText> = [];
        const hold = (placed: PlacedText): PlacedText => {
          held.push(placed);
          return { text: `\u0000${nonce}:${held.length - 1}\u0000`, spans: [] };
        };
        const marked = fillMarkers(template, values, data, hold);
        const left: Array<string> = [];
        let restored = 0;
        const source = marked.text;
        const text = replaceTracked(source, placeholderPattern(), (token, offset) => {
          const value = typed(token);
          if (value === undefined) {
            left.push(token);
            return undefined;
          }
          restored += 1;
          const written =
            data !== false
              ? plainForm(value, data)
              : value.table !== undefined
                ? value.written
                : withoutRepeatedUnit(
                    value.written,
                    source.slice(Math.max(0, offset - UNIT_REACH), offset),
                    source.slice(offset + token.length, offset + token.length + UNIT_REACH),
                    (item) => typed(item)?.written,
                  );
          return hold(placedValue(written, value, { token }));
        }).text;
        // Every value was held, so each lands, with its span, only here.
        const finished = replaceTracked(
          text,
          new RegExp(`\u0000${nonce}:(\\d+)\u0000`, "g"),
          (match) => held[Number(match.slice(nonce.length + 2, -1))] ?? { text: "", spans: [] },
        );
        return {
          text: finished.text,
          filled: marked.filled + restored,
          unknown: [...marked.unknown, ...left],
          spans: finished.spans,
        };
      };
      const done = json ? fillJson(template, values, typed) : fillText();
      const unknown = [...new Set(done.unknown)];
      // Judged from the text the model wrote, which says the same for any value. The finished
      // text is parsed as well before it is kept: the two differ only if the filling is wrong,
      // and a file that is not JSON must not be called finished.
      const invalid =
        json &&
        (!isJsonTemplate(template, jsonLines) ||
          (unknown.length === 0 && !parsesAsJson(done.text, jsonLines)));
      const info = options.store.writeOutput(
        project,
        name,
        done.text,
        done.filled,
        template,
        done.spans,
      );
      return { filled: done.filled, unknown, name: info.name, invalid };
    },
    drafts: (project) =>
      options.store
        .outputs(project)
        .filter((output) => output.hasTemplate === true)
        .map((output) => output.name),
    draft: (project, name) => {
      const vault = options.vault();
      const template = options.store.readOutputTemplate(project, name);
      // The model wrote it, but a real value it typed in is a stand-in again on the way back.
      return vault === undefined || template === undefined
        ? undefined
        : vault.maskKnown(template, true);
    },
    askFreeText: async (request) => {
      const endpoint = options.endpoint();
      if (endpoint === undefined) return { ok: false, message: NOT_CONNECTED };
      if ((await options.notInRegion?.()) === true) return { ok: false, message: NOT_IN_REGION };
      const known = options.store.list(request.project);
      const wanted =
        request.handles.length === 0 ? known.map((info) => info.handle) : request.handles;
      const question = [
        request.instruction.trim(),
        "",
        "Answer each of these about the document, in plain prose:",
        ...request.fields.map((field) => `- ${field.name}: ${field.description}`),
      ].join("\n");
      const started = performance.now();
      const answers = await Promise.all(
        wanted.map(async (handle) => {
          const text = options.store.read(request.project, handle);
          if (text === undefined) return { handle, answer: null, usage: null, ms: 0 };
          const user = `<document id="${handle}">\n${text}\n</document>\n\n${question}`;
          try {
            const reply = await callWorker(
              { ...endpoint, structured: "none" },
              {
                system: "You answer questions about one document. Answer from the document only.",
                user,
                schema: {},
                maxOutputTokens: 2_000,
                signal: AbortSignal.timeout(60_000),
              },
              options.fetch,
            );
            options.onExchange?.({
              handle,
              attempt: 1,
              request: user,
              corrections: [],
              reply: reply.text,
            });
            return {
              handle,
              answer: reply.text,
              usage: reply.usage,
              ms: reply.ms,
              characters: text.length,
              servedFrom: reply.servedFrom,
            };
          } catch (cause) {
            return {
              handle,
              answer: null,
              usage: null,
              ms: 0,
              problem: cause instanceof WorkerEndpointError ? cause.message : String(cause),
            };
          }
        }),
      );
      options.onCall?.({
        mode: "freetext",
        documents: wanted.length,
        fields: 0,
        program: null,
        ms: Math.round(performance.now() - started),
        jobs: answers.map((answer) => ({
          handle: answer.handle,
          status: answer.answer === null ? "failed" : "done",
          ms: Math.round(answer.ms),
          calls: answer.answer === null ? 0 : 1,
          endpointRetries: 0,
          endpointErrors: [],
          inputTokens: answer.usage?.inputTokens ?? 0,
          outputTokens: answer.usage?.outputTokens ?? 0,
          reasoningTokens: answer.usage?.reasoningTokens ?? 0,
          characters: answer.characters ?? 0,
          unverified: 0,
          servedFrom: answer.servedFrom ?? null,
        })),
        clear: { given: 0, mostOnOneDocument: 0 },
      });
      return {
        ok: true,
        mode: "masked",
        payload: {
          documents: answers.map(({ handle, answer }) => ({
            handle,
            status: answer === null ? "failed" : "done",
            fields: { answer: { value: answer } },
          })),
        },
      };
    },
  };
};
