/*
 * A public web page is not checked for new names: only values already in the vault are replaced.
 * The gateway sees a tool's name and the address it was given, never the page's audience, so
 * every rule here fails closed: any doubt, and the result is checked like any other tool's.
 */

/** A tool call as the request carries it: its name and its arguments. */
export interface ToolCall {
  readonly name: string;
  readonly input: unknown;
}

// Exact names only: a pattern such as `*fetch*` would take in `fetch_cloud_config`.
const FETCH_TOOLS = new Set(["webfetch", "web_fetch", "fetch_url", "fetch_webpage"]);
const SEARCH_TOOLS = new Set(["websearch", "web_search", "search_web", "google_web_search"]);

/** Endings of names that resolve inside a network, or nowhere public. */
const PRIVATE_SUFFIXES = [
  "local",
  "internal",
  "lan",
  "home",
  "home.arpa",
  "corp",
  "intranet",
  "localdomain",
  "arpa",
  "test",
  "example",
  "invalid",
  "onion",
  "ts.net",
  "localhost",
];

/**
 * True when the address is plainly a public web page: https, a public host name, the standard
 * port, nothing signed in. The name is never resolved: a lookup could answer differently from
 * one turn to the next, and the masked text has to stay the same.
 */
export const isPlainlyPublicUrl = (value: string): boolean => {
  if (/\s/u.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  if (url.port !== "" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  // The parser has already turned decimal, hex and octal IPv4 forms into four numbers.
  if (host.startsWith("[") || /^[0-9]+(?:\.[0-9]+){3}$/u.test(host)) return false;
  if (!host.includes(".") && host !== "localhost") return false;
  return !PRIVATE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
};

const SIGNED_IN_KEYS = new Set(["authorization", "cookie", "cookies", "x-api-key"]);

/** True when a tool's arguments carry a sign-in: the page behind it is the person's own. */
const carriesSignIn = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(carriesSignIn);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, child]) => SIGNED_IN_KEYS.has(key.toLowerCase()) || carriesSignIn(child),
  );
};

const asObject = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value === "string") {
    try {
      return asObject(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

const FINAL_URL_KEYS = ["url", "final_url", "finalUrl", "redirect_url", "redirectUrl"];

/** A structured result that names where the fetch ended: every such address has to be public. */
const endedSomewherePrivate = (result: unknown): boolean => {
  const fields = asObject(result);
  if (fields === undefined) return false;
  return FINAL_URL_KEYS.some((key) => {
    const value = fields[key];
    return typeof value === "string" && !isPlainlyPublicUrl(value);
  });
};

/**
 * True when `result` is what a web search returned, or what a web fetch returned from a plainly
 * public page. `call` is undefined when the request no longer holds the call.
 */
export const isPublicWebResult = (call: ToolCall | undefined, result: unknown): boolean => {
  if (call === undefined) return false;
  const name = call.name.toLowerCase();
  if (SEARCH_TOOLS.has(name)) return true;
  if (!FETCH_TOOLS.has(name)) return false;
  const input = asObject(call.input);
  const url = input?.url;
  if (typeof url !== "string" || !isPlainlyPublicUrl(url) || carriesSignIn(input)) return false;
  return !endedSomewherePrivate(result);
};
