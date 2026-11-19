import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import { type MaskingCore, MaskingRefusedError, type MaskingRoute } from "../core.ts";

/**
 * Masking for Codex through its lifecycle hooks, with nothing rewritten on the network. Not used
 * for a user's sessions yet: see `CODEX_UNCOVERED_ROUTES`.
 */
const FRONT_END = "Codex hooks";

const route = (what: string): MaskingRoute => ({ frontEnd: FRONT_END, what });

/** Tools whose input is read by a model, not run on this computer. Stand-ins stay in place. */
const INPUT_STAYS_MASKED = new Set(["spawn_agent", "Agent", "followup_task", "send_message"]);

/**
 * Routes on which content reaches OpenAI unmasked with this front end, each measured on Codex
 * 0.169.0 on 18 November 2026. See docs/operations/provider-connections.md.
 */
export const CODEX_UNCOVERED_ROUTES: ReadonlyArray<{
  readonly route: string;
  readonly why: string;
}> = [
  {
    route: "working folder and home folder paths",
    why: "Codex writes the working folder, and the folders it loads skills from under the home folder, into its own instructions. No hook changes them.",
  },
  {
    route: "a hook that does not run",
    why: "Codex continues with the original tool result when a hook fails, times out or cannot start, and its documentation calls tool hooks a guardrail, not a complete enforcement boundary.",
  },
  {
    route: "instruction files",
    why: "Codex reads AGENTS.md files into the conversation by itself. No hook changes their text.",
  },
];

export interface CodexHookInput {
  readonly hook_event_name: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
}

type CodexHookOutput = Record<string, unknown>;

const asText = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 1);

/**
 * Answers one Codex hook event. `PreToolUse` puts real values back into what the tool runs;
 * `PostToolUse` gives Codex masked text to use in place of the tool's result.
 */
export const handleCodexHook = async (
  core: MaskingCore,
  input: CodexHookInput,
): Promise<CodexHookOutput> => {
  const tool = input.tool_name ?? "tool";
  if (input.hook_event_name === "PreToolUse") {
    if (INPUT_STAYS_MASKED.has(tool) || input.tool_input === undefined) return {};
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: core.restore(input.tool_input),
      },
    };
  }
  if (input.hook_event_name === "PostToolUse") {
    try {
      const masked = await core.maskNew(asText(input.tool_response), route(`tool result: ${tool}`));
      // Codex replaces the tool's result with the reason of a blocking decision.
      return { decision: "block", reason: masked };
    } catch (cause) {
      const note = cause instanceof MaskingRefusedError ? cause.message : String(cause);
      return { decision: "block", reason: `[${note}]` };
    }
  }
  return {};
};

/**
 * What a hook process prints when it cannot reach DoeDesk: the tool is not run, or its result
 * is not used. A hook that prints nothing would let the original through.
 */
export const codexHookFallback = (event: string): CodexHookOutput => {
  const reason = "DoeDesk could not check this for personal data, so it was not used.";
  return event === "PreToolUse"
    ? {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }
    : { decision: "block", reason: `[${reason}]` };
};

/** Masks what the user typed before the app hands it to Codex. */
export const maskCodexPrompt = (core: MaskingCore, text: string): Promise<string> =>
  core.maskNew(text, route("user message"));

/** The text the app sends in place of an image or a file the user attached. */
export const readCodexAttachment = (
  core: MaskingCore,
  attachment: { readonly bytes: Buffer; readonly mediaType: string },
  kind: "image" | "file",
): Promise<string> => core.readAttachment(attachment, kind, route(`attached ${kind}`));

export interface CodexHookEndpoint {
  /** The program a Codex command hook runs: it forwards the event here and prints the answer. */
  readonly clientSource: string;
  /** Environment the hook program needs. */
  readonly environment: Readonly<Record<string, string>>;
  readonly close: () => Promise<void>;
}

/**
 * Codex hooks are separate programs. This listens on this computer only, so that such a program
 * can ask the running DoeDesk to answer the event with its vault.
 */
export const startCodexHookEndpoint = (core: MaskingCore): Promise<CodexHookEndpoint> => {
  const secret = NodeCrypto.randomBytes(24).toString("hex");
  const server = NodeHttp.createServer((request, response) => {
    if (request.method !== "POST" || request.headers["x-doedesk-hook"] !== secret) {
      response.writeHead(403).end();
      return;
    }
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let input: CodexHookInput;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CodexHookInput;
      } catch {
        response.writeHead(400).end();
        return;
      }
      void handleCodexHook(core, input).then(
        (output) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(output));
        },
        () => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(codexHookFallback(input.hook_event_name)));
        },
      );
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The Codex hook endpoint could not open a local port."));
        return;
      }
      resolve({
        clientSource: CODEX_HOOK_CLIENT_SOURCE,
        environment: {
          DOEDESK_HOOK_URL: `http://127.0.0.1:${address.port}/`,
          DOEDESK_HOOK_SECRET: secret,
        },
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
};

/** Plain JavaScript with no imports beyond Node, so Codex can run it from any folder. */
const CODEX_HOOK_CLIENT_SOURCE = `
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
  const body = Buffer.concat(chunks).toString("utf8");
  let event = "";
  try { event = JSON.parse(body).hook_event_name ?? ""; } catch {}
  const reason = "DoeDesk could not check this for personal data, so it was not used.";
  const fallback = event === "PreToolUse"
    ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }
    : event === "PostToolUse" ? { decision: "block", reason: "[" + reason + "]" } : {};
  try {
    const response = await fetch(process.env.DOEDESK_HOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-doedesk-hook": process.env.DOEDESK_HOOK_SECRET ?? "" },
      body,
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(String(response.status));
    process.stdout.write(await response.text());
  } catch {
    process.stdout.write(JSON.stringify(fallback));
  }
});
`;

/**
 * Arguments that give Codex the hooks for one run, without writing to the user's Codex folder.
 * `--dangerously-bypass-hook-trust` is Codex's documented switch for hooks that the starting
 * program vets itself; without it Codex skips hooks nobody has reviewed in its own screen.
 */
export const codexHookArguments = (hookCommand: string): ReadonlyArray<string> => {
  const group = `[{matcher=".*", hooks=[{type="command", command=${JSON.stringify(hookCommand)}, timeout=90}]}]`;
  return [
    "--dangerously-bypass-hook-trust",
    "-c",
    `hooks.PreToolUse=${group}`,
    "-c",
    `hooks.PostToolUse=${group}`,
  ];
};
