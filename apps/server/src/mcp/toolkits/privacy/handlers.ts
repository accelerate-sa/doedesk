import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as PrivacyGateway from "../../../privacy/PrivacyGateway.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { PrivacyToolkit } from "./tools.ts";

/** The reading service takes files up to this size. */
const MAX_BYTES = 20 * 1024 * 1024;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
};

const refuse = (code: "invalid_request" | "capability_denied", message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** True when `child` is `parent` or lies under it. Both are real paths. */
const within = (path: Path.Path, parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * The file a thread may have read for it. The server reads with the user's own rights and asks
 * nobody, so it reads only where the agent could read by itself without asking: anywhere for a
 * full-access thread, and otherwise inside the thread's own workspace. Links are resolved first.
 */
export const readableFile = Effect.fn("PrivacyToolkit.readableFile")(function* (requested: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!path.isAbsolute(requested)) {
    return yield* refuse("invalid_request", "Pass an absolute path.");
  }
  const mediaType = MEDIA_TYPES[path.extname(requested).toLowerCase()];
  if (mediaType === undefined) {
    return yield* refuse("invalid_request", "Only image and PDF files can be read.");
  }
  const missing = () => refuse("invalid_request", "No readable file is at that path.");
  const real = yield* fs.realPath(requested).pipe(Effect.mapError(missing));
  const info = yield* fs.stat(real).pipe(Effect.mapError(missing));
  if (info.type !== "File") return yield* missing();
  if (Number(info.size) === 0 || Number(info.size) > MAX_BYTES) {
    return yield* refuse("invalid_request", "The file is empty or larger than 20 MB.");
  }

  const { caller, limits } = yield* loadCaller();
  if (limits.runtimeMode !== "full-access") {
    const roots: Array<string> = [];
    if (caller !== undefined) {
      if (caller.worktreePath !== null) roots.push(caller.worktreePath);
      else {
        const projects = yield* Project.ProjectService;
        const project = yield* projects
          .getById(caller.projectId)
          .pipe(Effect.mapError(unavailable));
        if (Option.isSome(project)) roots.push(project.value.workspaceRoot);
      }
    }
    let inside = false;
    for (const root of roots) {
      const realRoot = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
      if (within(path, realRoot, real)) inside = true;
    }
    if (!inside) {
      return yield* refuse(
        "capability_denied",
        "That file is outside this thread's workspace. Only a full-access thread may have a file elsewhere read for it.",
      );
    }
  }
  const bytes = yield* fs.readFile(real).pipe(Effect.mapError(missing));
  return { bytes: Buffer.from(bytes), mediaType };
});

const handlers = {
  ocr_masked: McpToolAccess.readsAsCaller(({ path: requested }) =>
    Effect.gen(function* () {
      const privacy = yield* PrivacyGateway.PrivacyGateway;
      if (!PrivacyGateway.readingToolOffered()) {
        return yield* refuse(
          "capability_denied",
          "The reading tool is turned off in Settings, under Privacy.",
        );
      }
      const file = yield* readableFile(requested);
      const read = yield* privacy.readMasked(file.bytes, file.mediaType);
      if (!read.ok) return yield* refuse("invalid_request", read.message);
      return {
        text: read.text,
        note:
          read.text.trim().length === 0
            ? "No text was found in the file."
            : "Stand-ins such as [PERSON_FBJD2] hide personal data. Refer to a value by its stand-in.",
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PrivacyToolkit.tools>;

export const layer = McpToolAccess.toLayer(PrivacyToolkit, handlers);
