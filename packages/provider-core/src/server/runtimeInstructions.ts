import type { ProviderAdapterV2RuntimePolicy } from "./ProviderAdapter.ts";

/** Session-invariant; harnesses with a native system-prompt append can carry it once per session. */
export const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
Link each PR you create, take over, or push to: link_pull_request, or link_pull_requests for several, full URL, every stack layer, as your next call. Host tools don't link for you. If linking fails, say so. Skip PRs you only read or review and PRs named only as background. Call watch_pull_request when asked to monitor or babysit, or when work you were asked to do, such as a merge, still waits on checks or reviews, even after an earlier unwatch. Finish any needed branch update and push first, then watch and end your turn. Otherwise act now or hand back. Delegated children never watch, even if the brief says babysit. After PR work, a child's last line is: PR <full URL>, head <SHA>, checks and reviews <state>. Links and watches persist across pushes. For PR waits, no sleep, loops, gh --watch, Monitor or ScheduleWakeup. Before handback, call unwatch_pull_request on any PR you watch. When pull_request_* tools are listed, use them, not gh or cafe, to read, list, open, edit, review, reply on, close, or merge PRs, and ci_logs and ci_rerun for their checks. pull_request_create links for you.
If available, call link_issue for each issue you take on or file, even via CLI; skip issues you only read.
</pull_request_linking>`;

const privacyStandIns = (restoredIn: string) => `<doedesk_privacy>
Stand-ins like \`[PERSON_…]\` and \`[ID_…]\` are deliberate: DoeDesk replaces private data before requests leave this machine and restores real values locally ${restoredIn} Use stand-ins verbatim; nothing needs decoding. The person reads your reply with the real values in place, so never call a stand-in a placeholder or offer to add the real value. Never re-read a file in another form (\`od\`, \`xxd\`, hex, base64, or separated characters) to see past a stand-in: doing so can send the user's private data to the AI provider. Files on disk hold the real values. When a question turns on a property of masked values (an ID number that starts with 1 is a Saudi citizen's and with 2 a resident's iqama; whether two rows hold the same number), do not answer that it cannot be told: run a command that prints only a count or a yes or no per row, never the values.
</doedesk_privacy>`;

/** For an agent whose requests the privacy gateway masks. Session-invariant while masking lasts. */
export const PRIVACY_STAND_IN_INSTRUCTIONS = privacyStandIns(
  "in your commands, written files, and replies.",
);

// A sealed value is never restored in a tool call (docs/internals/sealed-documents.md).
const PRIVACY_STAND_IN_INSTRUCTIONS_WITH_SEALED = privacyStandIns(
  "in your commands, written files, and replies; sealed-file values only in your replies and files finished with `fill_sealed`.",
);

/** The note for a masked agent. `sealedValues`: stand-ins for a sealed file's values can reach it. */
export const privacyStandInInstructions = (sealedValues: boolean): string =>
  sealedValues ? PRIVACY_STAND_IN_INSTRUCTIONS_WITH_SEALED : PRIVACY_STAND_IN_INSTRUCTIONS;

/** Files named for one sealed folder, or outside any, before the note gives a count instead. */
const SEALED_FILES_LISTED = 30;
/** Files named in one note, whatever the folders. */
const SEALED_FILES_NAMED = 90;

interface SealedFileNote {
  readonly handle: string;
  readonly name: string;
  /** Where the file was, as the agent knew the path. */
  readonly path?: string | undefined;
  /** Kept sealed with no text yet, so nothing can be asked about it. */
  readonly unread?: boolean | undefined;
}

/**
 * For any agent in a folder that has sealed files, sent with each turn's prompt because files are
 * sealed and unsealed between turns. Empty when nothing is sealed. A sealed folder is named with
 * its files below it; one with many files is named with their count and how to list them.
 */
/** A label that is a handle and a file type, and no name: `DOC_3.txt`. */
const NAMELESS = /^DOC_\d+(\.[a-z0-9]{1,8})?$/u;

