import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { msg } from "gt-react";

import type { MessageResolver } from "~/i18n/messages";

/**
 * The names the built-in model catalogs give their options. The server sends them in English;
 * a name that is not here, such as a custom model's, is shown as sent.
 */
const KNOWN_OPTION_LABELS: Readonly<Record<string, string>> = {
  Reasoning: msg("Reasoning", { $context: "model option: how much the model thinks" }),
  "Service Tier": msg("Service Tier", { $context: "model option: speed of the service" }),
  "Cyber Access": msg("Cyber Access", { $context: "model option: a security research program" }),
  None: msg("None", { $context: "reasoning level" }),
  Minimal: msg("Minimal", { $context: "reasoning level" }),
  Low: msg("Low", { $context: "reasoning level" }),
  Medium: msg("Medium", { $context: "reasoning level" }),
  High: msg("High", { $context: "reasoning level" }),
  "Extra High": msg("Extra High", { $context: "reasoning level" }),
  Max: msg("Max", { $context: "reasoning level" }),
  Ultra: msg("Ultra", { $context: "reasoning level" }),
  Standard: msg("Standard", { $context: "model option: the usual service speed or program" }),
  Fast: msg("Fast", { $context: "model option: a faster service speed" }),
};

const localized = (label: string, resolve: MessageResolver): string => {
  const known = Object.hasOwn(KNOWN_OPTION_LABELS, label) ? KNOWN_OPTION_LABELS[label] : undefined;
  return known === undefined ? label : resolve(known);
};

export function localizeProviderOptionDescriptor(
  descriptor: ProviderOptionDescriptor,
  resolve: MessageResolver,
): ProviderOptionDescriptor {
  const label = localized(descriptor.label, resolve);
  return descriptor.type === "select"
    ? {
        ...descriptor,
        label,
        options: descriptor.options.map((option) => ({
          ...option,
          label: localized(option.label, resolve),
        })),
      }
    : { ...descriptor, label };
}
