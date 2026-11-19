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
} from "./detect.ts";
import { type GatewayRecord, startGateway } from "./gateway.ts";
import { Pseudonymizer } from "./pseudonymizer.ts";
import type { Reader } from "./reader.ts";
import type { AttachmentHandling } from "./requestMasking.ts";
import { Vault } from "./vault.ts";

export { PROVIDER_NOTICE_VERSION, startPrivacyController } from "./controller.ts";
export type {
  PrivacyAccountInput,
  PrivacyAccountResult,
  PrivacyConfigureInput,
  PrivacyController,
  PrivacyControllerOptions,
  PrivacyEvaluationOptions,
  PrivacyControllerStatus,
  PrivacyPreferenceInput,
  PrivacyReadMaskedResult,
  PrivacyProfileInput,
  PrivacySignInInput,
  PrivacySignInResult,
} from "./controller.ts";
export { describeMaskingFailure, makeMaskingCore, MaskingRefusedError } from "./core.ts";
export type { MaskingCore, MaskingRoute } from "./core.ts";
export { DetectorUnavailableError, makeRemoteDetector, patternDetector } from "./detect.ts";
export type { DetectedEntity, Detector } from "./detect.ts";
export { DEFAULT_BLOCKED_HOSTS, DEFAULT_INSPECTED_HOSTS } from "./gateway.ts";
export type { GatewayRecord } from "./gateway.ts";
export { ENTITY_KINDS } from "./placeholders.ts";
export type { EntityKind } from "./placeholders.ts";
export { Pseudonymizer } from "./pseudonymizer.ts";
export { Vault } from "./vault.ts";
export type { VaultEntry } from "./vault.ts";
export { makeRemoteReader } from "./reader.ts";
export type { Reader } from "./reader.ts";
export type { ImageHandling } from "./attachments.ts";
export type { RedactionFile, RedactionRecord } from "./redaction/store.ts";

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
  /** Reads text out of images and files. Without one they are withheld. */
  readonly reader?: (() => Reader | undefined) | undefined;
  /** Returns false while masking is turned off. See `GatewayOptions.masking`. */
  readonly masking?: (() => boolean) | undefined;
  /** Evaluation only. See `GatewayOptions.onSentBody`. */
  readonly onSentBody?: ((host: string, path: string, body: string) => void) | undefined;
  /** Evaluation only. See `GatewayOptions.attachmentsOnly`. */
  readonly attachmentsOnly?: (() => boolean) | undefined;
  /** How images are sent. See `GatewayOptions.attachments`. */
  readonly attachments?: (() => AttachmentHandling) | undefined;
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
  if (user.username.length >= 3) vault.tokenFor("PERSON", user.username);
  const host = NodeOS.hostname();
  if (host.length >= 3) vault.tokenFor("OTHER", host);
};

export const startPrivacyGateway = async (
  config: PrivacyGatewayConfig,
): Promise<PrivacyGateway> => {
  const vault = new Vault(NodePath.join(config.dataDirectory, "vault.json"));
  seedVault(vault);
  const authority = loadLocalAuthority(NodePath.join(config.dataDirectory, "authority"));
  const remote =
    config.detector ??
    (config.detection === undefined ? undefined : makeRemoteDetector(config.detection));
  const detector = cacheDetector(
    combineDetectors(
      remote === undefined ? [patternDetector] : [patternDetector, ignoreAppAuthoredBlocks(remote)],
    ),
  );
  const pseudonymizer = new Pseudonymizer(vault, detector);
  const gateway = await startGateway({
    authority,
    pseudonymizer,
    ...(config.attachments === undefined ? {} : { attachments: config.attachments }),
    ...(config.onRecord === undefined ? {} : { onRecord: config.onRecord }),
    ...(config.masking === undefined ? {} : { masking: config.masking }),
    ...(config.reader === undefined ? {} : { reader: config.reader }),
    ...(config.onSentBody === undefined ? {} : { onSentBody: config.onSentBody }),
    ...(config.attachmentsOnly === undefined ? {} : { attachmentsOnly: config.attachmentsOnly }),
  });
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
      // Node and Bun programs add this certificate to their defaults.
      NODE_EXTRA_CA_CERTS: authority.certificatePath,
      // Node only honours the proxy variables when asked to.
      NODE_USE_ENV_PROXY: "1",
      // Programs that replace their defaults get the public roots plus the authority.
      SSL_CERT_FILE: authority.bundlePath,
      REQUESTS_CA_BUNDLE: authority.bundlePath,
      CURL_CA_BUNDLE: authority.bundlePath,
      CODEX_CA_CERTIFICATE: authority.bundlePath,
    },
    close: async () => {
      await gateway.close();
      vault.flush();
    },
  };
};
