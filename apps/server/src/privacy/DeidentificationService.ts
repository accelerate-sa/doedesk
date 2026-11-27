// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  DEIDENTIFY_ROUTE_PREFIX,
  type DeidentifyFailureReason,
  DeidentifyFailureReason as DeidentifyFailureReasonSchema,
  type DeidentifyFileRef,
  type DeidentifyFileStatus,
  type DeidentifyInspection,
  type DeidentifyInspectRequest,
  type DeidentifyLayer,
  type DeidentifyLayerChange,
  type DeidentifyOfficePart,
  type DeidentifyPolicy,
  type DeidentifyPolicyRequest,
  type DeidentifyPreview,
  type DeidentifyScanRequest,
  type DeidentifyTarget,
  type DeidentifyUpdateRequest,
  type DeidentifyWorkspaceFile,
  ProjectId,
} from "@t3tools/contracts";
import {
  addLayerItem,
  type DeidentificationAction,
  type DeidentificationLayer,
  type DeidentifyContext,
  deidentifyFile,
  DetectorUnavailableError,
  exportDeidentified,
  formatOf,
  hashOfFile,
  type ItemTarget,
  type LayerItem,
  LayerStore,
  manualItem,
  type NormalizedPoint,
  previewPageSizes,
  previewPicture,
  type PreviewPicture,
  type PreviewPlace,
  PreviewPlaceError,
  readOfficeDocument,
  readSpreadsheet,
  removeLayerItem,
  setDefaultMode,
  setItemAction,
  setReviewState,
  type SourceFile,
  UnsupportedFormatError,
} from "@t3tools/privacy-gateway";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as Project from "../project/ProjectService.ts";
import * as PrivacyGateway from "./PrivacyGateway.ts";

/**
 * De-identification of files for this server: a project's own files, and files attached to a
 * chat. The file on disk is never written to. What was found and what a person decided is kept
 * as a layer under the server's state, and a copy is made from the file and its layer on demand.
 */

const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** A long sheet is shown by its first rows: the whole of it is still searched and rewritten. */
const SHEET_PREVIEW_ROWS = 2000;
const WORKSPACE_FILE_LIMIT = 2000;
const WORKSPACE_DEPTH_LIMIT = 12;
/** Each file may ask the reading service about every page: a few at a time is enough. */
const SCAN_CONCURRENCY = 3;
const STAGED_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STAGED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,10}$/u;
/** Folders no document a person reviews lives in. A folder whose name starts with a dot is one. */
const SKIPPED_FOLDERS: ReadonlySet<string> = new Set(["node_modules", "dist", "build", "target"]);

const ATTACHMENT_NAMESPACE = "@attachment";
const STAGED_NAMESPACE = "@staged";

const DEFAULT_POLICY: DeidentifyPolicy = {
  defaultMode: "mask",
  requireReviewBeforeAi: false,
  alwaysReviewBeforeSend: false,
};

const FAILURE_MESSAGES: Readonly<Record<DeidentifyFailureReason, string>> = {
  unsupported: "This kind of file cannot be de-identified.",
  missing: "The file is not where it was.",
  tooLarge: "The file is too large to de-identify.",
  unreadable: "The file could not be opened.",
  unavailable: "Checking for personal data is not available right now.",
  invalid: "The request does not fit the file.",
};

export class DeidentificationError extends Schema.TaggedError<DeidentificationError>()(
  "DeidentificationError",
  {
    reason: DeidentifyFailureReasonSchema,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return FAILURE_MESSAGES[this.reason];
  }
}

const refuse = (reason: DeidentifyFailureReason, cause?: unknown): DeidentificationError =>
  new DeidentificationError({ reason, ...(cause === undefined ? {} : { cause }) });

const isRefusal = Schema.is(DeidentificationError);

const failureOf = (cause: unknown): DeidentificationError => {
  if (isRefusal(cause)) return cause;
  if (cause instanceof UnsupportedFormatError) return refuse("unsupported", cause);
  if (cause instanceof DetectorUnavailableError) return refuse("unavailable", cause);
  if (cause instanceof PreviewPlaceError) return refuse("invalid", cause);
  return refuse("unreadable", cause);
};

/** A de-identified copy of a file a person has reviewed, ready to stand in for the file. */
export interface ReviewedCopy {
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly fileName: string;
  /** How many items were masked, redacted and kept. A redacted value is in no vault. */
  readonly counts: Readonly<Record<DeidentificationAction, number>>;
}

