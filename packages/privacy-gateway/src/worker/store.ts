import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { sanitizeIngestedText } from "./sanitize.ts";
import {
  type ClearAnswer,
  emptyLedger,
  type FilledSpan,
  type SealedValue,
  type SealedValueSource,
  type SealedValueSourceInput,
  type SealLedger,
} from "./seal.ts";
import { Tripwire } from "./tripwire.ts";

/**
 * Sealed documents: outside every workspace, named by handle, encrypted on disk. The key lies
 * beside the files, so this stops a tool that goes looking and finds no text. It does not stop a
 * program written to decrypt; the operating system's sandbox does.
 */
export interface SealedDocumentInfo {
  /**
   * `DOC_1`, `DOC_2`, ... in the order added. A handle is never given to another file: one
   * unsealed and sealed again where it was takes its own back.
   */
  readonly handle: string;
  /** The file's name when it was added, for the person. A provider is told `label`, never this. */
  readonly name: string;
  /**
   * The name with the values a detector found in it replaced by stand-ins: what a provider is
   * told the file is called. Unset until it could be checked; the handle and the file type are
   * sent until then (`neutralLabel` in `sealedLabels.ts`).
   */
  readonly label?: string;
  /** `origin` checked in the same way, each folder of the path apart. */
  readonly originLabel?: string;
  /** The person chose to send the handle and the file type alone for this file. */
  readonly neutralLabel?: true;
  readonly mediaType: string;
  readonly characters: number;
  readonly lines: number;
  readonly addedAt: string;
  readonly sha256: string;
  /** Where the file was moved out of when it was sealed. Unset when it was sealed from a copy. */
  readonly origin?: string;
  /** When that file was last changed, in milliseconds: it is put back with the same date. */
  readonly modifiedAt?: number;
  /**
   * Set while the file is kept but its text is not: it is sealed like any other, and nothing can
   * be asked of it until it has been read.
   */
  readonly unread?: SealedUnread;
}

/**
 * Why a sealed file has no text yet. `service`: the reading service did not answer, so reading
 * may succeed later as the file is. The others need another kind of file, or a smaller one.
 */
export interface SealedUnread {
  readonly kind: "unsupported" | "noText" | "tooLarge" | "service";
  /** Written for the person. Never quotes the file. */
  readonly message: string;
}

/** What is kept of a sealed file for the worker: its text, or the reason there is none yet. */
export type SealedContent =
  | { readonly text: string; readonly mediaType: string }
  | { readonly unread: SealedUnread };

/** The file as it was before sealing, kept so that unsealing can put it back. */
export interface SealedOriginal {
  readonly bytes: Buffer;
  readonly path: string;
  /** When the file was last changed, in milliseconds. */
  readonly modifiedAt?: number;
}

export interface SealedOutputInfo {
  readonly name: string;
  readonly characters: number;
  readonly writtenAt: string;
  /** Sealed values that were put into it. */
  readonly filled: number;
  /** Its draft is kept, so the model can revise it. Unset on files finished before drafts were. */
  readonly hasTemplate?: boolean;
  /** Values put into it whose source is kept, for the person to check. */
  readonly verifiedSpans?: number;
}

/** One sealed value of a finished file, where it stands and where it came from. */
export interface SealedOutputSpan
  extends Omit<FilledSpan, "source">, Omit<SealedValueSource, "inputs"> {
  /** The name of the document, or of each document, for the person. */
  readonly documentName: string;
  readonly inputs?: ReadonlyArray<SealedValueSourceInput & { readonly documentName: string }>;
}

/** A file of a sealed folder that stays readable there, and why. */
export interface SealedFolderLeftFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** Written for the person. */
  readonly message: string;
}

/** A subfolder whose files are sealed, now and as they arrive. */
export interface SealedFolderInfo {
  /** The project it was sealed for. The store names a project's files by a digest of this. */
  readonly project: string;
  readonly path: string;
  readonly sealedAt: string;
  /** Files that could not be sealed. One is tried again only once it has changed. */
  readonly left: ReadonlyArray<SealedFolderLeftFile>;
  /** `path` as a provider is told it, checked like a file's name. Unset until it was checked. */
  readonly pathLabel?: string;
  /** The person chose the handle and the file type alone for every file sealed in this folder. */
  readonly neutralLabels?: true;
}

/** What an agent asked of sealed documents in one turn, and what it was told in clear. */
export interface SealedTurnActivity {
  /**
   * The documents asked, in the order first asked, each with the name it had then and with
   * `label`, what the provider was told it is called. A record made before labels has none.
   */
  readonly asked: ReadonlyArray<{
    readonly handle: string;
    readonly name: string;
    readonly label?: string;
  }>;
  readonly answers: ReadonlyArray<RecordedClearAnswer>;
}

/** Activity of turns still running, by the thread that asked, and of ended turns, by run. */
export interface SealedTurnActivities {
  readonly open: Record<string, SealedTurnActivity>;
  readonly kept: Record<string, SealedTurnActivity>;
}

