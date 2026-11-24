import type { PrivacyImageHandling, PrivacyStatus } from "@t3tools/contracts";
import { T, useGT, useMessages } from "gt-react";

import { useClientSettings } from "~/hooks/useSettings";
import { formatDateTimeTimestamp } from "~/timestampFormat";
import { useState } from "react";

import {
  clearPrivacyRedactions,
  fetchRedactionFile,
  refreshPrivacyRedactions,
  setPrivacyPreference,
  usePrivacyRedactions,
} from "~/privacy/privacyClient";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useSearchableSetting } from "../settings/settingsSearch";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { describeRedaction, IMAGE_HANDLING_CHOICES, imageHandlingOf } from "./ImageRedaction.logic";

/** How images are sent to the AI, and whether agents may read a file as masked text. */
export function ImageHandlingSection({ status }: { readonly status: PrivacyStatus }) {
  const gt = useGT();
  const resolve = useMessages();
  const searchableSetting = useSearchableSetting();
  const [busy, setBusy] = useState(false);
  const handling = imageHandlingOf(status);
  const chosen = IMAGE_HANDLING_CHOICES.find((choice) => choice.value === handling);
  const masking = status.mode !== "off";
  // Promise chains rather than try/finally, which React Compiler cannot optimize.
  const change = (preference: Parameters<typeof setPrivacyPreference>[0]) => {
    setBusy(true);
    return setPrivacyPreference(preference).finally(() => setBusy(false));
  };
  return (
    <SettingsSection {...searchableSetting("privacy-images")} title={gt("Images and documents")}>
      <SettingsRow
        title={gt("How images are sent")}
        description={
          <>
            {chosen === undefined ? null : resolve(chosen.description)}{" "}
            {gt(
              "Faces, signatures, logos and anything that is not writing are not covered. PDFs are always sent as masked text.",
            )}
          </>
        }
        control={
          <Select
            value={handling}
            disabled={busy || !masking}
            onValueChange={(value) => {
              if (value === null || value === handling) return;
              void change({ kind: "imageHandling", handling: value as PrivacyImageHandling });
            }}
          >
            <SelectTrigger aria-label={gt("How images are sent")} className="w-44" size="sm">
              <SelectValue>{chosen === undefined ? null : resolve(chosen.label)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {IMAGE_HANDLING_CHOICES.map((choice) => (
                <SelectItem key={choice.value} value={choice.value}>
                  {resolve(choice.label)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title={gt("Reading tool for agents")}
        description={gt(
          "Agents can ask DoeDesk to read an image or PDF in their workspace. They get the text with personal details replaced by stand-ins, never the details themselves.",
        )}
        control={
          <Switch
            aria-label={gt("Reading tool for agents")}
            checked={status.readingTool !== false}
            disabled={busy || !masking}
            onCheckedChange={(offered) => void change({ kind: "readingTool", offered })}
          />
        }
      />
    </SettingsSection>
  );
}

const save = (fileName: string, blob: Blob): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
};

/** The redacted image and the masked text of each recent attachment, to download. */
export function RedactionsSection() {
  const gt = useGT();
  const resolve = useMessages();
  const searchableSetting = useSearchableSetting();
  const records = usePrivacyRedactions();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const download = (id: string, part: "image" | "text") => {
    setBusy(`${id}:${part}`);
    setProblem(null);
    return fetchRedactionFile(id, part)
      .then((file) => {
        if (file === null) {
          setProblem(gt("That file is no longer kept."));
          refreshPrivacyRedactions();
        } else save(file.fileName, file.blob);
      })
      .catch(() => setProblem(gt("The file could not be read.")))
      .finally(() => setBusy(null));
  };
  return (
    <SettingsSection
      {...searchableSetting("privacy-redactions")}
      title={gt("What was sent in place of files")}
      headerAction={
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={refreshPrivacyRedactions}>
            {gt("Refresh")}
          </Button>
          {records !== null && records.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void clearPrivacyRedactions().catch(() => setProblem(gt("Could not delete.")))
              }
            >
              {gt("Delete all")}
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="px-4 py-2">
        <p className="pb-2 text-xs text-muted-foreground">
          <T>
            Kept on this computer for seven days. These files hold stand-ins, not the real details.
          </T>
        </p>
        {problem !== null ? <p className="pb-2 text-sm text-destructive">{problem}</p> : null}
        {records === null ? (
          <p className="py-2 text-sm text-muted-foreground">{gt("Loading…")}</p>
        ) : records.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">{gt("Nothing yet.")}</p>
        ) : (
          <ul className="max-h-96 divide-y divide-border/60 overflow-y-auto">
            {records.map((record) => (
              <li
                key={record.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-1.5 text-sm"
              >
                <span className="min-w-0 text-foreground">
                  {describeRedaction(record, resolve)}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {" "}
                    · {formatDateTimeTimestamp(record.at, timestampFormat)}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {record.hasImage ? (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={busy !== null}
                      onClick={() => void download(record.id, "image")}
                    >
                      {gt("Redacted image", { $context: "download the redacted image" })}
                    </Button>
                  ) : null}
                  {record.hasText ? (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={busy !== null}
                      onClick={() => void download(record.id, "text")}
                    >
                      {gt("Masked text", { $context: "download the masked text" })}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
