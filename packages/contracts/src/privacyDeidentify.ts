import * as Schema from "effect/Schema";

/**
 * De-identification of files, as the server and the clients speak of it. A file is never
 * changed: what was found in it and what a person decided are kept beside it as a layer, and a
 * copy is written from the two. `mask` puts a stand-in that can be turned back; `redact` removes
 * the value for good; `keep` leaves it as it is.
 */

export const DEIDENTIFY_ROUTE_PREFIX = "/api/privacy/deidentify";

/** What a copy shows where a value was redacted. Written into files, so it is never translated. */
export const DEIDENTIFY_REDACTED_LABEL = "[REDACTED]";

export const DeidentifyAction = Schema.Literals(["mask", "redact", "keep"]);
export type DeidentifyAction = typeof DeidentifyAction.Type;

export const DeidentifyMode = Schema.Literals(["mask", "redact"]);
export type DeidentifyMode = typeof DeidentifyMode.Type;

export const DeidentifyReviewState = Schema.Literals([
  "unreviewed",
  "reviewed",
  "stale",
  "skipped",
]);
export type DeidentifyReviewState = typeof DeidentifyReviewState.Type;

/** A file's place in the review of a folder. `notScanned`: nothing has looked at it yet. */
export const DeidentifyFileStatus = Schema.Literals([
  "unreviewed",
  "reviewed",
  "stale",
  "skipped",
  "notScanned",
]);
export type DeidentifyFileStatus = typeof DeidentifyFileStatus.Type;

export const DeidentifyFamily = Schema.Literals([
  "text",
  "image",
  "pdf",
  "csv",
  "xlsx",
  "docx",
  "pptx",
]);
export type DeidentifyFamily = typeof DeidentifyFamily.Type;

/** A point of a page or picture, as shares of its width and height: 0 to 1 each way. */
const DeidentifyPoint = Schema.Struct({ x: Schema.Number, y: Schema.Number });
export type DeidentifyPoint = typeof DeidentifyPoint.Type;

const TextTarget = Schema.Struct({
  type: Schema.Literal("text"),
  start: Schema.Number,
  end: Schema.Number,
});

const RegionTarget = Schema.Struct({
  type: Schema.Literal("region"),
  page: Schema.Number,
  polygon: Schema.Array(DeidentifyPoint),
});

const CellsTarget = Schema.Struct({
  type: Schema.Literal("cells"),
  sheet: Schema.String,
  scope: Schema.Literals(["cell", "range", "row", "column"]),
  startRow: Schema.Number,
  endRow: Schema.NullOr(Schema.Number),
  startColumn: Schema.Number,
  endColumn: Schema.NullOr(Schema.Number),
  start: Schema.optional(Schema.Number),
  end: Schema.optional(Schema.Number),
});
export type DeidentifyCellsTarget = typeof CellsTarget.Type;

const XmlTarget = Schema.Struct({
  type: Schema.Literal("xml"),
  part: Schema.String,
  start: Schema.Number,
  end: Schema.Number,
});

const MediaTarget = Schema.Struct({
  type: Schema.Literal("media"),
  part: Schema.String,
  polygon: Schema.Array(DeidentifyPoint),
});

export const DeidentifyTarget = Schema.Union([
  TextTarget,
  RegionTarget,
  CellsTarget,
  XmlTarget,
  MediaTarget,
]);
export type DeidentifyTarget = typeof DeidentifyTarget.Type;

export const DeidentifyItem = Schema.Struct({
  id: Schema.String,
  /** `auto`: found. `manual`: added by a person. */
  source: Schema.Literals(["auto", "manual"]),
  action: DeidentifyAction,
  kind: Schema.String,
  label: Schema.String,
  /** The value itself. It is shown to the person at this computer and goes nowhere else. */
  preview: Schema.optional(Schema.String),
  /** What stood in its place the last time a copy was made. */
  replacement: Schema.optional(Schema.String),
  origin: Schema.optional(Schema.Literals(["value", "unreadable", "ink", "code"])),
  target: DeidentifyTarget,
});
export type DeidentifyItem = typeof DeidentifyItem.Type;

