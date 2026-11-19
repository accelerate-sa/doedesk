import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProviderFind,
  type ProviderVolume,
  type ProviderVolumeSearchProgress,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { resolveProviderInstanceDisplayName as agentName } from "@t3tools/client-runtime/state/provider-instance-display";
import { CheckIcon, FolderSearchIcon, HardDriveIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { usePersistEnvironmentProviderInstanceMutation } from "../../hooks/useSettings";
import { readLocalApi } from "../../localApi";
import {
  groupProviderPrograms,
  type ProviderPrograms,
  volumesToOffer,
} from "../../onboarding/providerPrograms.logic";
import { useSetupArabic, useSetupText } from "../../onboarding/setupLocale";
import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
}: {
  readonly environmentId: EnvironmentId;
  /** The providers the setup page offers, in its order. */
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<ServerSettings, "providerInstances"> | null | undefined;
}) {
  const t = useSetupText();
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const scan = useAtomCommand(serverEnvironment.scanProviderPrograms, COMMAND_OPTIONS);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, COMMAND_OPTIONS);
  const persistInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the automatic check reads the computer's disk once when the step opens
  useEffect(() => {
    if (!canManage) return;
    void scan({ environmentId, input: {} }).then((result) => {
      setScanFailed(result._tag !== "Success");
      if (result._tag === "Success") setAutomatic(result.value.finds);
    });
  }, [canManage, environmentId, scan]);

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
        title: t(
          `Could not save the program for ${agentName(provider)}`,
          `تعذّر حفظ برنامج ${agentName(provider)}`,
        ),
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
    <section className="mt-6 grid grid-cols-1 gap-3 border-t border-border/60 pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">
          {t("Programs found on this computer", "البرامج الموجودة على هذا الجهاز")}
        </h3>
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
          {t("Check again", "افحص مجددًا")}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t(
          "DoeDesk looked in your terminal's PATH, the usual install folders and the apps that carry these programs.",
          "بحث DoeDesk في مسارات الطرفية (PATH) ومجلدات التثبيت المعتادة والتطبيقات التي تحمل هذه البرامج.",
        )}
      </p>
      {automatic === null && !scanFailed ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" tone="muted" />
          {t("Looking…", "جارٍ البحث…")}
        </p>
      ) : null}
      {scanFailed ? (
        <p role="alert" className="text-sm text-destructive">
          {t("The check did not finish. Check again.", "لم يكتمل الفحص. أعد المحاولة.")}
        </p>
      ) : null}
      {automatic !== null && groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "No AI programs were found in the usual places.",
            "لم يُعثر على برامج ذكاء اصطناعي في الأماكن المعتادة.",
          )}
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
          onClick={() => setDrivesOpen((open) => !open)}
        >
          <HardDriveIcon className="size-3.5" />
          {t("Look on other drives", "ابحث في الأقراص الأخرى")}
        </Button>
        <Button
          size="xs"
          variant="ghost-muted"
          aria-expanded={manualOpen}
          onClick={() => setManualOpen((open) => !open)}
        >
          <FolderSearchIcon className="size-3.5" />
          {t("Point to a program", "حدّد برنامجًا بنفسك")}
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
          onFound={(find) => addFinds([find])}
        />
      ) : null}
    </section>
  );
}

