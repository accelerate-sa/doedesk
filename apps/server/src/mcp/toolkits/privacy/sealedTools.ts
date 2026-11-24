import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { COLUMN_TYPES, FIELD_TYPES } from "@t3tools/privacy-gateway";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PrivacyGateway from "../../../privacy/PrivacyGateway.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  PrivacyGateway.PrivacyGateway,
  Project.ProjectService,
  FileSystem.FileSystem,
  Path.Path,
];

const Name = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(40));

const Options = Schema.Array(Schema.String.check(Schema.isMaxLength(60)));

const Column = Schema.Struct({
  name: Name,
  type: Schema.Literals(COLUMN_TYPES),
  description: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  options: Schema.optionalKey(Options),
});

const Field = Schema.Struct({
  name: Name,
  type: Schema.Literals(FIELD_TYPES),
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(600)).annotate({
    description:
      "Exactly which value, for a reader who sees only the document: say which date or amount when it has several.",
  }),
  options: Schema.optionalKey(Options.annotate({ description: "enum only: the allowed answers." })),
  columns: Schema.optionalKey(
    Schema.Array(Column).annotate({ description: "list only: what each row holds." }),
  ),
  sealed: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "boolean, enum, list: keep the answer for your program; you are not shown it.",
    }),
  ),
});

/** Told to every agent: ask no more than the deliverable needs. */
const ASK_THE_MINIMUM =
  'Ask the minimum. Every answer that is not a stand-in (a yes or no, a choice, "not stated") reaches your provider, is recorded for the person and counts against a limit each document has; so does each run of a program, for every document of the call: once, and once more for each yes or no it reveals. Ask a yes-or-no question where one will do, seal a category only your program needs, ask for no category the deliverable does not need, compute in a program instead of narrowing a value down, and do not ask again to double-check.';
/** Evaluation only: what agents were told before, to measure what the sentence above changes. */
const ASK_WITHIN_THE_LIMIT =
  "Each document answers a limited number of questions in clear, and a program run counts as one for every document of the call: compute in a program instead of narrowing a value down, and do not ask again to double-check.";

