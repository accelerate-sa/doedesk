import type { GatewayRecord } from "./gateway.ts";

/** How long after the proxy refused a program's failure is taken to be that refusal. */
const FRESH_MS = 30_000;

/**
 * What the person's proxy last refused, until a request gets out again. A program's own request
 * (a setup call before its first model request) fails on the same proxy and reports it in words
 * that carry none of DoeDesk's: the app asks here why nothing is being sent.
 */
export class ProxyRefusal {
  #last: { readonly at: number; readonly reason: string } | undefined;

  note(record: GatewayRecord, now: number): void {
    if (record.notice === "proxySignIn" || record.notice === "proxyRefused") {
      if (record.reason !== undefined) this.#last = { at: now, reason: record.reason };
    } else if (record.outcome === "masked" || record.outcome === "passed") {
      this.#last = undefined;
    }
  }

  /** Why nothing is being sent now, or undefined when requests get out. */
  reason(now: number): string | undefined {
    return this.#last !== undefined && now - this.#last.at <= FRESH_MS
      ? this.#last.reason
      : undefined;
  }
}