/** What the service needs from the rest of the server. Tests give their own. */
export class DeidentificationSources extends Context.Service<
  DeidentificationSources,
  {
    readonly stateDir: string;
    readonly attachmentsDir: string;
    /** The gateway's detector, vault and reader. Undefined while the gateway is not running. */
    readonly context: Effect.Effect<DeidentifyContext | undefined>;
    readonly projectRoot: (projectId: string) => Effect.Effect<string | undefined>;
    /** Shows a file in the computer's file manager. False when that could not be done. */
    readonly reveal: (path: string) => Effect.Effect<boolean>;
  }
>()("t3/privacy/DeidentificationService/DeidentificationSources") {}

export class DeidentificationService extends Context.Service<
  DeidentificationService,
  {
    /** Finds what is in a file, or brings its layer up to the file as it is now. */
    readonly inspect: (
      input: DeidentifyInspectRequest,
    ) => Effect.Effect<DeidentifyInspection, DeidentificationError>;
    readonly updateLayer: (
      input: DeidentifyUpdateRequest,
    ) => Effect.Effect<DeidentifyLayer, DeidentificationError>;
    /** One page or picture, as it is or as the copy would show it. The file is only read. */
    readonly preview: (input: {
      readonly file: DeidentifyFileRef;
      readonly place: PreviewPlace;
      readonly view: "original" | "deidentified";
    }) => Effect.Effect<PreviewPicture, DeidentificationError>;
    /** The de-identified copy, for the person to save. The file it is made from is not touched. */
    readonly exportCopy: (
      file: DeidentifyFileRef,
    ) => Effect.Effect<ReviewedCopy, DeidentificationError>;
    readonly reveal: (file: DeidentifyFileRef) => Effect.Effect<boolean, DeidentificationError>;
    /** Keeps bytes sent ahead of a message so they can be reviewed. Answers with their id. */
    readonly stage: (name: string, bytes: Buffer) => Effect.Effect<string, DeidentificationError>;
    readonly workspace: (
      projectId: string,
    ) => Effect.Effect<WorkspaceListing, DeidentificationError>;
    readonly scanWorkspace: (
      input: DeidentifyScanRequest,
    ) => Effect.Effect<WorkspaceListing, DeidentificationError>;
    readonly policy: (input: DeidentifyPolicyRequest) => Effect.Effect<DeidentifyPolicy>;
    /** Where a file stands, without looking into it. */
    readonly status: (
      file: DeidentifyFileRef,
    ) => Effect.Effect<DeidentifyFileStatus, DeidentificationError>;
    /**
     * The copy to send in a file's place, for a turn or a tool that reads the file: masked values
     * as stand-ins the vault can turn back, redacted values gone. None unless a person reviewed
     * the file as it is now.
     */
    readonly reviewedCopy: (
      file: DeidentifyFileRef,
    ) => Effect.Effect<Option.Option<ReviewedCopy>, DeidentificationError>;
  }
>()("t3/privacy/DeidentificationService") {}

export interface WorkspaceListing {
  readonly policy: DeidentifyPolicy;
  readonly files: ReadonlyArray<DeidentifyWorkspaceFile>;
  readonly truncated: boolean;
}

interface Located {
  /** What the layer is kept under: a project, or the name for attachments. */
  readonly namespace: string;
  /** The file's name within the namespace. Its ending says what kind of file it is. */
  readonly layerPath: string;
  readonly absolutePath: string;
  /** The name a person knows the file by. */
  readonly name: string;
  readonly canReveal: boolean;
}

const toPosix = (path: string): string => path.replaceAll("\\", "/");

const insideRoot = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(`${root}${NodePath.sep}`);

