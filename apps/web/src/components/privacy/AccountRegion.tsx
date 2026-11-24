import type { PrivacyAccountRegion, PrivacyStatus } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { useState } from "react";

import { CLOUD_MESSAGES, NOT_WORKED, UNREACHABLE } from "~/doedesk/privacyMessages";
import { accountAction } from "~/privacy/privacyClient";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ACCOUNT_REGION_CHOICES, accountRegionLabel } from "./sealReader";

/**
 * Changing the account's region, wherever the person does it: under the account in Settings,
 * beside the worker, and in the dialog that precedes sealing. A change is confirmed first when
 * files are sealed, because their next questions go to the new region.
 */
export function useAccountRegionChange(status: PrivacyStatus) {
  const resolve = useMessages();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PrivacyAccountRegion | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const region = status.accountRegion ?? null;
  const sealed = (status.sealedDocuments ?? 0) > 0;

  // Promise chains rather than try/finally, which React Compiler cannot optimize.
  const change = (next: PrivacyAccountRegion) => {
    setBusy(true);
    setProblem(null);
    void accountAction({ action: "setRegion", region: next })
      .then((result) => {
        if (result.ok) return setPending(null);
        const known = result.code === null ? undefined : CLOUD_MESSAGES[result.code];
        setProblem(known === undefined ? (result.message ?? resolve(NOT_WORKED)) : resolve(known));
      })
      .catch(() => setProblem(resolve(UNREACHABLE)))
      .finally(() => setBusy(false));
  };
  return {
    region,
    pending,
    busy,
    problem,
    choose: (next: PrivacyAccountRegion) => {
      setProblem(null);
      if (next === region) return setPending(null);
      if (sealed) return setPending(next);
      change(next);
    },
    confirm: () => (pending === null ? undefined : change(pending)),
    cancel: () => setPending(null),
  };
}

type RegionChange = ReturnType<typeof useAccountRegionChange>;

export function AccountRegionSelect({ change }: { readonly change: RegionChange }) {
  const gt = useGT();
  const resolve = useMessages();
  const shown = change.pending ?? change.region;
  return (
    <Select
      value={shown ?? ""}
      disabled={change.busy}
      onValueChange={(value) => {
        const next = ACCOUNT_REGION_CHOICES.find((choice) => choice.value === value)?.value;
        if (next !== undefined) change.choose(next);
      }}
    >
      <SelectTrigger aria-label={gt("Account region")} className="w-44" size="sm">
        <SelectValue>
          {shown === null
            ? gt("Not known yet", { $context: "the account's region has not been read yet" })
            : accountRegionLabel(shown, resolve)}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {ACCOUNT_REGION_CHOICES.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {resolve(choice.label)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** The question asked before a change when files are sealed, and what went wrong with one. */
export function AccountRegionNotice({ change }: { readonly change: RegionChange }) {
  const gt = useGT();
  const resolve = useMessages();
  if (change.pending === null && change.problem === null) return null;
  return (
    <div className="grid gap-2 text-start">
      {change.pending === null ? null : (
        <>
          <p className="text-sm">
            {gt(
              "Future questions about your sealed files will use {regionLabel}. Already sealed files stay encrypted on this computer.",
              { regionLabel: accountRegionLabel(change.pending, resolve) },
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={change.busy} onClick={change.confirm}>
              {gt("Change region")}
            </Button>
            <Button size="sm" variant="outline" disabled={change.busy} onClick={change.cancel}>
              {gt("Keep the current region")}
            </Button>
          </div>
        </>
      )}
      {change.problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {change.problem}
        </p>
      )}
    </div>
  );
}
