import type {
  DeidentifyPolicy,
  DeidentifyWorkspace,
  DeidentifyWorkspaceFile,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { FolderSearchIcon, ScanSearchIcon, TriangleAlertIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Sheet, SheetPopup, SheetTitle } from "~/components/ui/sheet";
import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";
import { Spinner } from "~/components/ui/spinner";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";
import { type DeidentifyClient, liveDeidentifyClient } from "~/privacy/deidentifyClient";

import { DeidentifyStudioDialog } from "./DeidentifyStudioDialog";
import { FAILURE_LABELS, FAMILY_ICONS, STATUS_DOTS, STATUS_LABELS } from "./deidentifyLabels";
import { matchesFilter, type QueueFilter } from "./deidentifyModel";

type Listing = Extract<DeidentifyWorkspace, { readonly ok: true }>;

const FILTERS: ReadonlyArray<{ readonly value: QueueFilter; readonly label: string }> = [
  { value: "needsReview", label: msg("Needs review") },
  {
    value: "changed",
    label: msg("Changed", { $context: "files that changed since their review" }),
  },
  { value: "reviewed", label: msg("Reviewed") },
  { value: "all", label: msg("All", { $context: "all files" }) },
];

/** A few files for each request, so the list fills in while a long folder is checked. */
const SCAN_BATCH = 3;

const isFilter = (value: unknown): value is QueueFilter =>
  FILTERS.some((filter) => filter.value === value);

function FileRow({ file, onOpen }: { file: DeidentifyWorkspaceFile; onOpen: () => void }) {
  const m = useMessages();
  const Icon = FAMILY_ICONS[file.family];
  const slash = file.path.lastIndexOf("/");
  const folder = slash === -1 ? "" : file.path.slice(0, slash);
  const status = m(STATUS_LABELS[file.status]);
  return (
    <li>
      <button
        className="flex w-full items-center gap-2.5 px-4 py-2 text-start outline-none hover:bg-accent focus-visible:bg-accent"
        data-path={file.path}
        data-status={file.status}
        onClick={onOpen}
        type="button"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm" dir="auto">
            {file.path.slice(slash + 1)}
          </span>
          {folder === "" ? null : (
            <span className="block truncate text-muted-foreground text-xs" dir="ltr">
              {folder}
            </span>
          )}
        </span>
        {file.itemCount > 0 ? (
          <span className="rounded-full bg-warning/20 px-1.5 text-warning-foreground text-xs tabular-nums">
            {file.itemCount}
          </span>
        ) : null}
        <SharedTooltipTrigger
          label={status}
          render={
            <span
              aria-label={status}
              className={cn("size-2 shrink-0 rounded-full", STATUS_DOTS[file.status])}
              role="img"
            />
          }
        />
      </button>
    </li>
  );
}

function DrawerBody({ client, projectId }: { client: DeidentifyClient; projectId: string }) {
  const gt = useGT();
  const m = useMessages();
  const requireId = useId();
  const sendId = useId();
  const [listing, setListing] = useState<DeidentifyWorkspace | null>(null);
  const [filter, setFilter] = useState<QueueFilter>("needsReview");
  const [query, setQuery] = useState("");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  // The files being gone through, kept as they were when the first was opened: a file does
  // not leave the list under the person the moment it is marked reviewed.
  const [session, setSession] = useState<{ paths: ReadonlyArray<string>; index: number } | null>(
    null,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the folder's files from the server when the drawer opens
  useEffect(() => {
    let live = true;
    void client.workspace(projectId).then((result) => {
      if (live) setListing(result);
    });
    return () => {
      live = false;
    };
  }, [client, projectId]);

  const refresh = async () => setListing(await client.workspace(projectId));

  const scanAll = async (current: Listing) => {
    const paths = current.files
      .filter((file) => file.status === "notScanned" || file.status === "stale")
      .map((file) => file.path);
    if (paths.length === 0) return;
    setProgress({ done: 0, total: paths.length });
    for (let from = 0; from < paths.length; from += SCAN_BATCH) {
      setListing(await client.scan(projectId, paths.slice(from, from + SCAN_BATCH)));
      setProgress({ done: Math.min(paths.length, from + SCAN_BATCH), total: paths.length });
    }
    setProgress(null);
  };

  const setPolicy = async (policy: Partial<DeidentifyPolicy>, current: Listing) => {
    setListing({ ...current, policy: { ...current.policy, ...policy } });
    const saved = await client.policy({ projectId, policy });
    if (saved !== null) setListing({ ...current, policy: saved });
  };

  if (listing === null) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!listing.ok) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
        <TriangleAlertIcon className="size-6 opacity-60" />
        <p className="text-sm">{m(FAILURE_LABELS[listing.reason])}</p>
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const shown = listing.files.filter(
    (file) =>
      matchesFilter(file.status, filter) &&
      (needle === "" || file.path.toLowerCase().includes(needle)),
  );
  const openPath = session === null ? undefined : session.paths[session.index];
  const scanLabel = gt("Scan all");

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 ps-4 pe-12 pt-3 pb-3">
        <div className="min-w-0 flex-1">
          <SheetTitle>
            <T>Review files</T>
          </SheetTitle>
        </div>
        <Button
          disabled={progress !== null}
          onClick={() => void scanAll(listing)}
          size="sm"
          variant="outline"
        >
          {progress === null ? <ScanSearchIcon /> : <Spinner />}
          {progress === null ? scanLabel : `${progress.done} / ${progress.total}`}
        </Button>
      </div>
      <div className="flex shrink-0 flex-col gap-2 border-b px-4 pb-3">
        <ToggleGroup
          aria-label={gt("Filter", { $context: "which files are listed" })}
          className="w-full *:flex-1"
          onValueChange={(next) => {
            if (isFilter(next[0])) setFilter(next[0]);
          }}
          value={[filter]}
        >
          {FILTERS.map((option) => (
            <Toggle key={option.value} value={option.value}>
              {m(option.label)}
            </Toggle>
          ))}
        </ToggleGroup>
        <Input
          aria-label={gt("Search files")}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={gt("Search", { $context: "placeholder of a search box" })}
          size="compact"
          type="search"
          value={query}
        />
      </div>
      {shown.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
          <FolderSearchIcon className="size-6 opacity-60" />
          <p className="text-xs">
            <T>No files</T>
          </p>
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y overflow-y-auto">
          {shown.map((file, index) => (
            <FileRow
              file={file}
              key={file.path}
              onOpen={() => setSession({ paths: shown.map((entry) => entry.path), index })}
            />
          ))}
        </ul>
      )}
      <div className="flex shrink-0 flex-col gap-2 border-t px-4 py-3 text-xs">
        <label className="flex items-center justify-between gap-3" htmlFor={requireId}>
          <T>Require review before AI</T>
          <Switch
            checked={listing.policy.requireReviewBeforeAi}
            id={requireId}
            onCheckedChange={(checked) =>
              void setPolicy({ requireReviewBeforeAi: checked }, listing)
            }
            size="sm"
          />
        </label>
        <label className="flex items-center justify-between gap-3" htmlFor={sendId}>
          <T>Review attachments before sending</T>
          <Switch
            checked={listing.policy.alwaysReviewBeforeSend}
            id={sendId}
            onCheckedChange={(checked) =>
              void setPolicy({ alwaysReviewBeforeSend: checked }, listing)
            }
            size="sm"
          />
        </label>
      </div>
      <DeidentifyStudioDialog
        client={client}
        file={openPath === undefined ? null : { kind: "workspace", projectId, path: openPath }}
        onOpenChange={(open) => {
          if (open) return;
          setSession(null);
          void refresh();
        }}
        onReviewed={() => void refresh()}
        open={openPath !== undefined}
        {...(session === null
          ? {}
          : {
              queue: {
                position: session.index + 1,
                total: session.paths.length,
                onPrevious:
                  session.index > 0
                    ? () => setSession({ ...session, index: session.index - 1 })
                    : null,
                onNext:
                  session.index < session.paths.length - 1
                    ? () => setSession({ ...session, index: session.index + 1 })
                    : null,
              },
            })}
      />
    </>
  );
}

/**
 * A folder's files, to review one after another before an agent works with them: which need a
 * look, which changed since their review, and which are done.
 */
export function WorkspaceDeidentifyDrawer({
  client = liveDeidentifyClient,
  projectId,
  open,
  onOpenChange,
}: {
  readonly client?: DeidentifyClient;
  readonly projectId: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetPopup className="w-[min(92vw,28rem)] max-w-none" side="right">
        {open && projectId !== null ? (
          <DrawerBody client={client} key={projectId} projectId={projectId} />
        ) : null}
      </SheetPopup>
    </Sheet>
  );
}
