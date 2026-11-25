import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { openName } from "@t3tools/privacy-gateway";
import * as Effect from "effect/Effect";

import * as PrivacyGateway from "../../../privacy/PrivacyGateway.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller } from "../../threadAccess.ts";
import { readableBytes } from "./handlers.ts";
import { LIST_SEALED_PAGE, SealedToolkit } from "./sealedTools.ts";

const refuse = (code: "invalid_request" | "capability_denied", message: string) =>
  new OrchestratorMcpFailure({ code, message });

const HANDLE = /^DOC_\d+$/;

/**
 * The sealed files that were in a folder, oldest handle first. The folder is given as the agent
 * knows it, which is a path from its own working folder: it is matched as the end of where a
 * file's folder was, or as a part of it, with either kind of slash.
 */
export const sealedFilesIn = <File extends { readonly handle: string; readonly origin?: string }>(
  files: ReadonlyArray<File>,
  folder: string | undefined,
): ReadonlyArray<File> => {
  // A folder's name reaches the agent masked, and a stand-in comes back as the name's words:
  // "Adel Al Amri" for "Adel_AlAmri". Both are compared by their words.
  const words = (value: string) =>
    value
      .replaceAll("\\", "/")
      .split("/")
      .filter((part) => part !== "")
      .map((part) => openName(part).text.replace(/\s+/gu, " ").trim().toLowerCase())
      .join("/");
  const wanted = folder === undefined ? undefined : `/${words(folder)}/`;
  return files
    .filter(
      (file) =>
        wanted === undefined ||
        (file.origin !== undefined && `/${words(file.origin)}`.includes(wanted)),
    )
    .toSorted((first, second) => Number(first.handle.slice(4)) - Number(second.handle.slice(4)));
};

/** A finished file's draft by name, or the names of those that have one. */
export const readSealedDraft = Effect.fn("SealedToolkit.readSealedDraft")(function* (
  privacy: Pick<PrivacyGateway.PrivacyGateway["Service"], "sealedDrafts" | "sealedDraft">,
  project: string,
  name: string | undefined,
) {
  const outputs = [...(yield* privacy.sealedDrafts(project))];
  if (name === undefined) return { outputs };
  // fill_sealed keeps only the last part of a name.
  const wanted = name.split(/[\\/]/).at(-1) ?? name;
  const template = yield* privacy.sealedDraft(project, wanted);
  if (template === undefined) {
    return yield* refuse(
      "invalid_request",
      outputs.length === 0
        ? "No finished file has a draft to revise yet."
        : `No finished file called ${wanted} has a draft. These do: ${outputs.join(", ")}.`,
    );
  }
  return { name: wanted, template, outputs };
});

/** The project whose sealed documents the calling thread may ask about: its own. */
const callingThread = Effect.fn("SealedToolkit.callingThread")(function* () {
  const { caller } = yield* loadCaller();
  if (caller === undefined) {
    return yield* refuse("capability_denied", "Only an agent in a thread can ask about documents.");
  }
  return { project: caller.projectId, thread: caller.id };
});

