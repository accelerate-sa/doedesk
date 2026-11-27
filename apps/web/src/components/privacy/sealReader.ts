import type { PrivacyAccountRegion, PrivacyStatus } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";
import { sealReaderHost } from "./sealedFiles.logic";

/**
 * Who reads a sealed file; every screen takes its wording from this file. `hosted`: DoeDesk
 * Cloud's worker for the account's region (null until DoeDesk Cloud has said it). `operator` is
 * set only when DoeDesk Cloud names another operator than these sentences were written for.
 */
export type SealReader =
  | {
      readonly kind: "hosted";
      readonly region: PrivacyAccountRegion | null;
      readonly operator: { readonly host: string; readonly location: string } | null;
    }
  | { readonly kind: "ownServer"; readonly host: string };

/**
 * Who runs each region's worker in the sentences below. Not an address: DoeDesk Cloud holds those.
 * Null: nobody. DoeDesk Cloud offers no worker in the European Union region yet.
 */
const WRITTEN_FOR: Readonly<Record<PrivacyAccountRegion, string | null>> = {
  sa: "deep.sa",
  eu: null,
  global: "OpenRouter",
};

/**
 * The account has DoeDesk Cloud's worker and DoeDesk Cloud offers none in its region yet. DoeDesk
 * never sends a sealed file to another region, so such an account reads sealed files with its
 * own server.
 */
export const hostedWorkerNotInRegion = (status: PrivacyStatus | null): boolean =>
  status?.mode === "cloud" &&
  status.hostedWorkerEntitled === true &&
  status.hostedWorkerOffered === false;

/** Said calmly, once: it is not a fault, and nothing was sent anywhere. */
export const HOSTED_WORKER_NOT_IN_REGION = msg(
  "DoeDesk Cloud's worker is not available in your region yet. Your sealed files stay sealed and encrypted on this computer, and nothing is sent to another region. Connect your own server to ask about them.",
);

/** What DoeDesk Cloud says of the region's worker, when this app has no sentence of its own for it. */
const reportedOperator = (
  status: PrivacyStatus,
  region: PrivacyAccountRegion | null,
): { readonly host: string; readonly location: string } | null => {
  const hosted = status.hostedWorker ?? null;
  if (hosted === null || (region !== null && hosted.host === WRITTEN_FOR[region])) return null;
  return hosted;
};

const hostedReader = (status: PrivacyStatus): Extract<SealReader, { kind: "hosted" }> => {
  const region = status.worker?.region ?? status.accountRegion ?? null;
  return { kind: "hosted", region, operator: reportedOperator(status, region) };
};

/**
 * DoeDesk Cloud's worker is offered to organizations under an agreement. Everyone else is told
 * once, calmly, how sealed files are read and how to ask for it: here in Settings, and in the
 * dialog that precedes sealing. Null for an account that has it.
 */
export const managedWorkerNote = (
  status: PrivacyStatus,
  resolve: MessageResolver = m,
): string | null => {
  if (hostedWorkerNotInRegion(status)) {
    return resolve(
      msg(
        "DoeDesk Cloud's worker is not available in your region yet. Sealed files are read by a separate model you connect here. On your own computer or company server, they are read on hardware you control; under an API key, they go to that service.",
      ),
    );
  }
  if (status.hostedWorkerEntitled === true) return null;
  // Only an account whose entity detection runs through DoeDesk Cloud is told so.
  const cloudDetect =
    status.providers !== undefined
      ? status.providers.detect.provider === "doedeskCloud"
      : status.mode === "cloud";
  return cloudDetect
    ? resolve(
        msg(
          "Masking runs automatically on DoeDesk Cloud. Sealed files are read by a separate model you connect here. On your own computer or company server, they are read on hardware you control; under an API key, they go to that service. Organizations without their own model hardware yet can ask for a managed in-region worker at hello@doedesk.com.",
        ),
      )
    : resolve(
        msg(
          "Sealed files are read by a separate model you connect here. On your own computer or company server, they are read on hardware you control; under an API key, they go to that service. Organizations without their own model hardware yet can ask for a managed in-region worker at hello@doedesk.com.",
        ),
      );
};

export const MANAGED_WORKER_FOOTER = msg(
  "No model hardware of your own yet? Organizations can ask for a managed in-region worker at hello@doedesk.com.",
);

