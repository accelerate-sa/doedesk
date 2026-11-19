import { type MaskingCore, MaskingRefusedError, type MaskingRoute } from "../core.ts";

/**
 * Masking for Claude Code through the Agent SDK's hooks, with nothing rewritten on the network.
 * Not used for a user's sessions yet: the routes in `CLAUDE_UNCOVERED_ROUTES` reach no hook, so
 * Claude stays on the gateway until that list is empty.
 */
const FRONT_END = "Claude Code hooks";

const route = (what: string): MaskingRoute => ({ frontEnd: FRONT_END, what });

/**
 * Tools whose input is read by a model or by the AI company, not run on this computer. The
 * stand-ins the model wrote stay in place: restoring them would send the real values out.
 */
const INPUT_STAYS_MASKED = new Set(["Agent", "Task", "WebSearch", "ToolSearch"]);

/**
 * Tools the session must not have: Claude Code sends what they fetch to a model in a request
 * of its own, which no hook sees.
 */
export const CLAUDE_NATIVE_DISALLOWED_TOOLS: ReadonlyArray<string> = ["WebFetch"];

/**
 * Documented Claude Code switches for content the client adds by itself and no hook can mask.
 * `CLAUDE_CODE_DISABLE_AUTO_MEMORY` keeps the memory folder's path, which holds the account
 * name of this computer, out of the system prompt.
 */
export const CLAUDE_NATIVE_ENVIRONMENT: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
};

/**
 * Routes on which content reaches Anthropic unmasked with this front end, each measured on
 * Claude Code 2.1.327 with the Agent SDK 0.3.321 on 18 November 2026. See
 * docs/operations/provider-connections.md for the measurements.
 */
export const CLAUDE_UNCOVERED_ROUTES: ReadonlyArray<{
  readonly route: string;
  readonly why: string;
}> = [
  {
    route: "failed tool output",
    why: "PostToolUseFailure can add context but cannot replace the message of a failed tool, so an error text that quotes a file name or a restored value reaches the model as it is.",
  },
  {
    route: "edit of text that holds a stand-in",
    why: "Claude Code checks an Edit against the file before PreToolUse runs, so an edit whose old text names a stand-in is rejected and the real value is never restored.",
  },
  {
    route: "working folder and home folder paths",
    why: "Claude Code writes the resolved working folder and the home folder into the system prompt and a request field by itself. No hook or setting changes them, and a symbolic link is resolved.",
  },
  {
    route: "account email",
    why: "Claude Code adds the signed-in account's email address to the first message by itself.",
  },
];

export interface ClaudeHookInput {
  readonly hook_event_name: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly tool_response?: unknown;
}

type ClaudeHookOutput = Record<string, unknown>;

const isImageResult = (
  value: unknown,
): value is { type: "image"; file: { base64: string; type?: string } } =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === "image" &&
  typeof (value as { file?: { base64?: unknown } }).file?.base64 === "string";

/** Every string replaced by `note`, keeping the shape the tool promised. */
const blank = (value: unknown, note: string): unknown =>
  typeof value === "string"
    ? note
    : Array.isArray(value)
      ? value.map((child) => blank(child, note))
      : typeof value === "object" && value !== null
        ? Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              key,
              key === "type" ? child : blank(child, note),
            ]),
          )
        : value;

/** The hook callbacks to pass as the Agent SDK's `hooks` option. */
export const makeClaudeHooks = (core: MaskingCore) => {
  const preToolUse = (input: ClaudeHookInput): Promise<ClaudeHookOutput> => {
    const tool = input.tool_name ?? "";
    if (INPUT_STAYS_MASKED.has(tool) || input.tool_input === undefined) return Promise.resolve({});
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: core.restore(input.tool_input),
      },
    });
  };

  const postToolUse = async (input: ClaudeHookInput): Promise<ClaudeHookOutput> => {
    const what = `tool result: ${input.tool_name ?? "tool"}`;
    const replace = (updatedToolOutput: unknown): ClaudeHookOutput => ({
      hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput },
    });
    try {
      const response = input.tool_response;
      if (isImageResult(response)) {
        const text = await core.readAttachment(
          {
            bytes: Buffer.from(response.file.base64, "base64"),
            mediaType: response.file.type ?? "image/png",
          },
          "image",
          route(what),
        );
        const lines = text.split("\n").length;
        return replace({
          type: "text",
          file: { filePath: "", content: text, numLines: lines, startLine: 1, totalLines: lines },
        });
      }
      return replace(await core.maskNew(response, route(what)));
    } catch (cause) {
      const note = cause instanceof MaskingRefusedError ? cause.message : String(cause);
      return replace(blank(input.tool_response, `[${note}]`));
    }
  };

  const callback = (handler: (input: ClaudeHookInput) => Promise<ClaudeHookOutput>) => [
    { hooks: [handler] },
  ];
  return { PreToolUse: callback(preToolUse), PostToolUse: callback(postToolUse) };
};

/** Masks what the user typed before the app hands it to the Agent SDK. */
export const maskClaudePrompt = (core: MaskingCore, text: string): Promise<string> =>
  core.maskNew(text, route("user message"));

/** The text the app sends in place of an image or a file the user attached. */
export const readClaudeAttachment = (
  core: MaskingCore,
  attachment: { readonly bytes: Buffer; readonly mediaType: string },
  kind: "image" | "file",
): Promise<string> => core.readAttachment(attachment, kind, route(`attached ${kind}`));
