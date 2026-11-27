import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";

const FALLBACK_TRIAGE_COMMAND = "npx t3 triage";
const DOWNLOAD_URL = "https://doedesk.com/download";
const SUPPORT_EMAIL = "hello@doedesk.com";
const LAST_FAILURE_KEY = "t3code:boot-failed-at";
const REPEAT_FAILURE_MS = 5 * 60_000;
const MAX_CAUSES = 3;
const MAX_ERROR_CHARS = 6_000;

export interface BootErrorCopy {
  readonly title: string;
  readonly offline: string;
  readonly unknownReason: string;
  readonly reload: string;
  readonly downloadUpdate: string;
  readonly downloadingUpdate: (percent: number) => string;
  readonly restartToUpdate: string;
  readonly updateDownloadFailed: string;
  readonly updateInstallFailed: string;
  readonly copyCommand: string;
  readonly copied: string;
  readonly copiedToClipboard: string;
  readonly copyBlocked: string;
  readonly pressToCopyMac: string;
  readonly pressToCopyOther: string;
  readonly copyErrorDetails: string;
  readonly moreOptions: string;
  readonly reinstallNightly: string;
  readonly reinstallStable: string;
  readonly triageHelp: string;
  readonly privacyNotice: string;
  readonly contactSupport: string;
}

const BOOT_ERROR_COPY: Readonly<Record<"en" | "ar", BootErrorCopy>> = {
  en: {
    // oxlint-disable-next-line t3code/no-untranslated-copy -- boot failure page renders before the i18n runtime loads
    title: "DoeDesk failed to start",
    offline: "This browser appears to be offline. Check the connection, then reload.",
    // oxlint-disable-next-line t3code/no-untranslated-copy -- boot failure page renders before the i18n runtime loads
    unknownReason: "We are not sure why. Try a reload first.",
    reload: "Reload",
    downloadUpdate: "Download update",
    downloadingUpdate: (percent) => `Downloading update (${percent}%)`,
    restartToUpdate: "Restart to update",
    updateDownloadFailed: "The update download failed. Try Download update again.",
    updateInstallFailed: "The update install failed. Try Restart to update again.",
    copyCommand: "Copy command",
    copied: "Copied",
    copiedToClipboard: "Copied to clipboard.",
    copyBlocked: "Copy was blocked. The text is selected so you can copy it manually.",
    pressToCopyMac: "Press ⌘C to copy",
    pressToCopyOther: "Press Ctrl+C to copy",
    copyErrorDetails: "Copy error details",
    moreOptions: "More options if it keeps failing",
    reinstallNightly: "Download and reinstall the latest nightly build",
    reinstallStable: "Download and reinstall DoeDesk",
    triageHelp:
      "Run this on the computer that runs DoeDesk. Your agent can check the local logs and help you file a bug report.",
    privacyNotice: "Details may include local file paths and names. Check before sharing.",
    contactSupport: "Email DoeDesk support",
  },
  ar: {
    // oxlint-disable-next-line t3code/no-untranslated-copy -- boot failure page renders before the i18n runtime loads
    title: "تعذّر تشغيل DoeDesk",
    offline: "يبدو أن المتصفح غير متصل بالإنترنت. تحقّق من الاتصال ثم أعد التحميل.",
    // oxlint-disable-next-line t3code/no-untranslated-copy -- boot failure page renders before the i18n runtime loads
    unknownReason: "لم نتمكّن من تحديد السبب. جرّب إعادة التحميل أولًا.",
    reload: "إعادة التحميل",
    downloadUpdate: "تنزيل التحديث",
    downloadingUpdate: (percent) => `جارٍ تنزيل التحديث (${percent}%)`,
    restartToUpdate: "إعادة التشغيل للتحديث",
    updateDownloadFailed: "فشل تنزيل التحديث. جرّب تنزيل التحديث مرة أخرى.",
    updateInstallFailed: "فشل تثبيت التحديث. جرّب إعادة التشغيل للتحديث مرة أخرى.",
    copyCommand: "نسخ الأمر",
    copied: "تم النسخ",
    copiedToClipboard: "تم النسخ إلى الحافظة.",
    copyBlocked: "تم منع النسخ تلقائيًا. النص محدّد الآن ويمكنك نسخه يدويًا.",
    pressToCopyMac: "اضغط ⌘C للنسخ",
    pressToCopyOther: "اضغط Ctrl+C للنسخ",
    copyErrorDetails: "نسخ تفاصيل الخطأ",
    moreOptions: "خيارات إضافية إذا استمر التعذّر",
    reinstallNightly: "تنزيل أحدث إصدار ليلي وإعادة تثبيته",
    reinstallStable: "تنزيل DoeDesk وإعادة تثبيته",
    triageHelp:
      "شغّل هذا الأمر على الجهاز الذي يعمل عليه DoeDesk لجمع السجلات المحلية ومساعدتك في الإبلاغ عن المشكلة.",
    privacyNotice: "قد تتضمن التفاصيل مسارات وأسماء ملفات محلية. راجعها قبل المشاركة.",
    contactSupport: "مراسلة دعم DoeDesk",
  },
};

