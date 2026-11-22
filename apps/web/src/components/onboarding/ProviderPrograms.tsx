import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderFind,
  type ProviderVolume,
  type ProviderVolumeSearchProgress,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { isRtlLocale } from "@t3tools/client-runtime/locales";
import { resolveProviderInstanceDisplayName as agentName } from "@t3tools/client-runtime/state/provider-instance-display";
import { useGT, useLocale } from "gt-react";
import { CheckIcon, ChevronDownIcon, FolderSearchIcon, HardDriveIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import {
  groupProviderPrograms,
  manualProgramPlaceholder,
  type ProviderPrograms,
  volumesToOffer,
} from "../../onboarding/providerPrograms.logic";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

const COMMAND_OPTIONS = { reportFailure: false, reportDefect: false } as const;
const SEARCH_LIMIT_MINUTES = 2;

/**
 * Where each AI's program is on this computer. The usual places are checked on their own; other
 * drives are searched only after the person ticks them. A choice is kept in the provider's own
 * settings as its program path, the same field Settings shows.
 */
export function ProviderPrograms({
  environmentId,
  providers,
  settings,
  platformOs,
}: {
  readonly environmentId: EnvironmentId;
  /** The providers the setup page offers, in its order. */
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerSettings, "providerInstances"> | null | undefined;
  readonly platformOs?: string | null | undefined;
}) {
  const gt = useGT();
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const scan = useAtomCommand(serverEnvironment.scanProviderPrograms, COMMAND_OPTIONS);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, COMMAND_OPTIONS);
  const persistInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const [open, setOpen] = useState(false);
  const [automatic, setAutomatic] = useState<ReadonlyArray<ProviderFind> | null>(null);
  const [scanFailed, setScanFailed] = useState(false);
  const [extra, setExtra] = useState<ReadonlyArray<ProviderFind>>([]);
  const [saving, setSaving] = useState<string | null>(null);
  const [drivesOpen, setDrivesOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [search, setSearch] = useState<{ readonly volumes: ReadonlyArray<string> } | null>(null);
  const [lastSearch, setLastSearch] = useState<ProviderVolumeSearchProgress | null>(null);
  const searchQuery = useEnvironmentQuery(
    search === null
      ? null
      : serverEnvironment.providerVolumeSearch({ environmentId, input: search }),
  );
  // The last report is kept, so the finds stay listed once the stream ends or is stopped.
  if (searchQuery.data !== null && searchQuery.data !== lastSearch) {
    setLastSearch(searchQuery.data);
    if (searchQuery.data.state === "done") setSearch(null);
  }

  const runScan = () =>
    scan({ environmentId, input: {} }).then((result) => {
      setScanFailed(result._tag !== "Success");
      if (result._tag === "Success") setAutomatic(result.value.finds);
    });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scans the computer's disk lazily once the user opens the program finder
  useEffect(() => {
    if (!canManage || !open || automatic !== null || scanFailed) return;
    void scan({ environmentId, input: {} }).then((result) => {
      setScanFailed(result._tag !== "Success");
      if (result._tag === "Success") setAutomatic(result.value.finds);
    });
  }, [automatic, canManage, environmentId, open, scan, scanFailed]);

  const finds = [...(automatic ?? []), ...(lastSearch?.finds ?? []), ...extra];
  const groups = groupProviderPrograms({ providers, finds, settings });

  const choose = async (provider: ServerProvider, path: string) => {
    setSaving(path);
    const instance = settings?.providerInstances[provider.instanceId] ?? {
      driver: provider.driver,
    };
    const config =
      instance.config !== null && typeof instance.config === "object" ? instance.config : {};
    const result = await persistInstance({
      operation: "upsert",
      instanceId: provider.instanceId,
      instance: { ...instance, config: { ...config, binaryPath: path } },
    });
    setSaving(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: gt("Could not save the program path for {agent}", { agent: agentName(provider) }),
      });
      return;
    }
    void refreshProviders({ environmentId, input: { instanceId: provider.instanceId } });
  };

  const addFinds = (more: ReadonlyArray<ProviderFind>) =>
    setExtra((current) => [
      ...current,
      ...more.filter((find) => !current.some((known) => known.path === find.path)),
    ]);

  if (!canManage) return null;

  return (
    <section className="mt-4 border-t border-border/60 pt-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="group flex min-h-9 w-full items-center gap-3 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
          <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
            <FolderSearchIcon className="size-4" />
          </span>
          <span className="text-sm text-muted-foreground group-hover:text-foreground">
            {gt("Find an installed AI program")}
          </span>
          <ChevronDownIcon className="ms-auto size-4 text-muted-foreground group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="grid grid-cols-1 gap-3 pt-3 pb-1">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-foreground">{gt("Installed AI programs")}</h3>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={automatic === null && !scanFailed}
                onClick={() => {
                  setAutomatic(null);
                  setScanFailed(false);
                  void runScan();
                }}
              >
                {gt("Check again")}
              </Button>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {gt(
                "DoeDesk checked your system PATH, standard install folders, and installed apps for AI programs.",
              )}
            </p>
            {automatic === null && !scanFailed ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner size="sm" tone="muted" />
                {gt("Checking…", { $context: "looking for AI programs on this computer" })}
              </p>
            ) : null}
            {scanFailed ? (
              <p role="alert" className="text-sm text-destructive">
                {gt("Could not finish checking for programs. Try again.")}
              </p>
            ) : null}
            {automatic !== null && groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {gt("No AI programs were found in the usual locations.")}
              </p>
            ) : null}
            {groups.map((group) => (
              <ProgramGroup
                key={group.provider.instanceId}
                group={group}
                saving={saving}
                onChoose={(path) => void choose(group.provider, path)}
              />
            ))}
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                variant="outline"
                aria-expanded={drivesOpen}
                onClick={() => setDrivesOpen((currentlyOpen) => !currentlyOpen)}
              >
                <HardDriveIcon className="size-3.5" />
                {gt("Search other drives")}
              </Button>
              <Button
                size="xs"
                variant="ghost-muted"
                aria-expanded={manualOpen}
                onClick={() => setManualOpen((currentlyOpen) => !currentlyOpen)}
              >
                <FolderSearchIcon className="size-3.5" />
                {gt("Choose a program manually")}
              </Button>
            </div>
            {drivesOpen ? (
              <DriveSearch
                environmentId={environmentId}
                progress={lastSearch}
                searching={search !== null && searchQuery.error === null}
                failed={search !== null && searchQuery.error !== null}
                onSearch={(volumes) => {
                  setLastSearch(null);
                  setSearch({ volumes });
                }}
                onStop={() => setSearch(null)}
                onClose={() => {
                  setSearch(null);
                  setDrivesOpen(false);
                }}
              />
            ) : null}
            {manualOpen ? (
              <ManualProgram
                environmentId={environmentId}
                providers={providers}
                platformOs={platformOs}
                onFound={(find) => addFinds([find])}
              />
            ) : null}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </section>
  );
}

