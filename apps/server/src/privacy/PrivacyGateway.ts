import {
  type AskAnswer,
  type PrivacyAccountInput,
  type PrivacyAccountResult,
  type PrivacyAskInput,
  type PrivacyConfigureInput,
  type PrivacyConfigureOutcome,
  type PrivacyController,
  type PrivacyEvaluationOptions,
  type PrivacyPreferenceInput,
  type PrivacyProfileInput,
  type PrivacyReadMaskedResult,
  type PrivacySealedListing,
  type PrivacySignInInput,
  type PrivacySignInResult,
  type PrivacyTurnValue,
  type PrivacyWorkerInput,
  type SealedFolderGate,
  type SealedTurnActivity,
  type SealLabelChoice,
  type SealFileResult,
  type SealFolderResult,
  standInsByKind,
  startPrivacyController,
  type TurnTally,
  type UnsealFileResult,
  type UnsealFolderResult,
} from "@t3tools/privacy-gateway";
import { MAX_TURN_SEALED_HANDLES, type PrivacyTurnRecord } from "@t3tools/contracts";
import { setGatewayRefusalSource } from "@t3tools/provider-core/server/failure";
import {
  setProviderEnvironmentOverlay,
  setSealedFolderLookup,
  setSealedValuesInUse,
} from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import packageJson from "../../package.json" with { type: "json" };
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "../provider/ProviderInstanceRegistryMutator.ts";
import {
  agentWorkspaceRoots,
  sealChanged,
  setSealedFilesSource,
  setSealedFolderChecks,
  setSealedFolderPaths,
} from "./agentWorkspaces.ts";

/**
 * The privacy gateway for this server: masks personal data in the requests an agent of a masked
 * provider sends to a model, and restores it in what comes back.
 */
