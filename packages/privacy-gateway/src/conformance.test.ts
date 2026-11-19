import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

import { describe, expect, it } from "vite-plus/test";

import { loadLocalAuthority } from "./certificates.ts";
import { makeMaskingCore, type MaskingCore } from "./core.ts";
import {
  combineDetectors,
  type Detector,
  DetectorUnavailableError,
  patternDetector,
} from "./detect.ts";
import { type GatewayRecord, startGateway } from "./gateway.ts";
import {
  CLAUDE_UNCOVERED_ROUTES,
  makeClaudeHooks,
  maskClaudePrompt,
  readClaudeAttachment,
} from "./native/claude.ts";
import {
  CODEX_UNCOVERED_ROUTES,
  handleCodexHook,
  maskCodexPrompt,
  readCodexAttachment,
} from "./native/codex.ts";
import { Pseudonymizer } from "./pseudonymizer.ts";
import type { Reader } from "./reader.ts";
import { Vault } from "./vault.ts";

/**
 * One set of scenarios for every front end, judged by what leaves the computer. The gateway is
 * driven for real; the Claude and Codex harnesses call the real front-end code and apply the
 * client behaviour measured on 18 November 2026 (Claude Code 2.1.327, Codex 0.169.0).
 */
const PLANTED = {
  name: "Marta Kowalczyk",
  id: "44051401359",
  phone: "+48 601 234 567",
  iban: "PL61109010140000071219812874",
} as const;
const ALL_PLANTED = `${PLANTED.name}, ${PLANTED.id}, ${PLANTED.phone}, ${PLANTED.iban}`;
const PLANTED_VALUES = Object.values(PLANTED);
const STAND_IN = /\[(?:PERSON|ID|PHONE|IBAN)_[A-HJ-NP-Z2-9]{5}\]/g;

const plantedDetector: Detector = {
  detect: (texts) =>
    Promise.resolve(
      texts.map((text) =>
        (
          [
            [PLANTED.name, "PERSON"],
            [PLANTED.id, "ID"],
            [PLANTED.phone, "PHONE"],
            [PLANTED.iban, "IBAN"],
          ] as const
        ).flatMap(([value, kind]) => {
          const spans = [];
          for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
            spans.push({ start: at, end: at + value.length, kind });
          }
          return spans;
        }),
      ),
    ),
};
const plantedReader: Reader = {
  read: (_bytes, mediaType) => Promise.resolve(`(${mediaType}) Signed by ${ALL_PLANTED}.`),
};

interface FrontEnd extends AsyncDisposable {
  readonly vault: Vault;
  readonly activity: ReadonlyArray<GatewayRecord>;
  /** What leaves when the user sends a message, with attachments if any. */
  readonly userMessage: (
    text: string,
    attachments?: ReadonlyArray<{ readonly kind: "image" | "file"; readonly mediaType: string }>,
  ) => Promise<string>;
  /** What leaves when a tool on this computer hands its result back. */
  readonly toolResult: (output: string, failed?: boolean) => Promise<string>;
  /** What a tool on this computer is given when the model calls it with stand-ins. */
  readonly toolCall: (tool: "write" | "shell" | "edit", input: string) => Promise<string>;
  /** What the user reads when the model writes stand-ins. */
  readonly modelText: (text: string) => Promise<string>;
  /** What leaves when the client adds text of its own, such as the working folder's path. */
  readonly clientContext: (text: string) => Promise<string>;
}

const makeCore = (
  detector: Detector,
): { core: MaskingCore; vault: Vault; activity: Array<GatewayRecord> } => {
  const vault = new Vault();
  const activity: Array<GatewayRecord> = [];
  const core = makeMaskingCore({
    pseudonymizer: new Pseudonymizer(vault, combineDetectors([patternDetector, detector])),
    reader: () => plantedReader,
    onRecord: (record) => activity.push(record),
  });
  return { core, vault, activity };
};