function sourceLabel(find: ProviderFind, gt: ReturnType<typeof useGT>): string {
  switch (find.source) {
    case "path":
      return gt("System PATH");
    case "knownLocation":
      return gt("Install folder");
    case "appBundle":
      return find.app ? gt("Inside {app}", { app: find.app }) : gt("Inside an app");
    case "volume":
      return gt("Another drive");
    case "manual":
      return gt("Selected manually");
  }
}

function ProgramGroup({
  group,
  saving,
  onChoose,
}: {
  readonly group: ProviderPrograms;
  readonly saving: string | null;
  readonly onChoose: (path: string) => void;
}) {
  const gt = useGT();
  // Paths run left to right in both languages, but sit on the side the page reads from.
  const rtl = isRtlLocale(useLocale());
  return (
    <div className="grid grid-cols-1 gap-1">
      <p className="text-sm text-foreground">{agentName(group.provider)}</p>
      <ul className="grid grid-cols-1 gap-1">
        {group.finds.map((find) => {
          const inUse = group.inUse === find.path;
          return (
            <li
              key={find.path}
              className="flex min-h-9 items-center gap-3 rounded-md border border-border/60 px-3 py-1.5"
            >
              <div className="min-w-0 flex-1">
                {/* Paths read left to right in either language. */}
                <p
                  dir="ltr"
                  className={cn(
                    "truncate font-mono text-xs text-foreground",
                    rtl ? "text-right" : "text-left",
                  )}
                >
                  {find.path}
                </p>
                <p className="text-2xs text-muted-foreground">
                  {sourceLabel(find, gt)}
                  {" · "}
                  {find.version === null ? gt("version unknown") : <bdi>{find.version}</bdi>}
                </p>
              </div>
              {inUse ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success-foreground">
                  <CheckIcon className="size-3.5" />
                  {gt("In use")}
                </span>
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  disabled={saving !== null}
                  aria-label={gt("Use {path} for {agent}", {
                    path: find.path,
                    agent: agentName(group.provider),
                  })}
                  onClick={() => onChoose(find.path)}
                >
                  {gt("Use")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Lists the drives, searches only the ticked ones, and stops when closed or asked to. */
function DriveSearch({
  environmentId,
  progress,
  searching,
  failed,
  onSearch,
  onStop,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly progress: ProviderVolumeSearchProgress | null;
  readonly searching: boolean;
  readonly failed: boolean;
  readonly onSearch: (volumes: ReadonlyArray<string>) => void;
  readonly onStop: () => void;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const locale = useLocale();
  const listVolumes = useAtomCommand(serverEnvironment.listProviderVolumes, COMMAND_OPTIONS);
  const [volumes, setVolumes] = useState<ReadonlyArray<ProviderVolume> | null>(null);
  const [supported, setSupported] = useState(true);
  const [listFailed, setListFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the mounted drives from the computer when the panel opens
  useEffect(() => {
    void listVolumes({ environmentId, input: {} }).then((result) => {
      if (result._tag === "Success") {
        setVolumes(result.value.volumes);
        setSupported(result.value.supported);
      } else {
        setListFailed(true);
      }
    });
  }, [environmentId, listVolumes]);

  const offered = volumes === null ? [] : volumesToOffer(volumes, showAll);
  const hidden = (volumes?.length ?? 0) - offered.length;
  const tickedOffered = offered.filter((volume) => ticked.has(volume.path));
  const tickId = useId();

  return (
    <div className="grid grid-cols-1 gap-3 rounded-lg border border-border/70 p-3">
      <p className="text-xs leading-relaxed text-muted-foreground">
        {gt(
          "DoeDesk checks only file and folder names on the drives you select, never the contents of your files. Everything stays on this computer.",
        )}
      </p>
      {listFailed ? (
        <p role="alert" className="text-sm text-destructive">
          {gt("Could not list the drives.")}
        </p>
      ) : volumes === null ? (
        <Spinner size="sm" tone="muted" />
      ) : !supported ? (
        <p className="text-sm text-muted-foreground">
          {gt(
            "Drive search is not available on this operating system. Choose a program manually instead.",
          )}
        </p>
      ) : (
        <fieldset className="grid gap-1.5" disabled={searching}>
          <legend className="pb-1 text-sm text-foreground">{gt("Select drives to search")}</legend>
          {offered.length === 0 ? (
            <p className="text-sm text-muted-foreground">{gt("No other drives are connected.")}</p>
          ) : null}
          {offered.map((volume) => (
            <label key={volume.path} className="flex items-center gap-2.5 text-sm">
              <Checkbox
                id={`${tickId}-${volume.path}`}
                checked={ticked.has(volume.path)}
                onCheckedChange={(checked) =>
                  setTicked((current) => {
                    const next = new Set(current);
                    if (checked === true) next.add(volume.path);
                    else next.delete(volume.path);
                    return next;
                  })
                }
              />
              <bdi className="text-foreground">{volume.name}</bdi>
              {volume.kind !== "local" ? (
                <span className="text-xs text-muted-foreground">
                  {volume.kind === "network" ? gt("network drive") : gt("disk image")}
                </span>
              ) : null}
            </label>
          ))}
          {hidden > 0 || showAll ? (
            <label className="flex items-center gap-2.5 pt-1 text-xs text-muted-foreground">
              <Checkbox
                checked={showAll}
                onCheckedChange={(checked) => setShowAll(checked === true)}
              />
              {gt("Show network drives and disk images")}
            </label>
          ) : null}
        </fieldset>
      )}
      {progress !== null ? (
        <p className="text-xs text-muted-foreground" role="status">
          {progress.state === "searching" ? (
            <>
              {gt("Searching")}{" "}
              <bdi>
                {progress.volume?.split(/[/\\]/).filter(Boolean).at(-1) ?? progress.volume ?? ""}
              </bdi>
              {" · "}
            </>
          ) : null}
          {gt("Checked {folders} folders, {found} found.", {
            folders: progress.foldersChecked.toLocaleString(locale),
            found: progress.finds.length.toLocaleString(locale),
          })}
          {progress.stoppedBy === "time"
            ? ` ${gt("Stopped after {minutes} minutes; some folders were skipped.", {
                minutes: SEARCH_LIMIT_MINUTES,
              })}`
            : progress.stoppedBy === "folders"
              ? ` ${gt("Stopped at the folder limit; some folders were skipped.")}`
              : null}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {gt("The drive search stopped due to an error. Try again.")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {searching ? (
          <Button size="xs" variant="outline" onClick={onStop}>
            <Spinner size="sm" tone="muted" />
            {gt("Stop")}
          </Button>
        ) : (
          <Button
            size="xs"
            disabled={tickedOffered.length === 0}
            onClick={() => onSearch(tickedOffered.map((volume) => volume.path))}
          >
            {tickedOffered.length <= 1
              ? gt("Search", { $context: "button that starts the drive search" })
              : gt("{count, plural, one {Search {count} drive} other {Search {count} drives}}", {
                  count: tickedOffered.length,
                })}
          </Button>
        )}
        <Button size="xs" variant="ghost-muted" onClick={onClose}>
          {gt("Close")}
        </Button>
      </div>
    </div>
  );
}

function ManualProgram({
  environmentId,
  providers,
  platformOs,
  onFound,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly platformOs?: string | null | undefined;
  readonly onFound: (find: ProviderFind) => void;
}) {
  const gt = useGT();
  const inspect = useAtomCommand(serverEnvironment.inspectProviderProgram, COMMAND_OPTIONS);
  const drivers = [...new Map(providers.map((provider) => [provider.driver, provider])).values()];
  const [driver, setDriver] = useState(drivers[0]?.driver ?? null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const selectId = useId();
  const canPick = window.desktopBridge !== undefined;

  const check = async (value: string) => {
    if (driver === null || value.trim().length === 0) return;
    setBusy(true);
    setProblem(null);
    const result = await inspect({ environmentId, input: { driver, path: value.trim() } });
    setBusy(false);
    if (result._tag === "Failure") {
      setProblem(gt("Could not check that path. Try again."));
      return;
    }
    if (result.value.ok) {
      onFound(result.value.find);
      setPath("");
      return;
    }
    setProblem(
      result.value.reason === "notAbsolute"
        ? gt("Enter the full path to the program or its folder.")
        : result.value.reason === "notFound"
          ? gt("No runnable program was found at that path.")
          : gt("That file is not an executable program."),
    );
  };

  if (driver === null) return null;
  return (
    <form
      className="grid gap-2 rounded-lg border border-border/70 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        void check(path);
      }}
    >
      <label htmlFor={selectId} className="text-sm text-foreground">
        {gt("AI tool")}
      </label>
      <select
        id={selectId}
        className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        value={driver}
        onChange={(event) =>
          setDriver(drivers.find((entry) => entry.driver === event.target.value)?.driver ?? driver)
        }
      >
        {drivers.map((provider) => (
          <option key={provider.driver} value={provider.driver}>
            {agentName(provider)}
          </option>
        ))}
      </select>
      <Input
        dir="ltr"
        placeholder={manualProgramPlaceholder(platformOs)}
        aria-label={gt("Program path")}
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="xs" disabled={busy || path.trim().length === 0}>
          {gt("Check")}
        </Button>
        {canPick ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void readLocalApi()
                ?.dialogs.pickFolder()
                .then((picked) => {
                  if (picked) void check(picked);
                })
            }
          >
            {gt("Choose a folder…")}
          </Button>
        ) : null}
      </div>
      {problem !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
