import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Tells which names are files of a folder an agent works in. */
export interface WorkspaceFiles {
  /** The names, of those given, that are such files: a path under a folder, or a bare file name. */
  readonly find: (names: ReadonlyArray<string>) => Promise<ReadonlySet<string>>;
  /** Files came or went in a way the caller knows of: the folders are read again when next asked. */
  readonly forget: () => void;
}

const MAX_LISTED = 20_000;
const MAX_DEPTH = 8;
/** A listing this old is read again when a name is not in it: the agent may have made the file. */
const STALE_AFTER_MS = 5_000;
const SKIPPED_FOLDERS = new Set(["node_modules", ".git"]);

/** Every file name under a folder, read level by level and bounded, so a huge tree costs little. */
const listFileNames = async (root: string): Promise<ReadonlySet<string>> => {
  const names = new Set<string>();
  let level = [root];
  for (let depth = 0; depth <= MAX_DEPTH && level.length > 0 && names.size < MAX_LISTED; depth++) {
    const next: Array<string> = [];
    for (const folder of level) {
      const entries = await NodeFSP.readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIPPED_FOLDERS.has(entry.name)) next.push(NodePath.join(folder, entry.name));
        } else if (names.size < MAX_LISTED) {
          names.add(entry.name);
        }
      }
    }
    level = next;
  }
  return names;
};

const isFile = (path: string): Promise<boolean> =>
  NodeFSP.stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  );

/**
 * Looks names up in the folders agents were started in. Nothing is read until a detector reports
 * a span shaped like a file name, which is rare; a folder's listing is then kept for a few seconds.
 */
export const makeWorkspaceFiles = (
  roots: () => ReadonlyArray<string>,
  now: () => number = Date.now,
): WorkspaceFiles => {
  const listings = new Map<string, { readonly at: number; readonly names: ReadonlySet<string> }>();

  const listed = async (root: string, name: string): Promise<boolean> => {
    const current = listings.get(root);
    if (current?.names.has(name) === true) return true;
    if (current !== undefined && now() - current.at < STALE_AFTER_MS) return false;
    const names = await listFileNames(root);
    listings.set(root, { at: now(), names });
    return names.has(name);
  };

  const found = async (name: string, folders: ReadonlyArray<string>): Promise<boolean> => {
    if (NodePath.isAbsolute(name)) {
      return (
        folders.some((root) => !NodePath.relative(root, name).startsWith("..")) && isFile(name)
      );
    }
    for (const root of folders) {
      const path = NodePath.resolve(root, name);
      if (NodePath.relative(root, path).startsWith("..")) continue;
      if (await isFile(path)) return true;
      if (!name.includes("/") && (await listed(root, name))) return true;
    }
    return false;
  };

  return {
    find: async (names) => {
      const folders = roots();
      for (const root of listings.keys()) if (!folders.includes(root)) listings.delete(root);
      const files = new Set<string>();
      if (folders.length === 0) return files;
      for (const name of names) if (await found(name, folders)) files.add(name);
      return files;
    },
    forget: () => listings.clear(),
  };
};
