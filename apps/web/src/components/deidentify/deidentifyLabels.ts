import type {
  DeidentifyFailureReason,
  DeidentifyFamily,
  DeidentifyFileStatus,
  DeidentifyItem,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import {
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  type LucideIcon,
  PresentationIcon,
} from "lucide-react";

import type { MessageResolver } from "~/i18n/messages";

import { columnLetter } from "./deidentifyModel";

/** What a found value is, in the app's language. The server's own label is English. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  PERSON: msg("Name", { $context: "a person's name" }),
  ORG: msg("Organisation"),
  LOCATION: msg("Place"),
  ADDRESS: msg("Address"),
  PHONE: msg("Phone number"),
  EMAIL: msg("Email address"),
  ID: msg("ID number"),
  IBAN: msg("IBAN"),
  ACCOUNT: msg("Account number"),
  DATE: msg("Date"),
  URL: msg("Link", { $context: "a web address" }),
  AMOUNT: msg("Amount", { $context: "an amount of money" }),
  PARCEL: msg("Parcel", { $context: "a parcel of land" }),
  DEED: msg("Deed", { $context: "a title deed" }),
  CASE: msg("Case", { $context: "a court case" }),
};

const MARKED_BY_HAND = msg("Marked by hand");
const UNREAD_WRITING = msg("Unread writing");
const UNREAD_MARKS = msg("Unread marks");

/** The cells an item covers, the way a spreadsheet names them: B2 or B2:D7. */
const cellsName = (item: DeidentifyItem): string | undefined => {
  const { target } = item;
  if (target.type !== "cells" || target.scope === "column" || target.scope === "row") {
    return undefined;
  }
  const first = `${columnLetter(target.startColumn)}${target.startRow + 1}`;
  if (target.scope === "cell" || target.endRow === null || target.endColumn === null) return first;
  return `${first}:${columnLetter(target.endColumn)}${target.endRow + 1}`;
};

const COLUMN = msg("Column {name}");
const ROW = msg("Row {number}");

export const itemLabel = (item: DeidentifyItem, resolve: MessageResolver): string => {
  if (item.source === "manual") {
    // A mark on cells is named by the cells: there are no words under it to show.
    const { target } = item;
    if (target.type === "cells" && target.scope === "column") {
      return resolve(COLUMN, { name: columnLetter(target.startColumn) });
    }
    if (target.type === "cells" && target.scope === "row") {
      return resolve(ROW, { number: target.startRow + 1 });
    }
    return cellsName(item) ?? resolve(MARKED_BY_HAND);
  }
  if (item.origin === "unreadable") return resolve(UNREAD_WRITING);
  if (item.origin === "ink") return resolve(UNREAD_MARKS);
  // A code's label says what the code holds, which only the server knows.
  if (item.origin === "code") return item.label;
  const known = KIND_LABELS[item.kind];
  return known === undefined ? item.label : resolve(known);
};

export const FAMILY_ICONS: Readonly<Record<DeidentifyFamily, LucideIcon>> = {
  text: FileTextIcon,
  image: FileImageIcon,
  pdf: FileTextIcon,
  csv: FileSpreadsheetIcon,
  xlsx: FileSpreadsheetIcon,
  docx: FileTextIcon,
  pptx: PresentationIcon,
};

export const STATUS_LABELS: Readonly<Record<DeidentifyFileStatus, string>> = {
  notScanned: msg("Not checked yet"),
  unreviewed: msg("Needs review"),
  stale: msg("Changed since review"),
  reviewed: msg("Reviewed"),
  skipped: msg("Skipped"),
};

export const STATUS_DOTS: Readonly<Record<DeidentifyFileStatus, string>> = {
  notScanned: "bg-muted-foreground/40",
  unreviewed: "bg-warning",
  stale: "bg-destructive",
  reviewed: "bg-success",
  skipped: "bg-muted-foreground/40",
};

export const FAILURE_LABELS: Readonly<Record<DeidentifyFailureReason, string>> = {
  unsupported: msg("This kind of file cannot be opened here."),
  missing: msg("The file is not where it was."),
  tooLarge: msg("The file is too large to open here."),
  unreadable: msg("The file could not be opened."),
  unavailable: msg("Checking is not available right now. Try again in a moment."),
  invalid: msg("The file could not be opened."),
};