export function buildSealedFilesInstructions(sealed: {
  readonly files: ReadonlyArray<SealedFileNote>;
  /** Sealed folders, as the agent knows their paths: every file in one is sealed as it arrives. */
  readonly folders?: ReadonlyArray<string> | undefined;
  /** A worker is connected, so `ask_documents` and `list_sealed` are offered. */
  readonly askOffered: boolean;
}): string {
  const folders = (sealed.folders ?? []).map((folder) => folder.replace(/\/+$/, ""));
  if (sealed.files.length === 0 && folders.length === 0) return "";
  const folderOf = (file: SealedFileNote) =>
    folders.find((folder) => file.path?.startsWith(`${folder}/`) === true);
  const line = (file: SealedFileNote, folder?: string) => {
    // A file told by its handle and type alone: the person chose not to send its name.
    const type = NAMELESS.exec(file.name);
    const name =
      type === null || !file.name.startsWith(file.handle)
        ? folderLabel(file.name)
        : `a ${type[1] === undefined ? "" : `${type[1]} `}file, its name not shown to you`;
    const was = folderPath(
      folder === undefined ? (file.path ?? "") : (file.path ?? "").slice(folder.length + 1),
    );
    return `${folder === undefined ? "" : "  "}- ${file.handle}: ${name}${was === "" || was === name || was === file.name ? "" : ` (${folder === undefined ? "was at" : "at"} ${was})`}${file.unread === true ? " (cannot be asked about yet)" : ""}`;
  };
  const howToList = (folder?: string) =>
    sealed.askOffered
      ? ` Call the \`list_sealed\` tool${folder === undefined ? "" : ` with \`folder\` set to "${folderPath(folder)}"`} for each file's name and handle.`
      : "";
  let named = 0;
  const loose = sealed.files.filter((file) => folderOf(file) === undefined);
  const listedLoose = loose.slice(0, SEALED_FILES_LISTED);
  named += listedLoose.length;
  const lines = listedLoose.map((file) => line(file));
  if (loose.length > listedLoose.length) {
    lines.push(`- Not listed: ${loose.length - listedLoose.length} more.${howToList()}`);
  }
  for (const folder of folders) {
    const inFolder = sealed.files.filter((file) => folderOf(file) === folder);
    const label = `- Sealed folder ${folderPath(folder)}/`;
    const rule =
      "every file in it is sealed, and so is any file put there later; write nothing into it";
    if (inFolder.length > SEALED_FILES_LISTED || named + inFolder.length > SEALED_FILES_NAMED) {
      lines.push(
        `${label} (${rule}): ${inFolder.length} sealed files, not listed here.${howToList(folder)}`,
      );
      continue;
    }
    named += inFolder.length;
    lines.push(
      `${label} (${rule})${inFolder.length === 0 ? ": no file in it now." : ":"}`,
      ...inFolder.map((file) => line(file, folder)),
    );
  }
  return [
    "<doedesk_sealed_files>",
    "The person sealed these files on purpose. DoeDesk moved each one out of the folder and keeps it encrypted, so it is not missing, lost or deleted:",
    ...lines,
    sealed.askOffered
      ? "To use a sealed file, call the `ask_documents` tool with its handle; if your tools load on demand, load it by that exact name. It answers questions about the file and computes over its values."
      : "No worker is connected to read sealed files: tell the person to connect one in Settings, under Privacy.",
    "Never ask the person for a plain copy, an upload or to unseal it, never bring it back from Git or any other copy, and never try to read DoeDesk's stored copy. A command or program cannot read a sealed file: when a task needs that, say the file is sealed and what you can do instead.",
    "A value from a sealed file comes back as a stand-in such as [AMOUNT_K2M4P]. In your reply, write it as it is: the person sees the real value there.",
    "A file is different. A stand-in written into a file in the folder stays a stand-in: the person opens the file and reads [AMOUNT_K2M4P]. Make every file that is to hold sealed values, such as a summary, a letter, a table or a report, with the `fill_sealed` tool, which gives the person a finished copy with the real values in it.",
    "</doedesk_sealed_files>",
  ].join("\n");
}

