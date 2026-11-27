import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { loadLocalAuthority } from "./certificates.ts";
import {
  cacheDetector,
  combineDetectors,
  type Detector,
  ignoreAppAuthoredBlocks,
  makeRemoteDetector,
  patternDetector,
  withSecondPass,
} from "./detect.ts";
import {
  DEFAULT_INSPECTED_HOSTS,
  type EgressRules,
  type GatewayOptions,
  type GatewayRecord,
  startGateway,
} from "./gateway.ts";
import { Pseudonymizer } from "./pseudonymizer.ts";
import type { Reader } from "./reader.ts";
import { Restorations } from "./restorations.ts";
import { fetchThrough, readHostNetwork } from "./upstream.ts";
import type { AttachmentHandling } from "./requestMasking.ts";
import { Vault } from "./vault.ts";
import { makeWorkspaceFiles } from "./workspaceFiles.ts";

export { PROVIDER_NOTICE_VERSION, startPrivacyController } from "./controller.ts";
export type {
  PrivacyAskInput,
  PrivacySealedListing,
  PrivacyWorkerInput,
  PrivacyWorkerStatus,
  PrivacyAccountInput,
  PrivacyAccountResult,
  PrivacyConfigureInput,
  PrivacyConfigureOutcome,
  PrivacyController,
  PrivacyControllerOptions,
  PrivacyEvaluationOptions,
  PrivacyControllerStatus,
  PrivacyKnownValues,
  PrivacyPreferenceInput,
  PrivacyProviderInput,
  PrivacyProviderOutcome,
  PrivacyProviders,
  PrivacyReadMaskedResult,
  PrivacyProfileInput,
  PrivacySignInInput,
  PrivacySignInResult,
  PrivacyTurnValue,
  SealLabelChoice,
} from "./controller.ts";
export { openName } from "./sealedLabels.ts";
export { standInsByKind } from "./turns.ts";
export type { TurnTally } from "./turns.ts";
export { describeMaskingFailure, makeMaskingCore, MaskingRefusedError } from "./core.ts";
export type { MaskingCore, MaskingRoute } from "./core.ts";
export { DetectorUnavailableError, makeRemoteDetector, patternDetector } from "./detect.ts";
export type { DetectedEntity, Detector } from "./detect.ts";
export { DEFAULT_BLOCKED_HOSTS, DEFAULT_INSPECTED_HOSTS } from "./gateway.ts";
export type { EgressPolicy, GatewayRecord } from "./gateway.ts";
export { ENTITY_KINDS } from "./placeholders.ts";
export type { EntityKind } from "./placeholders.ts";
export { Pseudonymizer } from "./pseudonymizer.ts";
export { Vault } from "./vault.ts";
export type { VaultEntry } from "./vault.ts";
export { makeRemoteReader } from "./reader.ts";
export type { Reader } from "./reader.ts";
export type { ImageHandling } from "./attachments.ts";
export { COLUMN_TYPES, FIELD_TYPES } from "./worker/fields.ts";
export type { FieldSpec } from "./worker/fields.ts";
export type { AskAnswer } from "./worker/sealedWorker.ts";
export { workerBusyMessage } from "./worker/sealedWorker.ts";
export { NOT_REACHED, WORKER_BUSY, WORKER_NOT_INCLUDED } from "./worker/job.ts";
export { WORKER_DRIVERS } from "./worker/client.ts";
export type { WorkerDriver } from "./worker/client.ts";
export type { RedactionFile, RedactionRecord } from "./redaction/store.ts";
export type { SealFileResult, UnsealFileResult } from "./sealedFiles.ts";
export type {
  SealChange,
  SealedFolderGate,
  SealFolderResult,
  SealTargetsInspection,
  UnsealFolderResult,
} from "./sealedFolders.ts";
export type { SealedOutputSpan, SealedTurnActivity } from "./worker/store.ts";

