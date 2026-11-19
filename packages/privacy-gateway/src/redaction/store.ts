import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** What was sent in place of one image or document, kept for the user to look at and download. */
export interface RedactionRecord {
  readonly id: string;
  readonly at: string;
  readonly kind: "image" | "file";
  /** `redacted`: the image with boxes. `text`: its masked text only. `withheld`: neither. */
  readonly outcome: "redacted" | "text" | "withheld";
  readonly hasImage: boolean;
  readonly hasText: boolean;
  readonly imageMediaType: string | null;
  readonly width: number | null;
  readonly height: number | null;
  /** Boxes over values, and boxes over what could not be read. */
  readonly valueBoxes: number;
  readonly unreadableBoxes: number;
  readonly reason: string | null;
}

export interface RedactionFile {
  readonly bytes: Buffer;
  readonly mediaType: string;
  readonly fileName: string;
}

export interface RedactionStoreOptions {
  /** Records older than this are deleted. */
  readonly maxAgeMs?: number;
  /** At most this many records are kept; the oldest go first. */
  readonly maxRecords?: number;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * The redacted images and masked texts of recent attachments, on this computer only: folder
 * 0700, files 0600, deleted after seven days or beyond two hundred records. The original file is
 * never written here; a record is named by a hash of it.
 */
export class RedactionStore {
  readonly #directory: string;
  readonly #maxAgeMs: number;
  readonly #maxRecords: number;

  constructor(directory: string, options: RedactionStoreOptions = {}) {
    this.#directory = directory;
    this.#maxAgeMs = options.maxAgeMs ?? 7 * DAY;
    this.#maxRecords = options.maxRecords ?? 200;
    this.prune();
  }

  save(input: {
    readonly original: Buffer;
    readonly kind: "image" | "file";
    readonly outcome: RedactionRecord["outcome"];
    readonly image?: { readonly bytes: Buffer; readonly mediaType: string } | undefined;
    readonly text?: string | undefined;
    readonly width?: number | undefined;
    readonly height?: number | undefined;
    readonly valueBoxes?: number | undefined;
    readonly unreadableBoxes?: number | undefined;
    readonly reason?: string | undefined;
  }): RedactionRecord {
    const id = NodeCrypto.createHash("sha256").update(input.original).digest("hex").slice(0, 24);
    NodeFS.mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    const record: RedactionRecord = {
      id,
      at: new Date().toISOString(),
      kind: input.kind,
      outcome: input.outcome,
      hasImage: input.image !== undefined,
      hasText: input.text !== undefined,
      imageMediaType: input.image?.mediaType ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      valueBoxes: input.valueBoxes ?? 0,
      unreadableBoxes: input.unreadableBoxes ?? 0,
      reason: input.reason ?? null,
    };
    // A later record for the same file replaces the earlier one whole.
    this.#remove(id);
    const write = (name: string, data: Buffer | string) => {
      const target = NodePath.join(this.#directory, name);
      const temporary = `${target}.${process.pid}.tmp`;
      NodeFS.writeFileSync(temporary, data, { mode: 0o600 });
      NodeFS.renameSync(temporary, target);
    };
    if (input.image !== undefined) write(`${id}.image`, input.image.bytes);
    if (input.text !== undefined) write(`${id}.txt`, input.text);
    write(`${id}.json`, JSON.stringify(record));
    this.prune();
    return record;
  }

  /** Newest first. */
  list(): ReadonlyArray<RedactionRecord> {
    let names: Array<string>;
    try {
      names = NodeFS.readdirSync(this.#directory);
    } catch {
      return [];
    }
    const records: Array<RedactionRecord> = [];
    for (const name of names) {
      if (!/^[0-9a-f]{24}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(
          NodeFS.readFileSync(NodePath.join(this.#directory, name), "utf8"),
        ) as RedactionRecord;
        if (typeof record.id === "string" && typeof record.at === "string") records.push(record);
      } catch {
        // A record that cannot be read is left for `prune` to age out.
      }
    }
    return records.toSorted((left, right) => right.at.localeCompare(left.at));
  }

  read(id: string, part: "image" | "text"): RedactionFile | undefined {
    if (!/^[0-9a-f]{24}$/.test(id)) return undefined;
    const record = this.list().find((entry) => entry.id === id);
    if (record === undefined) return undefined;
    try {
      if (part === "image" && record.hasImage) {
        const mediaType = record.imageMediaType ?? "image/png";
        return {
          bytes: NodeFS.readFileSync(NodePath.join(this.#directory, `${id}.image`)),
          mediaType,
          fileName: `redacted-${id.slice(0, 8)}.${mediaType === "image/jpeg" ? "jpg" : "png"}`,
        };
      }
      if (part === "text" && record.hasText) {
        return {
          bytes: NodeFS.readFileSync(NodePath.join(this.#directory, `${id}.txt`)),
          mediaType: "text/plain; charset=utf-8",
          fileName: `masked-text-${id.slice(0, 8)}.txt`,
        };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  clear(): void {
    for (const record of this.list()) this.#remove(record.id);
  }

  prune(): void {
    const records = this.list();
    const cutoff = Date.now() - this.#maxAgeMs;
    records.forEach((record, index) => {
      if (index >= this.#maxRecords || Date.parse(record.at) < cutoff) this.#remove(record.id);
    });
  }

  #remove(id: string): void {
    for (const suffix of ["json", "image", "txt"]) {
      NodeFS.rmSync(NodePath.join(this.#directory, `${id}.${suffix}`), { force: true });
    }
  }
}