const handlers = {
  ask_documents: McpToolAccess.readsAsCaller((params) =>
    Effect.gen(function* () {
      const privacy = yield* PrivacyGateway.PrivacyGateway;
      if (!PrivacyGateway.sealedToolsOffered()) {
        return yield* refuse(
          "capability_denied",
          "No worker is connected in Settings, under Privacy.",
        );
      }
      const { project, thread } = yield* callingThread();
      const named = params.documents ?? [];
      const paths = named.filter((name) => !HANDLE.test(name));
      if (paths.length > 0 && paths.length !== named.length) {
        return yield* refuse(
          "invalid_request",
          "Name sealed handles or workspace paths in one call, not both.",
        );
      }
      const files: Array<{ name: string; text: string }> = [];
      for (const requested of paths) {
        const file = yield* readableBytes(requested);
        const read = yield* privacy.documentText(file.name, file.bytes);
        if (!read.ok) return yield* refuse("invalid_request", `${requested}: ${read.message}`);
        files.push({ name: requested, text: read.text });
      }
      const request = {
        project,
        caller: thread,
        handles: paths.length > 0 ? [] : named,
        ...(paths.length > 0 ? { files } : {}),
        instruction: params.instruction,
        fields: params.fields,
        ...(params.program === undefined ? {} : { program: params.program }),
      };
      const answer = yield* PrivacyGateway.workerAnswersInFreeText()
        ? privacy.askDocumentsFreeText(request)
        : privacy.askDocuments(request);
      if (!answer.ok) return yield* refuse("invalid_request", answer.message);
      const payload = answer.payload as {
        readonly documents: ReadonlyArray<{
          readonly handle: string;
          readonly status: "done" | "partial" | "failed";
          readonly fields: Record<string, unknown>;
          readonly problem?: string;
        }>;
        readonly program?: Record<string, unknown>;
      };
      return { mode: answer.mode, ...payload };
    }),
  ),
  fill_sealed: McpToolAccess.actsAsCaller(({ path: requested, name, content }) =>
    Effect.gen(function* () {
      const privacy = yield* PrivacyGateway.PrivacyGateway;
      const { project } = yield* callingThread();
      if ((requested === undefined) === (content === undefined)) {
        return yield* refuse("invalid_request", "Give name and content, or path, not both.");
      }
      let fileName: string;
      let template: string;
      if (content !== undefined) {
        // Only the last part of the name is kept: the copy goes to the sealed outputs, not to disk.
        fileName = (name ?? "").split(/[\\/]/).at(-1) ?? "";
        if (fileName === "") return yield* refuse("invalid_request", "Give the file a name.");
        template = content;
      } else {
        const file = yield* readableBytes(requested ?? "");
        fileName = file.name;
        template = file.bytes.toString("utf8");
      }
      if (template.includes("\u0000")) {
        return yield* refuse("invalid_request", "Only a text file can be filled.");
      }
      const result = yield* privacy.fillSealed(project, fileName, template);
      return {
        name: result.name,
        finished: result.unknown.length === 0 && !result.invalid,
        filled: result.filled,
        unknownMarkers: result.unknown,
        note:
          result.unknown.length > 0
            ? "The file is not finished: the markers and stand-ins in unknownMarkers name no sealed value and are still in it as you wrote them. Ask for those fields with ask_documents first, or fix the names (a program's value is {{calc.key}}, with its keys as the result shows them), then call this again."
            : result.invalid
              ? "The file is not finished: what you wrote is not valid JSON (a .jsonl file needs a JSON value on each line). Put each stand-in or marker where a whole JSON value belongs, with or without quotes around it and with no sign, digit or other text touching it, then call this again."
              : result.filled === 0
                ? "The file has no markers, so nothing was filled."
                : "The finished copy is in the person's sealed outputs. Tell them it is there; do not read it back.",
      };
    }),
  ),
  read_sealed_draft: McpToolAccess.readsAsCaller(({ name }) =>
    Effect.gen(function* () {
      const privacy = yield* PrivacyGateway.PrivacyGateway;
      const { project } = yield* callingThread();
      return yield* readSealedDraft(privacy, project, name);
    }),
  ),
  list_sealed: McpToolAccess.readsAsCaller(({ folder, after }) =>
    Effect.gen(function* () {
      const privacy = yield* PrivacyGateway.PrivacyGateway;
      const { project } = yield* callingThread();
      const listing = yield* privacy.sealedListing(project);
      // A file's own name and path are never returned: an agent is told what the gateway labels it.
      const told = new Map(
        (yield* privacy.sealedForAgents(project, null)).files.map((file) => [file.handle, file]),
      );
      const files = sealedFilesIn(listing.documents, folder);
      const from = after === undefined ? 0 : files.findIndex((file) => file.handle === after) + 1;
      return {
        files: files.slice(from, from + LIST_SEALED_PAGE).flatMap((file) => {
          const label = told.get(file.handle);
          return label === undefined
            ? []
            : [
                {
                  handle: file.handle,
                  name: label.name,
                  path: label.path ?? null,
                  askable: file.unread === undefined,
                },
              ];
        }),
        more: files.length > from + LIST_SEALED_PAGE,
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof SealedToolkit.tools>;

export const layer = McpToolAccess.toLayer(SealedToolkit, handlers);
