import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentHttpApi,
  type PrivacyClearAnswer,
  type PrivacySealedResult,
  ProjectId,
} from "@t3tools/contracts";
import type {
  PrivacyController,
  RedactionRecord,
  UnsealFileResult,
} from "@t3tools/privacy-gateway";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as Project from "../project/ProjectService.ts";
import * as UsageDataConsent from "../telemetry/UsageDataConsent.ts";
import * as PrivacyGateway from "./PrivacyGateway.ts";

/** A record as the app shows it: no reason text, which is for the model and the log. */
const publicRedaction = (record: RedactionRecord) => ({
  id: record.id,
  at: record.at,
  kind: record.kind,
  outcome: record.outcome,
  hasImage: record.hasImage,
  hasText: record.hasText,
  width: record.width,
  height: record.height,
  valueBoxes: record.valueBoxes,
  unreadableBoxes: record.unreadableBoxes,
});

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "privacy",
  Effect.fnUntraced(function* (handlers) {
    const privacy = yield* PrivacyGateway.PrivacyGateway;
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const usageData = yield* UsageDataConsent.UsageDataConsent;
    const projects = yield* Project.ProjectService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    return handlers
      .handle(
        "status",
        Effect.fn("environment.privacy.status")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* privacy.status;
        }),
      )
      .handle(
        "configure",
        Effect.fn("environment.privacy.configure")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const result = yield* privacy.configure(args.payload);
          return { ...result, status: yield* privacy.status };
        }),
      )
      .handle(
        "signIn",
        Effect.fn("environment.privacy.signIn")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const result = yield* privacy.signIn(args.payload);
          return { ...result, status: yield* privacy.status };
        }),
      )
      .handle(
        "profile",
        Effect.fn("environment.privacy.profile")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          // The answers go to the account and nowhere else: no usage event repeats them.
          yield* privacy.saveProfile(args.payload);
          return yield* privacy.status;
        }),
      )
      .handle(
        "preference",
        Effect.fn("environment.privacy.preference")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          yield* privacy.setPreference(args.payload);
          return yield* privacy.status;
        }),
      )
      .handle(
        "account",
        Effect.fn("environment.privacy.account")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const result = yield* privacy.account(args.payload);
          return { ...result, status: yield* privacy.status };
        }),
      )
      .handle(
        "usageData",
        Effect.fn("environment.privacy.usageData")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* usageData.status;
        }),
      )
      .handle(
        "setUsageData",
        Effect.fn("environment.privacy.setUsageData")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const request = args.payload;
          switch (request.action) {
            case "choose":
              return yield* usageData.choose(request);
            case "noticeShown":
              return yield* usageData.noticeShown(request);
            case "decide":
              return yield* usageData.decide(request);
          }
        }),
      )
      .handle(
        "activity",
        Effect.fn("environment.privacy.activity")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          const records = yield* privacy.activity;
          return {
            entries: records.map((record) => ({
              at: record.at,
              host: record.host,
              outcome: record.outcome,
              masked: record.masked ?? 0,
              withheld: record.withheld ?? 0,
              reason: record.reason ?? null,
              ...(record.notice === undefined ? {} : { notice: record.notice }),
              ...(record.outcome === "refused" && record.method !== undefined
                ? { request: `${record.method} ${(record.path.split("?")[0] ?? "").slice(0, 120)}` }
                : {}),
            })),
          };
        }),
      )
      .handle(
        "vault",
        Effect.fn("environment.privacy.vault")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // The vault holds the real values, so it needs the same right as changing settings.
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          return { entries: yield* privacy.vault, unmasked: yield* privacy.unmaskedValues };
        }),
      )
      .handle(
        "changeVault",
        Effect.fn("environment.privacy.changeVault")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // Stopping the masking of a value sends it to the provider: the right of a settings change.
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const ok = yield* privacy.setValueMasked(
            args.payload.token,
            args.payload.action === "maskAgain",
          );
          return {
            ok,
            vault: { entries: yield* privacy.vault, unmasked: yield* privacy.unmaskedValues },
            status: yield* privacy.status,
          };
        }),
      )
      .handle(
        "redactions",
        Effect.fn("environment.privacy.redactions")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return { entries: (yield* privacy.redactions).map(publicRedaction) };
        }),
      )
      .handle(
        "redactionFile",
        Effect.fn("environment.privacy.redactionFile")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // What was sent holds stand-ins if redaction worked; it is treated as the vault is.
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const file = yield* privacy.redactionFile(args.payload.id, args.payload.part);
          return {
            file:
              file === undefined
                ? null
                : {
                    fileName: file.fileName,
                    mediaType: file.mediaType,
                    data: file.bytes.toString("base64"),
                  },
          };
        }),
      )
      .handle(
        "clearRedactions",
        Effect.fn("environment.privacy.clearRedactions")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          yield* privacy.clearRedactions;
          return { entries: (yield* privacy.redactions).map(publicRedaction) };
        }),
      )
      .handle(
        "turnValues",
        Effect.fn("environment.privacy.turnValues")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // The real values, so the same right as the vault.
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          return { values: (yield* privacy.turnValues(args.payload.runId)) ?? null };
        }),
      )
      .handle(
        "knownValues",
        Effect.fn("environment.privacy.knownValues")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // The real values in every spelling, so the same right as the vault.
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const request = args.payload;
          return yield* privacy.knownValues(request.scope === "turns" ? request.runIds : undefined);
        }),
      )
      .handle(
        "worker",
        Effect.fn("environment.privacy.worker")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const result = yield* privacy.configureWorker(args.payload);
          return { ...result, status: yield* privacy.status };
        }),
      )
      .handle(
        "providers",
        Effect.fn("environment.privacy.providers")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // Addresses and key names of the organisation's own services: a settings right.
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          return yield* privacy.providers;
        }),
      )
      .handle(
        "configureProvider",
        Effect.fn("environment.privacy.configureProvider")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const result = yield* privacy.configureProvider(args.payload);
          return { ...result, providers: yield* privacy.providers, status: yield* privacy.status };
        }),
      )
      .handle(
        "testProvider",
        Effect.fn("environment.privacy.testProvider")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // A test sends the stored keys to the address in the request.
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          return yield* privacy.testProvider(args.payload);
        }),
      )
      .handle(
        "sealed",
        Effect.fn("environment.privacy.sealed")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          // Sealed documents and their outputs hold real values: the same right as the vault.
          yield* requireEnvironmentScope(AuthSettingsWriteScope);
          const request = args.payload;
          const project = request.projectId;
          let message: string | null = null;
          let handle: string | null = null;
          let output: string | null = null;
          let provenance: PrivacySealedResult["provenance"];
          let hasTemplate: boolean | undefined;
          let inGit: boolean | undefined;
          let seenByChats: boolean | undefined;
          // What history holds of the files about to be sealed. A few stand for a long list.
          const historyOf = (paths: ReadonlyArray<string>) =>
            Effect.forEach(
              paths.slice(0, 24),
              (filePath) =>
                checkpointStore
                  .fileHistory(filePath)
                  .pipe(Effect.orElseSucceed(() => ({ keptByGit: false, seenByTurns: false }))),
              { concurrency: 4 },
            );
          let unsealed: Extract<UnsealFileResult, { ok: true }> | undefined;
          let answers: ReadonlyArray<PrivacyClearAnswer> | null = null;
          let inspected: Awaited<ReturnType<PrivacyController["inspectSealTargets"]>> | undefined;
          let batch: PrivacySealedResult["batch"];
          let folderUnsealed: PrivacySealedResult["folderUnsealed"];
          let turn: PrivacySealedResult["turn"];
          let labels: PrivacySealedResult["labels"];
          let copy: PrivacySealedResult["copy"];
          const projectRoot = projects.getById(ProjectId.make(project)).pipe(
            Effect.map(
              Option.match({ onNone: () => null, onSome: (found) => found.workspaceRoot }),
            ),
            Effect.orElseSucceed(() => null),
          );
          /** For the person: paths as written from the project's folder. */
          const copyFrom = (
            root: string | null,
            found: {
              readonly original?: string;
              readonly readable: ReadonlyArray<string>;
              readonly complete: boolean;
            },
          ): PrivacySealedResult["copy"] => {
            const shown = (filePath: string) =>
              (root === null ? filePath : path.relative(root, filePath)).replaceAll("\\", "/");
            return {
              original: found.original === undefined ? null : shown(found.original),
              readable: found.readable.map(shown),
              complete: found.complete,
            };
          };
          // What the AI company would be told these files are called, for the confirmation.
          const labelsOf = (names: ReadonlyArray<string>) =>
            privacy
              .sealLabels(names)
              .pipe(
                Effect.map((told) =>
                  names.map((name, index) => ({ name, label: told[index] ?? null })),
                ),
              );
          const choice = (neutral: boolean | undefined) =>
            neutral === true ? { neutralLabel: true } : undefined;
          switch (request.action) {
            case "list":
              break;
            case "labels":
              labels = yield* labelsOf(request.names);
              break;
            case "inspectCopy": {
              labels = yield* labelsOf([request.name]);
              const root = yield* projectRoot;
              if (root === null) break;
              const found = yield* privacy.attachedFileInFolder(
                root,
                request.name,
                request.sha256,
                request.size,
              );
              copy = copyFrom(root, found);
              if (found.original === undefined) break;
              // The file itself will leave the folder: the same is said as for a file sealed there.
              const [held] = yield* historyOf([found.original]);
              inGit = held?.keptByGit;
              seenByChats =
                held?.seenByTurns === true ||
                (yield* privacy.openedToTurns(project, { files: [found.original] }));
              inspected = yield* privacy.inspectSealTargets({ files: [found.original] });
              break;
            }
            case "setLabel":
              if (!(yield* privacy.setSealedLabel(project, request.handle, request.neutral))) {
                message = "No sealed file has that handle.";
              }
              break;
            case "inspect": {
              const [held] = yield* historyOf([request.path]);
              inGit = held?.keptByGit;
              seenByChats =
                held?.seenByTurns === true ||
                (yield* privacy.openedToTurns(project, { files: [request.path] }));
              // Whether the file can be read: one that cannot is sealed without being asked about.
              inspected = yield* privacy.inspectSealTargets({ files: [request.path] });
              labels = yield* labelsOf(inspected.names);
              break;
            }
            case "inspectPaths":
              inspected = yield* privacy.inspectSealTargets({ files: request.paths });
              labels = yield* labelsOf(inspected.names);
              seenByChats =
                (yield* historyOf(request.paths)).some((file) => file.seenByTurns) ||
                (yield* privacy.openedToTurns(project, { files: request.paths }));
              break;
            case "inspectFolder":
              inspected = yield* privacy.inspectSealTargets({ folder: request.path });
              labels = yield* labelsOf(inspected.names);
              // A folder is asked about as one path: Git answers for everything below it.
              seenByChats =
                (yield* historyOf([request.path])).some((file) => file.seenByTurns) ||
                (yield* privacy.openedToTurns(project, { folder: request.path }));
              break;
            case "addPaths":
              batch = yield* privacy.sealFiles(
                project,
                request.paths,
                choice(request.neutralLabel),
              );
              break;
            case "sealFolder": {
              // The project's own folder is never sealed: the gateway checks against its root.
              const root = yield* projects.getById(ProjectId.make(project)).pipe(
                Effect.map(Option.map((found) => found.workspaceRoot)),
                Effect.orElseSucceed(() => Option.none<string>()),
              );
              if (Option.isNone(root)) {
                message = "This folder is not one of DoeDesk's folders on this computer.";
                break;
              }
              const sealed = yield* privacy.sealFolder(project, root.value, request.path, {
                neutralLabels: request.neutralLabel === true,
              });
              if (sealed.ok) {
                batch = {
                  sealed: sealed.sealed,
                  failed: sealed.left.map((file) => ({
                    name: path.basename(file.path),
                    message: file.message,
                  })),
                };
              } else message = sealed.message;
              break;
            }
            case "unsealFolder": {
              const result = yield* privacy.unsealFolder(project, request.path);
              if (result.ok) {
                folderUnsealed = {
                  restored: result.restored,
                  renamed: result.renamed,
                  failed: result.failed,
                };
              } else message = result.message;
              break;
            }
            case "turn":
              turn = (yield* privacy.sealedTurn(request.runId)) ?? null;
              break;
            case "add":
            case "addPath": {
              if (request.action === "addPath" && request.move === true) {
                const sealed = yield* privacy.sealFile(
                  project,
                  request.path,
                  choice(request.neutralLabel),
                );
                if (sealed.ok) handle = sealed.document.handle;
                else message = sealed.message;
                break;
              }
              const file =
                request.action === "add"
                  ? { name: request.name, bytes: Buffer.from(request.data, "base64") }
                  : yield* fs.readFile(request.path).pipe(
                      Effect.map((bytes) => ({
                        name: path.basename(request.path),
                        bytes: Buffer.from(bytes),
                      })),
                      Effect.orElseSucceed(() => null),
                    );
              if (file === null) {
                message = "No readable file is at that path.";
                break;
              }
              if (request.action === "addPath") {
                const sealed = yield* privacy.sealDocument(
                  project,
                  file.name,
                  file.bytes,
                  choice(request.neutralLabel),
                );
                if (sealed.ok) handle = sealed.document.handle;
                else message = sealed.message;
                break;
              }
              // A copy: the file it was made from may lie in the folder, where an agent opens it.
              const root = yield* projectRoot;
              const sealed = yield* privacy.sealAttached(
                project,
                root,
                file.name,
                file.bytes,
                choice(request.neutralLabel),
              );
              if (sealed.ok) {
                handle = sealed.document.handle;
                copy = copyFrom(root, sealed);
              } else message = sealed.message;
              break;
            }
            case "remove": {
              const result = yield* privacy.unsealFile(project, request.handle);
              if (result.ok) unsealed = result;
              else message = result.message;
              break;
            }
            case "read": {
              const read = yield* privacy.readSealed(project, request.handle);
              if (!read.ok) message = read.message;
              break;
            }
            case "resetLimits":
              yield* privacy.resetSealedLimits(project);
              break;
            case "answers":
              answers = yield* privacy.sealedClearAnswers(project);
              break;
            case "output": {
              const detail = yield* privacy.sealedOutputDetail(project, request.name);
              if (detail === undefined) message = "No finished file has that name.";
              else {
                output = detail.text;
                provenance = detail.provenance;
                hasTemplate = detail.hasTemplate;
              }
              break;
            }
          }
          const listing = yield* privacy.sealedListing(project);
          return {
            ok: message === null,
            message,
            listing: {
              ...listing,
              documents: listing.documents.map(
                ({
                  sha256: _sha256,
                  originLabel: _originLabel,
                  modifiedAt: _modifiedAt,
                  ...document
                }) => document,
              ),
              folders: listing.folders.map((folder) => ({
                path: folder.path,
                sealedAt: folder.sealedAt,
                left: folder.left.map((file) => ({ path: file.path, message: file.message })),
                ...(folder.neutralLabels === true ? { neutralLabels: true } : {}),
              })),
            },
            handle,
            output,
            ...(provenance === undefined ? {} : { provenance }),
            ...(hasTemplate === undefined ? {} : { hasTemplate }),
            ...(inGit === undefined ? {} : { inGit }),
            ...(seenByChats === undefined ? {} : { seenByChats }),
            ...(copy === undefined ? {} : { copy }),
            ...(unsealed === undefined
              ? {}
              : {
                  unsealed: {
                    name: unsealed.name,
                    path: unsealed.path,
                    renamed: unsealed.renamed,
                  },
                }),
            answers,
            ...(inspected === undefined
              ? {}
              : {
                  inspected: {
                    files: inspected.files,
                    unsupported: inspected.unsupported,
                    readFirst: inspected.readFirst,
                    inGit: inspected.inGit,
                  },
                }),
            ...(labels === undefined ? {} : { labels }),
            ...(batch === undefined ? {} : { batch }),
            ...(folderUnsealed === undefined ? {} : { folderUnsealed }),
            ...(turn === undefined ? {} : { turn }),
          };
        }),
      );
  }),
);
