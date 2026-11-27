import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ShieldCheckIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";

import { useDeidentificationOffered } from "./useDeidentificationOffered";
import { WorkspaceDeidentifyDrawer } from "./WorkspaceDeidentifyDrawer";

/** The way into a folder's review, shown where its files can be de-identified from here. */
export function WorkspaceDeidentifyButton({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: string | null;
}) {
  const gt = useGT();
  const offered = useDeidentificationOffered(environmentId, projectId);
  const [open, setOpen] = useState(false);
  if (!offered) return null;
  const label = gt("Review files");
  return (
    <span className="shrink-0 [-webkit-app-region:no-drag]">
      <SharedTooltipTrigger
        label={label}
        render={
          <Button aria-label={label} onClick={() => setOpen(true)} size="icon-sm" variant="ghost" />
        }
        side="bottom"
      >
        <ShieldCheckIcon />
      </SharedTooltipTrigger>
      <WorkspaceDeidentifyDrawer onOpenChange={setOpen} open={open} projectId={projectId} />
    </span>
  );
}
