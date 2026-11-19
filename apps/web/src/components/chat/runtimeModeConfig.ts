import {
  managedRuntimeModeDenial,
  type ManagedPolicySummary,
  type RuntimeMode,
} from "@t3tools/contracts";
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
    label: "Ask first",
    description: "Ask before changing files or running commands.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: ShieldCheckIcon,
  },
  "full-access": {
    label: "Don't ask",
    description: "Change files and run commands without asking.",
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

export function resolveRuntimeModeOptions(
  modes: ReadonlyArray<RuntimeMode>,
  managedPolicy: ManagedPolicySummary | undefined,
) {
  return modes.map((mode) => {
    const option = { mode, ...runtimeModeConfig[mode] };
    const disabledReason = managedRuntimeModeDenial(managedPolicy, mode);
    return disabledReason === undefined ? option : { ...option, disabledReason };
  });
}
