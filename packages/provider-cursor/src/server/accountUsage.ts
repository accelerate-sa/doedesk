import type { UsageRecord } from "@t3tools/provider-core/server/usage";

// Grok's xAI first-party rate entry has no bare alias.
export function cursorRateModel(model: string): string {
  const base = model
    .replace(/^cursor-/, "")
    .replace(/(?:-thinking)?(?:-(?:none|minimal|low|medium|high|xhigh|max))?(?:-fast)?$/, "");
  return base.startsWith("grok-") ? `xai/${base}` : base;
}

export interface CursorAccountUsageReadResult {
  readonly accountKey: string | null;
  readonly records: readonly UsageRecord[];
  readonly missing: boolean;
  readonly error: string | null;
}