export class PrivacyGateway extends Context.Service<
  PrivacyGateway,
  {
    readonly status: Effect.Effect<ReturnType<PrivacyController["status"]>>;
    readonly configure: (input: PrivacyConfigureInput) => Effect.Effect<PrivacyConfigureOutcome>;
    readonly signIn: (input: PrivacySignInInput) => Effect.Effect<PrivacySignInResult>;
    /** Accepting the Terms, a copy of the account's data, and deleting the account. */
    readonly account: (input: PrivacyAccountInput) => Effect.Effect<PrivacyAccountResult>;
    readonly saveProfile: (input: PrivacyProfileInput) => Effect.Effect<void>;
    readonly setPreference: (input: PrivacyPreferenceInput) => Effect.Effect<void>;
    /**
     * Emits when some provider's processes need a restart to be routed as the settings now say:
     * the function tells, by driver kind, which providers those are.
     */
    readonly routingChanges: Stream.Stream<(provider: string) => boolean>;
    /** A short-lived signed token proving the signed-in account to another DoeDesk service. */
    readonly accountToken: (audience: string) => Effect.Effect<string | null>;
    readonly activity: Effect.Effect<ReturnType<PrivacyController["activity"]>>;
    /**
     * What the gateway did for a turn that just ended, to keep on the turn. `sessions` are the
     * names the provider's program gives the chat. Undefined when the gateway has nothing to say.
     */
    readonly recordTurn: (input: TurnInput) => Effect.Effect<PrivacyTurnRecord | undefined>;
    /** A turn's stand-ins beside their real values, for the person at this computer. */
    readonly turnValues: (
      runId: string,
    ) => Effect.Effect<ReadonlyArray<PrivacyTurnValue> | undefined>;
    /** Stand-ins and their spellings, for marking replaced values where the person reads them. */
    readonly knownValues: (
      runIds?: ReadonlyArray<string>,
    ) => Effect.Effect<ReturnType<PrivacyController["knownValues"]>>;
    /** The text of an image or PDF, masked: what the agent's reading tool returns. */
    readonly readMasked: (
      bytes: Buffer,
      mediaType: string,
    ) => Effect.Effect<PrivacyReadMaskedResult>;
    /** What was sent in place of recent images and documents, newest first. */
    readonly redactions: Effect.Effect<ReturnType<PrivacyController["redactions"]>>;
    readonly redactionFile: (
      id: string,
      part: "image" | "text",
    ) => Effect.Effect<ReturnType<PrivacyController["redactionFile"]>>;
    readonly clearRedactions: Effect.Effect<void>;
    readonly vault: Effect.Effect<ReturnType<PrivacyController["vault"]>>;
    /** The values the person stopped masking, each with the stand-in it had. */
    readonly unmaskedValues: Effect.Effect<ReturnType<PrivacyController["unmaskedValues"]>>;
    /** Stops masking one value, or masks it again. False when there is no such entry. */
    readonly setValueMasked: (token: string, masked: boolean) => Effect.Effect<boolean>;
    /** Connects, changes or removes the worker that reads sealed documents. */
    readonly configureWorker: (
      input: PrivacyWorkerInput,
    ) => Effect.Effect<{ readonly ok: boolean; readonly message: string | null }>;
    /** A file's text, unmasked, for the worker. */
    readonly documentText: (
      name: string,
      bytes: Buffer,
    ) => Effect.Effect<Awaited<ReturnType<PrivacyController["documentText"]>>>;
    /**
     * Seals a file for a project: keeps its text where agents cannot read it. `label` is the
     * person's choice of what a provider is told the file is called.
     */
    readonly sealDocument: (
      project: string,
      name: string,
      bytes: Buffer,
      label?: SealLabelChoice,
    ) => Effect.Effect<Awaited<ReturnType<PrivacyController["sealDocument"]>>>;
    /** What a project's folder holds of a file that came as a copy. See the controller. */
    readonly attachedFileInFolder: (
      root: string,
      name: string,
      sha256: string,
      size: number,
    ) => Effect.Effect<Awaited<ReturnType<PrivacyController["attachedFileInFolder"]>>>;
    /** Seals a file that came as a copy: the file itself where the folder holds it, else the copy. */
    readonly sealAttached: (
      project: string,
      root: string | null,
      name: string,
      bytes: Buffer,
      label?: SealLabelChoice,
    ) => Effect.Effect<Awaited<ReturnType<PrivacyController["sealAttached"]>>>;
    /** Seals the file at a path on this machine and moves it out of its folder. */
    readonly sealFile: (
      project: string,
      filePath: string,
      label?: SealLabelChoice,
    ) => Effect.Effect<SealFileResult>;
    /** Seals several files where they lie. One that fails leaves the others sealed. */
    readonly sealFiles: (
      project: string,
      filePaths: ReadonlyArray<string>,
      label?: SealLabelChoice,
    ) => Effect.Effect<Awaited<ReturnType<PrivacyController["sealFiles"]>>>;
    /** What a provider would be told each of these file names is. Null: it cannot be checked now. */
    readonly sealLabels: (
      names: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string | null>>;
    /** The person's choice for a sealed file: its handle and type alone, or its masked name. */
    readonly setSealedLabel: (
      project: string,
      handle: string,
      neutral: boolean,
    ) => Effect.Effect<boolean>;
    /** A project's sealed files and folders as an agent is told them: never a file's own name. */
    readonly sealedForAgents: (
      project: string,
      cwd: string | null,
    ) => Effect.Effect<ReturnType<PrivacyController["sealedForAgents"]>>;
    /** Puts a sealed file back where it was. Never offered to an agent: it would undo sealing. */
    readonly unsealFile: (project: string, handle: string) => Effect.Effect<UnsealFileResult>;
    /** Before sealing a folder or several files: how many, and what the person is told. */
    readonly inspectSealTargets: (
      target: Parameters<PrivacyController["inspectSealTargets"]>[0],
    ) => Effect.Effect<Awaited<ReturnType<PrivacyController["inspectSealTargets"]>>>;
    /** Whether a turn started in the project while these files, once sealed, were back in it. */
    readonly openedToTurns: (
      project: string,
      target: Parameters<PrivacyController["openedToTurns"]>[1],
    ) => Effect.Effect<boolean>;
    /** Seals a subfolder of `root`, the project's folder: its files now and as they arrive. */
    readonly sealFolder: (
      project: string,
      root: string,
      folder: string,
      options?: { readonly neutralLabels?: boolean },
    ) => Effect.Effect<SealFolderResult>;
    /** Puts a sealed folder's files back. Never offered to an agent. */
    readonly unsealFolder: (project: string, folder: string) => Effect.Effect<UnsealFolderResult>;
    /** Seals what has appeared in a project's sealed folders, as before an agent's turn. */
    readonly sealedFoldersBeforeTurn: (project: string) => Effect.Effect<SealedFolderGate>;
    /** Reads a sealed file that has no text yet, from the copy kept when it was sealed. */
    readonly readSealed: (
      project: string,
      handle: string,
    ) => Effect.Effect<Awaited<ReturnType<PrivacyController["readSealed"]>>>;
    /** What one turn asked of sealed files, for the person at this computer. */
    readonly sealedTurn: (runId: string) => Effect.Effect<SealedTurnActivity | undefined>;
    readonly sealedListing: (project: string) => Effect.Effect<PrivacySealedListing>;
    readonly resetSealedLimits: (project: string) => Effect.Effect<void>;
    /** Every answer agents were given in clear about a project's sealed documents. */
    readonly sealedClearAnswers: (
      project: string,
    ) => Effect.Effect<ReturnType<PrivacyController["sealedClearAnswers"]>>;
    /** A finished file that holds sealed values, for the person. Never for an agent. */
    readonly sealedOutput: (project: string, name: string) => Effect.Effect<string | undefined>;
    /** What the `ask_documents` tool answers. */
    readonly askDocuments: (input: PrivacyAskInput) => Effect.Effect<AskAnswer>;
    /** Evaluation only: the worker's own words about each document, unchecked. */
    readonly askDocumentsFreeText: (input: PrivacyAskInput) => Effect.Effect<AskAnswer>;
    /** What the `fill_sealed` tool does. */
    readonly fillSealed: (
      project: string,
      name: string,
      template: string,
    ) => Effect.Effect<ReturnType<PrivacyController["fillSealed"]>>;
    /**
     * A count that grows with each change to what is sealed: the count as it stands, then each
     * new count. Clients read their sealed lists again on each one.
     */
    readonly sealedChanges: Stream.Stream<number>;
  }
>()("t3/privacy/PrivacyGateway") {}

/**
 * Counts changes to sealed state for the clients that show it. `changed` is called from the
 * gateway's own code, outside any fiber. Sliding: each count means "read again", so a subscriber
 * that falls behind is owed the newest and none before it.
 */
export const makeSealedChanges = Effect.gen(function* () {
  const counts = yield* PubSub.sliding<number>(1);
  // Started from the clock, so a count after a restart is never one an earlier server sent.
  let revision = yield* Clock.currentTimeMillis;
  return {
    changed: (): void => {
      revision += 1;
      PubSub.publishUnsafe(counts, revision);
    },
    // Subscribed before the count is read, so a change in between is not missed.
    stream: Stream.unwrap(
      Effect.map(PubSub.subscribe(counts), (subscription) =>
        Stream.concat(
          Stream.sync(() => revision),
          Stream.fromSubscription(subscription),
        ),
      ),
    ),
  };
});

/** The turn record as it is kept: counts by kind, and no stand-in. */
export const turnRecordOf = (tally: TurnTally): PrivacyTurnRecord => ({
  state: "masked",
  replaced: standInsByKind(tally.replaced),
  rewritten: tally.rewritten,
  refused: tally.refused,
  redacted: tally.redacted,
  read: tally.read,
  withheld: tally.withheld,
  sealed: tally.sealed,
  attribution: tally.attribution,
});

interface TurnInput {
  readonly runId: string;
  /** The thread the turn ran in: sealed files are asked about in its name. */
  readonly threadId: string;
  readonly driver: string;
  readonly sessions: ReadonlyArray<string>;
  /** The run completed, so it sent at least one request to a model. */
  readonly completed: boolean;
}

/** What to keep on a turn that just ended, or undefined when the gateway has nothing to say. */
export const recordTurnWith = (
  controller: Pick<PrivacyController, "takeTurn" | "takeSealedTurn" | "environmentFor" | "status">,
  input: TurnInput,
): PrivacyTurnRecord | undefined => {
  const requests = requestsRecordWith(controller, input);
  const activity = controller.takeSealedTurn(input.runId, input.threadId);
  if (activity === undefined) return requests;
  return {
    // A turn that asked about sealed files has a record even when it stopped early.
    ...(requests ?? { state: "unseen" }),
    sealedFiles: {
      asked: activity.asked.slice(0, MAX_TURN_SEALED_HANDLES).map((document) => document.handle),
      askedCount: activity.asked.length,
      clear: activity.answers.length,
    },
  };
};

const requestsRecordWith = (
  controller: Pick<PrivacyController, "takeTurn" | "environmentFor" | "status">,
  input: TurnInput,
): PrivacyTurnRecord | undefined => {
  // What the gateway saw decides first: a turn that began masked stays a masked turn.
  const tally = controller.takeTurn(input.runId, input.sessions);
  if (tally !== undefined) return turnRecordOf(tally);
  if (controller.environmentFor(input.driver) === undefined) {
    return { state: "unmasked", reason: controller.status().mode === "off" ? "off" : "direct" };
  }
  // A turn that stopped early may have sent nothing; one that completed sent something unseen.
  return input.completed ? { state: "unseen" } : undefined;
};

let offered: () => boolean = () => false;
/**
 * Whether the reading tool is offered now, for a tool's listing, which runs outside any fiber
 * that could ask the service. False until the gateway has started.
 */
export const readingToolOffered = (): boolean => offered();

let workerOffered: () => boolean = () => false;
let workerFreeText: () => boolean = () => false;
/** Whether the tools that ask about sealed documents are offered now. See `readingToolOffered`. */
export const sealedToolsOffered = (): boolean => workerOffered();
/** Evaluation only: the worker answers in its own prose, unchecked. */
export const workerAnswersInFreeText = (): boolean => workerFreeText();

/**
 * Evaluation only. Read once from `DOEDESK_EVAL_*` at startup, so nothing in the app can turn
 * them on. The files they name hold confidential text; the two `WORKER_*` switches weaken the
 * worker on purpose. `PrivacyEvaluationOptions` says what each one does.
 */
export const evaluationOptionsFromEnvironment = (
  environment: NodeJS.ProcessEnv,
): PrivacyEvaluationOptions | undefined => {
  const path = (name: string) => environment[name]?.trim() || undefined;
  const options = {
    attachmentsOnly: environment.DOEDESK_EVAL_OCR_ONLY?.trim() === "1",
    sentBodiesPath: path("DOEDESK_EVAL_SENT_BODIES_FILE"),
    eventsPath: path("DOEDESK_EVAL_EVENTS_FILE"),
    workerPath: path("DOEDESK_EVAL_WORKER_FILE"),
    otherHostsPath: path("DOEDESK_EVAL_HOSTS_FILE"),
    workerUnchecked: environment.DOEDESK_EVAL_WORKER_UNCHECKED?.trim() === "1",
    workerFreeText: environment.DOEDESK_EVAL_WORKER_FREETEXT?.trim() === "1",
  };
  return options.attachmentsOnly ||
    options.workerUnchecked ||
    options.workerFreeText ||
    options.sentBodiesPath !== undefined ||
    options.eventsPath !== undefined ||
    options.workerPath !== undefined ||
    options.otherHostsPath !== undefined
    ? options
    : undefined;
};

/**
 * Evaluation only (`DOEDESK_EVAL_SEALED_ASK_FREELY=1`): agents get `ask_documents` without the
 * instruction to ask the minimum, to measure what that instruction changes.
 */
export const sealedAskFreelyFromEnvironment = (environment: NodeJS.ProcessEnv): boolean =>
  environment.DOEDESK_EVAL_SEALED_ASK_FREELY?.trim() === "1";

/**
 * Starts the gateway and returns its service. Run this before any provider is set up: a provider
 * captures its process environment when it is created, and for a masked provider that
 * environment has to route through the gateway already.
 */
export const make = Effect.fn("PrivacyGateway.make")(function* (stateDirectory: string) {
  const platform = yield* HostProcess.Platform;
  const hostEnvironment = yield* HostProcess.Environment;
  const evaluation = evaluationOptionsFromEnvironment(hostEnvironment);
  if (sealedAskFreelyFromEnvironment(hostEnvironment)) {
    yield* Effect.logWarning("Sealed documents: agents are not told to ask the minimum");
  }
  if (evaluation !== undefined) {
    yield* Effect.logWarning("Privacy gateway evaluation switches are on", {
      ocrOnly: evaluation.attachmentsOnly,
      sentBodiesFile: evaluation.sentBodiesPath ?? null,
      eventsFile: evaluation.eventsPath ?? null,
      workerFile: evaluation.workerPath ?? null,
      hostsFile: evaluation.otherHostsPath ?? null,
      workerUnchecked: evaluation.workerUnchecked,
      workerFreeText: evaluation.workerFreeText,
    });
  }
  // Unbounded: each change names its own providers, so none may be dropped. Changes are rare.
  const routingChanges = yield* PubSub.unbounded<(provider: string) => boolean>();
  const sealedChanges = yield* makeSealedChanges;
  const controller = yield* Effect.acquireRelease(
    Effect.promise(() =>
      startPrivacyController({
        dataDirectory: `${stateDirectory}/privacy`,
        onRoutingChange: (changed) => PubSub.publishUnsafe(routingChanges, changed),
        platform,
        appVersion: packageJson.version,
        evaluation,
        workspaceRoots: agentWorkspaceRoots,
        hostEnvironment,
        onSealChange: sealChanged,
        onSealedListingChange: sealedChanges.changed,
      }),
    ),
    (running) => Effect.promise(() => running.close()),
  );
  setProviderEnvironmentOverlay(controller.environmentFor);
  setGatewayRefusalSource(controller.refusingNow);
  setSealedValuesInUse(() => controller.workerOffered());
  setSealedFilesSource((project, cwd) => ({
    ...controller.sealedForAgents(project, cwd),
    askOffered: controller.workerOffered(),
  }));
  setSealedFolderLookup(controller.sealedFolderContaining);
  setSealedFolderPaths(controller.sealedFolderPaths);
  setSealedFolderChecks({
    beforeTurn: controller.sealedFoldersBeforeTurn,
    sweepSoon: controller.sweepSealedFoldersSoon,
  });
  offered = () => {
    const status = controller.status();
    return status.active && status.readingTool;
  };
  workerOffered = () => controller.workerOffered();
  workerFreeText = () => controller.workerFreeText();
  return PrivacyGateway.of({
    status: Effect.sync(() => controller.status()),
    configure: Effect.fn("PrivacyGateway.configure")((input: PrivacyConfigureInput) =>
      Effect.promise(() => controller.configure(input)),
    ),
    signIn: Effect.fn("PrivacyGateway.signIn")((input: PrivacySignInInput) =>
      Effect.promise(() => controller.signIn(input)),
    ),
    account: Effect.fn("PrivacyGateway.account")((input: PrivacyAccountInput) =>
      Effect.promise(() => controller.account(input)),
    ),
    saveProfile: Effect.fn("PrivacyGateway.saveProfile")((input: PrivacyProfileInput) =>
      Effect.promise(() => controller.saveProfile(input)),
    ),
    setPreference: Effect.fn("PrivacyGateway.setPreference")((input: PrivacyPreferenceInput) =>
      Effect.sync(() => controller.setPreference(input)),
    ),
    routingChanges: Stream.fromPubSub(routingChanges),
    accountToken: Effect.fn("PrivacyGateway.accountToken")((audience: string) =>
      Effect.promise(() => controller.accountToken(audience)),
    ),
    activity: Effect.sync(() => controller.activity()),
    recordTurn: Effect.fn("PrivacyGateway.recordTurn")((input) =>
      Effect.sync(() => recordTurnWith(controller, input)),
    ),
    turnValues: Effect.fn("PrivacyGateway.turnValues")((runId: string) =>
      Effect.sync(() => controller.turnValues(runId)),
    ),
    knownValues: Effect.fn("PrivacyGateway.knownValues")((runIds?: ReadonlyArray<string>) =>
      Effect.sync(() => controller.knownValues(runIds)),
    ),
    readMasked: Effect.fn("PrivacyGateway.readMasked")((bytes: Buffer, mediaType: string) =>
      Effect.promise(() => controller.readMasked(bytes, mediaType)),
    ),
    redactions: Effect.sync(() => controller.redactions()),
    redactionFile: Effect.fn("PrivacyGateway.redactionFile")((id: string, part: "image" | "text") =>
      Effect.sync(() => controller.redactionFile(id, part)),
    ),
    clearRedactions: Effect.sync(() => controller.clearRedactions()),
    vault: Effect.sync(() => controller.vault()),
    unmaskedValues: Effect.sync(() => controller.unmaskedValues()),
    setValueMasked: Effect.fn("PrivacyGateway.setValueMasked")((token: string, masked: boolean) =>
      Effect.sync(() => controller.setValueMasked(token, masked)),
    ),
    configureWorker: Effect.fn("PrivacyGateway.configureWorker")((input: PrivacyWorkerInput) =>
      Effect.promise(() => controller.configureWorker(input)),
    ),
    documentText: Effect.fn("PrivacyGateway.documentText")((name: string, bytes: Buffer) =>
      Effect.promise(() => controller.documentText(name, bytes)),
    ),
    sealDocument: Effect.fn("PrivacyGateway.sealDocument")(
      (project: string, name: string, bytes: Buffer, label?: SealLabelChoice) =>
        Effect.promise(() => controller.sealDocument(project, name, bytes, undefined, label)),
    ),
    sealLabels: Effect.fn("PrivacyGateway.sealLabels")((names: ReadonlyArray<string>) =>
      Effect.promise(() => controller.sealLabels(names)),
    ),
    setSealedLabel: Effect.fn("PrivacyGateway.setSealedLabel")(
      (project: string, handle: string, neutral: boolean) =>
        Effect.promise(() => controller.setSealedLabel(project, handle, neutral)),
    ),
    sealedForAgents: Effect.fn("PrivacyGateway.sealedForAgents")(
      (project: string, cwd: string | null) =>
        Effect.sync(() => controller.sealedForAgents(project, cwd)),
    ),
    sealedListing: Effect.fn("PrivacyGateway.sealedListing")((project: string) =>
      Effect.sync(() => controller.sealedListing(project)),
    ),
    attachedFileInFolder: Effect.fn("PrivacyGateway.attachedFileInFolder")(
      (root: string, name: string, sha256: string, size: number) =>
        Effect.promise(() => controller.attachedFileInFolder(root, name, sha256, size)),
    ),
    sealAttached: Effect.fn("PrivacyGateway.sealAttached")(
      (
        project: string,
        root: string | null,
        name: string,
        bytes: Buffer,
        label?: SealLabelChoice,
      ) => Effect.promise(() => controller.sealAttached(project, root, name, bytes, label)),
    ),
    sealFile: Effect.fn("PrivacyGateway.sealFile")(
      (project: string, filePath: string, label?: SealLabelChoice) =>
        Effect.promise(() => controller.sealFile(project, filePath, label)),
    ),
    sealFiles: Effect.fn("PrivacyGateway.sealFiles")(
      (project: string, filePaths: ReadonlyArray<string>, label?: SealLabelChoice) =>
        Effect.promise(() => controller.sealFiles(project, filePaths, label)),
    ),
    unsealFile: Effect.fn("PrivacyGateway.unsealFile")((project: string, handle: string) =>
      Effect.promise(() => controller.unsealFile(project, handle)),
    ),
    readSealed: Effect.fn("PrivacyGateway.readSealed")((project: string, handle: string) =>
      Effect.promise(() => controller.readSealed(project, handle)),
    ),
    inspectSealTargets: Effect.fn("PrivacyGateway.inspectSealTargets")(
      (target: Parameters<PrivacyController["inspectSealTargets"]>[0]) =>
        Effect.promise(() => controller.inspectSealTargets(target)),
    ),
    openedToTurns: Effect.fn("PrivacyGateway.openedToTurns")(
      (project: string, target: Parameters<PrivacyController["openedToTurns"]>[1]) =>
        Effect.sync(() => controller.openedToTurns(project, target)),
    ),
    sealFolder: Effect.fn("PrivacyGateway.sealFolder")(
      (
        project: string,
        root: string,
        folder: string,
        options?: { readonly neutralLabels?: boolean },
      ) => Effect.promise(() => controller.sealFolder(project, root, folder, options)),
    ),
    unsealFolder: Effect.fn("PrivacyGateway.unsealFolder")((project: string, folder: string) =>
      Effect.promise(() => controller.unsealFolder(project, folder)),
    ),
    sealedFoldersBeforeTurn: Effect.fn("PrivacyGateway.sealedFoldersBeforeTurn")(
      (project: string) => Effect.promise(() => controller.sealedFoldersBeforeTurn(project)),
    ),
    sealedTurn: Effect.fn("PrivacyGateway.sealedTurn")((runId: string) =>
      Effect.sync(() => controller.sealedTurn(runId)),
    ),
    resetSealedLimits: Effect.fn("PrivacyGateway.resetSealedLimits")((project: string) =>
      Effect.sync(() => controller.resetSealedLimits(project)),
    ),
    sealedClearAnswers: Effect.fn("PrivacyGateway.sealedClearAnswers")((project: string) =>
      Effect.sync(() => controller.sealedClearAnswers(project)),
    ),
    sealedOutput: Effect.fn("PrivacyGateway.sealedOutput")((project: string, name: string) =>
      Effect.sync(() => controller.sealedOutput(project, name)),
    ),
    askDocuments: Effect.fn("PrivacyGateway.askDocuments")((input: PrivacyAskInput) =>
      Effect.promise(() => controller.askDocuments(input)),
    ),
    askDocumentsFreeText: Effect.fn("PrivacyGateway.askDocumentsFreeText")(
      (input: PrivacyAskInput) => Effect.promise(() => controller.askDocumentsFreeText(input)),
    ),
    fillSealed: Effect.fn("PrivacyGateway.fillSealed")(
      (project: string, name: string, template: string) =>
        Effect.sync(() => controller.fillSealed(project, name, template)),
    ),
    sealedChanges: sealedChanges.stream,
  });
});

/**
 * A provider process keeps the environment it was started with. When masking is turned on or off,
 * for everything or for one provider, the instances of the providers whose route changed are
 * rebuilt, which ends their running processes: none keeps talking to its vendor on the old route.
 * The turns of every other provider go on.
 */
/** The instances of the providers whose route changed. */
const instancesToRestart = <Id>(
  instances: ReadonlyArray<{ readonly instanceId: Id; readonly driverKind: string }>,
  changed: (provider: string) => boolean,
): ReadonlyArray<Id> =>
  instances.flatMap((instance) => (changed(instance.driverKind) ? [instance.instanceId] : []));

export const layerRoutingWatcher = Layer.effectDiscard(
  Effect.gen(function* () {
    const privacy = yield* PrivacyGateway;
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
    yield* privacy.routingChanges.pipe(
      Stream.runForEach((changed) =>
        registry.listInstances.pipe(
          Effect.flatMap((instances) => mutator.rebuild(instancesToRestart(instances, changed))),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
