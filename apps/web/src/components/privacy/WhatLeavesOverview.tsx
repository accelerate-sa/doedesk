import type { PrivacyStatus } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { FileLock2Icon, ShieldCheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { SettingsSection } from "../settings/settingsLayout";
import { sealedReaderSentences } from "./sealReader";

/**
 * Masking and sealing side by side, so that nobody takes one for the other: masking still sends
 * amounts, dates and wording; sealing sends none of a file's contents.
 */
export function WhatLeavesOverview({ status }: { readonly status: PrivacyStatus }) {
  const gt = useGT();
  const resolve = useMessages();
  const masking = status.mode === "cloud" || status.mode === "selfHosted";
  const maskingLines = masking
    ? [
        gt(
          "Names, ID numbers, emails and phone numbers that DoeDesk finds are swapped for stand-ins before they leave.",
        ),
        gt(
          "Amounts, dates and the wording of your documents still reach your AI company as written, so your AI works as it normally does.",
        ),
        status.mode === "cloud"
          ? gt("Names are found by DoeDesk Cloud in Saudi Arabia.")
          : gt("Names are found by your own detection service."),
      ]
    : [
        status.mode === "off"
          ? gt("Masking is off, so everything in your chats reaches your AI company as written.")
          : gt("Masking is not set up yet, so DoeDesk sends nothing to your AI company."),
      ];
  const sealedLines = [
    gt(
      "A sealed file's contents never reach your AI company. Only a short label, stand-ins, and yes-or-no or multiple-choice answers do, and those answers are counted and kept for you to read.",
    ),
    gt(
      "The whole file goes only to the model that reads sealed files. On your own computer or company server, it is read on hardware you control. Organizations without their own model hardware yet can use a managed in-region worker by agreement.",
    ),
    ...sealedReaderSentences(status, resolve),
    status.mode === "cloud"
      ? gt(
          "PDFs and images are first read by DoeDesk Cloud in Saudi Arabia, without storing them, to get their text.",
        )
      : gt("PDFs and images are first read by your reading service to get their text."),
  ];
  return (
    <SettingsSection id="privacy-what-leaves" title={gt("What leaves your computer")}>
      <div className="grid gap-4 px-4 py-3 sm:grid-cols-2">
        <Column icon={<ShieldCheckIcon />} title={gt("A normal folder: masking")}>
          {maskingLines}
        </Column>
        <Column icon={<FileLock2Icon />} title={gt("Sealed files")}>
          {sealedLines}
        </Column>
      </div>
    </SettingsSection>
  );
}

function Column({
  icon,
  title,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly children: ReadonlyArray<string>;
}) {
  return (
    <div className="grid content-start gap-2">
      <h4 className="flex items-center gap-2 text-sm font-medium text-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground">
        {icon}
        {title}
      </h4>
      <ul className="grid list-disc gap-1.5 ps-5 text-xs text-muted-foreground">
        {children.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