const makeGatewayFrontEnd = async (detector: Detector): Promise<FrontEnd> => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doedesk-conformance-"));
  let reply: unknown = { content: [{ type: "text", text: "ok" }] };
  const received: Array<string> = [];
  const upstream = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const vault = new Vault();
  const activity: Array<GatewayRecord> = [];
  const authority = loadLocalAuthority(directory);
  const gateway = await startGateway({
    authority,
    reader: () => plantedReader,
    pseudonymizer: new Pseudonymizer(vault, combineDetectors([patternDetector, detector])),
    upstream: () => ({ host: "127.0.0.1", port: address.port, tls: false }),
    onRecord: (record) => activity.push(record),
  });
  const trusted = NodeFS.readFileSync(authority.certificatePath, "utf8");
  /** Sends one request as Claude Code would and returns what arrived and what came back. */
  const send = (body: unknown): Promise<{ arrived: string; returned: string }> =>
    new Promise((resolve, reject) => {
      const connect = NodeHttp.request({
        host: "127.0.0.1",
        port: gateway.port,
        method: "CONNECT",
        path: "api.anthropic.com:443",
      });
      connect.on("error", reject);
      connect.on("connect", (_response, socket) => {
        const secure = NodeTls.connect({ socket, servername: "api.anthropic.com", ca: trusted });
        const payload = JSON.stringify(body);
        const before = received.length;
        const request = NodeHttps.request(
          {
            createConnection: () => secure,
            host: "api.anthropic.com",
            method: "POST",
            path: "/v1/messages",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            },
          },
          (response) => {
            let returned = "";
            response.on("data", (chunk) => (returned += chunk));
            response.on("end", () => {
              secure.destroy();
              // A refused request never arrives: what the client reads is the refusal.
              resolve({ arrived: received[before] ?? returned, returned });
            });
          },
        );
        request.on("error", reject);
        request.end(payload);
      });
      connect.end();
    });
  const user = (content: unknown) => ({ model: "m", messages: [{ role: "user", content }] });
  return {
    vault,
    activity,
    userMessage: async (text, attachments = []) =>
      (
        await send(
          user([
            { type: "text", text },
            ...attachments.map((attachment) =>
              attachment.kind === "image"
                ? {
                    type: "image",
                    source: { type: "base64", media_type: attachment.mediaType, data: "aGk=" },
                  }
                : {
                    type: "document",
                    source: { type: "base64", media_type: attachment.mediaType, data: "aGk=" },
                  },
            ),
          ]),
        )
      ).arrived,
    toolResult: async (output, failed = false) =>
      (
        await send(
          user([{ type: "tool_result", tool_use_id: "t1", content: output, is_error: failed }]),
        )
      ).arrived,
    toolCall: async (_tool, input) => {
      reply = { content: [{ type: "tool_use", id: "t1", name: "Tool", input: { value: input } }] };
      const { returned } = await send(user("go"));
      const parsed = JSON.parse(returned) as { content: [{ input: { value: string } }] };
      return parsed.content[0].input.value;
    },
    modelText: async (text) => {
      reply = { content: [{ type: "text", text }] };
      const { returned } = await send(user("go"));
      return (JSON.parse(returned) as { content: [{ text: string }] }).content[0].text;
    },
    clientContext: async (text) =>
      (
        await send({
          model: "m",
          system: [{ type: "text", text }],
          messages: [{ role: "user", content: "go" }],
        })
      ).arrived,
    [Symbol.asyncDispose]: async () => {
      await gateway.close();
      await new Promise((resolve) => upstream.close(resolve));
      NodeFS.rmSync(directory, { recursive: true, force: true });
    },
  };
};

const attachmentsText = async (
  read: (
    attachment: { bytes: Buffer; mediaType: string },
    kind: "image" | "file",
  ) => Promise<string>,
  attachments: ReadonlyArray<{ readonly kind: "image" | "file"; readonly mediaType: string }>,
): Promise<string> =>
  (
    await Promise.all(
      attachments.map((attachment) =>
        read({ bytes: Buffer.from("hi"), mediaType: attachment.mediaType }, attachment.kind),
      ),
    )
  ).join("\n");

