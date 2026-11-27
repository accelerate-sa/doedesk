import type {
  PrivacyProviderCatalogEntry,
  PrivacyProviderConfig,
  PrivacyProviderField,
  PrivacyProviderHealth,
  PrivacyProviderRequest,
  PrivacyService,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export const PRIVACY_SERVICES = [
  "ocr",
  "detect",
  "worker",
] as const satisfies ReadonlyArray<PrivacyService>;

export const SERVICE_TITLES: Readonly<Record<PrivacyService, string>> = {
  ocr: msg("Document reading"),
  detect: msg("Entity detection"),
  worker: msg("Sealed files model"),
};

export const DOEDESK_CLOUD = "doedeskCloud";

/** Providers that are not a company's product. The rest are shown by the name the server gives. */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  custom: msg("Custom API"),
  openaiCompatible: msg("OpenAI-compatible"),
  localOnly: msg("Local rules only"),
  off: msg("Off", { $context: "no model reads sealed files" }),
};

export const providerName = (
  entry: Pick<PrivacyProviderCatalogEntry, "id" | "label">,
  resolve: MessageResolver = m,
): string => {
  const known = PROVIDER_NAMES[entry.id];
  return known === undefined ? entry.label : resolve(known);
};

/**
 * What a person has to know before relying on a provider, or null. Rules that run on this
 * computer find no names, and a service without Arabic lets Arabic text through unread.
 */
export const providerCaution = (
  service: PrivacyService,
  entry: PrivacyProviderCatalogEntry,
  resolve: MessageResolver = m,
): string | null => {
  if (service === "worker") return null;
  if (entry.id === "localOnly") return resolve(msg("Names are not masked."));
  return entry.capabilities.supportsArabic ? null : resolve(msg("Arabic text may be missed."));
};

/**
 * The providers to offer. DoeDesk Cloud's model for sealed files is offered only to an account
 * that has it, or while it is still the choice.
 */
export const offeredProviders = (
  service: PrivacyService,
  catalog: ReadonlyArray<PrivacyProviderCatalogEntry>,
  current: string,
  hostedWorkerEntitled: boolean,
): ReadonlyArray<PrivacyProviderCatalogEntry> =>
  service !== "worker" || hostedWorkerEntitled
    ? catalog
    : catalog.filter((entry) => entry.id !== DOEDESK_CLOUD || entry.id === current);

/** The server's field labels, which it sends in English. Any other label is shown as sent. */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  "Service address": msg("Service address"),
  "Access token": msg("Access token"),
  "AWS region": msg("AWS region"),
  "Access key ID": msg("Access key ID"),
  "Secret access key": msg("Secret access key"),
  "Session token": msg("Session token"),
  "Private endpoint": msg("Private endpoint"),
  "Service account key (JSON)": msg("Service account key (JSON)"),
  "API key": msg("API key"),
  "API address": msg("API address"),
  Model: msg("Model"),
  "Key is sent as": msg("Key is sent as"),
  "API version": msg("API version"),
  "Extra request headers": msg("Extra request headers"),
  "Resource endpoint": msg("Resource endpoint"),
  "Resource key": msg("Resource key"),
  "Project ID": msg("Project ID"),
  Location: msg("Location", { $context: "the cloud region a service runs in" }),
  "Processor ID": msg("Processor ID"),
  "Processor version": msg("Processor version"),
  "Analyzer address": msg("Analyzer address"),
  Language: msg("Language"),
  "Entity types": msg("Entity types"),
  "Minimum score": msg("Minimum score"),
  "Key header": msg("Key header"),
  Domain: msg("Domain", { $context: "the subject area a detection service is tuned for" }),
  "PII categories": msg("PII categories"),
  "Processing location": msg("Processing location"),
  "Minimum likelihood": msg("Minimum likelihood"),
  "API format": msg("API format"),
  "Reasoning effort": msg("Reasoning effort"),
};

export const fieldLabel = (field: PrivacyProviderField, resolve: MessageResolver = m): string => {
  const known = FIELD_LABELS[field.label];
  return known === undefined ? field.label : resolve(known);
};

const HEALTH_LABELS: Readonly<Record<PrivacyProviderHealth["kind"], string>> = {
  ok: msg("Connected", { $context: "a service answered a connection test" }),
  auth: msg("Key not accepted"),
  busy: msg("Busy. Try again."),
  timeout: msg("Timed out"),
  unreachable: msg("Can't be reached"),
  failing: msg("Service error"),
  refused: msg("Request refused"),
  unreadable: msg("Unexpected answer"),
  misconfigured: msg("Check the fields"),
};