/** DoeDesk Cloud's worker read this account's sealed files and the account does not have it now. */
export const HOSTED_WORKER_NOT_INCLUDED = msg(
  "DoeDesk Cloud's worker is not included in this account. Your sealed files stay sealed and encrypted on this computer, and nothing is sent anywhere else. Connect your own server to ask about them again.",
);

/** Null: nobody is connected to read sealed files, so none can be sealed yet. */
export const sealReader = (status: PrivacyStatus | null): SealReader | null => {
  const worker = status?.worker;
  if (status === null || worker === undefined || worker.kind === "off") return null;
  // A region with no worker reads nothing: nobody is named as the reader, here or in another region.
  if (worker.kind === "cloud") return hostedWorkerNotInRegion(status) ? null : hostedReader(status);
  const host = sealReaderHost(status);
  return host === null ? null : { kind: "ownServer", host };
};

/** What is about to be sealed: one file, several, or a folder with the files it holds now. */
export type SealSubject =
  | { readonly kind: "file" }
  | { readonly kind: "files"; readonly count: number }
  | { readonly kind: "folder"; readonly count: number };

/** Global is not called a country: OpenRouter's global endpoint has no region restriction. */
export const ACCOUNT_REGION_CHOICES: ReadonlyArray<{
  readonly value: PrivacyAccountRegion;
  readonly label: string;
}> = [
  { value: "sa", label: msg("Saudi Arabia", { $context: "an account region" }) },
  { value: "eu", label: msg("European Union", { $context: "an account region" }) },
  {
    value: "global",
    label: msg("Global", { $context: "an account region with no region restriction" }),
  },
];

export const accountRegionLabel = (
  region: PrivacyAccountRegion,
  resolve: MessageResolver = m,
): string => {
  const choice = ACCOUNT_REGION_CHOICES.find((candidate) => candidate.value === region);
  return choice === undefined ? region : resolve(choice.label);
};

/** Where a hosted answer came from: DoeDesk Cloud names the region, which is shown by its name. */
export const servedFromLabel = (servedFrom: string, resolve: MessageResolver = m): string => {
  const choice = ACCOUNT_REGION_CHOICES.find((candidate) => candidate.value === servedFrom);
  return choice === undefined ? servedFrom : resolve(choice.label);
};

const DESTINATION: Readonly<Record<PrivacyAccountRegion, string>> = {
  sa: msg("the worker model at deep.sa, in Saudi Arabia according to deep.sa", {
    $context: "where a sealed file's text is sent; follows 'sends it to' or 'read by'",
  }),
  eu: msg("the worker model for the European Union region", {
    $context: "where a sealed file's text is sent; follows 'sends it to' or 'read by'",
  }),
  global: msg("OpenRouter's global endpoint", {
    $context: "where a sealed file's text is sent; follows 'sends it to' or 'read by'",
  }),
};

/** Where DoeDesk Cloud sends a sealed file's text, as a phrase for the longer sentences. */
const destinationOf = (
  reader: Extract<SealReader, { kind: "hosted" }>,
  resolve: MessageResolver,
): string =>
  reader.operator !== null
    ? resolve(
        msg("the worker model at {host} ({location})", {
          host: reader.operator.host,
          location: reader.operator.location,
          $context: "where a sealed file's text is sent; follows 'sends it to' or 'read by'",
        }),
      )
    : reader.region === null
      ? resolve(
          msg("the worker model for your account's region", {
            $context: "where a sealed file's text is sent; follows 'sends it to' or 'read by'",
          }),
        )
      : resolve(DESTINATION[reader.region]);

const SEAL_FILE_HOSTED: Readonly<Record<PrivacyAccountRegion, string>> = {
  sa: msg(
    "Each time your AI asks about this file, DoeDesk Cloud (in Saudi Arabia) receives the file's text and, without storing it, sends it to the worker model at deep.sa, in Saudi Arabia according to deep.sa. Your AI company does not receive the file; yes-or-no answers and choices from a list still reach it.",
  ),
  eu: msg(
    "Each time your AI asks about this file, DoeDesk Cloud (in Saudi Arabia) receives the file's text and, without storing it, sends it to the worker model for the European Union region. Your AI company does not receive the file; yes-or-no answers and choices from a list still reach it.",
  ),
  global: msg(
    "Each time your AI asks about this file, DoeDesk Cloud (in Saudi Arabia) receives the file's text and, without storing it, sends it to OpenRouter's global endpoint. Your AI company does not receive the file; yes-or-no answers and choices from a list still reach it.",
  ),
};

