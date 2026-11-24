import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";
import { ShieldIcon } from "lucide-react";
import { createContext, use, useState, type ReactNode } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useFileValueMatcher } from "~/privacy/knownValues";
import { usePrivacyStatus } from "~/privacy/privacyClient";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { FileSurfaceAction, FileSurfaceNotice } from "../files/fileSurfaceChrome";
import { Button } from "../ui/button";
import { FileValueMarksContext, type FileValueSurfaceKind } from "./FileValueMarkSurface";
import type { ValueMarkStats } from "./valueMarkRanges";

const HIGHLIGHT_STORAGE_KEY = "doedesk.highlightReplacedValues";

/** True where a file preview sits inside another that already shows the switch and notice. */
const NestedPreviewContext = createContext(false);

/**
 * Holds the "Highlight what DoeDesk replaces" switch for one open file and reads the values to
 * highlight when it is on. Only on the computer that holds the vault and while masking is on:
 * anywhere else there is no switch and nothing is read.
 */
export function FileValueMarksProvider({
  environmentId,
  fileKey,
  children,
}: {
  readonly environmentId: EnvironmentId;
  /** Names the open file. A new file reads the values again. */
  readonly fileKey: string | null;
  readonly children: ReactNode;
}) {
  const local = usePrimaryEnvironmentId() === environmentId;
  const privacy = usePrivacyStatus();
  const masking =
    local &&
    privacy.kind === "ready" &&
    (privacy.status.mode === "cloud" || privacy.status.mode === "selfHosted");
  const [on, setOn] = useLocalStorage(HIGHLIGHT_STORAGE_KEY, false, Schema.Boolean);
  const [surfaces, setSurfaces] = useState<Record<FileValueSurfaceKind, number>>({
    text: 0,
    textless: 0,
  });
  const [looked, setLooked] = useState<{ fileKey: string | null; stats: ValueMarkStats } | null>(
    null,
  );
  const [mount] = useState(() => (kind: FileValueSurfaceKind) => {
    setSurfaces((current) => ({ ...current, [kind]: current[kind] + 1 }));
    return () => setSurfaces((current) => ({ ...current, [kind]: current[kind] - 1 }));
  });
  // The vault's size is in the key, so deleting an entry reads the values again.
  const vaultSize = privacy.kind === "ready" ? privacy.status.vaultSize : 0;
  const state = useFileValueMatcher(
    masking && on && surfaces.text > 0 && fileKey !== null ? `${vaultSize}:${fileKey}` : null,
  );
  // Always the same tree: the previews under it must not remount when the status arrives.
  return (
    <FileValueMarksContext
      value={
        masking
          ? {
              on,
              setOn,
              surfaces,
              mount,
              state,
              stats: looked !== null && looked.fileKey === fileKey ? looked.stats : null,
              report: (stats) => setLooked({ fileKey, stats }),
            }
          : null
      }
    >
      {children}
    </FileValueMarksContext>
  );
}

/** Wraps a preview shown inside another preview, whose header already holds the switch. */
export function NestedFilePreview({ children }: { readonly children: ReactNode }) {
  return <NestedPreviewContext value={true}>{children}</NestedPreviewContext>;
}

/** The switch, for a file preview's header row. Nothing where the highlight is not offered. */
export function FileValueMarksToggle() {
  const gt = useGT();
  const marks = use(FileValueMarksContext);
  const nested = use(NestedPreviewContext);
  if (marks === null || nested || marks.surfaces.text + marks.surfaces.textless === 0) return null;
  return (
    <FileSurfaceAction
      label={marks.on ? gt("Hide highlights") : gt("Highlight what DoeDesk replaces")}
      pressed={marks.on}
      onPress={() => marks.setOn(!marks.on)}
    >
      <ShieldIcon className="size-3.5" />
    </FileSurfaceAction>
  );
}

/** One line under the header, while the highlight is on, saying what it does and does not show. */
export function FileValueMarksNotice() {
  const gt = useGT();
  const navigate = useNavigate();
  const marks = use(FileValueMarksContext);
  const nested = use(NestedPreviewContext);
  if (marks === null || nested || !marks.on) return null;
  const { state, stats, surfaces } = marks;
  if (surfaces.text + surfaces.textless === 0 || state?.kind === "loading") return null;
  if (state?.kind === "failed") {
    return (
      <FileSurfaceNotice>
        {gt("The values DoeDesk replaces could not be read from this computer.")}
      </FileSurfaceNotice>
    );
  }
  const scanned = stats !== null && stats.units > 0 && stats.characters === 0;
  const textless = surfaces.text === 0 || (state?.kind === "ready" && scanned);
  return (
    <div
      role="status"
      data-file-value-marks-notice={
        textless ? "textless" : stats !== null && stats.marks > 0 ? "marked" : "explained"
      }
      className="shrink-0 border-b px-3 py-1.5 text-start text-2xs text-muted-foreground"
    >
      {textless ? (
        <>
          {gt(
            "This file has no text to highlight. DoeDesk does not read scanned pages or images in the viewer.",
          )}{" "}
          <Button
            variant="link"
            size="micro"
            onClick={() => void navigate({ to: "/settings/privacy" })}
          >
            {gt("See what was sent in place of files")}
          </Button>
        </>
      ) : state?.kind === "ready" && state.matcher === null ? (
        gt(
          "DoeDesk has not replaced any values on this computer yet, so there is nothing to highlight.",
        )
      ) : stats !== null && stats.units > 0 && stats.marks === 0 ? (
        gt(
          "Nothing on screen matches a value DoeDesk has replaced before. This file may still hold personal details; DoeDesk checks it when an agent reads it.",
        )
      ) : (
        gt(
          "Highlights show only values DoeDesk has replaced before. Other details are checked when an agent reads this file, and sent as written if unrecognized.",
        )
      )}
    </div>
  );
}
