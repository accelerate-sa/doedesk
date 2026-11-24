import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Maps a hash of assistant text with sealed values restored to the text as the model wrote it.
 * The client resends its history with the real values in it; this puts the stand-ins back,
 * including those of values too short to search for. It holds no real value.
 */
export class Restorations {
  readonly #byHash = new Map<string, string>();
  readonly #filePath: string | undefined;
  readonly #maxEntries: number;
  #saveTimer: NodeJS.Timeout | undefined;

  constructor(filePath?: string, maxEntries = 8000) {
    this.#filePath = filePath;
    this.#maxEntries = maxEntries;
    if (filePath === undefined) return;
    try {
      const stored = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as Record<string, string>;
      for (const [hash, masked] of Object.entries(stored)) this.#byHash.set(hash, masked);
    } catch {
      // Nothing kept yet, or unreadable: history restored before this start is not re-masked.
    }
  }

  static #hash(text: string): string {
    return NodeCrypto.createHash("sha256").update(text).digest("base64");
  }

  /** Keeps the model's own wording of a text that was shown with sealed values restored. */
  record(restored: string, masked: string): void {
    if (restored === masked) return;
    this.#byHash.set(Restorations.#hash(restored), masked);
    while (this.#byHash.size > this.#maxEntries) {
      const oldest = this.#byHash.keys().next().value;
      if (oldest === undefined) break;
      this.#byHash.delete(oldest);
    }
    if (this.#filePath === undefined || this.#saveTimer !== undefined) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.flush();
    }, 250);
    this.#saveTimer.unref();
  }

  /** The model's own wording of a text it was shown restored, when this is one. */
  masked(text: string): string | undefined {
    return this.#byHash.size === 0 ? undefined : this.#byHash.get(Restorations.#hash(text));
  }

  flush(): void {
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
    }
    if (this.#filePath === undefined) return;
    NodeFS.mkdirSync(NodePath.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    NodeFS.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.#byHash)), {
      mode: 0o600,
    });
    NodeFS.renameSync(temporary, this.#filePath);
  }
}
