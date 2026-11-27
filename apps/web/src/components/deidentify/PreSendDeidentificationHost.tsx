import { T, useGT } from "gt-react";
import { CheckIcon, TriangleAlertIcon } from "lucide-react";

import {
  Dialog,
  DialogAction,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Spinner } from "~/components/ui/spinner";

import { DeidentifyStudioDialog } from "./DeidentifyStudioDialog";
import type { PreSendController, PreSendEntry } from "./usePreSendDeidentification";

function WaitingRow({ entry }: { entry: PreSendEntry }) {
  return (
    <li className="flex items-center gap-2 py-1.5" data-status={entry.status}>
      <span className="min-w-0 flex-1 truncate text-sm" dir="auto">
        {entry.name}
      </span>
      {entry.status === "scanning" ? <Spinner /> : null}
      {entry.status === "failed" ? (
        <TriangleAlertIcon className="size-4 text-warning-foreground" />
      ) : null}
      {entry.status === "reviewed" ? <CheckIcon className="size-4 text-success" /> : null}
      {entry.itemCount > 0 && entry.status !== "reviewed" ? (
        <span className="rounded-full bg-warning/20 px-1.5 text-warning-foreground text-xs tabular-nums">
          {entry.itemCount}
        </span>
      ) : null}
    </li>
  );
}

/**
 * What a message's attachments need before it is sent: the short list of files still waiting
 * for a review, one button to go through them, and the studio they are reviewed in.
 */
export function PreSendDeidentificationHost({ controller }: { controller: PreSendController }) {
  const gt = useGT();
  const waiting = controller.waitingOn;
  const allReviewed = waiting !== null && waiting.length === 0;
  const checking = waiting?.some((entry) => entry.status === "scanning") === true;
  return (
    <>
      <Dialog
        onOpenChange={(open) => {
          if (!open) controller.releaseHeld();
        }}
        open={waiting !== null && controller.studio === null}
      >
        <DialogPopup className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {allReviewed ? <T>Ready to send</T> : <T>Review before sending</T>}
            </DialogTitle>
          </DialogHeader>
          {waiting === null || waiting.length === 0 ? null : (
            <DialogPanel>
              <ul aria-label={gt("Files to review")} className="divide-y">
                {waiting.map((entry) => (
                  <WaitingRow entry={entry} key={entry.id} />
                ))}
              </ul>
            </DialogPanel>
          )}
          <DialogFooter>
            <DialogAction onClick={controller.releaseHeld} variant="ghost">
              <T>Cancel</T>
            </DialogAction>
            {allReviewed ? (
              <DialogAction onClick={controller.sendHeld}>
                <T>Send</T>
              </DialogAction>
            ) : (
              <DialogAction disabled={checking} onClick={controller.reviewWaiting}>
                <T>Review</T>
              </DialogAction>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <DeidentifyStudioDialog
        client={controller.deidentify}
        file={controller.studio?.file ?? null}
        onOpenChange={(open) => {
          if (!open) controller.studio?.onClose();
        }}
        open={controller.studio !== null}
        {...(controller.studio === null
          ? {}
          : {
              onReviewed: controller.studio.onReviewed,
              ...(controller.studio.queue === undefined ? {} : { queue: controller.studio.queue }),
            })}
      />
    </>
  );
}