export interface PrivacyGatewayConfig {
  /** Where the vault and the local certificate authority are kept. */
  readonly dataDirectory: string;
  /**
   * The service that finds names and other free-text personal data: DoeDesk Cloud, or one the
   * user hosts. Without it only fixed-format identifiers (phones, IDs, IBANs, emails) are found.
   */
  readonly detection?:
    | { readonly endpoint: string; readonly token?: string | undefined }
    | undefined;
  /** Replaces the detection service. Used by tests. */
  readonly detector?: Detector | undefined;
  readonly onRecord?: ((record: GatewayRecord) => void) | undefined;
  /** Told the stand-ins a reply restored. See `GatewayOptions.onRestored`. */
  readonly onRestored?: GatewayOptions["onRestored"] | undefined;
  /** Reads text out of images and files. Without one they are withheld. */
  readonly reader?: (() => Reader | undefined) | undefined;
  /** Returns false while masking is turned off. See `GatewayOptions.masking`. */
  readonly masking?: (() => boolean) | undefined;
  /** Evaluation only. See `GatewayOptions.onSentBody`. */
  readonly onSentBody?: ((host: string, path: string, body: string) => void) | undefined;
  /** Measurement only: hosts to open besides the AI hosts, to see what a program sends them. */
  readonly alsoInspect?: ReadonlyArray<string> | undefined;
  /** Measurement only. See `GatewayOptions.onUnsentBody`. */
  readonly onUnsentBody?: ((host: string, path: string, body: string) => void) | undefined;
  /** Evaluation only. See `GatewayOptions.attachmentsOnly`. */
  readonly attachmentsOnly?: (() => boolean) | undefined;
  /** How images are sent. See `GatewayOptions.attachments`. */
  readonly attachments?: (() => AttachmentHandling) | undefined;
  /** A second detector, while one is switched on. Looked up on every check. */
  readonly secondPass?: (() => Detector | undefined) | undefined;
  /** Which other hosts may be reached. See `GatewayOptions.egress`. */
  readonly egress?: (() => EgressRules) | undefined;
  /** See `MaskRequestOptions.webResults`. Without it web results are checked like any other. */
  readonly webResults?: (() => "known" | "detect") | undefined;
  /** See `GatewayOptions.withholdSealedText`. */
  readonly withholdSealedText?: ((text: string, typed: boolean) => string | undefined) | undefined;
  /** Evaluation only. See `GatewayOptions.onOtherHost`. */
  readonly onOtherHost?:
    | ((host: string, port: number, outcome: "passed" | "blocked") => void)
    | undefined;
  /**
   * The folders agents work in. A file of one of them that a detector takes for a web address
   * (`summary.md`) is left alone. Without it no file name is.
   */
  readonly workspaceRoots?: (() => ReadonlyArray<string>) | undefined;
  /**
   * The environment DoeDesk was started with, for the person's own proxy and certificate bundle:
   * the gateway sends through that proxy and adds to that bundle. Defaults to `process.env`.
   */
  readonly hostEnvironment?: NodeJS.ProcessEnv | undefined;
  /** See `GatewayOptions.upstream`. Used by tests. */
  readonly upstream?: GatewayOptions["upstream"] | undefined;
}

export interface PrivacyGateway {
  readonly port: number;
  readonly vault: Vault;
  /** The one detector and vault of this gateway, for masking done outside a request. */
  readonly pseudonymizer: Pseudonymizer;
  /** Environment that routes a child process's model traffic through the gateway. */
  readonly environment: Readonly<Record<string, string>>;
  readonly close: () => Promise<void>;
}

/**
 * Vendor-documented switches DoeDesk sets for a masked session, and nothing else. Each one stops
 * a report that can carry text from the session, which the gateway does not rewrite. Claude
 * Code's usage metrics are left on: Anthropic documents that they hold no prompts, code or file
 * paths (https://code.claude.com/docs/en/data-usage, read 18 November 2026).
 */
export const MASKED_SESSION_SWITCHES: Readonly<Record<string, string>> = {
  // Error reports hold error text and stack traces from the session.
  DISABLE_ERROR_REPORTING: "1",
  // /feedback sends the conversation, which on this computer holds the real values.
  DISABLE_FEEDBACK_COMMAND: "1",
  // The survey can ask to upload the session transcript.
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
  // The Artifact tool publishes a page the model wrote, with real values restored, to Anthropic.
  CLAUDE_CODE_DISABLE_ARTIFACT: "1",
  // claude.ai connectors run through Anthropic's MCP proxy, which sees the restored tool input.
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
};

/** Added when the user turns Claude Code's usage reports off in Settings. */
export const USAGE_REPORTS_OFF_SWITCHES: Readonly<Record<string, string>> = {
  DISABLE_TELEMETRY: "1",
};