const makeClaudeFrontEnd = (detector: Detector): FrontEnd => {
  const { core, vault, activity } = makeCore(detector);
  const hooks = makeClaudeHooks(core);
  const pre = hooks.PreToolUse[0]?.hooks[0];
  const post = hooks.PostToolUse[0]?.hooks[0];
  if (pre === undefined || post === undefined) throw new Error("hooks missing");
  /** The text of a file on this computer, as Claude Code's Edit check sees it. */
  const fileOnDisk = `Phone: ${PLANTED.phone}\n`;
  return {
    vault,
    activity,
    userMessage: async (text, attachments = []) =>
      [
        await maskClaudePrompt(core, text),
        await attachmentsText(
          (attachment, kind) => readClaudeAttachment(core, attachment, kind),
          attachments,
        ),
      ].join("\n"),
    toolResult: async (output, failed = false) => {
      // Measured: a failed tool's message goes to the model as it is. PostToolUse does not run,
      // and PostToolUseFailure cannot replace it.
      if (failed) return output;
      const answer = await post({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_response: { stdout: output, stderr: "", interrupted: false, isImage: false },
      });
      return JSON.stringify(
        (answer.hookSpecificOutput as { updatedToolOutput: unknown }).updatedToolOutput,
      );
    },
    toolCall: async (tool, input) => {
      // Measured: Claude Code checks an Edit against the file before PreToolUse runs.
      if (tool === "edit" && !fileOnDisk.includes(input)) {
        return "String to replace not found in file.";
      }
      const answer = await pre({
        hook_event_name: "PreToolUse",
        tool_name: tool,
        tool_input: { value: input },
      });
      return (answer.hookSpecificOutput as { updatedInput: { value: string } }).updatedInput.value;
    },
    modelText: (text) => Promise.resolve(core.restore(text)),
    // Measured: no hook or setting changes what Claude Code writes into its own prompt.
    clientContext: (text) => Promise.resolve(text),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
};

const makeCodexFrontEnd = (detector: Detector): FrontEnd => {
  const { core, vault, activity } = makeCore(detector);
  return {
    vault,
    activity,
    userMessage: async (text, attachments = []) =>
      [
        await maskCodexPrompt(core, text),
        await attachmentsText(
          (attachment, kind) => readCodexAttachment(core, attachment, kind),
          attachments,
        ),
      ].join("\n"),
    // Documented and measured: Codex runs PostToolUse after a failed command too.
    toolResult: async (output) => {
      const answer = await handleCodexHook(core, {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_response: output,
      });
      return String(answer.reason);
    },
    toolCall: async (tool, input) => {
      const answer = await handleCodexHook(core, {
        hook_event_name: "PreToolUse",
        tool_name: tool === "shell" ? "Bash" : "apply_patch",
        tool_input: { command: input },
      });
      return (answer.hookSpecificOutput as { updatedInput: { command: string } }).updatedInput
        .command;
    },
    modelText: (text) => Promise.resolve(core.restore(text)),
    // Measured: no hook changes the instructions Codex builds by itself.
    clientContext: (text) => Promise.resolve(text),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
};

const FRONT_ENDS = {
  gateway: makeGatewayFrontEnd,
  "claude-native": (detector: Detector) => Promise.resolve(makeClaudeFrontEnd(detector)),
  "codex-native": (detector: Detector) => Promise.resolve(makeCodexFrontEnd(detector)),
} as const;
type FrontEndName = keyof typeof FRONT_ENDS;

const leaked = (text: string): ReadonlyArray<string> =>
  PLANTED_VALUES.filter((value) => text.includes(value));

/** Each scenario returns the planted values that leaked, or the real values that went missing. */
const SCENARIOS: Readonly<Record<string, (frontEnd: FrontEnd) => Promise<ReadonlyArray<string>>>> =
  {
    "the user's message": async (frontEnd) =>
      leaked(await frontEnd.userMessage(`Write to ${ALL_PLANTED}.`)),
    "an attached PDF and image": async (frontEnd) => {
      const left = await frontEnd.userMessage("See attached.", [
        { kind: "file", mediaType: "application/pdf" },
        { kind: "image", mediaType: "image/png" },
      ]);
      const replaced = left.includes("Text read from an attached file by DoeDesk");
      return [...leaked(left), ...(replaced ? [] : ["attachment not replaced by its text"])];
    },
    "a file the agent reads": async (frontEnd) =>
      leaked(await frontEnd.toolResult(`Client: ${ALL_PLANTED}\n`)),
    "a file name in a listing": async (frontEnd) =>
      leaked(await frontEnd.toolResult(`./${PLANTED.name} contract.txt\n`)),
    "a search result": async (frontEnd) =>
      leaked(await frontEnd.toolResult(`notes.txt:3:Phone: ${PLANTED.phone}\n`)),
    "an MCP tool's result": async (frontEnd) =>
      leaked(await frontEnd.toolResult(`Office record: ${ALL_PLANTED}`)),
    "a second turn": async (frontEnd) => {
      await frontEnd.userMessage(`My client is ${PLANTED.name}.`);
      return leaked(await frontEnd.userMessage(`Call ${PLANTED.name} on ${PLANTED.phone}.`));
    },
    "the output of a failed command": async (frontEnd) =>
      leaked(
        await frontEnd.toolResult(`cat: ${PLANTED.name}.txt: No such file or directory`, true),
      ),
    "a path the client adds by itself": async (frontEnd) => {
      await frontEnd.userMessage(`My client is ${PLANTED.name}.`);
      return leaked(await frontEnd.clientContext(`Working folder: /work/${PLANTED.name}`));
    },
    "the agent writes real values to a file": async (frontEnd) => {
      const left = await frontEnd.userMessage(`Client: ${ALL_PLANTED}`);
      const written = await frontEnd.toolCall("write", (left.match(STAND_IN) ?? []).join(" "));
      return PLANTED_VALUES.filter((value) => !written.includes(value));
    },
    "the agent runs a command that needs real values": async (frontEnd) => {
      const left = await frontEnd.userMessage(`Client: ${PLANTED.name}`);
      const command = await frontEnd.toolCall("shell", `grep -c '${left.match(STAND_IN)?.[0]}' f`);
      return command.includes(PLANTED.name) ? [] : [PLANTED.name];
    },
    "the agent edits text that holds a value": async (frontEnd) => {
      const left = await frontEnd.userMessage(`Phone: ${PLANTED.phone}`);
      const edited = await frontEnd.toolCall("edit", `Phone: ${left.match(STAND_IN)?.[0]}`);
      return edited.includes(PLANTED.phone) ? [] : [PLANTED.phone];
    },
    "what the user reads": async (frontEnd) => {
      const left = await frontEnd.userMessage(`Client: ${ALL_PLANTED}`);
      const read = await frontEnd.modelText(
        `The client is ${(left.match(STAND_IN) ?? []).join(", ")}.`,
      );
      return PLANTED_VALUES.filter((value) => !read.includes(value));
    },
  };

/** The scenarios each front end fails today. Empty means the front end may carry a session. */
const KNOWN_FAILURES: Readonly<Record<FrontEndName, ReadonlyArray<string>>> = {
  gateway: [],
  "claude-native": [
    "the output of a failed command",
    "a path the client adds by itself",
    "the agent edits text that holds a value",
  ],
  "codex-native": ["a path the client adds by itself"],
};

describe.each(Object.keys(FRONT_ENDS) as Array<FrontEndName>)("conformance: %s", (name) => {
  it("fails exactly the scenarios recorded for it", async () => {
    const failed: Array<string> = [];
    for (const [scenario, run] of Object.entries(SCENARIOS)) {
      await using frontEnd = await FRONT_ENDS[name](plantedDetector);
      if ((await run(frontEnd)).length > 0) failed.push(scenario);
    }
    expect(failed).toEqual(KNOWN_FAILURES[name]);
  });

  it("sends nothing and says why when detection is unavailable", async () => {
    const unavailable: Detector = {
      detect: () => Promise.reject(new DetectorUnavailableError("Detection is offline.")),
    };
    await using frontEnd = await FRONT_ENDS[name](unavailable);
    const outcome = await frontEnd.userMessage(`Client: ${PLANTED.name}`).catch(String);
    expect(leaked(outcome)).toEqual([]);
    expect(outcome).toContain(
      "It could not be checked for personal data, so nothing left this device. Detection is offline.",
    );
    expect(frontEnd.activity.at(-1)?.outcome).toBe("refused");
  });

  it("records what it masked", async () => {
    await using frontEnd = await FRONT_ENDS[name](plantedDetector);
    await frontEnd.userMessage(`Client: ${ALL_PLANTED}`);
    expect(frontEnd.activity.at(-1)).toMatchObject({ outcome: "masked", masked: 4 });
    expect(
      frontEnd.vault
        .entries()
        .map((entry) => entry.kind)
        .toSorted(),
    ).toEqual(expect.arrayContaining(["IBAN", "ID", "PERSON", "PHONE"]));
  });
});

describe("conformance: which front ends may carry a session", () => {
  it("lists a reason for every native front end that fails a scenario", () => {
    expect(CLAUDE_UNCOVERED_ROUTES.length).toBeGreaterThan(0);
    expect(CODEX_UNCOVERED_ROUTES.length).toBeGreaterThan(0);
    expect(KNOWN_FAILURES.gateway).toEqual([]);
  });
});