/** A file that was sealed and then put back in its folder, where an agent can open it again. */
interface PutBackFile {
  readonly path: string;
  /** A turn has started in the project since the file came back. */
  readonly turn?: true;
}

/** As many files put back as are remembered for a project. The oldest are forgotten first. */
const PUT_BACK_KEPT = 512;

/** As many unsealed files as keep their handle for a project. The oldest lose it first. */
const FORMER_HANDLES_KEPT = 512;

interface ProjectIndex {
  next: number;
  documents: Array<SealedDocumentInfo>;
  outputs: Array<SealedOutputInfo>;
  folders?: Array<SealedFolderInfo>;
  putBack?: Array<PutBackFile>;
  /**
   * The handle each unsealed file had, by where it was. Sealed again there, it is the same file
   * to a chat that knew it, whether or not it changed meanwhile.
   */
  formerHandles?: Array<{ readonly path: string; readonly handle: string }>;
}

/** Not a project's digest, so it never meets one: holds what is kept across projects. */
const SHARED_KEY = "shared";

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".xml",
  ".yaml",
  ".yml",
  ".log",
  ".text",
  ".rtf",
]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

const decodeEntities = (text: string): string =>
  text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    )
    .replace(/&amp;/g, "&");

/** One file out of a ZIP archive, by name. Enough for a .docx; no encryption, no ZIP64. */
const unzipEntry = (archive: Buffer, wanted: string): Buffer | undefined => {
  let end = archive.length - 22;
  while (end >= 0 && archive.readUInt32LE(end) !== 0x06054b50) end -= 1;
  if (end < 0) return undefined;
  const entries = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50)
      return undefined;
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString("utf8", offset + 46, offset + 46 + nameLength);
    if (name === wanted) {
      const dataStart =
        localOffset +
        30 +
        archive.readUInt16LE(localOffset + 26) +
        archive.readUInt16LE(localOffset + 28);
      const data = archive.subarray(dataStart, dataStart + compressedSize);
      return method === 0 ? data : method === 8 ? NodeZlib.inflateRawSync(data) : undefined;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
};

/** A Word run and its properties; a run's own text is never a tag. */
const WORD_RUN = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
const RUN_PROPERTIES = /<w:rPr\b[^>]*>([\s\S]*?)<\/w:rPr>/;
/** Hidden text, text hidden on the web, or text of size zero; `w:val="false"` turns one off. */
const HIDDEN_RUN = /<w:(?:vanish|webHidden)\b(?![^>]*w:val="(?:0|false|off)")|<w:sz w:val="0"/;

const docxText = (bytes: Buffer): string | undefined => {
  const xml = unzipEntry(bytes, "word/document.xml")?.toString("utf8");
  if (xml === undefined) return undefined;
  // Text Word does not show is not part of the document a person reads, so a model is not given it.
  const visible = xml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(WORD_RUN, (run) => (HIDDEN_RUN.test(RUN_PROPERTIES.exec(run)?.[1] ?? "") ? "" : run));
  return sanitizeIngestedText(
    decodeEntities(
      visible
        .replace(/<w:tab\b[^>]*\/>/g, "\t")
        .replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n")
        .replace(/<\/w:tc>/g, "\t")
        .replace(/<\/w:(?:p|tr)>/g, "\n")
        .replace(/<[^>]+>/g, ""),
    ),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

/** Whether `localText` reads a file of this name: decided by its extension alone. */
export const readLocally = (name: string): boolean => {
  const extension = NodePath.extname(name).toLowerCase();
  return extension === ".docx" || TEXT_EXTENSIONS.has(extension) || HTML_EXTENSIONS.has(extension);
};

/**
 * The text of a file that can be read on this machine with nothing sent anywhere: plain text
 * formats, HTML and Word documents. Undefined for anything else (a PDF or an image needs the
 * reading service, which is the caller's decision to use).
 */
export const localText = (bytes: Buffer, name: string): string | undefined => {
  const extension = NodePath.extname(name).toLowerCase();
  if (extension === ".docx") return docxText(bytes);
  if (!TEXT_EXTENSIONS.has(extension) && !HTML_EXTENSIONS.has(extension)) return undefined;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/^﻿/, "");
  if (text.includes("\u0000")) return undefined;
  if (!HTML_EXTENSIONS.has(extension)) return sanitizeIngestedText(text);
  return sanitizeIngestedText(
    decodeEntities(
      withoutHiddenElements(
        text.replace(/<!--[\s\S]*?(?:-->|$)/g, "").replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ""),
      )
        .replace(/<\/(?:p|div|tr|li|h[1-6])>|<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, ""),
    ),
  ).replace(/\n{3,}/g, "\n\n");
};