/** Values that identify the person at this machine and appear in paths and prompts. */
const seedVault = (vault: Vault): void => {
  const user = NodeOS.userInfo();
  if (user.username.length >= 3 && !vault.isReleased(user.username)) {
    vault.tokenFor("PERSON", user.username);
  }
  const host = NodeOS.hostname();
  if (host.length >= 3 && !vault.isReleased(host)) vault.tokenFor("OTHER", host);
};

export const startPrivacyGateway = async (
  config: PrivacyGatewayConfig,
): Promise<PrivacyGateway> => {
  const vault = new Vault(NodePath.join(config.dataDirectory, "vault.json"));
  seedVault(vault);
  const network = readHostNetwork(config.hostEnvironment ?? process.env);
  const authority = loadLocalAuthority(NodePath.join(config.dataDirectory, "authority"), network);
  const remote =
    config.detector ??
    (config.detection === undefined
      ? undefined
      : makeRemoteDetector({ ...config.detection, fetch: fetchThrough(network) }));
  const first = cacheDetector(
    combineDetectors(
      remote === undefined ? [patternDetector] : [patternDetector, ignoreAppAuthoredBlocks(remote)],
    ),
  );
  // The second pass keeps its own cache on disk, so it sits outside the one in memory.
  const detector =
    config.secondPass === undefined ? first : withSecondPass(first, config.secondPass);
  const pseudonymizer = new Pseudonymizer(
    vault,
    detector,
    [],
    config.workspaceRoots === undefined ? undefined : makeWorkspaceFiles(config.workspaceRoots),
  );
  const restorations = new Restorations(NodePath.join(config.dataDirectory, "restorations.json"));
  let ownPort = 0;
  const gateway = await startGateway({
    authority,
    pseudonymizer,
    restorations,
    upstreamCertificates: network.certificates,
    upstreamProxy: (host, port, secure) => {
      const proxy = network.proxyFor(host, port, secure);
      // DoeDesk started from inside one of its own agents inherits this gateway's address.
      const own =
        proxy !== undefined &&
        Number(proxy.port) === ownPort &&
        (proxy.hostname === "127.0.0.1" || proxy.hostname === "localhost");
      return own ? undefined : proxy;
    },
    ...(config.attachments === undefined ? {} : { attachments: config.attachments }),
    ...(config.onRecord === undefined ? {} : { onRecord: config.onRecord }),
    ...(config.onRestored === undefined ? {} : { onRestored: config.onRestored }),
    ...(config.masking === undefined ? {} : { masking: config.masking }),
    ...(config.reader === undefined ? {} : { reader: config.reader }),
    ...(config.onSentBody === undefined ? {} : { onSentBody: config.onSentBody }),
    ...(config.onUnsentBody === undefined ? {} : { onUnsentBody: config.onUnsentBody }),
    ...(config.alsoInspect === undefined
      ? {}
      : { inspectedHosts: [...DEFAULT_INSPECTED_HOSTS, ...config.alsoInspect] }),
    ...(config.attachmentsOnly === undefined ? {} : { attachmentsOnly: config.attachmentsOnly }),
    ...(config.egress === undefined ? {} : { egress: config.egress }),
    ...(config.webResults === undefined ? {} : { webResults: config.webResults }),
    ...(config.withholdSealedText === undefined
      ? {}
      : { withholdSealedText: config.withholdSealedText }),
    ...(config.onOtherHost === undefined ? {} : { onOtherHost: config.onOtherHost }),
    ...(config.upstream === undefined ? {} : { upstream: config.upstream }),
  });
  ownPort = gateway.port;
  const proxy = `http://127.0.0.1:${gateway.port}`;
  return {
    port: gateway.port,
    vault,
    pseudonymizer,
    environment: {
      HTTPS_PROXY: proxy,
      https_proxy: proxy,
      HTTP_PROXY: proxy,
      http_proxy: proxy,
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
      // Node and Bun programs add these to their defaults: the person's own, then the authority.
      NODE_EXTRA_CA_CERTS: authority.certificatePath,
      // Node only honours the proxy variables when asked to.
      NODE_USE_ENV_PROXY: "1",
      // Programs that replace their defaults get the public roots, the person's own bundle and
      // the authority.
      SSL_CERT_FILE: authority.bundlePath,
      REQUESTS_CA_BUNDLE: authority.bundlePath,
      CURL_CA_BUNDLE: authority.bundlePath,
      CODEX_CA_CERTIFICATE: authority.bundlePath,
    },
    close: async () => {
      await gateway.close();
      vault.flush();
      restorations.flush();
    },
  };
};
