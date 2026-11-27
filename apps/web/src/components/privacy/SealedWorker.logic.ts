import type {
  PrivacyClearAnswer,
  PrivacyEgressPolicy,
  PrivacyStatus,
  PrivacyWorkerKind,
  PrivacyWorkerRequest,
  PrivacyWorkerStatus,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";
import {
  HOSTED_WORKER_NOT_IN_REGION,
  HOSTED_WORKER_NOT_INCLUDED,
  hostedWorkerDisclosure,
  hostedWorkerNotInRegion,
} from "./sealReader";

const NO_WORKER: PrivacyWorkerStatus = {
  kind: "off",
  address: null,
  model: null,
  driver: null,
  reasoningEffort: null,
  available: false,
  servedFrom: null,
};

/** A server from before the worker existed reports none. */
export const workerOf = (status: PrivacyStatus): PrivacyWorkerStatus => status.worker ?? NO_WORKER;

/**
 * Where sealed documents go, said plainly: the worker receives them whole and unmasked, which
 * is the one thing a person has to know before choosing an address.
 */
export const workerDisclosure = (
  worker: PrivacyWorkerStatus,
  status: PrivacyStatus,
  resolve: MessageResolver = m,
): string => {
  switch (worker.kind) {
    case "off":
      return worker.notIncluded === true
        ? resolve(HOSTED_WORKER_NOT_INCLUDED)
        : resolve(msg("No worker is connected, so agents cannot ask about sealed files."));
    case "cloud":
      return hostedWorkerNotInRegion(status)
        ? resolve(HOSTED_WORKER_NOT_IN_REGION)
        : hostedWorkerDisclosure(status, resolve);
    case "custom":
      return worker.address === null
        ? resolve(
            msg(
              "Sealed files are sent whole, with nothing masked, to the address you gave. If that is not a server you control, they leave your control.",
            ),
          )
        : resolve(
            msg(
              "Sealed files are sent whole, with nothing masked, to {address}. If that is not a server you control, they leave your control.",
              { address: worker.address },
            ),
          );
  }
};

/** The choice of worker, with the person's own server as typed into Settings or before sealing. */
export interface WorkerForm {
  readonly kind: PrivacyWorkerKind;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly driver: "chatCompletions" | "responses";
  readonly reasoningEffort: string;
}

/** The request a filled form makes, or the reason it cannot be sent yet, as a `msg()` string. */
export const workerRequest = (
  form: WorkerForm,
): { readonly request: PrivacyWorkerRequest } | { readonly problem: string } => {
  const text = (value: string) => value.trim();
  switch (form.kind) {
    case "off":
    case "cloud":
      return { request: { kind: form.kind } };
    case "custom":
      if (text(form.baseUrl) === "") return { problem: msg("Enter the server's address.") };
      if (text(form.model) === "") return { problem: msg("Enter the model's name.") };
      return {
        request: {
          kind: "custom",
          baseUrl: text(form.baseUrl),
          model: text(form.model),
          driver: form.driver,
          ...(text(form.apiKey) === "" ? {} : { apiKey: text(form.apiKey) }),
          ...(text(form.reasoningEffort) === ""
            ? {}
            : { reasoningEffort: text(form.reasoningEffort) }),
        },
      };
  }
};

export const EGRESS_CHOICES: ReadonlyArray<{
  readonly value: PrivacyEgressPolicy;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "open",
    label: msg("Any host"),
    description: msg(
      "Agents' tools can reach any host. A command an agent runs can send real values there.",
    ),
  },
  {
    value: "allowlist",
    label: msg("Listed hosts only"),
    description: msg(
      "Agents' tools reach AI hosts and the hosts you list. Everything else is refused.",
    ),
  },
  {
    value: "closed",
    label: msg("AI hosts only"),
    description: msg(
      "Agents' tools reach AI hosts and nothing else: no downloads, no web pages, no remote tools.",
    ),
  },
];

export const egressOf = (status: PrivacyStatus): NonNullable<PrivacyStatus["egress"]> =>
  status.egress ?? { policy: "open", hosts: [] };

/** Host names out of what a person typed: one per line or separated by commas or spaces. */
export const parseHosts = (text: string): ReadonlyArray<string> => [
  ...new Set(
    text
      .split(/[\s,]+/)
      .map((host) =>
        host
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/[/:].*$/, ""),
      )
      .filter((host) => /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(host) || host === "localhost"),
  ),
];

/** An answer that reached the AI as it is, in the person's language. */
export const describeClearAnswer = (
  answer: Pick<PrivacyClearAnswer, "kind" | "value">,
  resolve: MessageResolver = m,
): string => {
  switch (answer.kind) {
    case "yes":
      return resolve(msg("Yes", { $context: "the answer to a yes-or-no question" }));
    case "no":
      return resolve(msg("No", { $context: "the answer to a yes-or-no question" }));
    case "notStated":
      return resolve(msg("Not stated", { $context: "the document does not state the answer" }));
    case "unchecked":
      return resolve(
        msg("Could not be checked", {
          $context: "no answer passed the check against the document",
        }),
      );
    case "ran":
      return answer.value === null
        ? resolve(msg("Program ran; every result stayed sealed"))
        : resolve(msg("Program ran and showed: {shown}", { shown: answer.value }));
    case "failed":
      return resolve(
        msg("Program failed, and your AI was not told why: {reason}", {
          reason: answer.value ?? "",
        }),
      );
    case "value":
      return answer.value ?? "";
  }
};