export const DeidentifyLayer = Schema.Struct({
  family: DeidentifyFamily,
  defaultMode: DeidentifyMode,
  reviewState: DeidentifyReviewState,
  items: Schema.Array(DeidentifyItem),
  /** True when some of the file could not be checked and is hidden until a person looks. */
  unchecked: Schema.Boolean,
  /** Changes when the file's content does: a picture of the file itself is cached by this. */
  fileRevision: Schema.String,
  /** Changes with every change to the layer: a picture drawn from it is cached by this. */
  revision: Schema.String,
});
export type DeidentifyLayer = typeof DeidentifyLayer.Type;

/**
 * Which file. `workspace`: a file of a project, by its path from the project's folder.
 * `attachment`: a file a chat already uploaded. `staged`: bytes sent ahead for review.
 */
export const DeidentifyFileRef = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("workspace"),
    projectId: Schema.String,
    path: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("attachment"),
    attachmentId: Schema.String,
    name: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("staged"),
    stagedId: Schema.String,
    name: Schema.optional(Schema.String),
  }),
]);
export type DeidentifyFileRef = typeof DeidentifyFileRef.Type;

const PictureUrls = Schema.Struct({ original: Schema.String, deidentified: Schema.String });

const PagePreview = Schema.Struct({
  index: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  urls: PictureUrls,
});
export type DeidentifyPagePreview = typeof PagePreview.Type;

const SheetPreview = Schema.Struct({
  name: Schema.String,
  columnCount: Schema.Number,
  rows: Schema.Array(Schema.Struct({ index: Schema.Number, cells: Schema.Array(Schema.String) })),
  /** Rows the sheet has in all; more than `rows` holds when the sheet is long. */
  rowCount: Schema.Number,
});
export type DeidentifySheetPreview = typeof SheetPreview.Type;

const OfficePartPreview = Schema.Struct({
  /** The part's name in the file: what an item's target names. */
  name: Schema.String,
  /** What kind of part it is, and its number where there are several. */
  role: Schema.Literals([
    "body",
    "header",
    "footer",
    "footnotes",
    "endnotes",
    "comments",
    "slide",
    "notes",
  ]),
  number: Schema.Number,
  text: Schema.String,
});
export type DeidentifyOfficePart = typeof OfficePartPreview.Type;

const OfficeMediaPreview = Schema.Struct({
  part: Schema.String,
  name: Schema.String,
  /** Null for a drawing that cannot be opened as a picture. */
  size: Schema.NullOr(Schema.Struct({ width: Schema.Number, height: Schema.Number })),
  urls: PictureUrls,
});
export type DeidentifyOfficeMedia = typeof OfficeMediaPreview.Type;

export const DeidentifyPreview = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("pages"), pages: Schema.Array(PagePreview) }),
  Schema.Struct({ type: Schema.Literal("sheets"), sheets: Schema.Array(SheetPreview) }),
  Schema.Struct({
    type: Schema.Literal("office"),
    parts: Schema.Array(OfficePartPreview),
    media: Schema.Array(OfficeMediaPreview),
  }),
]);
export type DeidentifyPreview = typeof DeidentifyPreview.Type;

/** Why a file could not be opened for de-identification. */
export const DeidentifyFailureReason = Schema.Literals([
  "unsupported",
  "missing",
  "tooLarge",
  "unreadable",
  "unavailable",
  "invalid",
]);
export type DeidentifyFailureReason = typeof DeidentifyFailureReason.Type;

export const DeidentifyFailure = Schema.Struct({
  ok: Schema.Literal(false),
  reason: DeidentifyFailureReason,
});
export type DeidentifyFailure = typeof DeidentifyFailure.Type;

export const DeidentifyInspectRequest = Schema.Struct({
  file: DeidentifyFileRef,
  /** Looks again even when the file is as it was, and asks for a new review. */
  rescan: Schema.optional(Schema.Boolean),
});
export type DeidentifyInspectRequest = typeof DeidentifyInspectRequest.Type;