const whoReadsHosted = (
  reader: Extract<SealReader, { kind: "hosted" }>,
  subject: SealSubject,
  resolve: MessageResolver,
): string => {
  const destination = destinationOf(reader, resolve);
  switch (subject.kind) {
    case "file":
      return reader.operator === null && reader.region !== null
        ? resolve(SEAL_FILE_HOSTED[reader.region])
        : resolve(
            msg(
              "Each time your AI asks about this file, DoeDesk Cloud (in Saudi Arabia) receives the file's text and, without storing it, sends it to {destination}. Your AI company does not receive the file; yes-or-no answers and choices from a list still reach it.",
              { destination },
            ),
          );
    case "files":
      // Several were chosen, so one that can be read is one among them, not "this file".
      return subject.count === 1
        ? resolve(
            msg(
              "Each time your AI asks about the one file here that DoeDesk can read, DoeDesk Cloud (in Saudi Arabia) receives its text and, without storing it, sends it to {destination}. Your AI company does not receive the files; yes-or-no answers and choices from a list still reach it.",
              { destination },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Each time your AI asks about this file} other {Each time your AI asks about one of these {count} files}}, DoeDesk Cloud (in Saudi Arabia) receives that file's text and, without storing it, sends it to {destination}. Your AI company does not receive the files; yes-or-no answers and choices from a list still reach it.",
              { count: subject.count, destination },
            ),
          );
    case "folder":
      return resolve(
        msg(
          "{count, plural, =0 {Each time your AI asks about a file added to this folder} one {Each time your AI asks about the one file in this folder, or about a file added later} other {Each time your AI asks about one of the {count} files in this folder, or about a file added later}}, DoeDesk Cloud (in Saudi Arabia) receives that file's text and, without storing it, sends it to {destination}. Your AI company does not receive the files; yes-or-no answers and choices from a list still reach it.",
          { count: subject.count, destination },
        ),
      );
  }
};

const whoReadsOwnServer = (
  host: string,
  subject: SealSubject,
  resolve: MessageResolver,
): string => {
  switch (subject.kind) {
    case "file":
      return resolve(
        msg(
          "The model on your own server at {host} will read this file so your AI can ask about it. Your AI company will not receive the file; yes-or-no answers and choices from a list still reach it.",
          { host },
        ),
      );
    case "files":
      return subject.count === 1
        ? resolve(
            msg(
              "The model on your own server at {host} will read the one file here that DoeDesk can read, so your AI can ask about it. Your AI company will not receive the files; yes-or-no answers and choices from a list still reach it.",
              { host },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {The model on your own server at {host} will read this file so your AI can ask about it.} other {The model on your own server at {host} will read these {count} files so your AI can ask about them.}} Your AI company will not receive the files; yes-or-no answers and choices from a list still reach it.",
              { count: subject.count, host },
            ),
          );
    case "folder":
      return resolve(
        msg(
          "{count, plural, =0 {The model on your own server at {host} will read every file added to this folder so your AI can ask about it.} one {The model on your own server at {host} will read the one file in this folder, and every file added later, so your AI can ask about them.} other {The model on your own server at {host} will read the {count} files in this folder, and every file added later, so your AI can ask about them.}} Your AI company will not receive the files; yes-or-no answers and choices from a list still reach it.",
          { count: subject.count, host },
        ),
      );
  }
};

/**
 * The sentence every seal confirmation leads with: who will read the files, and what still
 * reaches the AI company. A new kind of reader adds its wording here and nowhere else.
 */
export const whoReadsSealedFiles = (
  reader: SealReader,
  subject: SealSubject,
  resolve: MessageResolver = m,
): string =>
  reader.kind === "hosted"
    ? whoReadsHosted(reader, subject, resolve)
    : whoReadsOwnServer(reader.host, subject, resolve);

/**
 * A PDF or an image is read by the reading service before it is sealed. That is DoeDesk Cloud
 * whenever masking is, whoever the worker is. `readFirst`: how many of the files are such.
 */