const askDocumentsTool = (guidance: string) =>
  Tool.make("ask_documents", {
    description: [
      "Read a sealed file: ask typed questions about sealed files and other documents through a small model that reads them for you. A file the person sealed is no longer in the folder, and this is the only way to use it (handles DOC_1, DOC_2, ...; leave `documents` out for all of them). Or give absolute paths of workspace files to read many at once.",
      "Every listed document is asked the same fields in one call, and each call makes the worker read every listed document from start to end, so ask once: put everything the task needs from the documents in one call, the fields of every deliverable and the `program` with them. Do not ask what kind each document is first and come back for its details: ask the kind and the details together, and a document that does not state a field says so. If a later step turns out to need one more field, repeat the instruction and the earlier fields word for word beside it, so the worker is asked only for the new one. Field types: boolean and enum come back in clear, or as a stand-in when you set `sealed: true` because only your program needs them; number, date and identifier are copied from the document and come back sealed; a name (of a person, a company, a place) and a reference number are identifiers. A list field reads rows the document repeats (line items, a schedule of payments): give `columns`, and it comes back as an array of rows, each cell like a single value, with the number of rows in clear. For sealed documents text fields are off unless the person turned them on: ask for an identifier, an enum or a boolean instead.",
      'Sealed documents answer: boolean or enum as the value; number, date or identifier as a stand-in like [AMOUNT_K2M4P]; {"found":false} when the document does not state it; {"verified":false} when no answer could be confirmed. A value read from a document always gets the same stand-in, so you can match documents by it; a computed result or a sealed choice gets a new one each call. Dates are read in either calendar and any digits, a number field can copy an amount written in words, a figure that accounts write in brackets is read as negative, and a scale a heading states (in thousands) is already applied: never ask for a conversion, flip a sign or multiply by the scale yourself. Write a stand-in wherever the value belongs: in your reply the person sees the real value. In a file it stays a stand-in until you call fill_sealed. It is never replaced in a command or tool you run, so you cannot read or compute with the value yourself: send a `program`.',
      [
        '`program` is a small Python program run over this call\'s answers, so you compute with values you never see. `docs` is the documents in order; `d.handle` is its handle and `d["field"]` its value: a number, a date, text, True or False, a list of row dicts (empty when the document has none), or None when not stated or not confirmed. Assign `result`, a dict or list: every value in it comes back as a stand-in, a yes or no included. Its keys and the length of its lists must not depend on a value: key by d.handle and put a condition in the value (`{d.handle: d["amount"] > 1000 for d in docs}`), never filter a list by one. To be shown something, wrap it in reveal(): reveal(x) shows a yes or no, such as reveal(n > 0); reveal(x, [0, 1, 2, 3]) shows which of the answers you list x is, up to 16, and costs as many answers as it takes to tell them apart. A value of a document is never shown as it is.',
        'There is if, for, def, lambda, comprehensions and these functions: len sum min max abs round ceil floor int float sorted range enumerate zip any all, date("2026-01-31"), days_between(a, b), add_days(d, n), add_months(d, n), doc("DOC_1"). No import, no while, no f-strings. round() rounds a half away from zero, a date compares only with a date, has .year .month .day, and minus a date is days, and text compares without regard to case or digit script.',
        'Example: `days = {d.handle: days_between(d["due"], d["paid"]) for d in docs}` then `result = {"days": days, "penalty": min(sum(0.01 * d["amount"] for d in docs if days[d.handle] > 30), 50000), "any_late": reveal(max(days.values()) > 30)}`.',
        "The program first runs on made-up values: a fault in its text or in that run is reported with its line and costs nothing. A fault on the documents' own values is not explained, because the reason could give a value away.",
      ].join(" "),
      guidance,
    ].join("\n"),
    parameters: Schema.Struct({
      documents: Schema.optionalKey(
        Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).annotate({
          description: "Sealed handles, or absolute workspace paths; not both.",
        }),
      ),
      instruction: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000)).annotate({
        description:
          "What the fields are for. The worker sees this and the fields, not this conversation.",
      }),
      fields: Schema.Array(Field),
      program: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4000))),
    }),
    success: Schema.Struct({
      mode: Schema.Literals(["sealed", "masked"]),
      documents: Schema.Array(
        Schema.Struct({
          handle: Schema.String,
          status: Schema.Literals(["done", "partial", "failed"]),
          fields: Schema.Record(Schema.String, Schema.Unknown),
          problem: Schema.optionalKey(Schema.String),
        }),
      ),
      program: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies,
  })
    .annotate(Tool.Title, "Ask sealed files and documents")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true)
    .annotate(Tool.OpenWorld, true)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const FillSealedTool = Tool.make("fill_sealed", {
  description: [
    "Make a finished file that holds sealed values: a summary, a letter, a table, a report. This is the only way to give the person a file with the real values in it; a stand-in written into a file in the folder with another tool stays a stand-in there. Give its `name` and `content` here, with a stand-in where each value belongs (or the `path` of a file you already wrote). For a value in another form use a marker instead: {{DOC_1.field_name|number}} for plain digits, {{DOC_1.field_name|iso}} for a YYYY-MM-DD date, {{DOC_1.list_name[0].column|number}} for a cell of a list's first row, {{calc.total}} or {{calc.rows.DOC_1.days}} for a value of a program's result, named by its keys as the result shows them. In a .json, .jsonl or .csv file a number is written as plain digits and a date as YYYY-MM-DD unless you add |written, and in a .json or .jsonl file a stand-in or a marker that is a value of its own becomes the JSON its value needs (a number, true, false, null or a quoted string) whether or not you put quotes around it.",
    "A stand-in, or a marker with no form, is written as the document writes the value, with or without its currency or percent sign: you cannot tell which. Write the unit beside it (`SAR [AMOUNT_K2M4P]`, `{{DOC_1.rate}}%`); one the value already carries is then written once. `|number` never brings a unit.",
    "The finished copy goes to the person's sealed outputs, not to the workspace, and is not returned and cannot be read back: check `finished` and the counts in the result instead, and tell the person where it is.",
  ].join("\n"),
  parameters: Schema.Struct({
    name: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)).annotate({
        description: "With content: the file's name, such as answers.json.",
      }),
    ),
    content: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(400_000)).annotate({
        description: "The file's text, with stand-ins and markers.",
      }),
    ),
    path: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)).annotate({
        description: "Instead of name and content: absolute path of a text file with markers.",
      }),
    ),
  }),
  success: Schema.Struct({
    name: Schema.String,
    finished: Schema.Boolean,
    filled: Schema.Number,
    unknownMarkers: Schema.Array(Schema.String),
    note: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Fill sealed values")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

/** How many sealed files one `list_sealed` call names. */
export const LIST_SEALED_PAGE = 200;

const ListSealedTool = Tool.make("list_sealed", {
  description:
    "List this project's sealed files: each one's handle (DOC_1, ...), its name and where it was. A name may have stand-ins in it, or be only the handle and the file type when the person chose not to send it. Use it when the note about sealed files gives a folder or a count in place of every file, then ask about a file with `ask_documents`. It reads nothing from the files.",
  parameters: Schema.Struct({
    folder: Schema.optionalKey(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)).annotate({
        description: "Only files that were in this folder: its path as the note gives it.",
      }),
    ),
    after: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(32)).annotate({
        description: "The last handle of an earlier call, when it said there were more.",
      }),
    ),
  }),
  success: Schema.Struct({
    files: Schema.Array(
      Schema.Struct({
        handle: Schema.String,
        name: Schema.String,
        /** Where the file was. Null when it was sealed from a copy. */
        path: Schema.NullOr(Schema.String),
        /** False while the file has no text, so nothing can be asked about it yet. */
        askable: Schema.Boolean,
      }),
    ),
    more: Schema.Boolean,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List sealed files")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const SealedToolkit = Toolkit.make(
  askDocumentsTool(ASK_THE_MINIMUM),
  FillSealedTool,
  ListSealedTool,
);
/** Evaluation only (`DOEDESK_EVAL_SEALED_ASK_FREELY`): the same tools without "ask the minimum". */
export const SealedToolkitAskingFreely = Toolkit.make(
  askDocumentsTool(ASK_WITHIN_THE_LIMIT),
  FillSealedTool,
  ListSealedTool,
);
