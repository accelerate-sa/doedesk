import type {
  PrivacySealedListing,
  PrivacyTurnRecord,
  PrivacyTurnValues,
} from "@t3tools/contracts";
import { msg } from "gt-react";

/** What each kind of stand-in is called. A kind this build does not know is shown as Other. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  PERSON: msg("People", { $context: "kind of masked value: names of people" }),
  ORG: msg("Organizations", { $context: "kind of masked value" }),
  LOCATION: msg("Places", { $context: "kind of masked value: cities, districts, countries" }),
  ADDRESS: msg("Addresses", { $context: "kind of masked value: street addresses" }),
  PHONE: msg("Phone numbers", { $context: "kind of masked value" }),
  EMAIL: msg("Email addresses", { $context: "kind of masked value" }),
  ID: msg("ID numbers", { $context: "kind of masked value: national ID, iqama, registration" }),
  IBAN: msg("IBANs", { $context: "kind of masked value: bank account numbers in IBAN form" }),
  ACCOUNT: msg("Account numbers", { $context: "kind of masked value" }),
  DATE: msg("Dates", { $context: "kind of masked value" }),
  URL: msg("Links", { $context: "kind of masked value: web addresses" }),
  AMOUNT: msg("Amounts", { $context: "kind of masked value: sums of money, measurements" }),
  PARCEL: msg("Parcel numbers", { $context: "kind of masked value: land parcel numbers" }),
  DEED: msg("Deed numbers", { $context: "kind of masked value: title deed numbers" }),
  CASE: msg("Case numbers", { $context: "kind of masked value: court or file numbers" }),
  OTHER: msg("Other", { $context: "kind of masked value: none of the named kinds" }),
};

/** The label of a kind of stand-in, as a message to resolve where it is shown. */
export const standInKindLabel = (kind: string): string => KIND_LABELS[kind] ?? KIND_LABELS.OTHER!;

type TurnValue = NonNullable<PrivacyTurnValues["values"]>[number];

/** A turn's values under their kinds, in the order the turn's counts list the kinds. */
export const valuesByKind = (
  kinds: ReadonlyArray<{ readonly kind: string }>,
  values: ReadonlyArray<TurnValue>,
): ReadonlyArray<{ readonly kind: string; readonly values: ReadonlyArray<TurnValue> }> => {
  const known = new Set(kinds.map((entry) => entry.kind));
  // A value whose kind the counts do not list still belongs somewhere the person can see it.
  const order = [...known, ...new Set(values.map((value) => value.kind))];
  return [...new Set(order)]
    .map((kind) => ({ kind, values: values.filter((value) => value.kind === kind) }))
    .filter((group) => group.values.length > 0);
};

type TurnSealedFiles = NonNullable<PrivacyTurnRecord["sealedFiles"]>;

/** As many of a turn's sealed files as its one line names. The rest are counted. */
const NAMED_ON_THE_LINE = 2;

/**
 * The sealed files a turn asked about, as its line names them: by file name where this computer
 * holds the files, by handle anywhere else or once a file is no longer sealed.
 */
export const sealedFilesAsked = (
  sealedFiles: TurnSealedFiles,
  listing: PrivacySealedListing | null,
): { readonly count: number; readonly names: ReadonlyArray<string>; readonly more: number } => {
  const names = new Map(listing?.documents.map((document) => [document.handle, document.name]));
  const shown = sealedFiles.asked
    .slice(0, NAMED_ON_THE_LINE)
    .map((handle) => names.get(handle) ?? handle);
  return {
    count: sealedFiles.askedCount,
    names: shown,
    more: Math.max(0, sealedFiles.askedCount - shown.length),
  };
};