const readFirstSentence = (
  status: PrivacyStatus,
  subject: SealSubject,
  readFirst: number,
  resolve: MessageResolver,
): string | null => {
  if (readFirst <= 0) return null;
  const cloud =
    status.providers !== undefined
      ? status.providers.ocr.provider === "doedeskCloud"
      : status.mode === "cloud";
  if (subject.kind === "file") {
    return cloud
      ? resolve(
          msg(
            "This is a PDF or an image, so DoeDesk Cloud reads its text first in Saudi Arabia (without storing it), as it does for masking. The worker then reads that text.",
          ),
        )
      : resolve(
          msg(
            "This is a PDF or an image, so your reading service reads its text first, as it does for masking. The model then reads that text.",
          ),
        );
  }
  // The one file the sentence before named: "1 of them" would count a list of one.
  if (subject.count === 1) {
    return cloud
      ? resolve(
          msg(
            "That one file is a PDF or an image, so DoeDesk Cloud reads its text first in Saudi Arabia (without storing it), as it does for masking. The worker then reads that text.",
          ),
        )
      : resolve(
          msg(
            "That one file is a PDF or an image, so your reading service reads its text first, as it does for masking. The model then reads that text.",
          ),
        );
  }
  return cloud
    ? resolve(
        msg(
          "{count, plural, one {One of them is a PDF or an image, so DoeDesk Cloud reads its text first in Saudi Arabia (without storing it), as it does for masking. The worker then reads that text.} other {{count} of them are PDFs or images, so DoeDesk Cloud reads their text first in Saudi Arabia (without storing them), as it does for masking. The worker then reads that text.}}",
          { count: readFirst },
        ),
      )
    : resolve(
        msg(
          "{count, plural, one {One of them is a PDF or an image, so your reading service reads its text first, as it does for masking. The model then reads that text.} other {{count} of them are PDFs or images, so your reading service reads their text first, as it does for masking. The model then reads that text.}}",
          { count: readFirst },
        ),
      );
};

/**
 * What a seal confirmation says about who reads the files: who, each time, and who first for a
 * PDF or an image. Null: nobody is connected to read them.
 */
export const sealReaderLines = (
  status: PrivacyStatus | null,
  subject: SealSubject,
  readFirst: number,
  resolve: MessageResolver = m,
): ReadonlyArray<string> | null => {
  const reader = sealReader(status);
  if (status === null || reader === null) return null;
  // Several files of which none can be read: they are sealed, and sent to nobody.
  if (subject.kind === "files" && subject.count === 0) return [];
  const first = readFirstSentence(status, subject, readFirst, resolve);
  return [whoReadsSealedFiles(reader, subject, resolve), ...(first === null ? [] : [first])];
};

/**
 * The worker that gave an answer, as the record of clear answers names it: a hosted region
 * (`sa`, `eu`, `global`) or `custom:<host>`.
 */
export const answerRouteLabel = (route: string, resolve: MessageResolver = m): string => {
  const region = ACCOUNT_REGION_CHOICES.find((candidate) => candidate.value === route);
  if (region !== undefined) {
    return resolve(
      msg("Answered by DoeDesk Cloud's worker, {regionLabel}", {
        regionLabel: resolve(region.label),
      }),
    );
  }
  return route.startsWith("custom:")
    ? resolve(msg("Answered by your own server at {host}", { host: route.slice("custom:".length) }))
    : route;
};

const READ_BY_HOSTED: Readonly<Record<PrivacyAccountRegion, string>> = {
  sa: msg(
    "Sealed files are read through DoeDesk Cloud in Saudi Arabia by deep.sa, in Saudi Arabia according to deep.sa.",
  ),
  eu: msg(
    "Sealed files are read through DoeDesk Cloud in Saudi Arabia by the worker model for the European Union region.",
  ),
  global: msg(
    "Sealed files are read through DoeDesk Cloud in Saudi Arabia by OpenRouter's global endpoint.",
  ),
};