export const DeidentifyInspection = Schema.Struct({
  ok: Schema.Literal(true),
  name: Schema.String,
  /** False where the file's place cannot be shown: a file that is not in a folder of the person's. */
  canReveal: Schema.Boolean,
  layer: DeidentifyLayer,
  preview: DeidentifyPreview,
});
export type DeidentifyInspection = typeof DeidentifyInspection.Type;

export const DeidentifyInspectResult = Schema.Union([DeidentifyInspection, DeidentifyFailure]);
export type DeidentifyInspectResult = typeof DeidentifyInspectResult.Type;

export const DeidentifyLayerChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal("setDefaultMode"), mode: DeidentifyMode }),
  Schema.Struct({
    type: Schema.Literal("setItemAction"),
    id: Schema.String,
    action: DeidentifyAction,
  }),
  Schema.Struct({
    type: Schema.Literal("addItem"),
    target: DeidentifyTarget,
    action: DeidentifyAction,
  }),
  /** The same item at a new place: a box that was moved or resized. */
  Schema.Struct({
    type: Schema.Literal("moveItem"),
    id: Schema.String,
    target: DeidentifyTarget,
  }),
  Schema.Struct({ type: Schema.Literal("removeItem"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("setReviewState"),
    state: Schema.Literals(["reviewed", "unreviewed", "skipped"]),
  }),
]);
export type DeidentifyLayerChange = typeof DeidentifyLayerChange.Type;

export const DeidentifyUpdateRequest = Schema.Struct({
  file: DeidentifyFileRef,
  changes: Schema.Array(DeidentifyLayerChange),
});
export type DeidentifyUpdateRequest = typeof DeidentifyUpdateRequest.Type;

export const DeidentifyUpdateResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), layer: DeidentifyLayer }),
  DeidentifyFailure,
]);
export type DeidentifyUpdateResult = typeof DeidentifyUpdateResult.Type;

export const DeidentifyFileRequest = Schema.Struct({ file: DeidentifyFileRef });
export type DeidentifyFileRequest = typeof DeidentifyFileRequest.Type;

export const DeidentifyPolicy = Schema.Struct({
  defaultMode: DeidentifyMode,
  requireReviewBeforeAi: Schema.Boolean,
  alwaysReviewBeforeSend: Schema.Boolean,
});
export type DeidentifyPolicy = typeof DeidentifyPolicy.Type;

export const DeidentifyPolicyRequest = Schema.Struct({
  projectId: Schema.String,
  /** Left out to read the policy as it stands. */
  policy: Schema.optional(
    Schema.Struct({
      defaultMode: Schema.optional(DeidentifyMode),
      requireReviewBeforeAi: Schema.optional(Schema.Boolean),
      alwaysReviewBeforeSend: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type DeidentifyPolicyRequest = typeof DeidentifyPolicyRequest.Type;

export const DeidentifyWorkspaceFile = Schema.Struct({
  /** From the project's folder, with `/` between its parts. */
  path: Schema.String,
  family: DeidentifyFamily,
  status: DeidentifyFileStatus,
  itemCount: Schema.Number,
  defaultMode: Schema.NullOr(DeidentifyMode),
});
export type DeidentifyWorkspaceFile = typeof DeidentifyWorkspaceFile.Type;

export const DeidentifyWorkspace = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    policy: DeidentifyPolicy,
    files: Schema.Array(DeidentifyWorkspaceFile),
    /** True when the folder holds more files than are listed. */
    truncated: Schema.Boolean,
  }),
  DeidentifyFailure,
]);
export type DeidentifyWorkspace = typeof DeidentifyWorkspace.Type;

export const DeidentifyScanRequest = Schema.Struct({
  projectId: Schema.String,
  /** Left out to look at every file that has not been reviewed. */
  paths: Schema.optional(Schema.Array(Schema.String)),
});
export type DeidentifyScanRequest = typeof DeidentifyScanRequest.Type;

export const DeidentifyStageResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), stagedId: Schema.String }),
  DeidentifyFailure,
]);
export type DeidentifyStageResult = typeof DeidentifyStageResult.Type;
