import {
  managedRuntimeModeDenial,
  providerRuntimeModeLimitMessage,
} from "@t3tools/client-runtime/contract-labels";
import type {
  ManagedPolicySummary,
  ProviderRuntimeModeLimit,
  RuntimeMode,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import { m, type MessageResolver } from "~/i18n/messages";
import {
  type LucideIcon,
  LockIcon,
  PenLineIcon,
  ShieldCheckIcon,
  ShieldOffIcon,
} from "lucide-react";

import { isDeveloperMode } from "~/doedesk/product";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: msg("Ask first", { $context: "permission mode, agent asks before acting" }),
    description: msg("Ask before changing files or running commands."),
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: msg("Auto-accept edits"),
    description: msg("Auto-approve edits, ask before other actions."),
    icon: PenLineIcon,
  },
  auto: {
    label: msg("Auto", { $context: "permission mode, provider approves routine actions" }),
    description: msg("Supported providers approve routine actions; others still ask."),
    icon: ShieldCheckIcon,
  },
  "full-access": {
    label: msg("Don't ask"),
    description: msg("Change files and run commands without asking."),
    // An open lock reads like a closed one at small sizes; a crossed shield does not.
    icon: ShieldOffIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

const PLAIN_RUNTIME_MODES: ReadonlySet<RuntimeMode> = new Set(["approval-required", "full-access"]);

/**
 * The modes to offer. Outside Developer mode that is the two plain choices, ask or do not ask,
 * plus whichever mode is already in use so it stays visible.
 */
export function offeredRuntimeModes(
  modes: ReadonlyArray<RuntimeMode>,
  current: RuntimeMode | undefined,
): ReadonlyArray<RuntimeMode> {
  if (isDeveloperMode()) return modes;
  return modes.filter((mode) => PLAIN_RUNTIME_MODES.has(mode) || mode === current);
}

/** The modes a provider supports (all when it reports none) and the mode a thread really runs in. */
export function resolveCompatibleRuntimeMode(
  runtimeMode: RuntimeMode,
  supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined,
) {
  const modes =
    supportedRuntimeModes && supportedRuntimeModes.length > 0
      ? runtimeModeOptions.filter((mode) => supportedRuntimeModes.includes(mode))
      : runtimeModeOptions;
  const mode = modes.includes(runtimeMode) ? runtimeMode : (modes[0] ?? runtimeMode);
  return { modes: offeredRuntimeModes(modes, mode), mode };
}

/**
 * The modes a draft's send can run in. A multi-model send gives every thread the draft's mode
 * and only that thread's provider narrows it, so the composer offers what any of them supports.
 */
export function draftSupportedRuntimeModes(
  activeProviderModes: ReadonlyArray<RuntimeMode> | undefined,
  multipleModelSelections: ReadonlyArray<{ readonly instanceId: string }> | null,
  providers: ReadonlyArray<{
    readonly instanceId: string;
    readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined;
  }>,
) {
  if (multipleModelSelections === null || multipleModelSelections.length === 0) {
    return activeProviderModes;
  }
  const supported = multipleModelSelections.map(
    (selection) =>
      providers.find((provider) => provider.instanceId === selection.instanceId)
        ?.supportedRuntimeModes ?? [],
  );
  // A provider that reports no modes supports them all.
  if (supported.some((modes) => modes.length === 0)) return undefined;
  return runtimeModeOptions.filter((mode) => supported.some((modes) => modes.includes(mode)));
}

/**
 * The provider whose folder limits a draft's send is under: the one every thread it starts will
 * use. Selected models on different providers share none, so no one provider's limits apply.
 */
export function draftRuntimeModeLimitsInstance<InstanceId extends string>(
  activeInstanceId: InstanceId | undefined,
  multipleModelSelections: ReadonlyArray<{ readonly instanceId: InstanceId }> | null,
): InstanceId | undefined {
  const first = multipleModelSelections?.[0];
  if (multipleModelSelections === null || first === undefined) return activeInstanceId;
  return multipleModelSelections.every((selection) => selection.instanceId === first.instanceId)
    ? first.instanceId
    : undefined;
}

export function resolveRuntimeModeOption(
  mode: RuntimeMode,
  resolve: MessageResolver = m,
): {
  mode: RuntimeMode;
  label: string;
  description: string;
  icon: LucideIcon;
  disabledReason?: string;
} {
  const config = runtimeModeConfig[mode];
  return {
    mode,
    ...config,
    label: resolve(config.label),
    description: resolve(config.description),
  };
}

/** Why `mode` is unavailable under `managedPolicy`, or undefined when it is allowed. */
export function runtimeModeDenial(
  managedPolicy: ManagedPolicySummary | undefined,
  mode: RuntimeMode,
  resolve: MessageResolver = m,
) {
  const ceiling = managedPolicy?.limits?.maxRuntimeMode;
  if (ceiling === undefined || managedRuntimeModeDenial(managedPolicy, mode) === undefined) {
    return undefined;
  }
  return resolve(
    msg("{organization} limits threads to {mode}.", {
      organization: managedPolicy!.organization,
      mode: resolve(runtimeModeConfig[ceiling].label),
    }),
  );
}

/**
 * `limits` are modes the provider cannot run in the current folder. They stay listed, disabled
 * with the reason; a thread already in one keeps it and shows that reason as its description.
 */
export function resolveRuntimeModeOptions(
  modes: ReadonlyArray<RuntimeMode>,
  managedPolicy: ManagedPolicySummary | undefined,
  resolve: MessageResolver = m,
  limits?: ReadonlyArray<ProviderRuntimeModeLimit>,
) {
  return modes.map((mode) => {
    const option = resolveRuntimeModeOption(mode, resolve);
    const disabledReason =
      runtimeModeDenial(managedPolicy, mode, resolve) ??
      providerRuntimeModeLimitMessage(limits, mode, resolve);
    return disabledReason === undefined ? option : { ...option, disabledReason };
  });
}