/** Omit model and effort when the harness manages them dynamically. */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  /** False when the session's system prompt already carries the linking instructions. */
  readonly pullRequestLinking?: boolean;
  /** Adds the folder list of a multi-folder thread. */
  readonly runtimePolicy?: Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace"> | undefined;
  /** The privacy gateway masks this agent's requests: say what its stand-ins are. */
  readonly privacyMasking?: boolean;
  /** A worker reads sealed files here, so some stand-ins are never restored in a command. */
  readonly sealedValues?: boolean;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in DoeDesk through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images, video, and audio using Markdown image syntax with absolute file paths. Link every other file you cite or produce by its absolute path, as in [http.ts:42](/abs/path/http.ts:42), so the user can open it in DoeDesk's files viewer.</runtime_info>`;
  const workspace =
    runtime.runtimePolicy === undefined ? "" : buildWorkspaceInstructions(runtime.runtimePolicy);
  return [
    runtimeInfo,
    ...(runtime.pullRequestLinking === false ? [] : [PULL_REQUEST_LINKING_INSTRUCTIONS]),
    ...(workspace === "" ? [] : [workspace]),
    ...(runtime.privacyMasking === true
      ? [privacyStandInInstructions(runtime.sealedValues === true)]
      : []),
  ].join("\n\n");
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

// Codex truncates context entries over 4,000 bytes, and this block is sent as its own entry.
const WORKSPACE_INSTRUCTIONS_MAX_BYTES = 3_600;
const FOLDER_NAME_MAX_LENGTH = 64;
// Control characters and Unicode line separators would let a name or path add lines.
const LINE_BREAKING = /[\p{Cc}\p{Zl}\p{Zp}]/gu;
const textEncoder = new TextEncoder();

const byteLength = (value: string) => textEncoder.encode(value).length;

/** Names come from users and disk; keep each one a short label that cannot close the block. */
function folderLabel(name: string): string {
  const label = Array.from(
    name.replaceAll(LINE_BREAKING, " ").replaceAll(/[<>`]/g, " ").replaceAll(/\s+/g, " ").trim(),
  );
  if (label.length === 0) return "folder";
  return label.length > FOLDER_NAME_MAX_LENGTH
    ? `${label.slice(0, FOLDER_NAME_MAX_LENGTH - 1).join("")}…`
    : label.join("");
}

const folderPath = (value: string) =>
  value.replaceAll(LINE_BREAKING, "?").replaceAll("<", "‹").replaceAll(">", "›");

/** Lists a multi-folder thread's folders. Empty for single-folder threads, so their text is unchanged. */
export function buildWorkspaceInstructions(
  runtimePolicy: Pick<ProviderAdapterV2RuntimePolicy, "cwd" | "workspace">,
): string {
  const workspace = runtimePolicy.workspace;
  if (workspace === undefined || workspace.folders.length === 0) return "";
  const head = [
    "<workspace_folders>",
    "This project spans several folders. Each Git repository has its own history and branches: run Git commands inside the repository you change, and commit each one separately.",
    ...(runtimePolicy.cwd === null
      ? []
      : [`- Your working directory: ${folderPath(runtimePolicy.cwd)}`]),
  ];
  const tail = ["</workspace_folders>"];
  const entries = workspace.folders.map(
    (folder) =>
      `- ${folderLabel(folder.name)} (${folder.isGitRepository ? "Git repository" : "folder"}): ${folderPath(folder.path)}`,
  );
  // Reserve room for the line that counts folders left out.
  let budget = WORKSPACE_INSTRUCTIONS_MAX_BYTES - byteLength([...head, ...tail].join("\n")) - 32;
  const shown: Array<string> = [];
  for (const entry of entries) {
    budget -= byteLength(entry) + 1;
    if (budget < 0) break;
    shown.push(entry);
  }
  const hidden = entries.length - shown.length;
  return [...head, ...shown, ...(hidden > 0 ? [`- Not listed: ${hidden} more`] : []), ...tail].join(
    "\n",
  );
}
