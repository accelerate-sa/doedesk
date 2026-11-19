import {
  type PrivacyAccountInput,
  type PrivacyAccountResult,
  type PrivacyConfigureInput,
  type PrivacyController,
  type PrivacyEvaluationOptions,
  type PrivacyPreferenceInput,
  type PrivacyProfileInput,
  type PrivacyReadMaskedResult,
  type PrivacySignInInput,
  type PrivacySignInResult,
  startPrivacyController,
} from "@t3tools/privacy-gateway";
import { setProviderEnvironmentOverlay } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import packageJson from "../../package.json" with { type: "json" };
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "../provider/ProviderInstanceRegistryMutator.ts";

/**
 * The privacy gateway for this server: masks personal data in the requests an agent of a masked
 * provider sends to a model, and restores it in what comes back.
 */
export class PrivacyGateway extends Context.Service<
  PrivacyGateway,
  {
    readonly status: Effect.Effect<ReturnType<PrivacyController["status"]>>;
    readonly configure: (
      input: PrivacyConfigureInput,
    ) => Effect.Effect<{ readonly ok: boolean; readonly message: string | null }>;
    readonly signIn: (input: PrivacySignInInput) => Effect.Effect<PrivacySignInResult>;
    /** Accepting the Terms, a copy of the account's data, and deleting the account. */
    readonly account: (input: PrivacyAccountInput) => Effect.Effect<PrivacyAccountResult>;
    readonly saveProfile: (input: PrivacyProfileInput) => Effect.Effect<void>;
    readonly setPreference: (input: PrivacyPreferenceInput) => Effect.Effect<void>;
    /** Emits when a provider's processes need a restart to be routed as the settings now say. */
    readonly routingChanges: Stream.Stream<void>;
    /** A short-lived signed token proving the signed-in account to another DoeDesk service. */
    readonly accountToken: (audience: string) => Effect.Effect<string | null>;
    readonly activity: Effect.Effect<ReturnType<PrivacyController["activity"]>>;
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
  }
>()("t3/privacy/PrivacyGateway") {}

let offered: () => boolean = () => false;
/**
 * Whether the reading tool is offered now, for a tool's listing, which runs outside any fiber
 * that could ask the service. False until the gateway has started.
 */
export const readingToolOffered = (): boolean => offered();

/**
 * Evaluation only, for measuring what masking costs. Read once from the environment at startup,
 * so nothing in the app can turn them on. `DOEDESK_EVAL_OCR_ONLY=1` reads attachments as text but
 * masks nothing; `DOEDESK_EVAL_SENT_BODIES_FILE` and `DOEDESK_EVAL_EVENTS_FILE` name files that
 * receive every request body sent to a model and what the gateway did. Both hold confidential text.
 */
export const evaluationOptionsFromEnvironment = (
  environment: NodeJS.ProcessEnv,
): PrivacyEvaluationOptions | undefined => {
  const path = (name: string) => environment[name]?.trim() || undefined;
  const options = {
    attachmentsOnly: environment.DOEDESK_EVAL_OCR_ONLY?.trim() === "1",
    sentBodiesPath: path("DOEDESK_EVAL_SENT_BODIES_FILE"),
    eventsPath: path("DOEDESK_EVAL_EVENTS_FILE"),
  };
  return options.attachmentsOnly ||
    options.sentBodiesPath !== undefined ||
    options.eventsPath !== undefined
    ? options
    : undefined;
};

/**
 * Starts the gateway and returns its service. Run this before any provider is set up: a provider
 * captures its process environment when it is created, and for a masked provider that
 * environment has to route through the gateway already.
 */
export const make = Effect.fn("PrivacyGateway.make")(function* (stateDirectory: string) {
  const platform = yield* HostProcess.Platform;
  const evaluation = evaluationOptionsFromEnvironment(yield* HostProcess.Environment);
  if (evaluation !== undefined) {
    yield* Effect.logWarning("Privacy gateway evaluation switches are on", {
      ocrOnly: evaluation.attachmentsOnly,
      sentBodiesFile: evaluation.sentBodiesPath ?? null,
      eventsFile: evaluation.eventsPath ?? null,
    });
  }
  const routingChanges = yield* PubSub.sliding<void>(1);
  const controller = yield* Effect.acquireRelease(
    Effect.promise(() =>
      startPrivacyController({
        dataDirectory: `${stateDirectory}/privacy`,
        onRoutingChange: () => PubSub.publishUnsafe(routingChanges, undefined),
        platform,
        appVersion: packageJson.version,
        evaluation,
      }),
    ),
    (running) => Effect.promise(() => running.close()),
  );
  setProviderEnvironmentOverlay(controller.environmentFor);
  offered = () => {
    const status = controller.status();
    return status.active && status.readingTool;
  };
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
    readMasked: Effect.fn("PrivacyGateway.readMasked")((bytes: Buffer, mediaType: string) =>
      Effect.promise(() => controller.readMasked(bytes, mediaType)),
    ),
    redactions: Effect.sync(() => controller.redactions()),
    redactionFile: Effect.fn("PrivacyGateway.redactionFile")((id: string, part: "image" | "text") =>
      Effect.sync(() => controller.redactionFile(id, part)),
    ),
    clearRedactions: Effect.sync(() => controller.clearRedactions()),
    vault: Effect.sync(() => controller.vault()),
  });
});

/**
 * A provider process keeps the environment it was started with. When masking is turned on or off,
 * for everything or for one provider, every provider instance is rebuilt, which ends its running
 * processes: none keeps talking to its vendor on the old route.
 */
export const layerRoutingWatcher = Layer.effectDiscard(
  Effect.gen(function* () {
    const privacy = yield* PrivacyGateway;
    const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
    yield* privacy.routingChanges.pipe(
      Stream.runForEach(() =>
        registry.listInstances.pipe(
          Effect.flatMap((instances) =>
            mutator.rebuild(instances.map((instance) => instance.instanceId)),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);
