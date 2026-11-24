import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

// The server writes these in English and stays English; a client says them in its language.
const FIXED: ReadonlyMap<string, string> = new Map([
  [
    "Cancelled because the server shut down before the provider work completed.",
    msg("Cancelled because the server shut down before the provider work completed."),
  ],
  [
    "Cancelled because the server restarted before the provider work completed.",
    msg("Cancelled because the server restarted before the provider work completed."),
  ],
  ["Server shut down", msg("Server shut down")],
  ["Server restarted", msg("Server restarted")],
  ["DoeDesk restarted and resumed this turn", msg("DoeDesk restarted and resumed this turn")],
  [
    "DoeDesk restarted and stopped background work",
    msg("DoeDesk restarted and stopped background work"),
  ],
  [
    "The agent runtime exited and stopped background work",
    msg("The agent runtime exited and stopped background work"),
  ],
]);

const STATUS_NOT_CHECKED = /^(.+) provider status has not been checked in this session yet\.$/u;
const WORKER_ANSWERED = /^The worker answered (\d{3}): ([\s\S]*)$/u;

/**
 * A sentence the server wrote, in the app's language when it is one of the fixed sentences a
 * person meets in ordinary use. Any other text is returned as the server wrote it.
 */
export function serverSentence(text: string, resolve: MFunctionType = mFallback): string {
  const fixed = FIXED.get(text.trim());
  if (fixed !== undefined) return resolve(fixed);
  const notChecked = STATUS_NOT_CHECKED.exec(text.trim());
  if (notChecked !== null) {
    return resolve(
      msg("{provider} provider status has not been checked in this session yet.", {
        provider: notChecked[1]!,
      }),
    );
  }
  const worker = WORKER_ANSWERED.exec(text.trim());
  if (worker !== null) {
    return resolve(
      msg("The worker answered {status}: {detail}", { status: worker[1]!, detail: worker[2]! }),
    );
  }
  return text;
}

/**
 * The name a person reads for one of the sealed-file tools, whose own names are written for
 * agents. Undefined for any other tool. `label` is the tool's name or the title made from it.
 */
export function sealedToolTitle(
  label: string | null | undefined,
  resolve: MFunctionType = mFallback,
): string | undefined {
  const tool = label
    ?.trim()
    .toLowerCase()
    .replace(/^.*(?:__|[.:/])/u, "")
    .replace(/[\s_-]+/gu, "_");
  switch (tool) {
    case "ask_documents":
      return resolve(msg("Ask about sealed files"));
    case "fill_sealed":
      return resolve(msg("Make a finished file"));
    case "list_sealed":
      return resolve(msg("List sealed files"));
    default:
      return undefined;
  }
}