export const healthLabel = (
  health: Pick<PrivacyProviderHealth, "kind">,
  resolve: MessageResolver = m,
): string => resolve(HEALTH_LABELS[health.kind]);

/** What was typed for one provider, by field name. A secret left empty stays as saved. */
export type ProviderDraft = Readonly<Record<string, string>>;

const shownValue = (value: PrivacyProviderConfig["settings"][string] | undefined): string =>
  value === undefined
    ? ""
    : typeof value === "string"
      ? value
      : typeof value === "number"
        ? String(value)
        : value.join(", ");

/** The form for a provider: its saved settings when it is the one in use, and no secret. */
export const draftOf = (
  entry: PrivacyProviderCatalogEntry,
  saved: PrivacyProviderConfig,
): ProviderDraft =>
  Object.fromEntries(
    entry.fields.map((field) => [
      field.name,
      field.in === "settings" && saved.provider === entry.id
        ? shownValue(saved.settings[field.name])
        : "",
    ]),
  );

/**
 * A provider's fields in two groups: what it cannot work without or what is a key, and the rest,
 * which stays folded away.
 */
export const fieldGroups = (
  entry: PrivacyProviderCatalogEntry,
): {
  readonly main: ReadonlyArray<PrivacyProviderField>;
  readonly more: ReadonlyArray<PrivacyProviderField>;
} => {
  const isMain = (field: PrivacyProviderField) =>
    field.required || field.oneOf !== undefined || field.input === "secret";
  return {
    main: entry.fields.filter(isMain),
    more: entry.fields.filter((field) => !isMain(field)),
  };
};

const filled = (
  field: PrivacyProviderField,
  entry: PrivacyProviderCatalogEntry,
  draft: ProviderDraft,
  saved: PrivacyProviderConfig,
  removed: ReadonlySet<string>,
): boolean =>
  (draft[field.name] ?? "").trim() !== "" ||
  (field.in === "secrets" &&
    saved.provider === entry.id &&
    saved.secretsSet[field.name] === true &&
    !removed.has(field.name));

/** The first thing still to fill in before the provider can be saved or tested. */
export const missingField = (
  entry: PrivacyProviderCatalogEntry,
  draft: ProviderDraft,
  saved: PrivacyProviderConfig,
  removed: ReadonlySet<string> = new Set(),
): PrivacyProviderField | undefined => {
  const has = (field: PrivacyProviderField) => filled(field, entry, draft, saved, removed);
  return entry.fields.find((field) =>
    field.oneOf === undefined
      ? field.required && !has(field)
      : // Fields that stand in for each other: one of the group is enough.
        !entry.fields.some((other) => other.oneOf === field.oneOf && has(other)),
  );
};

/** One `Name: value` on each line. A line without a name is left out. */
const headersOf = (text: string): Record<string, string> =>
  Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      return colon < 1 || name === "" || value === "" ? [] : [[name, value]];
    }),
  );

/** What is sent to save or test the form. */
export const requestOf = (
  service: PrivacyService,
  entry: PrivacyProviderCatalogEntry,
  draft: ProviderDraft,
  removed: ReadonlySet<string> = new Set(),
): PrivacyProviderRequest => {
  const settings: Record<string, string | number | ReadonlyArray<string>> = {};
  const secrets: Record<string, string | Record<string, string> | null> = {};
  for (const field of entry.fields) {
    const typed = (draft[field.name] ?? "").trim();
    if (field.in === "secrets") {
      if (typed !== "") secrets[field.name] = field.input === "headers" ? headersOf(typed) : typed;
      else if (removed.has(field.name)) secrets[field.name] = null;
      continue;
    }
    if (typed === "") continue;
    const number = Number(typed);
    settings[field.name] =
      field.input === "number" && Number.isFinite(number)
        ? number
        : field.input === "list"
          ? typed
              .split(/[,\n]/)
              .map((item) => item.trim())
              .filter((item) => item !== "")
          : typed;
  }
  return { service, provider: entry.id, settings, secrets };
};

/** Whether the form holds something that is not saved yet. */
export const isDirty = (
  entry: PrivacyProviderCatalogEntry,
  draft: ProviderDraft,
  saved: PrivacyProviderConfig,
  removed: ReadonlySet<string> = new Set(),
): boolean => {
  if (saved.provider !== entry.id || removed.size > 0) return true;
  const stored = draftOf(entry, saved);
  return entry.fields.some(
    (field) => (draft[field.name] ?? "").trim() !== (stored[field.name] ?? "").trim(),
  );
};
