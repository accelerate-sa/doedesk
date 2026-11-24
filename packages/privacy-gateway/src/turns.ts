import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { GatewayRecord } from "./gateway.ts";
import { type EntityKind, isEntityKind } from "./placeholders.ts";

/**
 * What the gateway did to the requests of one turn. Every number counts something the gateway
 * did; none says anything about what it did not find.
 */
export interface TurnTally {
  /** Requests whose content was rewritten before they were sent. */
  readonly rewritten: number;
  /** Requests that were not sent, because they could not be checked. */
  readonly refused: number;
  /**
   * The distinct stand-ins written into what was sent, and those restored in what came back: a
   * reply can use a value from an earlier turn that no request of this turn carried.
   */
  readonly replaced: ReadonlyArray<string>;
  /**
   * Images sent with their values covered, images and files sent as the text read from them,
   * images and files left out, and texts left out for holding sealed wording. A client sends the
   * whole chat with every request, so each is the most seen in one request, not a sum.
   */
  readonly redacted: number;
  readonly read: number;
  readonly withheld: number;
  readonly sealed: number;
  /**
   * `session`: the requests named this chat. `time`: they named no chat, so these are all such
   * requests since the last turn that was counted this way, whichever chat sent them.
   */
  readonly attribution: "session" | "time";
}

interface OpenTally {
  /** Every name a request of this chat has gone by. */
  readonly names: Set<string>;
  rewritten: number;
  refused: number;
  readonly replaced: Set<string>;
  redacted: number;
  read: number;
  withheld: number;
  sealed: number;
}