/** Selects boot-error copy from the document language index.html resolved before startup. */
export function bootErrorCopy(lang: string | null | undefined): BootErrorCopy {
  const subtag = lang?.trim().toLowerCase().split(/[-_]/)[0];
  return subtag === "ar" ? BOOT_ERROR_COPY.ar : BOOT_ERROR_COPY.en;
}

/** The Windows launcher is a `.cmd` run from PowerShell, which needs `&` to run a quoted path. */
function launcherCommand(launcherPath: string) {
  if (launcherPath.endsWith(".cmd")) {
    return /^[\w:\\.-]+$/.test(launcherPath)
      ? launcherPath
      : `& '${launcherPath.replace(/['\u2018\u2019\u201A\u201B]/g, "$&$&")}'`;
  }
  return /^[\w@%+=:,./-]+$/.test(launcherPath)
    ? launcherPath
    : `'${launcherPath.replaceAll("'", `'"'"'`)}'`;
}

/** Desktop can run its bundled launcher without Node; everything else falls back to npx. */
export async function resolveTriageCommand(bridge: DesktopBridge | undefined) {
  try {
    const state = await bridge?.cliCommand.getState();
    // Windows reports onPath from its PATH entry alone; only an existing launcher proves it runs.
    if (state?.launcherPath) {
      return state.onPath ? "t3 triage" : `${launcherCommand(state.launcherPath)} triage`;
    }
  } catch (error) {
    console.warn("Could not read the desktop CLI state.", error);
  }
  return FALLBACK_TRIAGE_COMMAND;
}

/** The update button only appears when the desktop updater has a newer build to offer. */
export function updateActionFor(state: DesktopUpdateState | null | undefined) {
  switch (state?.status) {
    case "available":
      return { kind: "download" } as const;
    case "downloading":
      return { kind: "downloading", percent: Math.round(state.downloadPercent ?? 0) } as const;
    case "downloaded":
      return { kind: "install" } as const;
    default:
      return null;
  }
}

function safeString(value: unknown) {
  try {
    return String(value);
  } catch {
    return "";
  }
}

function describeOne(value: unknown) {
  if (value instanceof Error) {
    const header = value.message ? `${value.name}: ${value.message}` : value.name;
    // V8 stacks start with the header; Safari and Firefox stacks do not.
    const stack = typeof value.stack === "string" ? value.stack : "";
    return stack === header || stack.startsWith(`${header}\n`)
      ? stack
      : [header, stack].filter(Boolean).join("\n");
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? safeString(value);
  } catch {
    return safeString(value);
  }
}

