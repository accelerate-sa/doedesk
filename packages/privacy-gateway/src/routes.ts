import { wireFormatForPath, type WireFormat } from "./requestMasking.ts";

/**
 * What the gateway does with one request to an AI host while masking is on. Nothing with a body
 * is forwarded unread: a path is on this list, or its body is not sent.
 */
export type Route =
  /** A body the gateway rewrites: a model request, or text in a shape of its own. */
  | { readonly kind: "masked"; readonly format: WireFormat }
  /** A usage report. Measured to hold no text of the session; known values are still replaced. */
  | { readonly kind: "report" }
  /** Sign-in, settings, flags, quota: carries nothing of the session, and is sent as written. */
  | { readonly kind: "plain" }
  /** JSON-RPC to apps the AI company hosts: listing them is plain, calling one carries content. */
  | { readonly kind: "apps" }
  /** A body on a path that is none of the above: not sent. */
  | { readonly kind: "unknown" };

interface Rule {
  /** Host names the rule is for, subdomains included. Without it, any AI host. */
  readonly hosts?: ReadonlyArray<string>;
  readonly path: RegExp;
  readonly route: Route;
}

const PLAIN: Route = { kind: "plain" };
const REPORT: Route = { kind: "report" };
const TEXT: Route = { kind: "masked", format: "json-text" };
const ANTHROPIC = ["anthropic.com"];
const CHATGPT = ["chatgpt.com"];
const CODE_ASSIST = ["cloudcode-pa.googleapis.com", "daily-cloudcode-pa.googleapis.com"];

/*
 * Each path below was seen in a recorded session of the vendor's program or read in its source
 * (docs/operations/provider-connections.md says which). A path that is missing costs the agent
 * that one request; a path wrongly listed as plain sends its body unread. When unsure, leave out.
 */
const RULES: ReadonlyArray<Rule> = [
  // Text to count, embed or complete, outside the four model formats.
  { path: /\/responses\/input_tokens$/, route: TEXT },
  { path: /\/(?:embeddings|moderations)$/, route: TEXT },
  { path: /(?<!\/chat)\/completions$/, route: TEXT },
  { path: /:(?:embedContent|batchEmbedContents)$/, route: TEXT },

  // Claude Code: usage reports, organisation metrics, feature flags (account attributes only).
  { hosts: ANTHROPIC, path: /^\/api\/event_logging\//, route: REPORT },
  { hosts: ANTHROPIC, path: /^\/api\/claude_code\/metrics$/, route: REPORT },
  { hosts: ANTHROPIC, path: /^\/api\/eval(?:-authed)?\//, route: PLAIN },
  { hosts: ANTHROPIC, path: /^\/(?:v1|api)\/oauth\/(?:token|claude_cli\/[a-z_]+)$/, route: PLAIN },

  // Codex: analytics events and metrics (they name the tools used, nothing else), usage queries
  // by chat id, and the apps OpenAI hosts.
  { hosts: CHATGPT, path: /^\/backend-api\/codex\/analytics-events\//, route: REPORT },
  { hosts: ["ab.chatgpt.com"], path: /^\/otlp\/v1\/metrics$/, route: REPORT },
  { hosts: CHATGPT, path: /^\/backend-api\/(?:wham|api\/codex)\/usage\//, route: PLAIN },
  { hosts: CHATGPT, path: /^\/backend-api\/ps\/mcp$/, route: { kind: "apps" } },

  // Gemini CLI and Antigravity on Google's code host: account set-up, the model list, quota,
  // settings and who may read a conversation's record (an id), then the metrics report.
  {
    hosts: CODE_ASSIST,
    path: /^\/v1internal:(?:loadCodeAssist|onboardUser|listExperiments|retrieveUserQuota|retrieveUserQuotaSummary|fetchAdminControls|fetchAvailableModels|fetchUserInfo|setCodeAssistGlobalUserSetting|writeTrajectoryAcls)$/,
    route: PLAIN,
  },
  { hosts: CODE_ASSIST, path: /^\/v1internal:recordCodeAssistMetrics$/, route: REPORT },

  // OpenRouter's sign-in exchange.
  { hosts: ["openrouter.ai"], path: /^\/api\/v1\/auth\/keys$/, route: PLAIN },
];

const under = (host: string, domains: ReadonlyArray<string>): boolean =>
  domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

/** The route of a request to an AI host. `hasBody`: it sends bytes of its own. */
export const routeFor = (host: string, path: string, hasBody: boolean): Route => {
  // Nothing to read: an address and headers. A GET is the vendor's program asking, not telling.
  if (!hasBody) return PLAIN;
  const pathname = path.split("?")[0] ?? path;
  const format = wireFormatForPath(pathname);
  if (format !== undefined) return { kind: "masked", format };
  const rule = RULES.find(
    (candidate) =>
      (candidate.hosts === undefined || under(host, candidate.hosts)) &&
      candidate.path.test(pathname),
  );
  return rule?.route ?? { kind: "unknown" };
};

/** JSON-RPC methods that ask an app server what it offers, and say nothing of the session. */
const APP_METHODS_WITHOUT_CONTENT =
  /^(?:initialize|ping|notifications\/[a-z_/]+|(?:tools|prompts|resources|resources\/templates)\/list)$/;

/** Whether every message of a JSON-RPC body is one that carries nothing of the session. */
export const appsBodyIsPlain = (body: unknown): boolean => {
  const messages = Array.isArray(body) ? body : [body];
  return messages.every((message) => {
    if (typeof message !== "object" || message === null) return false;
    const { method } = message as { readonly method?: unknown };
    // A reply the program sends back to the server has no method: only an empty one is plain.
    if (method === undefined) {
      const { result } = message as { readonly result?: unknown };
      return result === undefined || JSON.stringify(result) === "{}";
    }
    return typeof method === "string" && APP_METHODS_WITHOUT_CONTENT.test(method);
  });
};