/** A request that names no chat is counted here. */
const UNNAMED: ReadonlyArray<string> = [""];
const SESSION_ID =
  /session(?:_id)?[\\":_\s]*([0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})/;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;

/**
 * The names the provider's own program gives the chat a request belongs to, where it gives any:
 * Claude Code in `metadata.user_id`; Codex in the `thread_id` and `session_id` headers and in
 * `prompt_cache_key`. All are kept, because which one the server knows the chat by differs.
 */
export const sessionsNamedIn = (
  headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>,
  body: unknown,
): ReadonlyArray<string> => {
  const names = [text(headers.thread_id), text(headers.session_id)];
  if (typeof body === "object" && body !== null) {
    const fields = body as Record<string, unknown>;
    const metadata = fields.metadata;
    if (typeof metadata === "object" && metadata !== null) {
      const user = text((metadata as Record<string, unknown>).user_id);
      names.push(user === undefined ? undefined : SESSION_ID.exec(user)?.[1]);
    }
    names.push(text(fields.prompt_cache_key));
  }
  return [...new Set(names.filter((name) => name !== undefined))];
};

export const kindOfStandIn = (token: string): EntityKind => {
  const kind = token.slice(1, token.lastIndexOf("_"));
  return isEntityKind(kind) ? kind : "OTHER";
};

/** How many of the stand-ins are of each kind, most first. */
export const standInsByKind = (
  tokens: ReadonlyArray<string>,
): ReadonlyArray<{ readonly kind: EntityKind; readonly count: number }> => {
  const counts = new Map<EntityKind, number>();
  for (const token of tokens) {
    const kind = kindOfStandIn(token);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts]
    .map(([kind, count]) => ({ kind, count }))
    .toSorted((left, right) => right.count - left.count || left.kind.localeCompare(right.kind));
};

/**
 * Adds up what the gateway did, chat by chat, until the server asks for a turn's share, and keeps
 * the stand-ins of recent turns so they can be shown beside their values later. It holds
 * stand-ins and counts only: the values stay in the vault.
 */
export class TurnLedger {
  /** Oldest first. A chat has few names and there are few chats, so a list is searched. */
  #open: Array<OpenTally> = [];
  readonly #kept = new Map<string, ReadonlyArray<string>>();
  readonly #filePath: string | undefined;
  readonly #maxOpen: number;
  readonly #maxKept: number;
  #saveTimer: NodeJS.Timeout | undefined;

  constructor(filePath?: string, limits: { readonly open?: number; readonly kept?: number } = {}) {
    this.#filePath = filePath;
    this.#maxOpen = limits.open ?? 64;
    this.#maxKept = limits.kept ?? 500;
    if (filePath === undefined) return;
    try {
      const stored = JSON.parse(NodeFS.readFileSync(filePath, "utf8")) as Record<string, unknown>;
      for (const [id, tokens] of Object.entries(stored)) {
        if (Array.isArray(tokens)) {
          this.#kept.set(
            id,
            tokens.filter((token): token is string => typeof token === "string"),
          );
        }
      }
    } catch {
      // Nothing kept yet, or unreadable: earlier turns show their counts without the list.
    }
  }

  /** Counts one request. Only requests the gateway rewrote or refused say anything about a turn. */
  add(record: GatewayRecord): void {
    if (record.format === undefined) return;
    if (record.outcome !== "masked" && record.outcome !== "refused") return;
    const tally = this.#tallyOf(record.sessions);
    if (record.outcome === "refused") {
      tally.refused += 1;
      return;
    }
    tally.rewritten += 1;
    for (const token of record.replaced ?? []) tally.replaced.add(token);
    tally.redacted = Math.max(tally.redacted, record.redacted ?? 0);
    tally.read = Math.max(tally.read, record.read ?? 0);
    tally.withheld = Math.max(tally.withheld, record.withheld ?? 0);
    tally.sealed = Math.max(tally.sealed, record.sealed ?? 0);
  }

  /** Counts the stand-ins restored in a reply to the chat its request named. */
  restored(sessions: ReadonlyArray<string> | undefined, tokens: ReadonlyArray<string>): void {
    const tally = this.#tallyOf(sessions);
    for (const token of tokens) tally.replaced.add(token);
  }

  /** The open tally of the chat that goes by these names, started when there is none. */
  #tallyOf(sessions: ReadonlyArray<string> | undefined): OpenTally {
    const names = sessions === undefined ? UNNAMED : sessions;
    let tally = this.#open.find((open) => names.some((name) => open.names.has(name)));
    if (tally === undefined) {
      tally = {
        names: new Set(),
        rewritten: 0,
        refused: 0,
        replaced: new Set(),
        redacted: 0,
        read: 0,
        withheld: 0,
        sealed: 0,
      };
      this.#open.push(tally);
      // A chat nobody asks about, such as a title being written, is dropped, oldest first.
      if (this.#open.length > this.#maxOpen) this.#open.shift();
    }
    for (const name of names) tally.names.add(name);
    return tally;
  }

  /**
   * What was counted since the last call for the chats that go by these names, and nothing left
   * behind. With none counted under a name, the requests that named no chat are taken instead.
   */
  take(sessions: ReadonlyArray<string>): TurnTally | undefined {
    const goesBy = (names: ReadonlyArray<string>) => (open: OpenTally) =>
      names.some((name) => open.names.has(name));
    const named = this.#open.filter(goesBy(sessions.filter((name) => name !== "")));
    const tallies = named.length > 0 ? named : this.#open.filter(goesBy(UNNAMED));
    this.#open = this.#open.filter((open) => !tallies.includes(open));
    if (tallies.length === 0) return undefined;
    const most = (pick: (tally: OpenTally) => number) => Math.max(...tallies.map(pick));
    return {
      rewritten: tallies.reduce((total, tally) => total + tally.rewritten, 0),
      refused: tallies.reduce((total, tally) => total + tally.refused, 0),
      replaced: [...new Set(tallies.flatMap((tally) => [...tally.replaced]))],
      redacted: most((tally) => tally.redacted),
      read: most((tally) => tally.read),
      withheld: most((tally) => tally.withheld),
      sealed: most((tally) => tally.sealed),
      attribution: named.length > 0 ? "session" : "time",
    };
  }

  /** Keeps a turn's stand-ins under the name the server gives the turn. */
  keep(id: string, tokens: ReadonlyArray<string>): void {
    if (tokens.length === 0) return;
    this.#kept.delete(id);
    this.#kept.set(id, tokens);
    while (this.#kept.size > this.#maxKept) {
      const oldest = this.#kept.keys().next().value;
      if (oldest === undefined) break;
      this.#kept.delete(oldest);
    }
    if (this.#filePath === undefined || this.#saveTimer !== undefined) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.flush();
    }, 250);
    this.#saveTimer.unref();
  }

  /** The stand-ins of a turn, or undefined when the turn is no longer kept. */
  kept(id: string): ReadonlyArray<string> | undefined {
    return this.#kept.get(id);
  }

  flush(): void {
    if (this.#saveTimer !== undefined) {
      clearTimeout(this.#saveTimer);
      this.#saveTimer = undefined;
    }
    if (this.#filePath === undefined) return;
    NodeFS.mkdirSync(NodePath.dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filePath}.${process.pid}.tmp`;
    NodeFS.writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.#kept)), {
      mode: 0o600,
    });
    NodeFS.renameSync(temporary, this.#filePath);
  }
}
