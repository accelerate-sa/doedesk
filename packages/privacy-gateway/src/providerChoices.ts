/**
 * The three services as they are kept in `config.json`: one choice each for reading, detection
 * and the worker. A choice holds its secrets; only `publicChoice` leaves the server. A DoeDesk
 * Cloud choice holds none: the signed-in account's token is added when the service is built.
 */

import {
  DETECT_PROVIDERS,
  OCR_PROVIDERS,
  type ProviderCatalogEntry,
  type ProviderField,
  WORKER_PROVIDERS,
} from "./providers/catalog.ts";
import { type OcrProviderConfig, toPublicConfig } from "./providers/types.ts";

export const SERVICE_KINDS = ["ocr", "detect", "worker"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

export type ProviderSettingValue = string | number | ReadonlyArray<string>;
export type ProviderSecretValue = string | Readonly<Record<string, string>>;

export interface StoredProviderChoice {
  readonly provider: string;
  readonly settings: Readonly<Record<string, ProviderSettingValue>>;
  readonly secrets: Readonly<Record<string, ProviderSecretValue>>;
}

export type StoredProviders = { readonly [Service in ServiceKind]?: StoredProviderChoice };

/** A choice as a settings screen sends it. */
export interface ProviderChoiceInput {
  readonly provider: string;
  /** Every setting of the choice: one left out is unset. */
  readonly settings?: Readonly<Record<string, unknown>> | undefined;
  /** Only the secrets to change. Left out or empty: the stored one stays. Null: it is removed. */
  readonly secrets?: Readonly<Record<string, unknown>> | undefined;
}

export interface PublicProviderChoice {
  readonly provider: string;
  readonly settings: Readonly<Record<string, ProviderSettingValue>>;
  readonly secretsSet: Readonly<Record<string, boolean>>;
}

const CATALOGS: Readonly<Record<ServiceKind, ReadonlyArray<ProviderCatalogEntry<string>>>> = {
  ocr: OCR_PROVIDERS,
  detect: DETECT_PROVIDERS,
  worker: WORKER_PROVIDERS,
};

export const DOEDESK_CLOUD = "doedeskCloud";

/**
 * A service's providers as a settings screen is given them. DoeDesk Cloud has nothing to fill
 * in: its one secret is the account's sign-in.
 */
export const providerCatalog = (
  service: ServiceKind,
): ReadonlyArray<ProviderCatalogEntry<string>> =>
  CATALOGS[service].map((entry) => (entry.id === DOEDESK_CLOUD ? { ...entry, fields: [] } : entry));

const entryOf = (service: ServiceKind, provider: string) =>
  providerCatalog(service).find((entry) => entry.id === provider);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** A field's value as its adapter takes it. Undefined: unset. Null: not a value of this field. */
const coerce = (
  field: ProviderField,
  value: unknown,
): ProviderSettingValue | ProviderSecretValue | undefined | null => {
  if (value === undefined || value === null) return undefined;
  switch (field.input) {
    case "number": {
      if (typeof value === "string" && value.trim() === "") return undefined;
      const number = typeof value === "string" ? Number(value) : value;
      return typeof number === "number" && Number.isFinite(number) ? number : null;
    }
    case "list": {
      const items = typeof value === "string" ? value.split(/[,\n]/) : value;
      if (!Array.isArray(items)) return null;
      const list = items.flatMap((item) => textOf(item) ?? []);
      return list.length === 0 ? undefined : list;
    }
    case "headers": {
      if (value === "") return undefined;
      if (!isRecord(value)) return null;
      const headers = Object.fromEntries(
        Object.entries(value).flatMap(([name, header]) => {
          const text = textOf(header);
          return name.trim() === "" || text === undefined ? [] : [[name.trim(), text]];
        }),
      );
      return Object.keys(headers).length === 0 ? undefined : headers;
    }
    default: {
      if (typeof value !== "string") return null;
      const text = textOf(value);
      if (text === undefined || field.input !== "select") return text;
      return field.options === undefined || field.options.includes(text) ? text : null;
    }
  }
};

const isSet = (value: unknown): boolean => value !== undefined && value !== null && value !== "";

export type MergedChoice =
  | { readonly ok: true; readonly choice: StoredProviderChoice }
  | { readonly ok: false; readonly message: string };

/**
 * The choice to store for what a settings screen sent. Settings are taken as sent; a secret that
 * was not sent stays as stored, as long as the provider is the same one.
 */
export const mergeChoice = (
  service: ServiceKind,
  input: ProviderChoiceInput,
  stored: StoredProviderChoice | undefined,
): MergedChoice => {
  const entry = entryOf(service, input.provider);
  if (entry === undefined) return { ok: false, message: "That service is not one DoeDesk knows." };
  const kept = stored?.provider === entry.id ? stored.secrets : {};
  const settings: Record<string, ProviderSettingValue> = {};
  const secrets: Record<string, ProviderSecretValue> = {};
  for (const field of entry.fields) {
    const sent = (field.in === "settings" ? input.settings : input.secrets)?.[field.name];
    if (field.in === "secrets" && sent === null) continue;
    const value = coerce(field, sent);
    if (value === null) return { ok: false, message: `Check ${field.label}.` };
    if (field.in === "settings") {
      if (value !== undefined) settings[field.name] = value as ProviderSettingValue;
      continue;
    }
    const secret = value ?? kept[field.name];
    if (secret !== undefined) secrets[field.name] = secret as ProviderSecretValue;
  }
  const missing = entry.fields.find(
    (field) => field.required && !isSet((field.in === "settings" ? settings : secrets)[field.name]),
  );
  if (missing !== undefined) return { ok: false, message: `Enter ${missing.label}.` };
  // Fields that stand in for each other: one of the group is enough, and one is needed.
  for (const group of new Set(entry.fields.flatMap((field) => field.oneOf ?? []))) {
    const members = entry.fields.filter((field) => field.oneOf === group);
    if (!members.some((field) => isSet(secrets[field.name]) || isSet(settings[field.name]))) {
      return {
        ok: false,
        message: `Enter one of: ${members.map((field) => field.label).join(", ")}.`,
      };
    }
  }
  return { ok: true, choice: { provider: entry.id, settings, secrets } };
};

/**
 * A choice as it was stored, or undefined when it is not one that can be used: a provider that
 * is no longer offered, or a file edited by hand into something its adapter cannot take.
 */
export const readStoredChoice = (
  service: ServiceKind,
  value: unknown,
): StoredProviderChoice | undefined => {
  if (!isRecord(value) || typeof value.provider !== "string") return undefined;
  const settings = isRecord(value.settings) ? value.settings : {};
  const secrets = isRecord(value.secrets) ? value.secrets : {};
  const merged = mergeChoice(service, { provider: value.provider, settings, secrets }, undefined);
  if (!merged.ok) return undefined;
  const fields = new Set(entryOf(service, value.provider)?.fields.map((field) => field.name));
  // What the server itself found and stored with the choice, such as how a worker takes JSON.
  const found = Object.entries(settings).filter(
    ([name, setting]) => !fields.has(name) && typeof setting === "string",
  );
  return {
    ...merged.choice,
    settings: {
      ...(Object.fromEntries(found) as Record<string, string>),
      ...merged.choice.settings,
    },
  };
};

/**
 * A choice as a settings screen may see it: every secret the provider takes is only said to be
 * set or not, and a setting the screen has no field for is left out.
 */
export const publicChoice = (
  service: ServiceKind,
  choice: StoredProviderChoice,
): PublicProviderChoice => {
  const fields = entryOf(service, choice.provider)?.fields ?? [];
  // Checked against the catalog when it was stored, so it is one of the adapters' own shapes.
  const shown = toPublicConfig(choice as unknown as OcrProviderConfig);
  const secretsSet: Readonly<Record<string, boolean>> = shown.secretsSet;
  return {
    provider: choice.provider,
    settings: Object.fromEntries(
      fields.flatMap((field) => {
        const value = choice.settings[field.name];
        return field.in !== "settings" || value === undefined ? [] : [[field.name, value]];
      }),
    ),
    secretsSet: Object.fromEntries(
      fields.flatMap((field) =>
        field.in === "secrets" ? [[field.name, secretsSet[field.name] === true]] : [],
      ),
    ),
  };
};

const EMPTY_CHOICE = { settings: {}, secrets: {} } as const;

/** The stored choice of a provider that has nothing to fill in. */
export const plainChoice = (provider: string): StoredProviderChoice => ({
  provider,
  ...EMPTY_CHOICE,
});

/**
 * The three choices of a `config.json` written before they were chosen one by one. Then one's
 * own detection service was also the reading service (`mode: "selfHosted"`), and the worker was
 * kept as `worker` with `workerChoice`. A file that already has `providers` is read as it is.
 */
export const migrateProviders = (
  stored: Readonly<Record<string, unknown>>,
): { readonly providers: StoredProviders; readonly rest: Readonly<Record<string, unknown>> } => {
  const {
    providers: kept,
    worker,
    workerChoice,
    endpoint,
    ...rest
  } = stored as Record<string, unknown> & { readonly providers?: unknown };
  const providers: { -readonly [Service in ServiceKind]?: StoredProviderChoice } = {};
  if (isRecord(kept)) {
    for (const service of SERVICE_KINDS) {
      const choice = readStoredChoice(service, kept[service]);
      if (choice !== undefined) providers[service] = choice;
    }
    return { providers, rest };
  }
  const address = textOf(endpoint);
  if (stored.mode === "selfHosted") {
    const { token, ...withoutToken } = rest;
    if (address !== undefined) {
      const own: StoredProviderChoice = {
        provider: "custom",
        settings: { endpoint: address },
        secrets: textOf(token) === undefined ? {} : { token: textOf(token) as string },
      };
      providers.detect = own;
      providers.ocr = own;
    }
    return { providers: workerFrom(providers, worker, workerChoice), rest: withoutToken };
  }
  return { providers: workerFrom(providers, worker, workerChoice), rest };
};

const workerFrom = (
  providers: StoredProviders,
  worker: unknown,
  workerChoice: unknown,
): StoredProviders => {
  const own =
    isRecord(worker) && typeof worker.baseUrl === "string" && typeof worker.model === "string"
      ? worker
      : undefined;
  // Unset, the person had not chosen: their own server when one was stored.
  const choice = workerChoice ?? (own === undefined ? undefined : "custom");
  if (choice === "cloud") return { ...providers, worker: plainChoice(DOEDESK_CLOUD) };
  if (choice === "off" || (choice === "custom" && own === undefined)) {
    return { ...providers, worker: plainChoice("off") };
  }
  if (choice !== "custom" || own === undefined) return providers;
  const setting = (name: string) => {
    const value = textOf(own[name]);
    return value === undefined ? {} : { [name]: value };
  };
  return {
    ...providers,
    worker: {
      provider: "openaiCompatible",
      settings: {
        ...setting("baseUrl"),
        ...setting("model"),
        ...setting("driver"),
        ...setting("reasoningEffort"),
        ...setting("structured"),
      },
      secrets: setting("apiKey"),
    },
  };
};