/** Hosts can name private machines, and pairing tokens live in query strings and hashes. */
function redact(text: string) {
  return text
    .replace(/\b[a-z][\w+.-]*:\/\/[^\s/?#'"()]+/gi, "")
    .replace(/[?#][^\s'"()]*=[^\s'"()]*?((?::\d+){1,2})?(?=[\s'"()]|$)/g, "$1");
}

export interface BootErrorEnvironment {
  readonly version: string;
  readonly channel: string;
  readonly surface: "desktop" | "web";
  readonly platform: string;
  readonly userAgent: string;
  readonly time: string;
}

/** Plain text that is shown and copied as-is, so users see exactly what they share. */
export function buildErrorReport(error: unknown, environment: BootErrorEnvironment) {
  const parts: Array<string> = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current != null && !seen.has(current) && parts.length <= MAX_CAUSES) {
    seen.add(current);
    const text = describeOne(current);
    parts.push(parts.length === 0 ? text : `Caused by: ${text}`);
    current = current instanceof Error ? current.cause : undefined;
  }
  let details = redact(parts.join("\n") || "(no error message)");
  if (details.length > MAX_ERROR_CHARS) {
    let end = MAX_ERROR_CHARS;
    const last = details.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    details = `${details.slice(0, end)}\n[truncated]`;
  }
  return [
    details,
    "",
    `Version: ${environment.version}`,
    `Channel: ${environment.channel}`,
    `Surface: ${environment.surface}`,
    `Platform: ${environment.platform}`,
    `User agent: ${environment.userAgent}`,
    `Time: ${environment.time}`,
  ].join("\n");
}

function clientPlatform(bridge: DesktopBridge | undefined) {
  try {
    return bridge?.getClientPlatform() ?? navigator.platform;
  } catch {
    return navigator.platform;
  }
}

function readEnvironment(bridge: DesktopBridge | undefined): BootErrorEnvironment {
  const version = import.meta.env.APP_VERSION;
  return {
    version,
    channel:
      import.meta.env.VITE_RELEASE_CHANNEL || /-(nightly|preview)\./.exec(version)?.[1] || "stable",
    surface: bridge ? "desktop" : "web",
    platform: clientPlatform(bridge),
    userAgent: navigator.userAgent,
    time: new Date().toISOString(),
  };
}

/** Opens More options by default when startup already failed in this tab a moment ago. */
function isRepeatFailure(now: number) {
  try {
    const previous = Number(sessionStorage.getItem(LAST_FAILURE_KEY));
    sessionStorage.setItem(LAST_FAILURE_KEY, String(now));
    return now - previous < REPEAT_FAILURE_MS;
  } catch {
    return false;
  }
}

const icon = (paths: string) =>
  `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const COPY_ICON = icon(
  '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
);
const CHECK_ICON = icon('<path d="M20 6 9 17l-5-5"/>');

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: ReadonlyArray<Node | string> = [],
) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function selectContents(target: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(target);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function copySelection() {
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

/** Plain http has no Clipboard API, but the legacy copy command still works on a selection. */
function copyText(
  target: HTMLElement,
  copy: BootErrorCopy,
  onCopied: () => void,
  onBlocked: (hint: string) => void,
) {
  const fallback = () => {
    selectContents(target);
    if (copySelection()) return onCopied();
    onBlocked(
      /Mac|iPhone|iPad/.test(navigator.platform) ? copy.pressToCopyMac : copy.pressToCopyOther,
    );
  };
  const clipboard = window.isSecureContext ? navigator.clipboard : undefined;
  if (typeof clipboard?.writeText !== "function") return fallback();
  clipboard.writeText(target.textContent ?? "").then(onCopied, fallback);
}

function mountUpdateButton(
  bridge: DesktopBridge,
  copy: BootErrorCopy,
  button: HTMLButtonElement,
  note: HTMLParagraphElement,
  announce: (text: string) => void,
) {
  let action: ReturnType<typeof updateActionFor> = null;
  const render = (state: DesktopUpdateState) => {
    action = updateActionFor(state);
    button.hidden = action === null;
    // aria-disabled keeps keyboard focus on the button while the download runs.
    button.setAttribute("aria-disabled", String(action?.kind === "downloading"));
    if (action?.kind === "download") button.textContent = copy.downloadUpdate;
    if (action?.kind === "downloading") button.textContent = copy.downloadingUpdate(action.percent);
    if (action?.kind === "install") button.textContent = copy.restartToUpdate;
    const failure = !action
      ? ""
      : state.errorContext === "download"
        ? copy.updateDownloadFailed
        : state.errorContext === "install"
          ? copy.updateInstallFailed
          : "";
    if (failure === note.textContent) return;
    note.textContent = failure;
    note.hidden = !failure;
    if (failure) announce(failure);
  };
  button.addEventListener("click", () => {
    const run =
      action?.kind === "install"
        ? bridge.installUpdate()
        : action?.kind === "download"
          ? bridge.downloadUpdate()
          : undefined;
    run?.then(
      (result) => render(result.state),
      (error: unknown) => console.warn("Could not update DoeDesk.", error),
    );
  });
  // A pushed state is newer than the initial read, so the read must not overwrite it.
  let pushed = false;
  try {
    bridge.onUpdateState((state) => {
      pushed = true;
      render(state);
    });
    bridge.getUpdateState().then(
      (state) => pushed || render(state),
      (error: unknown) => console.warn("Could not read the desktop update state.", error),
    );
  } catch (error) {
    console.warn("Could not read the desktop update state.", error);
  }
}

export function showBootError(error: unknown) {
  console.error("DoeDesk failed to start.", error);
  const bootShell = document.getElementById("boot-shell");
  if (!bootShell) return;

  const copy = bootErrorCopy(document.documentElement.lang);
  const bridge = window.desktopBridge;
  const environment = readEnvironment(bridge);
  const offline = !bridge && navigator.onLine === false;

  const status = element("span", { className: "boot-error-sr" });
  status.setAttribute("aria-live", "polite");
  // Clearing first makes screen readers announce a repeated message.
  let announcement: ReturnType<typeof setTimeout> | undefined;
  const announce = (text: string) => {
    clearTimeout(announcement);
    status.textContent = "";
    announcement = setTimeout(() => (status.textContent = text), 100);
  };

  const message = element("div", {}, [
    element("h1", { textContent: copy.title }),
    element("p", { textContent: offline ? copy.offline : copy.unknownReason }),
  ]);
  message.setAttribute("role", "alert");

  const reload = element("button", {
    id: "boot-error-reload",
    type: "button",
    textContent: copy.reload,
  });
  reload.addEventListener("click", () => window.location.reload());
  const update = element("button", { id: "boot-error-update", type: "button", hidden: true });
  const updateNote = element("p", { id: "boot-error-update-note", hidden: true });
  if (bridge) mountUpdateButton(bridge, copy, update, updateNote, announce);

  const command = element("code", { textContent: FALLBACK_TRIAGE_COMMAND });
  const copyCommand = element("button", {
    className: "boot-error-icon",
    type: "button",
    title: copy.copyCommand,
    innerHTML: COPY_ICON,
  });
  copyCommand.setAttribute("aria-label", copy.copyCommand);
  copyCommand.addEventListener("click", () =>
    copyText(
      command,
      copy,
      () => {
        copyCommand.innerHTML = CHECK_ICON;
        copyCommand.title = copy.copied;
        copyCommand.setAttribute("aria-label", copy.copied);
        announce(copy.copiedToClipboard);
      },
      (hint) => {
        copyCommand.textContent = hint;
        copyCommand.title = hint;
        copyCommand.setAttribute("aria-label", hint);
        announce(copy.copyBlocked);
      },
    ),
  );
  void resolveTriageCommand(bridge).then((value) => (command.textContent = value));

  let report = "(no error message)";
  try {
    report = buildErrorReport(error, environment);
  } catch (reportError) {
    console.warn("Could not describe the startup error.", reportError);
  }
  const details = element("pre", { id: "boot-error-details", tabIndex: 0, textContent: report });
  const copyDetails = element("button", { type: "button", textContent: copy.copyErrorDetails });
  copyDetails.addEventListener("click", () =>
    copyText(
      details,
      copy,
      () => {
        copyDetails.textContent = copy.copied;
        announce(copy.copiedToClipboard);
      },
      (hint) => {
        copyDetails.textContent = hint;
        announce(copy.copyBlocked);
      },
    ),
  );

  const supportHref = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(
    `DoeDesk failed to start (${environment.version}, ${environment.surface})`,
  )}`;
  const link = (href: string, textContent: string) =>
    element("a", { href, textContent, target: "_blank", rel: "noreferrer" });
  const nightly = environment.channel === "nightly";

  const more = element("details", { open: isRepeatFailure(Date.now()) }, [
    element("summary", { textContent: copy.moreOptions }),
    ...(bridge
      ? [
          link(
            nightly ? `${DOWNLOAD_URL}?channel=nightly` : DOWNLOAD_URL,
            nightly ? copy.reinstallNightly : copy.reinstallStable,
          ),
        ]
      : []),
    element("div", {}, [
      element("p", { textContent: copy.triageHelp }),
      element("div", { id: "boot-error-command" }, [command, copyCommand]),
    ]),
    element("div", {}, [
      details,
      element("p", { textContent: copy.privacyNotice }),
      element("div", { id: "boot-error-report" }, [
        copyDetails,
        link(supportHref, copy.contactSupport),
      ]),
    ]),
  ]);

  bootShell.replaceChildren(
    element("div", { id: "boot-error" }, [
      message,
      element("div", { id: "boot-error-actions" }, [reload, update]),
      updateNote,
      more,
      status,
    ]),
  );
}
