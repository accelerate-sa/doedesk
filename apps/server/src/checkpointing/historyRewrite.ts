const ESCAPES: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

/** A path as `git fast-export` prints it: bare, or in quotes with C escapes. */
const unquote = (printed: string): string =>
  printed.startsWith('"') && printed.endsWith('"') && printed.length > 1
    ? printed
        .slice(1, -1)
        .replace(/\\([0-7]{3}|.)/g, (_, escape: string) =>
          escape.length === 3
            ? String.fromCharCode(Number.parseInt(escape, 8))
            : (ESCAPES[escape] ?? escape),
        )
    : printed;

/**
 * Takes files out of a `git fast-export --no-data` stream and counts the entries removed. Text
 * is walked a byte per character, as `data` blocks give byte lengths. With `inCommit`, only
 * commits whose message it accepts change: a file there is then what the first parent holds.
 */
export const removePaths = (
  stream: string,
  relativePaths: ReadonlyArray<string>,
  inCommit?: (message: string) => boolean,
): { readonly stream: string; readonly removed: number } => {
  const bytes = Buffer.from(stream, "utf8").toString("latin1");
  const targets = new Set(
    relativePaths.map((relativePath) => Buffer.from(relativePath, "utf8").toString("latin1")),
  );
  const kept: Array<string> = [];
  let removed = 0;
  let at = 0;
  // A commit's message is its first data block, ahead of its files.
  let awaitingMessage = false;
  let changes = inCommit === undefined;
  while (at < bytes.length) {
    const end = bytes.indexOf("\n", at);
    const line = bytes.slice(at, end === -1 ? undefined : end);
    at = end === -1 ? bytes.length : end + 1;
    if (inCommit !== undefined && /^(?:commit|tag|reset|blob)(?: |$)/.test(line)) {
      awaitingMessage = line.startsWith("commit ");
      changes = false;
    }
    const printed = /^M [0-7]+ \S+ (.*)$/.exec(line)?.[1] ?? /^D (.*)$/.exec(line)?.[1];
    if (changes && printed !== undefined && targets.has(unquote(printed))) {
      removed += 1;
      continue;
    }
    const dataLength = Number(/^data (\d+)$/.exec(line)?.[1] ?? 0);
    const data = bytes.slice(at, at + dataLength);
    if (awaitingMessage && /^data \d+$/.test(line)) {
      awaitingMessage = false;
      changes = inCommit?.(data) ?? true;
    }
    kept.push(end === -1 ? line : `${line}\n`, data);
    at += dataLength;
  }
  return { stream: Buffer.from(kept.join(""), "latin1").toString("utf8"), removed };
};
