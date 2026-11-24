import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

/**
 * What a project's folder holds of a file that reached DoeDesk as a copy: attached in a browser,
 * pasted, or dropped, it comes with its bytes and its name and no path. Sealing the copy alone
 * would leave the file itself where an agent can open it.
 */
export interface FolderCopies {
  /** The one file with the same bytes and the same name: the file itself, sealed where it lies. */
  readonly original?: string;
  /** Files that stay readable when only the copy is sealed: the same bytes, or the same name. */
  readonly readable: ReadonlyArray<string>;
  /** False when the folder was too large to look through: a file may be there unseen. */
  readonly complete: boolean;
}

const MAX_FILES = 20_000;
const MAX_DEPTH = 12;
const MAX_NAMED = 20;
const SKIPPED_FOLDERS = new Set(["node_modules", ".git"]);

const digestOf = async (filePath: string): Promise<string | undefined> => {
  const hash = NodeCrypto.createHash("sha256");
  try {
    await NodeStreamPromises.pipeline(NodeFS.createReadStream(filePath), hash);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
};

/**
 * Looks through `root` for the file a copy was made from. Only a file of the same size is read,
 * so a large folder costs its listing and little more.
 */
export const findFolderCopies = async (
  root: string,
  copy: { readonly name: string; readonly sha256: string; readonly size: number },
  /** Whether two names are the same file name on this computer. */
  sameName: (left: string, right: string) => boolean,
): Promise<FolderCopies> => {
  const sameBytes: Array<string> = [];
  const named: Array<string> = [];
  let seen = 0;
  let complete = true;
  let level = [root];
  for (let depth = 0; level.length > 0; depth += 1) {
    if (depth > MAX_DEPTH) {
      complete = false;
      break;
    }
    const next: Array<string> = [];
    for (const folder of level) {
      const entries = await NodeFSP.readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const entryPath = NodePath.join(folder, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_FOLDERS.has(entry.name)) next.push(entryPath);
          continue;
        }
        if (!entry.isFile()) continue;
        seen += 1;
        if (seen > MAX_FILES) {
          complete = false;
          continue;
        }
        const size = await NodeFSP.stat(entryPath).then(
          (stats) => stats.size,
          () => -1,
        );
        if (size === copy.size && (await digestOf(entryPath)) === copy.sha256) {
          sameBytes.push(entryPath);
        } else if (sameName(entry.name, copy.name)) {
          named.push(entryPath);
        }
      }
    }
    level = next;
  }
  const [only] = sameBytes;
  if (
    complete &&
    only !== undefined &&
    sameBytes.length === 1 &&
    sameName(NodePath.basename(only), copy.name)
  ) {
    // A file of the same name over other bytes is another file: it is not what was attached.
    return { original: only, readable: [], complete };
  }
  return { readable: [...sameBytes, ...named].toSorted().slice(0, MAX_NAMED), complete };
};