function sourceLabel(find: ProviderFind, t: ReturnType<typeof useSetupText>): string {
  switch (find.source) {
    case "path":
      return t("On PATH", "ضمن PATH");
    case "knownLocation":
      return t("Install folder", "مجلد تثبيت");
    case "appBundle":
      return t(`Inside ${find.app ?? "an app"}`, `داخل ${find.app ?? "تطبيق"}`);
    case "volume":
      return t("Another drive", "قرص آخر");
    case "manual":
      return t("Chosen by you", "اخترته بنفسك");
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
  const t = useSetupText();
  // Paths run left to right in both languages, but sit on the side the page reads from.
  const arabic = useSetupArabic();
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
                    arabic ? "text-right" : "text-left",
                  )}
                >
                  {find.path}
                </p>
                <p className="text-2xs text-muted-foreground">
                  {sourceLabel(find, t)}
                  {" · "}
                  {find.version === null ? (
                    t("version unknown", "الإصدار غير معروف")
                  ) : (
                    <bdi>{find.version}</bdi>
                  )}
                </p>
              </div>
              {inUse ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-success-foreground">
                  <CheckIcon className="size-3.5" />
                  {t("In use", "مستخدم")}
                </span>
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  className="shrink-0"
                  disabled={saving !== null}
                  aria-label={t(
                    `Use ${find.path} for ${agentName(group.provider)}`,
                    `استخدم ${find.path} مع ${agentName(group.provider)}`,
                  )}
                  onClick={() => onChoose(find.path)}
                >
                  {t("Use", "استخدم")}
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
  const t = useSetupText();
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
        {t(
          "DoeDesk reads only file and folder names on the drives you tick, never what is in your files. Nothing found leaves this computer.",
          "يقرأ DoeDesk أسماء الملفات والمجلدات وحدها في الأقراص التي تختارها، ولا يقرأ ما في ملفاتك. ولا يغادر شيء مما يجده هذا الجهاز.",
        )}
      </p>
      {listFailed ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Could not list the drives.", "تعذّر عرض الأقراص.")}
        </p>
      ) : volumes === null ? (
        <Spinner size="sm" tone="muted" />
      ) : !supported ? (
        <p className="text-sm text-muted-foreground">
          {t(
            "DoeDesk cannot list drives on this computer.",
            "لا يستطيع DoeDesk عرض الأقراص على هذا الجهاز.",
          )}
        </p>
      ) : (
        <fieldset className="grid gap-1.5" disabled={searching}>
          <legend className="pb-1 text-sm text-foreground">
            {t("Which drives should DoeDesk search?", "أي الأقراص يبحث فيها DoeDesk؟")}
          </legend>
          {offered.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("No other drives are connected.", "لا توجد أقراص أخرى متصلة.")}
            </p>
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
                  {volume.kind === "network"
                    ? t("network drive", "قرص شبكي")
                    : t("disk image", "صورة قرص")}
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
              {t("Show network drives and disk images", "اعرض أقراص الشبكة وصور الأقراص")}
            </label>
          ) : null}
        </fieldset>
      )}
      {progress !== null ? (
        <p className="text-xs text-muted-foreground" role="status">
          {progress.state === "searching" ? (
            <>
              {t("Searching", "جارٍ البحث في")}{" "}
              <bdi>{progress.volume?.slice(progress.volume.lastIndexOf("/") + 1) ?? ""}</bdi>
              {" · "}
            </>
          ) : null}
          {t(
            `${progress.foldersChecked.toLocaleString()} folders checked, ${progress.finds.length} found.`,
            `فُحص ${progress.foldersChecked.toLocaleString("ar")} مجلد، وعُثر على ${progress.finds.length.toLocaleString("ar")}.`,
          )}
          {progress.stoppedBy === "time"
            ? t(
                ` Stopped after ${SEARCH_LIMIT_MINUTES} minutes; some folders were not searched.`,
                ` توقف البحث بعد دقيقتين، وبقيت مجلدات لم يصل إليها.`,
              )
            : progress.stoppedBy === "folders"
              ? t(
                  " Stopped at the folder limit; some folders were not searched.",
                  " توقف البحث عند حد المجلدات، وبقيت مجلدات لم يصل إليها.",
                )
              : null}
        </p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t("The search stopped with an error.", "توقف البحث بسبب خطأ.")}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {searching ? (
          <Button size="xs" variant="outline" onClick={onStop}>
            <Spinner size="sm" tone="muted" />
            {t("Stop", "أوقف")}
          </Button>
        ) : (
          <Button
            size="xs"
            disabled={tickedOffered.length === 0}
            onClick={() => onSearch(tickedOffered.map((volume) => volume.path))}
          >
            {tickedOffered.length <= 1
              ? t("Search", "ابحث")
              : t(
                  `Search ${tickedOffered.length} drives`,
                  `ابحث في ${tickedOffered.length.toLocaleString("ar")} أقراص`,
                )}
          </Button>
        )}
        <Button size="xs" variant="ghost-muted" onClick={onClose}>
          {t("Close", "إغلاق")}
        </Button>
      </div>
    </div>
  );
}

function ManualProgram({
  environmentId,
  providers,
  onFound,
}: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onFound: (find: ProviderFind) => void;
}) {
  const t = useSetupText();
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
      setProblem(t("The check did not finish.", "لم يكتمل الفحص."));
      return;
    }
    if (result.value.ok) {
      onFound(result.value.find);
      setPath("");
      return;
    }
    setProblem(
      result.value.reason === "notAbsolute"
        ? t("Enter the full path, starting with /.", "أدخل المسار كاملًا، بدءًا بالشرطة المائلة /.")
        : result.value.reason === "notFound"
          ? t("Nothing that runs was found there.", "لم يُعثر هناك على برنامج يمكن تشغيله.")
          : t("That file cannot be run as a program.", "لا يمكن تشغيل هذا الملف برنامجًا."),
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
        {t("Which AI is it for?", "لأي ذكاء اصطناعي هذا البرنامج؟")}
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
        placeholder="/Volumes/work/tools/bin/claude"
        aria-label={t("Program path", "مسار البرنامج")}
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="xs" disabled={busy || path.trim().length === 0}>
          {t("Check", "افحص")}
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
            {t("Choose a folder…", "اختر مجلدًا…")}
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