/** Beside a chat with sealed files: who reads them now, and whether that worker is answering. */
export const sealedReaderSentences = (
  status: PrivacyStatus,
  resolve: MessageResolver = m,
): ReadonlyArray<string> => {
  const reader = sealReader(status);
  if (reader === null) {
    return [
      status.worker?.notIncluded === true
        ? resolve(HOSTED_WORKER_NOT_INCLUDED)
        : hostedWorkerNotInRegion(status)
          ? resolve(HOSTED_WORKER_NOT_IN_REGION)
          : resolve(msg("No worker is connected, so your AI cannot ask about sealed files.")),
    ];
  }
  if (reader.kind === "ownServer") {
    return [
      resolve(msg("Sealed files are read by your own server at {host}.", { host: reader.host })),
    ];
  }
  return [
    reader.operator === null && reader.region !== null
      ? resolve(READ_BY_HOSTED[reader.region])
      : resolve(
          msg("Sealed files are read through DoeDesk Cloud in Saudi Arabia by {destination}.", {
            destination: destinationOf(reader, resolve),
          }),
        ),
    ...(status.worker?.available === false
      ? [
          resolve(
            msg(
              "The worker in this region is not answering. DoeDesk does not route sealed files to another region.",
            ),
          ),
        ]
      : status.worker?.busy != null
        ? [
            // Busy is a state, not a failure: the worker is answering other people first.
            resolve(
              msg(
                "{count, plural, one {The worker in this region is busy, with {count} waiting.} other {The worker in this region is busy, with {count} waiting.}} DoeDesk does not route sealed files to another region.",
                { count: status.worker.busy.waiting },
              ),
            ),
          ]
        : []),
  ];
};

const HOSTED_DISCLOSURE: Readonly<Record<PrivacyAccountRegion, string>> = {
  sa: msg(
    "Sealed files are sent whole, with nothing masked, through DoeDesk Cloud in Saudi Arabia to deep.sa, in Saudi Arabia according to deep.sa. DoeDesk Cloud does not store them.",
  ),
  eu: msg(
    "Sealed files are sent whole, with nothing masked, through DoeDesk Cloud in Saudi Arabia to the worker model for the European Union region. DoeDesk Cloud does not store them.",
  ),
  global: msg(
    "Sealed files are sent whole, with nothing masked, through DoeDesk Cloud in Saudi Arabia to OpenRouter's global endpoint. DoeDesk Cloud does not store them.",
  ),
};

/** Settings, under who reads sealed files: where DoeDesk Cloud's worker sends them. */
export const hostedWorkerDisclosure = (
  status: PrivacyStatus,
  resolve: MessageResolver = m,
): string => {
  const reader = hostedReader(status);
  return reader.operator === null && reader.region !== null
    ? resolve(HOSTED_DISCLOSURE[reader.region])
    : resolve(
        msg(
          "Sealed files are sent whole, with nothing masked, through DoeDesk Cloud in Saudi Arabia to {destination}. DoeDesk Cloud does not store them.",
          { destination: destinationOf(reader, resolve) },
        ),
      );
};

const REGION_EXPLAINED: Readonly<Record<PrivacyAccountRegion, string>> = {
  sa: msg(
    "Controls where DoeDesk Cloud runs the worker model for sealed files: deep.sa, in Saudi Arabia according to deep.sa. Detection, PDF and image reading, and your account also run on DoeDesk Cloud in Saudi Arabia.",
  ),
  eu: msg(
    "DoeDesk Cloud's worker for sealed files is not available in the European Union region yet. An account in this region reads sealed files with its own server. Detection, PDF and image reading, and your account run on DoeDesk Cloud in Saudi Arabia.",
  ),
  global: msg(
    "Controls where DoeDesk Cloud runs the worker model for sealed files: OpenRouter's global endpoint, with no region restriction. Detection, PDF and image reading, your account, and worker requests in transit still pass through DoeDesk Cloud in Saudi Arabia.",
  ),
};

/** Settings, under the account: what the region changes, and what it does not. */
export const accountRegionExplained = (
  status: PrivacyStatus,
  region: PrivacyAccountRegion,
  resolve: MessageResolver = m,
): string => {
  const operator = reportedOperator(status, region);
  return operator === null
    ? resolve(REGION_EXPLAINED[region])
    : resolve(
        msg(
          "Controls where DoeDesk Cloud runs the worker model for sealed files: {host} ({location}). Detection, PDF and image reading, your account, and worker requests in transit still pass through DoeDesk Cloud in Saudi Arabia.",
          { host: operator.host, location: operator.location },
        ),
      );
};