/** The file a path names inside a folder, or nothing when the path leads out of it. */
const withinFolder = (root: string, relativePath: string): string | undefined => {
  if (relativePath === "" || relativePath.includes("\0") || NodePath.isAbsolute(relativePath)) {
    return undefined;
  }
  const folder = NodePath.resolve(root);
  const candidate = NodePath.resolve(folder, relativePath);
  if (!insideRoot(folder, candidate) || candidate === folder) return undefined;
  try {
    // A link may sit inside the folder and point out of it: the place it leads to decides.
    const realFolder = NodeFS.realpathSync(folder);
    const realCandidate = NodeFS.realpathSync(candidate);
    return insideRoot(realFolder, realCandidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
};

const clampShare = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

const cleanPolygon = (
  polygon: ReadonlyArray<NormalizedPoint>,
): ReadonlyArray<NormalizedPoint> | undefined =>
  polygon.length >= 3 && polygon.length <= 64
    ? polygon.map((point) => ({ x: clampShare(point.x), y: clampShare(point.y) }))
    : undefined;

const wholeNumber = (value: number): boolean => Number.isInteger(value) && value >= 0;

/** The target as it is kept, or nothing when it does not fit a file of this family. */
const cleanTarget = (
  target: DeidentifyTarget,
  family: DeidentificationLayer["family"],
): ItemTarget | undefined => {
  switch (target.type) {
    case "text":
      return family === "text" && wholeNumber(target.start) && target.end > target.start
        ? { type: "text", start: target.start, end: target.end }
        : undefined;
    case "region": {
      const polygon = cleanPolygon(target.polygon);
      const fits = family === "pdf" || (family === "image" && target.page === 0);
      return fits && wholeNumber(target.page) && polygon !== undefined
        ? { type: "region", page: target.page, polygon }
        : undefined;
    }
    case "cells": {
      const bounded =
        wholeNumber(target.startRow) &&
        wholeNumber(target.startColumn) &&
        (target.endRow === null || target.endRow >= target.startRow) &&
        (target.endColumn === null || target.endColumn >= target.startColumn);
      if ((family !== "csv" && family !== "xlsx") || !bounded) return undefined;
      return {
        type: "cells",
        sheet: target.sheet,
        scope: target.scope,
        startRow: target.startRow,
        endRow: target.endRow,
        startColumn: target.startColumn,
        endColumn: target.endColumn,
        ...(target.start === undefined || target.end === undefined
          ? {}
          : { start: target.start, end: target.end }),
      };
    }
    case "xml":
      return (family === "docx" || family === "pptx") &&
        wholeNumber(target.start) &&
        target.end > target.start
        ? { type: "xml", part: target.part, start: target.start, end: target.end }
        : undefined;
    case "media": {
      const polygon = cleanPolygon(target.polygon);
      return (family === "docx" || family === "pptx") && polygon !== undefined
        ? { type: "media", part: target.part, polygon }
        : undefined;
    }
  }
};

const revisionOf = (layer: DeidentificationLayer): string =>
  NodeCrypto.createHash("sha256")
    .update(`${layer.fileHash}\u0000${layer.updatedAt}\u0000${layer.items.length}`)
    .digest("hex")
    .slice(0, 16);

const wireLayer = (layer: DeidentificationLayer): DeidentifyLayer => ({
  family: layer.family,
  defaultMode: layer.defaultMode,
  reviewState: layer.reviewState,
  items: layer.items.map((item) => ({
    id: item.id,
    source: item.source,
    action: item.action,
    kind: item.kind,
    label: item.label,
    ...(item.preview === undefined ? {} : { preview: item.preview }),
    ...(item.replacement === undefined ? {} : { replacement: item.replacement }),
    ...(item.origin === undefined ? {} : { origin: item.origin }),
    target: item.target,
  })),
  unchecked: layer.warnings.length > 0,
  fileRevision: layer.fileHash.slice(0, 16),
  revision: revisionOf(layer),
});

const OFFICE_ROLES: ReadonlyArray<readonly [RegExp, DeidentifyOfficePart["role"]]> = [
  [/^word\/document\.xml$/u, "body"],
  [/^word\/header(\d*)\.xml$/u, "header"],
  [/^word\/footer(\d*)\.xml$/u, "footer"],
  [/^word\/footnotes\.xml$/u, "footnotes"],
  [/^word\/endnotes\.xml$/u, "endnotes"],
  [/^word\/comments\.xml$/u, "comments"],
  [/^ppt\/slides\/slide(\d+)\.xml$/u, "slide"],
  [/^ppt\/notesSlides\/notesSlide(\d+)\.xml$/u, "notes"],
];

const officeRoleOf = (
  name: string,
): { readonly role: DeidentifyOfficePart["role"]; readonly number: number } => {
  for (const [pattern, role] of OFFICE_ROLES) {
    const match = pattern.exec(name);
    if (match !== null) return { role, number: Number(match[1] ?? "") || 1 };
  }
  return { role: "body", number: 1 };
};

const pictureUrls = (
  file: DeidentifyFileRef,
  place: PreviewPlace,
): { readonly original: string; readonly deidentified: string } => {
  const query = new URLSearchParams({ file: JSON.stringify(file) });
  if (place.type === "page") query.set("page", String(place.page));
  else query.set("part", place.part);
  const base = `${DEIDENTIFY_ROUTE_PREFIX}/preview?${query.toString()}`;
  return { original: `${base}&view=original`, deidentified: `${base}&view=deidentified` };
};

/** Runs `tasks` a few at a time. One that fails leaves the others running. */
const settleEach = async <Item>(
  items: ReadonlyArray<Item>,
  limit: number,
  task: (item: Item) => Promise<unknown>,
): Promise<void> => {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next] as Item;
      next += 1;
      await task(item).catch(() => undefined);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
};

const make = Effect.gen(function* () {
  const sources = yield* DeidentificationSources;
  const privacyDirectory = NodePath.join(sources.stateDir, "privacy");
  const store = new LayerStore(NodePath.join(privacyDirectory, "layers"));
  const stagedDirectory = NodePath.join(privacyDirectory, "staged");
  const policiesPath = NodePath.join(privacyDirectory, "deidentify-policies.json");

  /** One change at a time for each layer: two requests never write over each other. */
  const queues = new Map<string, Promise<unknown>>();
  const oneAtATime = <Result>(located: Located, work: () => Promise<Result>): Promise<Result> => {
    const key = `${located.namespace}\u0000${located.layerPath}`;
    const run = (queues.get(key) ?? Promise.resolve()).then(work, work);
    const settled = run.catch(() => undefined);
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return run;
  };

  const readPolicies = (): Record<string, Partial<DeidentifyPolicy>> => {
    try {
      const stored: unknown = JSON.parse(NodeFS.readFileSync(policiesPath, "utf8"));
      return typeof stored === "object" && stored !== null && !Array.isArray(stored)
        ? (stored as Record<string, Partial<DeidentifyPolicy>>)
        : {};
    } catch {
      return {};
    }
  };

  const policyOf = (projectId: string): DeidentifyPolicy => {
    const stored = readPolicies()[projectId] ?? {};
    return {
      defaultMode: stored.defaultMode === "redact" ? "redact" : DEFAULT_POLICY.defaultMode,
      requireReviewBeforeAi: stored.requireReviewBeforeAi === true,
      alwaysReviewBeforeSend: stored.alwaysReviewBeforeSend === true,
    };
  };

  const writePolicy = (projectId: string, policy: DeidentifyPolicy): void => {
    NodeFS.mkdirSync(privacyDirectory, { recursive: true, mode: 0o700 });
    const draft = `${policiesPath}.${process.pid}.tmp`;
    NodeFS.writeFileSync(draft, JSON.stringify({ ...readPolicies(), [projectId]: policy }), {
      mode: 0o600,
    });
    NodeFS.renameSync(draft, policiesPath);
  };

  const locate = (
    file: DeidentifyFileRef,
    projectRoot: string | undefined,
  ): Located | DeidentificationError => {
    switch (file.kind) {
      case "workspace": {
        if (projectRoot === undefined) return refuse("missing");
        const absolutePath = withinFolder(projectRoot, file.path);
        if (absolutePath === undefined) return refuse("missing");
        return {
          namespace: file.projectId,
          layerPath: toPosix(NodePath.relative(NodePath.resolve(projectRoot), absolutePath)),
          absolutePath,
          name: NodePath.basename(absolutePath),
          canReveal: true,
        };
      }
      case "attachment": {
        const absolutePath = resolveAttachmentPathById({
          attachmentsDir: sources.attachmentsDir,
          attachmentId: file.attachmentId,
        });
        if (absolutePath === null) return refuse("missing");
        const name = file.name === undefined ? NodePath.basename(absolutePath) : file.name;
        // The name a person gave decides the kind of file: it is stored under its id.
        const extension = NodePath.extname(name) || NodePath.extname(absolutePath);
        return {
          namespace: ATTACHMENT_NAMESPACE,
          layerPath: `${file.attachmentId}${extension.toLowerCase()}`,
          absolutePath,
          name: NodePath.basename(name),
          canReveal: false,
        };
      }
      case "staged": {
        if (!STAGED_ID.test(file.stagedId)) return refuse("missing");
        return {
          namespace: STAGED_NAMESPACE,
          layerPath: file.stagedId,
          absolutePath: NodePath.join(stagedDirectory, file.stagedId),
          name: NodePath.basename(file.name ?? file.stagedId),
          canReveal: false,
        };
      }
    }
  };

  const readSource = (located: Located): SourceFile => {
    if (formatOf(located.layerPath) === undefined) throw refuse("unsupported");
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.statSync(located.absolutePath);
    } catch (cause) {
      throw refuse("missing", cause);
    }
    if (!stat.isFile()) throw refuse("missing");
    if (stat.size > MAX_FILE_BYTES) throw refuse("tooLarge");
    try {
      return {
        path: located.layerPath,
        bytes: NodeFS.readFileSync(located.absolutePath),
        mtimeMs: stat.mtimeMs,
      };
    } catch (cause) {
      throw refuse("missing", cause);
    }
  };

  /**
   * The layer of a file as the file is now. A file that is as it was is not searched again; one
   * that changed is, and a layer that had been reviewed comes back `stale`.
   */
  const currentLayer = async (
    located: Located,
    source: SourceFile,
    context: DeidentifyContext,
    options: { readonly rescan?: boolean | undefined } = {},
  ): Promise<DeidentificationLayer> => {
    const stored = store.read(located.namespace, located.layerPath);
    // Looking again is the same work as after a change: the hash on record is set aside.
    const existing =
      stored !== undefined && options.rescan === true ? { ...stored, fileHash: "" } : stored;
    const layer = await deidentifyFile(source, context, {
      projectId: located.namespace,
      existing,
      ...(existing === undefined ? { defaultMode: policyOf(located.namespace).defaultMode } : {}),
    });
    const settled =
      options.rescan === true && layer.reviewState === "stale"
        ? setReviewState(layer, "unreviewed")
        : layer;
    if (settled !== stored) store.write(settled);
    return settled;
  };

  const previewOf = async (
    file: DeidentifyFileRef,
    source: SourceFile,
    layer: DeidentificationLayer,
    context: DeidentifyContext,
  ): Promise<DeidentifyPreview> => {
    switch (layer.family) {
      case "text":
        return { type: "text", text: source.bytes.toString("utf8") };
      case "image":
      case "pdf": {
        const sizes = await previewPageSizes(source, context);
        return {
          type: "pages",
          pages: sizes.map((size, index) => ({
            index,
            width: size.width,
            height: size.height,
            urls: pictureUrls(file, { type: "page", page: index }),
          })),
        };
      }
      case "csv":
      case "xlsx": {
        const sheets = await readSpreadsheet(source);
        return {
          type: "sheets",
          sheets: sheets.map((sheet) => ({
            name: sheet.name,
            columnCount: sheet.rows.reduce((most, row) => Math.max(most, row.cells.length), 0),
            rows: sheet.rows.slice(0, SHEET_PREVIEW_ROWS),
            rowCount: sheet.rows.length,
          })),
        };
      }
      case "docx":
      case "pptx": {
        const document = await readOfficeDocument(source, context);
        return {
          type: "office",
          parts: document.parts.map((part) => ({
            name: part.name,
            ...officeRoleOf(part.name),
            text: part.text,
          })),
          media: document.media.map((media) => ({
            part: media.part,
            name: NodePath.basename(media.part),
            size:
              media.width === undefined || media.height === undefined
                ? null
                : { width: media.width, height: media.height },
            urls: pictureUrls(file, { type: "media", part: media.part }),
          })),
        };
      }
    }
  };

  /** The words a person's item marks, so the item can be found again after the file changes. */
  const wordsAt = async (
    source: SourceFile,
    target: ItemTarget,
    context: DeidentifyContext,
  ): Promise<string | undefined> => {
    if (target.type === "text") {
      return source.bytes.toString("utf8").slice(target.start, target.end);
    }
    if (target.type === "xml") {
      const document = await readOfficeDocument(source, context);
      return document.parts
        .find((part) => part.name === target.part)
        ?.text.slice(target.start, target.end);
    }
    return undefined;
  };

  const applyChange = async (
    layer: DeidentificationLayer,
    change: DeidentifyLayerChange,
    source: SourceFile,
    context: DeidentifyContext,
    fileChanged: boolean,
  ): Promise<DeidentificationLayer> => {
    switch (change.type) {
      case "setDefaultMode":
        return setDefaultMode(layer, change.mode);
      case "setItemAction":
        return setItemAction(layer, change.id, change.action);
      case "addItem": {
        const target = cleanTarget(change.target, layer.family);
        if (target === undefined) throw refuse("invalid");
        const preview = await wordsAt(source, target, context);
        if (preview !== undefined && preview.trim() === "") throw refuse("invalid");
        return addLayerItem(layer, manualItem({ target, action: change.action, preview }));
      }
      case "moveItem": {
        const item = layer.items.find((candidate) => candidate.id === change.id);
        const target = cleanTarget(change.target, layer.family);
        if (item === undefined || item.source !== "manual" || target === undefined) {
          throw refuse("invalid");
        }
        const moved: LayerItem = { ...item, target, replacement: undefined };
        return addLayerItem(layer, moved);
      }
      case "removeItem": {
        const item = layer.items.find((candidate) => candidate.id === change.id);
        // What was found stays on the list, where a person can keep it: only their own goes.
        return item?.source === "manual" ? removeLayerItem(layer, change.id) : layer;
      }
      case "setReviewState":
        // A file that changed under the review is not approved by a click made before it did.
        return fileChanged && change.state === "reviewed"
          ? layer
          : setReviewState(layer, change.state);
    }
  };

  const statusOf = (located: Located): DeidentifyFileStatus => {
    const layer = store.read(located.namespace, located.layerPath);
    if (layer === undefined) return "notScanned";
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.statSync(located.absolutePath);
    } catch {
      return "notScanned";
    }
    if (stat.mtimeMs === layer.fileMtimeMs) return layer.reviewState;
    let hash: string;
    try {
      hash = hashOfFile(NodeFS.readFileSync(located.absolutePath));
    } catch {
      return "notScanned";
    }
    if (hash === layer.fileHash) {
      // Saved again with nothing changed: remembered, so the file is not read on every listing.
      store.write({ ...layer, fileMtimeMs: stat.mtimeMs });
      return layer.reviewState;
    }
    return layer.reviewState === "unreviewed" ? "unreviewed" : "stale";
  };

  const listWorkspace = (
    projectId: string,
    root: string,
  ): { readonly files: ReadonlyArray<DeidentifyWorkspaceFile>; readonly truncated: boolean } => {
    const folder = NodePath.resolve(root);
    const files: Array<DeidentifyWorkspaceFile> = [];
    let truncated = false;
    const walk = (directory: string, depth: number): void => {
      if (truncated) return;
      let entries: ReadonlyArray<NodeFS.Dirent>;
      try {
        entries = NodeFS.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
        if (entry.name.startsWith(".")) continue;
        const absolutePath = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (depth < WORKSPACE_DEPTH_LIMIT && !SKIPPED_FOLDERS.has(entry.name)) {
            walk(absolutePath, depth + 1);
          }
          continue;
        }
        const handler = entry.isFile() ? formatOf(entry.name) : undefined;
        if (handler === undefined) continue;
        if (files.length >= WORKSPACE_FILE_LIMIT) {
          truncated = true;
          return;
        }
        const layerPath = toPosix(NodePath.relative(folder, absolutePath));
        const layer = store.read(projectId, layerPath);
        files.push({
          path: layerPath,
          family: handler.family,
          status: statusOf({
            namespace: projectId,
            layerPath,
            absolutePath,
            name: entry.name,
            canReveal: true,
          }),
          itemCount: layer?.items.filter((item) => item.action !== "keep").length ?? 0,
          defaultMode: layer?.defaultMode ?? null,
        });
      }
    };
    walk(folder, 0);
    return { files, truncated };
  };

  const sweepStaged = (now: number): void => {
    let names: ReadonlyArray<string>;
    try {
      names = NodeFS.readdirSync(stagedDirectory);
    } catch {
      return;
    }
    const oldest = now - STAGED_MAX_AGE_MS;
    for (const name of names) {
      const path = NodePath.join(stagedDirectory, name);
      try {
        if (NodeFS.statSync(path).mtimeMs < oldest) {
          NodeFS.rmSync(path, { force: true });
          store.remove(STAGED_NAMESPACE, name);
        }
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  };

  const attempt = <Result>(work: () => Promise<Result>) =>
    Effect.tryPromise({ try: work, catch: failureOf });

  const located = Effect.fnUntraced(function* (file: DeidentifyFileRef) {
    const root = file.kind === "workspace" ? yield* sources.projectRoot(file.projectId) : undefined;
    const found = locate(file, root);
    return isRefusal(found) ? yield* found : found;
  });

  const contextNow = Effect.fnUntraced(function* () {
    const context = yield* sources.context;
    return context === undefined ? yield* refuse("unavailable") : context;
  });

  const inspect: DeidentificationService["Service"]["inspect"] = Effect.fn(
    "DeidentificationService.inspect",
  )(function* (input) {
    const place = yield* located(input.file);
    const context = yield* contextNow();
    return yield* attempt(() =>
      oneAtATime(place, async () => {
        const source = readSource(place);
        const layer = await currentLayer(place, source, context, { rescan: input.rescan });
        return {
          ok: true as const,
          name: place.name,
          canReveal: place.canReveal,
          layer: wireLayer(layer),
          preview: await previewOf(input.file, source, layer, context),
        };
      }),
    );
  });

  const updateLayer: DeidentificationService["Service"]["updateLayer"] = Effect.fn(
    "DeidentificationService.updateLayer",
  )(function* (input) {
    const place = yield* located(input.file);
    const context = yield* contextNow();
    return yield* attempt(() =>
      oneAtATime(place, async () => {
        const source = readSource(place);
        const before = store.read(place.namespace, place.layerPath);
        let layer = await currentLayer(place, source, context);
        const fileChanged = before !== undefined && before.fileHash !== layer.fileHash;
        for (const change of input.changes) {
          layer = await applyChange(layer, change, source, context, fileChanged);
        }
        store.write(layer);
        return wireLayer(layer);
      }),
    );
  });

  const preview: DeidentificationService["Service"]["preview"] = Effect.fn(
    "DeidentificationService.preview",
  )(function* (input) {
    const place = yield* located(input.file);
    const context = yield* contextNow();
    return yield* attempt(async () => {
      const source = readSource(place);
      if (input.view === "original") return previewPicture(source, input.place, context);
      const layer = store.read(place.namespace, place.layerPath);
      // A picture of the copy is only true of the file the layer was made from.
      if (layer === undefined || layer.fileHash !== hashOfFile(source.bytes)) {
        throw refuse("invalid");
      }
      return previewPicture(source, input.place, context, layer.items);
    });
  });

  const copyOf = async (
    place: Located,
    layer: DeidentificationLayer,
    source: SourceFile,
    context: DeidentifyContext,
  ): Promise<ReviewedCopy> => {
    // Named after the file as a person knows it: an attachment is stored under its id.
    const exported = await exportDeidentified({ ...source, path: place.name }, layer, context);
    store.write(exported.layer);
    return {
      bytes: exported.bytes,
      mediaType: exported.mediaType,
      fileName: exported.fileName,
      counts: exported.counts,
    };
  };

  const exportCopy: DeidentificationService["Service"]["exportCopy"] = Effect.fn(
    "DeidentificationService.exportCopy",
  )(function* (file) {
    const place = yield* located(file);
    const context = yield* contextNow();
    return yield* attempt(() =>
      oneAtATime(place, async () => {
        const source = readSource(place);
        return copyOf(place, await currentLayer(place, source, context), source, context);
      }),
    );
  });

  const reviewedCopy: DeidentificationService["Service"]["reviewedCopy"] = Effect.fn(
    "DeidentificationService.reviewedCopy",
  )(function* (file) {
    const place = yield* located(file);
    const context = yield* contextNow();
    return yield* attempt(() =>
      oneAtATime(place, async () => {
        const layer = store.read(place.namespace, place.layerPath);
        if (layer === undefined || layer.reviewState !== "reviewed") return Option.none();
        const source = readSource(place);
        if (hashOfFile(source.bytes) !== layer.fileHash) return Option.none();
        return Option.some(await copyOf(place, layer, source, context));
      }),
    );
  });

  const status: DeidentificationService["Service"]["status"] = Effect.fn(
    "DeidentificationService.status",
  )(function* (file) {
    return statusOf(yield* located(file));
  });

  const reveal: DeidentificationService["Service"]["reveal"] = Effect.fn(
    "DeidentificationService.reveal",
  )(function* (file) {
    const place = yield* located(file);
    return place.canReveal ? yield* sources.reveal(place.absolutePath) : false;
  });

  const stage: DeidentificationService["Service"]["stage"] = Effect.fn(
    "DeidentificationService.stage",
  )(function* (name, bytes) {
    if (bytes.length === 0) return yield* refuse("unreadable");
    if (bytes.length > MAX_FILE_BYTES) return yield* refuse("tooLarge");
    const extension = NodePath.extname(name).toLowerCase();
    if (formatOf(name) === undefined) return yield* refuse("unsupported");
    const now = yield* Clock.currentTimeMillis;
    return yield* attempt(async () => {
      sweepStaged(now);
      const stagedId = `${NodeCrypto.randomUUID()}${extension}`;
      NodeFS.mkdirSync(stagedDirectory, { recursive: true, mode: 0o700 });
      NodeFS.writeFileSync(NodePath.join(stagedDirectory, stagedId), bytes, { mode: 0o600 });
      return stagedId;
    });
  });

  const rootOf = Effect.fnUntraced(function* (projectId: string) {
    const root = yield* sources.projectRoot(projectId);
    return root === undefined ? yield* refuse("missing") : root;
  });

  const workspace: DeidentificationService["Service"]["workspace"] = Effect.fn(
    "DeidentificationService.workspace",
  )(function* (projectId) {
    const root = yield* rootOf(projectId);
    return yield* attempt(async () => ({
      policy: policyOf(projectId),
      ...listWorkspace(projectId, root),
    }));
  });

  const scanWorkspace: DeidentificationService["Service"]["scanWorkspace"] = Effect.fn(
    "DeidentificationService.scanWorkspace",
  )(function* (input) {
    const root = yield* rootOf(input.projectId);
    const context = yield* contextNow();
    return yield* attempt(async () => {
      const paths =
        input.paths ??
        listWorkspace(input.projectId, root)
          .files.filter((file) => file.status === "notScanned" || file.status === "stale")
          .map((file) => file.path);
      await settleEach(paths, SCAN_CONCURRENCY, async (path) => {
        const place = locate({ kind: "workspace", projectId: input.projectId, path }, root);
        if (isRefusal(place)) return;
        await oneAtATime(place, async () => {
          await currentLayer(place, readSource(place), context);
        });
      });
      return { policy: policyOf(input.projectId), ...listWorkspace(input.projectId, root) };
    });
  });

  const policy: DeidentificationService["Service"]["policy"] = Effect.fn(
    "DeidentificationService.policy",
  )(function* (input) {
    return yield* Effect.sync(() => {
      const current = policyOf(input.projectId);
      if (input.policy === undefined) return current;
      const next: DeidentifyPolicy = {
        defaultMode: input.policy.defaultMode ?? current.defaultMode,
        requireReviewBeforeAi: input.policy.requireReviewBeforeAi ?? current.requireReviewBeforeAi,
        alwaysReviewBeforeSend:
          input.policy.alwaysReviewBeforeSend ?? current.alwaysReviewBeforeSend,
      };
      writePolicy(input.projectId, next);
      return next;
    });
  });

  return DeidentificationService.of({
    inspect,
    updateLayer,
    preview,
    exportCopy,
    reveal,
    stage,
    workspace,
    scanWorkspace,
    policy,
    status,
    reviewedCopy,
  });
});

/** The service over the sources it is given: what tests build on. */
export const layerWithSources = Layer.effect(DeidentificationService, make);

const layerSources = Layer.effect(
  DeidentificationSources,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const privacy = yield* PrivacyGateway.PrivacyGateway;
    const projects = yield* Project.ProjectService;
    const launcher = yield* ExternalLauncher.ExternalLauncher;
    return DeidentificationSources.of({
      stateDir: config.stateDir,
      attachmentsDir: config.attachmentsDir,
      context: privacy.deidentifyContext,
      projectRoot: Effect.fn("DeidentificationSources.projectRoot")(function* (projectId: string) {
        const found = yield* projects
          .getById(ProjectId.make(projectId))
          .pipe(Effect.orElseSucceed(() => Option.none()));
        return Option.isSome(found) ? found.value.workspaceRoot : undefined;
      }),
      reveal: Effect.fn("DeidentificationSources.reveal")(function* (path: string) {
        return yield* launcher
          .launchEditor({ cwd: path, editor: "file-manager", reveal: true })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
      }),
    });
  }),
);

export const layer = layerWithSources.pipe(Layer.provide(layerSources));