const HTML_VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);
const HIDING_CSS =
  /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?:[^.\d]|$)|font-size\s*:\s*0(?:px|pt|em|rem|%)?(?:[;\s"']|$)/i;

/** Whether a tag's attributes hide it: `hidden`, or a style a browser shows nothing of. */
const hidesElement = (attributes: string): boolean => {
  const style = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
  if (HIDING_CSS.test(style?.[1] ?? style?.[2] ?? "")) return true;
  // Quoted values blanked first, so `title="not hidden"` does not count.
  return /(?:^|\s)hidden(?=[\s=/]|$)/i.test(attributes.replace(/"[^"]*"|'[^']*'/g, '""'));
};

/**
 * HTML without the elements a browser does not show, nested ones included. An element left open
 * is cut to the next closing tag, as far as it plausibly reaches, and not to the end of the file.
 */
const withoutHiddenElements = (html: string): string => {
  let kept = "";
  let from = 0;
  const opening = /<([a-z][a-z0-9-]*)\b([^>]*)>/gi;
  for (let found = opening.exec(html); found !== null; found = opening.exec(html)) {
    const [whole, name = "", attributes = ""] = found;
    if (!hidesElement(attributes)) continue;
    let end = found.index + whole.length;
    const tag = name.toLowerCase();
    if (!HTML_VOID.has(tag) && !whole.endsWith("/>")) {
      const same = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
      same.lastIndex = end;
      let depth = 1;
      for (let next = same.exec(html); next !== null; next = same.exec(html)) {
        if (next[1] === "" && next[0].endsWith("/>")) continue;
        depth += next[1] === "/" ? -1 : 1;
        if (depth === 0) {
          end = next.index + next[0].length;
          break;
        }
      }
      if (depth > 0) {
        const close = html.indexOf("</", end);
        end = close === -1 ? html.length : close;
      }
    }
    kept += html.slice(from, found.index);
    from = end;
    opening.lastIndex = end;
  }
  return kept + html.slice(from);
};

/** The record keeps this many answers a project; the oldest go first. */
const MAX_CLEAR_ANSWERS = 2_000;

/** An answer given in clear, with the name of the file it was about when it was given. */
export interface RecordedClearAnswer extends ClearAnswer {
  readonly document: string;
  /**
   * The worker that answered: a hosted region (`sa`, `eu`, `global`) or `custom:<host>`. Unset on
   * answers recorded before routes were; an entry is never rewritten.
   */
  readonly route?: string;
}

/**
 * A worker's reply for one field of a sealed document, kept across sessions so the same question
 * is not sent to the worker twice. `key` is a digest of the question; `raw` is what the worker
 * wrote, which is checked against the document again each time it is used.
 */
export interface KeptAnswer {
  readonly key: string;
  readonly raw: unknown;
  readonly unquotedChoice: boolean;
}

/** Replies kept for one document: the oldest go first, by count and then by size. */
const MAX_KEPT_ANSWERS = 256;
const MAX_KEPT_ANSWER_CHARS = 256_000;

interface KeptAnswers {
  /** The worker that gave them, and a digest of the text they are about. Another of either: none. */
  readonly worker: string;
  readonly text: string;
  readonly answers: ReadonlyArray<KeptAnswer>;
}

const projectKey = (project: string): string =>
  NodeCrypto.createHash("sha256").update(project).digest("hex").slice(0, 24);

const safeName = (name: string): string =>
  NodePath.basename(name)
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .slice(0, 120) || "output.txt";

/** The files of a project that its listing is read from: its documents, counts and answers. */
const LISTED_FILES: ReadonlySet<string> = new Set(["index", "ledger", "clear"]);

export class SealedStore {
  readonly #directory: string;
  readonly #key: Buffer;
  readonly #onListingChange: (() => void) | undefined;
  /** A digest of each listed file as last written, so writing the same again tells no one. */
  readonly #listed = new Map<string, string>();
  /** Sealed text of every project, to notice it in what is sent. */
  readonly tripwire = new Tripwire();

  /** `onListingChange` is told whenever what some project's listing shows has changed. */
  constructor(directory: string, onListingChange?: () => void) {
    this.#directory = directory;
    this.#onListingChange = onListingChange;
    NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyPath = NodePath.join(directory, "key");
    let key: Buffer;
    try {
      key = NodeFS.readFileSync(keyPath);
    } catch {
      key = NodeCrypto.randomBytes(32);
      NodeFS.writeFileSync(keyPath, key, { mode: 0o600 });
    }
    this.#key = key;
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const info of this.#index(entry.name).documents) {
        const text = this.#readText(entry.name, `docs/${info.handle}`);
        if (text !== undefined) this.tripwire.add(`${entry.name}/${info.handle}`, text);
      }
    }
  }

  #path(key: string, file: string): string {
    return NodePath.join(this.#directory, key, `${file}.bin`);
  }

  #write(key: string, file: string, bytes: Buffer): void {
    const path = this.#path(key, file);
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    const iv = NodeCrypto.randomBytes(12);
    const cipher = NodeCrypto.createCipheriv("aes-256-gcm", this.#key, iv);
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const temporary = `${path}.${process.pid}.tmp`;
    NodeFS.writeFileSync(temporary, Buffer.concat([iv, cipher.getAuthTag(), body]), {
      mode: 0o600,
    });
    NodeFS.renameSync(temporary, path);
    if (!LISTED_FILES.has(file)) return;
    const written = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (this.#listed.get(path) === written) return;
    this.#listed.set(path, written);
    this.#onListingChange?.();
  }

  #read(key: string, file: string): Buffer | undefined {
    let raw: Buffer;
    try {
      raw = NodeFS.readFileSync(this.#path(key, file));
    } catch {
      return undefined;
    }
    try {
      const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", this.#key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    } catch {
      return undefined;
    }
  }

  #readText(key: string, file: string): string | undefined {
    return this.#read(key, file)?.toString("utf8");
  }

  #readJson<T>(key: string, file: string, fallback: () => T): T {
    const text = this.#readText(key, file);
    if (text === undefined) return fallback();
    try {
      return JSON.parse(text) as T;
    } catch {
      return fallback();
    }
  }

  #index(key: string): ProjectIndex {
    return this.#readJson<ProjectIndex>(key, "index", () => ({
      next: 1,
      documents: [],
      outputs: [],
    }));
  }

  #saveIndex(key: string, index: ProjectIndex): void {
    this.#write(key, "index", Buffer.from(JSON.stringify(index), "utf8"));
  }

  /**
   * Encrypts a file into the store a piece at a time, so one of any size is kept without being
   * held in memory. Resolves to the digest and size of what it read.
   */
  async #encryptFile(
    source: string,
    destination: string,
  ): Promise<{ readonly sha256: string; readonly bytes: number }> {
    NodeFS.mkdirSync(NodePath.dirname(destination), { recursive: true, mode: 0o700 });
    const iv = NodeCrypto.randomBytes(12);
    const cipher = NodeCrypto.createCipheriv("aes-256-gcm", this.#key, iv);
    const digest = NodeCrypto.createHash("sha256");
    let bytes = 0;
    const output = await NodeFSP.open(destination, "w", 0o600);
    try {
      // The tag is known only at the end: its place is left empty and filled then.
      await output.write(Buffer.concat([iv, Buffer.alloc(16)]));
      for await (const chunk of NodeFS.createReadStream(source, { highWaterMark: 1 << 20 })) {
        const piece = chunk as Buffer;
        digest.update(piece);
        bytes += piece.length;
        await output.write(cipher.update(piece));
      }
      await output.write(cipher.final());
      await output.write(cipher.getAuthTag(), 0, 16, 12);
    } finally {
      await output.close();
    }
    return { sha256: digest.digest("hex"), bytes };
  }

  /**
   * Decrypts a kept file a piece at a time, into `destination` when one is given. Resolves to the
   * digest of what came out, or undefined when the kept file is missing or was altered.
   */
  async #decryptFile(source: string, destination?: string): Promise<string | undefined> {
    let input: NodeFSP.FileHandle;
    try {
      input = await NodeFSP.open(source, "r");
    } catch {
      return undefined;
    }
    let output: NodeFSP.FileHandle | undefined;
    try {
      if (destination !== undefined) output = await NodeFSP.open(destination, "wx", 0o600);
      const header = Buffer.alloc(28);
      if ((await input.read(header, 0, 28, 0)).bytesRead !== 28) return undefined;
      const decipher = NodeCrypto.createDecipheriv(
        "aes-256-gcm",
        this.#key,
        header.subarray(0, 12),
      );
      decipher.setAuthTag(header.subarray(12, 28));
      const digest = NodeCrypto.createHash("sha256");
      const chunk = Buffer.alloc(1 << 20);
      for (let position = 28; ;) {
        const { bytesRead } = await input.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const piece = decipher.update(chunk.subarray(0, bytesRead));
        digest.update(piece);
        await output?.write(piece);
      }
      const last = decipher.final();
      digest.update(last);
      await output?.write(last);
      return digest.digest("hex");
    } catch {
      return undefined;
    } finally {
      await input.close();
      await output?.close();
    }
  }

  /**
   * Adds a document's text. The same text added twice keeps its first handle, unless the two were
   * moved out of different places: each of those is put back on its own.
   */
  add(
    project: string,
    name: string,
    text: string,
    mediaType: string,
    original?: SealedOriginal,
  ): SealedDocumentInfo {
    return this.keep(project, name, { text, mediaType }, original);
  }

  /**
   * Keeps a file: its text for the worker, or the reason it has none yet, and with `original` the
   * file itself so it can be put back. `replaces` names the document a newer version of the same
   * file takes the place of, which keeps its handle.
   */
  keep(
    project: string,
    name: string,
    content: SealedContent,
    original?: SealedOriginal,
    replaces?: string,
  ): SealedDocumentInfo {
    const key = projectKey(project);
    const sha256 = NodeCrypto.createHash("sha256")
      .update("text" in content ? content.text : (original?.bytes ?? ""))
      .digest("hex");
    return this.#commit(key, name, content, sha256, original, replaces, (handle) => {
      if (original !== undefined) this.#write(key, `orig/${handle}`, original.bytes);
    });
  }

  /**
   * Keeps a file too large to hold in memory, which for that reason has no text. `unchanged` is
   * asked once the kept copy has been read back whole: a file still being written is not taken.
   * Resolves to undefined when it was not kept.
   */
  async keepLarge(
    project: string,
    filePath: string,
    unread: SealedUnread,
    unchanged: () => boolean,
    replaces?: string,
    modifiedAt?: number,
  ): Promise<SealedDocumentInfo | undefined> {
    const key = projectKey(project);
    const pending = this.#path(key, `orig/pending-${NodeCrypto.randomUUID()}`);
    try {
      const kept = await this.#encryptFile(filePath, pending);
      if ((await this.#decryptFile(pending)) !== kept.sha256 || !unchanged()) return undefined;
      return this.#commit(
        key,
        NodePath.basename(filePath),
        { unread },
        kept.sha256,
        { path: filePath, ...(modifiedAt === undefined ? {} : { modifiedAt }) },
        replaces,
        (handle) => NodeFS.renameSync(pending, this.#path(key, `orig/${handle}`)),
      );
    } finally {
      NodeFS.rmSync(pending, { force: true });
    }
  }

  #commit(
    key: string,
    name: string,
    content: SealedContent,
    sha256: string,
    from: Pick<SealedOriginal, "path" | "modifiedAt"> | undefined,
    replaces: string | undefined,
    writeOriginal: (handle: string) => void,
  ): SealedDocumentInfo {
    const origin = from?.path;
    const modifiedAt = from?.modifiedAt === undefined ? {} : { modifiedAt: from.modifiedAt };
    const index = this.#index(key);
    const replaced =
      replaces === undefined
        ? undefined
        : index.documents.find((document) => document.handle === replaces);
    const existing =
      replaced !== undefined || !("text" in content)
        ? undefined
        : index.documents.find(
            (document) =>
              document.sha256 === sha256 &&
              document.unread === undefined &&
              (origin === undefined || document.origin === undefined || document.origin === origin),
          );
    if (existing !== undefined) {
      if (origin === undefined) return existing;
      const moved = { ...existing, origin, ...modifiedAt };
      writeOriginal(existing.handle);
      this.#saveIndex(key, {
        ...index,
        documents: index.documents.map((document) => (document === existing ? moved : document)),
      });
      return moved;
    }
    const former =
      replaced !== undefined || origin === undefined
        ? undefined
        : (index.formerHandles ?? []).find(
            (was) =>
              was.path === origin &&
              !index.documents.some((document) => document.handle === was.handle),
          )?.handle;
    const info: SealedDocumentInfo = {
      handle: replaced?.handle ?? former ?? `DOC_${index.next}`,
      name: NodePath.basename(name),
      mediaType: "text" in content ? content.mediaType : "application/octet-stream",
      characters: "text" in content ? content.text.length : 0,
      lines: "text" in content ? content.text.split("\n").length : 0,
      addedAt: new Date().toISOString(),
      sha256,
      ...(origin === undefined ? {} : { origin }),
      ...modifiedAt,
      ...("text" in content ? {} : { unread: content.unread }),
      // A file saved again at the same path is the same file to a provider: same label and choice.
      ...(replaced?.label === undefined || replaced.origin !== origin
        ? {}
        : { label: replaced.label }),
      ...(replaced?.originLabel === undefined || replaced.origin !== origin
        ? {}
        : { originLabel: replaced.originLabel }),
      ...(replaced?.neutralLabel === true ? { neutralLabel: true as const } : {}),
    };
    // The file itself first: a text without its file could not be put back.
    writeOriginal(info.handle);
    this.tripwire.remove(`${key}/${info.handle}`);
    NodeFS.rmSync(this.#path(key, `answers/${info.handle}`), { force: true });
    if ("text" in content) {
      this.#write(key, `docs/${info.handle}`, Buffer.from(content.text, "utf8"));
      this.tripwire.add(`${key}/${info.handle}`, content.text);
    } else {
      NodeFS.rmSync(this.#path(key, `docs/${info.handle}`), { force: true });
    }
    this.#saveIndex(
      key,
      replaced === undefined
        ? {
            ...index,
            next: former === undefined ? index.next + 1 : index.next,
            documents: [...index.documents, info],
          }
        : {
            ...index,
            documents: index.documents.map((document) => (document === replaced ? info : document)),
          },
    );
    return info;
  }

  /** Gives a kept file the text that was read from it later. False when no such file is kept. */
  setText(project: string, handle: string, text: string, mediaType: string): boolean {
    const key = projectKey(project);
    const index = this.#index(key);
    const before = index.documents.find((document) => document.handle === handle);
    if (before === undefined) return false;
    const { unread: _unread, ...kept } = before;
    const info: SealedDocumentInfo = {
      ...kept,
      mediaType,
      characters: text.length,
      lines: text.split("\n").length,
    };
    this.#write(key, `docs/${handle}`, Buffer.from(text, "utf8"));
    this.tripwire.add(`${key}/${handle}`, text);
    this.#saveIndex(key, {
      ...index,
      documents: index.documents.map((document) => (document === before ? info : document)),
    });
    return true;
  }

  /** Records what a provider is told each of these files is called, once it has been checked. */
  setLabels(
    project: string,
    labels: ReadonlyArray<{
      readonly handle: string;
      readonly label: string;
      readonly originLabel?: string;
    }>,
  ): void {
    if (labels.length === 0) return;
    const key = projectKey(project);
    const index = this.#index(key);
    const byHandle = new Map(labels.map((entry) => [entry.handle, entry]));
    this.#saveIndex(key, {
      ...index,
      documents: index.documents.map((document) => {
        const checked = byHandle.get(document.handle);
        if (checked === undefined) return document;
        const { originLabel: _before, ...rest } = document;
        return {
          ...rest,
          label: checked.label,
          ...(checked.originLabel === undefined ? {} : { originLabel: checked.originLabel }),
        };
      }),
    });
  }

  /** Records the person's choice for one file. False when no such file is kept. */
  setNeutralLabel(project: string, handle: string, neutral: boolean): boolean {
    const key = projectKey(project);
    const index = this.#index(key);
    if (!index.documents.some((document) => document.handle === handle)) return false;
    this.#saveIndex(key, {
      ...index,
      documents: index.documents.map((document) => {
        if (document.handle !== handle) return document;
        const { neutralLabel: _before, ...rest } = document;
        return neutral ? { ...rest, neutralLabel: true as const } : rest;
      }),
    });
    return true;
  }

  /** Records why a kept file still has no text, after another try at reading it. */
  setUnread(project: string, handle: string, unread: SealedUnread): void {
    const key = projectKey(project);
    const index = this.#index(key);
    this.#saveIndex(key, {
      ...index,
      documents: index.documents.map((document) =>
        document.handle === handle && document.unread !== undefined
          ? { ...document, unread }
          : document,
      ),
    });
  }

  /**
   * Decrypts the file a sealed document was moved out of into a temporary file of the store, for
   * the caller to copy where it belongs and then delete. Undefined when none is kept, or the kept
   * copy cannot be read.
   */
  async decryptOriginal(
    project: string,
    handle: string,
  ): Promise<{ readonly path: string; readonly sha256: string } | undefined> {
    const info = this.list(project).find((document) => document.handle === handle);
    if (info?.origin === undefined) return undefined;
    const path = NodePath.join(this.#directory, `restore-${NodeCrypto.randomUUID()}.tmp`);
    const sha256 = await this.#decryptFile(this.#path(projectKey(project), `orig/${handle}`), path);
    if (sha256 !== undefined) return { path, sha256 };
    NodeFS.rmSync(path, { force: true });
    return undefined;
  }

  /** The file a sealed document was moved out of, as it was. Undefined when none was kept. */
  original(project: string, handle: string): SealedOriginal | undefined {
    const info = this.list(project).find((document) => document.handle === handle);
    if (info?.origin === undefined) return undefined;
    const bytes = this.#read(projectKey(project), `orig/${handle}`);
    return bytes === undefined ? undefined : { bytes, path: info.origin };
  }

  /** The kept file's bytes, unless it is larger than `maxBytes`: such a file is never read whole. */
  originalWithin(project: string, handle: string, maxBytes: number): Buffer | undefined {
    try {
      const { size } = NodeFS.statSync(this.#path(projectKey(project), `orig/${handle}`));
      // The kept file is the bytes after a nonce and a tag of 28 bytes.
      if (size - 28 > maxBytes) return undefined;
    } catch {
      return undefined;
    }
    return this.original(project, handle)?.bytes;
  }

  list(project: string): ReadonlyArray<SealedDocumentInfo> {
    return this.#index(projectKey(project)).documents;
  }

  read(project: string, handle: string): string | undefined {
    if (!/^DOC_\d+$/.test(handle)) return undefined;
    return this.#readText(projectKey(project), `docs/${handle}`);
  }

  remove(project: string, handle: string): boolean {
    const key = projectKey(project);
    const index = this.#index(key);
    const removed = index.documents.find((document) => document.handle === handle);
    if (removed === undefined) return false;
    NodeFS.rmSync(this.#path(key, `docs/${handle}`), { force: true });
    NodeFS.rmSync(this.#path(key, `orig/${handle}`), { force: true });
    // Nothing the worker said of it outlives the sealed copy, whatever is sealed there next.
    NodeFS.rmSync(this.#path(key, `answers/${handle}`), { force: true });
    const { origin } = removed;
    this.#saveIndex(key, {
      ...index,
      documents: index.documents.filter((document) => document.handle !== handle),
      ...(origin === undefined
        ? {}
        : {
            formerHandles: [
              ...(index.formerHandles ?? []).filter(
                (was) => was.path !== origin && was.handle !== handle,
              ),
              { path: origin, handle },
            ].slice(-FORMER_HANDLES_KEPT),
          }),
    });
    this.tripwire.remove(`${key}/${handle}`);
    return true;
  }

  /** The sealed subfolders of a project. */
  folders(project: string): ReadonlyArray<SealedFolderInfo> {
    return this.#index(projectKey(project)).folders ?? [];
  }

  saveFolders(project: string, folders: ReadonlyArray<SealedFolderInfo>): void {
    const key = projectKey(project);
    this.#saveIndex(key, { ...this.#index(key), folders: [...folders] });
  }

  /** Files were unsealed back into the folder: from now on a turn can open them. */
  notePutBack(project: string, paths: ReadonlyArray<string>): void {
    if (paths.length === 0) return;
    const key = projectKey(project);
    const index = this.#index(key);
    const back = new Set(paths);
    const putBack = [
      ...(index.putBack ?? []).filter((file) => !back.has(file.path)),
      ...paths.map((path) => ({ path })),
    ].slice(-PUT_BACK_KEPT);
    this.#saveIndex(key, { ...index, putBack });
  }

  /** A turn starts in the project: it can open every file put back before now. */
  noteTurn(project: string): void {
    const key = projectKey(project);
    const index = this.#index(key);
    if (index.putBack === undefined || index.putBack.every((file) => file.turn === true)) return;
    const putBack = index.putBack.map((file): PutBackFile => ({ path: file.path, turn: true }));
    this.#saveIndex(key, { ...index, putBack });
  }

  /** The files put back that a turn has started beside since. */
  openedToTurns(project: string): ReadonlyArray<string> {
    const putBack = this.#index(projectKey(project)).putBack ?? [];
    return putBack.flatMap((file) => (file.turn === true ? [file.path] : []));
  }

  /** The sealed files of every project. */
  allDocuments(): ReadonlyArray<SealedDocumentInfo> {
    return NodeFS.readdirSync(this.#directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? this.#index(entry.name).documents : [],
    );
  }

  /** The sealed subfolders of every project, read when the store opens. */
  allFolders(): ReadonlyArray<SealedFolderInfo> {
    return NodeFS.readdirSync(this.#directory, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? (this.#index(entry.name).folders ?? []) : [],
    );
  }

  turnActivities(): SealedTurnActivities {
    const stored = this.#readJson<Partial<SealedTurnActivities>>(SHARED_KEY, "turns", () => ({}));
    return { open: stored.open ?? {}, kept: stored.kept ?? {} };
  }

  saveTurnActivities(activities: SealedTurnActivities): void {
    this.#write(SHARED_KEY, "turns", Buffer.from(JSON.stringify(activities), "utf8"));
  }

  ledger(project: string): SealLedger {
    // A ledger written before answers were counted has other fields: it starts again.
    return { ...emptyLedger(), ...this.#readJson(projectKey(project), "ledger", emptyLedger) };
  }

  saveLedger(project: string, ledger: SealLedger): void {
    this.#write(projectKey(project), "ledger", Buffer.from(JSON.stringify(ledger), "utf8"));
  }

  /**
   * Starts the count of clear answers again. The person's decision. The record of what was
   * answered stays.
   */
  resetLedger(project: string): void {
    this.saveLedger(project, emptyLedger());
  }

  /** Every answer the remote model was given in clear about this project's documents. */
  clearAnswers(project: string): ReadonlyArray<RecordedClearAnswer> {
    return this.#readJson<Array<RecordedClearAnswer>>(projectKey(project), "clear", () => []);
  }

  /**
   * Keeps the answers for the person and returns them as kept, each with its file's name and,
   * when it is known, the worker that gave it.
   */
  recordClearAnswers(
    project: string,
    answers: ReadonlyArray<ClearAnswer>,
    route: string | null = null,
  ): ReadonlyArray<RecordedClearAnswer> {
    if (answers.length === 0) return [];
    const names = new Map(this.list(project).map((info) => [info.handle, info.name]));
    const recorded = answers.map((answer) => ({
      ...answer,
      document: answer.handle
        .split(", ")
        .flatMap((handle) => names.get(handle) ?? [])
        .join(", "),
      ...(route === null ? {} : { route }),
    }));
    const all = [...this.clearAnswers(project), ...recorded];
    this.#write(
      projectKey(project),
      "clear",
      Buffer.from(JSON.stringify(all.slice(-MAX_CLEAR_ANSWERS)), "utf8"),
    );
    return recorded;
  }

  /**
   * The worker's replies kept for a document, when they came from this worker and are about this
   * text. Given a document's handle, never a name the caller chose.
   */
  keptAnswers(
    project: string,
    handle: string,
    worker: string,
    text: string,
  ): ReadonlyArray<KeptAnswer> {
    if (!/^DOC_\d+$/.test(handle)) return [];
    const kept = this.#readJson<KeptAnswers | null>(
      projectKey(project),
      `answers/${handle}`,
      () => null,
    );
    return kept !== null && kept.worker === worker && kept.text === text ? kept.answers : [];
  }

  /** Adds replies to those kept for a document, and drops the ones of another worker or text. */
  keepAnswers(
    project: string,
    handle: string,
    worker: string,
    text: string,
    answers: ReadonlyArray<KeptAnswer>,
  ): void {
    if (answers.length === 0 || !/^DOC_\d+$/.test(handle)) return;
    const added = new Set(answers.map((answer) => answer.key));
    let all = [
      ...this.keptAnswers(project, handle, worker, text).filter((answer) => !added.has(answer.key)),
      ...answers,
    ].slice(-MAX_KEPT_ANSWERS);
    let json = JSON.stringify({ worker, text, answers: all } satisfies KeptAnswers);
    while (json.length > MAX_KEPT_ANSWER_CHARS && all.length > 0) {
      all = all.slice(Math.ceil(all.length / 2));
      json = JSON.stringify({ worker, text, answers: all } satisfies KeptAnswers);
    }
    if (all.length === 0) return;
    this.#write(projectKey(project), `answers/${handle}`, Buffer.from(json, "utf8"));
  }

  /** Drops every kept reply, of every project: another worker answers from now on. */
  forgetAnswers(): void {
    for (const entry of NodeFS.readdirSync(this.#directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      NodeFS.rmSync(NodePath.join(this.#directory, entry.name, "answers"), {
        recursive: true,
        force: true,
      });
    }
  }

  values(project: string): Record<string, SealedValue> {
    return this.#readJson<Record<string, SealedValue>>(projectKey(project), "values", () => ({}));
  }

  mergeValues(project: string, values: Readonly<Record<string, SealedValue>>): void {
    if (Object.keys(values).length === 0) return;
    this.#write(
      projectKey(project),
      "values",
      Buffer.from(JSON.stringify({ ...this.values(project), ...values }), "utf8"),
    );
  }

  /** Keeps a finished file that holds sealed values, for the person to open. */
  writeOutput(
    project: string,
    name: string,
    text: string,
    filled: number,
    /** The text before sealed values were put in, as the model wrote it. */
    template: string,
    /** Where each value was put in `text`. Only those with a source are kept. */
    spans: ReadonlyArray<FilledSpan> = [],
  ): SealedOutputInfo {
    const key = projectKey(project);
    const index = this.#index(key);
    const traced = spans.filter((span) => span.source !== undefined);
    const info: SealedOutputInfo = {
      name: safeName(name),
      characters: text.length,
      writtenAt: new Date().toISOString(),
      filled,
      hasTemplate: true,
      verifiedSpans: traced.length,
    };
    this.#write(key, `out/${info.name}`, Buffer.from(text, "utf8"));
    this.#write(key, `out-tpl/${info.name}`, Buffer.from(template, "utf8"));
    this.#write(key, `out-prov/${info.name}`, Buffer.from(JSON.stringify(traced), "utf8"));
    this.#saveIndex(key, {
      ...index,
      outputs: [...(index.outputs ?? []).filter((output) => output.name !== info.name), info],
    });
    // A finished file read back would carry sealed values to the model, so the wording around
    // each value is watched too.
    this.tripwire.add(`${key}/out/${info.name}`, text, template);
    return info;
  }

  outputs(project: string): ReadonlyArray<SealedOutputInfo> {
    return this.#index(projectKey(project)).outputs ?? [];
  }

  readOutput(project: string, name: string): string | undefined {
    return this.#readText(projectKey(project), `out/${safeName(name)}`);
  }

  /** The draft a finished file was filled from, with stand-ins and markers. */
  readOutputTemplate(project: string, name: string): string | undefined {
    return this.#readText(projectKey(project), `out-tpl/${safeName(name)}`);
  }

  /**
   * Where each sealed value of a finished file came from, with the name each document has for
   * the person. Empty for a file finished before this was kept.
   */
  readOutputProvenance(project: string, name: string): ReadonlyArray<SealedOutputSpan> {
    const key = projectKey(project);
    const spans = this.#readJson<ReadonlyArray<FilledSpan>>(
      key,
      `out-prov/${safeName(name)}`,
      () => [],
    );
    const names = new Map(this.#index(key).documents.map((info) => [info.handle, info.name]));
    const documentName = (handles: string) =>
      handles
        .split(", ")
        .map((handle) => names.get(handle) ?? handle)
        .join(", ");
    return spans.flatMap(({ source, ...span }): ReadonlyArray<SealedOutputSpan> => {
      if (source === undefined) return [];
      const { inputs, ...from } = source;
      return [
        {
          ...span,
          ...from,
          documentName: documentName(source.handle),
          ...(inputs === undefined
            ? {}
            : {
                inputs: inputs.map((input) => ({
                  ...input,
                  documentName: documentName(input.handle),
                })),
              }),
        },
      ];
    });
  }
}
