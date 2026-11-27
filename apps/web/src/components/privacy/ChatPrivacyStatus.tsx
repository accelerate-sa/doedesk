import {
  chatMaskingState,
  type ChatMaskingState,
} from "@t3tools/client-runtime/state/thread-privacy";
import type {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useGT, useMessages } from "gt-react";
import { ShieldAlertIcon, ShieldCheckIcon, ShieldOffIcon, ShieldQuestionIcon } from "lucide-react";

import { providerWords, resolveProviderWords } from "~/doedesk/providerConnections";
import { cn } from "~/lib/utils";
import { usePrivacyStatus, useSealedDocuments } from "~/privacy/privacyClient";
import { useThreadRunPrivacy } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { ComposerControl, ComposerControlIcon } from "../chat/ComposerControl";
import { providerClients } from "../settings/providerDriverMeta";
import { sealedReaderSentences } from "./sealReader";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

const ICONS = {
  masked: ShieldCheckIcon,
  notMasked: ShieldOffIcon,
  unconfirmed: ShieldQuestionIcon,
  notSending: ShieldAlertIcon,
} as const;

type Translate = ReturnType<typeof useGT>;
type Words = ReturnType<typeof resolveProviderWords>;

/** The pill's one word. What it means is in the popover. */
const labelOf = (state: ChatMaskingState, gt: Translate): string => {
  switch (state.kind) {
    case "masked":
      return gt("De-identified", {
        $context: "status of a chat: personal details in it are replaced before sending",
      });
    case "notMasked":
      return gt("Unprotected", {
        $context: "status of a chat: it is sent as written, without de-identification",
      });
    case "unconfirmed":
      return gt("Unconfirmed", {
        $context: "status of a chat: its de-identification could not be confirmed",
      });
    case "notSending":
      return gt("Held", { $context: "status of a chat: its requests are held back, not sent" });
  }
};

/** What is known about this chat's protection, one sentence each. */
const sentencesOf = (state: ChatMaskingState, words: Words, gt: Translate): Array<string> => {
  const { name, tool, company } = words;
  switch (state.kind) {
    case "masked":
      return [
        gt("Personal details are replaced before this chat reaches {company}.", { company }),
        ...(state.sealed > 0
          ? [
              gt(
                "{count, plural, one {{count} sealed file here. Work on it is slower and runs no commands.} other {{count} sealed files here. Work on them is slower and runs no commands.}}",
                { count: state.sealed },
              ),
            ]
          : [
              // Said only without sealed files, so de-identification is not taken for sealing.
              gt("Amounts, dates and wording still reach {company}. Seal a file to keep it away.", {
                company,
              }),
            ]),
      ];
    case "notMasked":
      return [
        state.reason === "off"
          ? gt("De-identification is off. This chat reaches {company} as written.", { company })
          : gt("De-identification is off for {name}. This chat reaches {company} as written.", {
              name,
              company,
            }),
      ];
    case "unconfirmed":
      return [
        state.reason === "unseen"
          ? gt("DoeDesk could not confirm the last turn. {tool} may have sent it as written.", {
              tool,
            })
          : gt("DoeDesk is not tested with {tool}. It may send this chat as written.", { tool }),
      ];
    case "notSending":
      switch (state.reason) {
        case "notSetUp":
          return [
            gt("Nothing is sent to {company} until de-identification is set up.", { company }),
          ];
        case "terms":
          return [gt("Nothing is sent until you accept the current Terms of Use.")];
        case "stopped":
          return [
            gt("Nothing is sent to {company} while de-identification is not running.", {
              company,
            }),
          ];
        case "blocked":
          return [
            gt(
              "DoeDesk cannot de-identify {tool}, so nothing is sent. To use {name} as written, open Privacy settings.",
              { tool, name },
            ),
          ];
      }
  }
};

/**
 * The state of this chat's protection, beside the composer: de-identified, unprotected,
 * unconfirmed, or held. One word on the pill, the reasons in its popover. It reads what the app
 * already holds and asks the server nothing.
 */
export function ChatPrivacyStatus({
  environmentId,
  threadRef,
  projectId,
  driver,
  compact,
}: {
  readonly environmentId: EnvironmentId;
  /** Null for a chat that has not been sent yet. */
  readonly threadRef: ScopedThreadRef | null;
  readonly projectId: ProjectId | null;
  /** The driver kind of the provider this chat uses now. */
  readonly driver: ProviderDriverKind;
  /** Icon only, where the composer is narrow. */
  readonly compact: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const navigate = useNavigate();
  // The privacy status is this computer's; a chat on another one speaks through its own turns.
  const local = usePrimaryEnvironmentId() === environmentId;
  const privacy = usePrivacyStatus();
  const turns = useThreadRunPrivacy(threadRef);
  const status = local && privacy.kind === "ready" ? privacy.status : null;
  const sealed = useSealedDocuments(
    status !== null && (status.sealedDocuments ?? 0) > 0 ? projectId : null,
  );
  if (local && status === null) return null;
  const state = chatMaskingState({
    status,
    driver,
    turns,
    sealed: sealed?.documents.length ?? 0,
  });
  if (state === null) return null;

  const words = resolveProviderWords(
    providerWords(driver, providerClients.get(driver)?.label ?? driver),
    resolve,
  );
  const label = labelOf(state, gt);
  // Sent as written: tinted, so it is seen before Send. Held back: nothing leaves, so only the icon.
  const exposed = state.kind === "notMasked" || state.kind === "unconfirmed";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <ComposerControl
            aria-label={gt("Privacy of this chat: {label}", { label })}
            data-chat-privacy-status={state.kind}
            className={cn(
              exposed &&
                "border-warning/25 bg-warning/10 text-warning-foreground hover:bg-warning/16 hover:text-warning-foreground dark:text-warning-foreground",
            )}
          />
        }
      >
        <ComposerControlIcon
          icon={ICONS[state.kind]}
          className={
            exposed ? "text-current" : state.kind === "notSending" ? "text-warning" : undefined
          }
        />
        {/* Only the calm state gives up its words where the composer is narrow. */}
        {compact && state.kind === "masked" ? null : (
          <span data-composer-control-label>{label}</span>
        )}
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" width="md">
        <div className="flex flex-col gap-2 text-start">
          <PopoverTitle>{label}</PopoverTitle>
          {[
            ...sentencesOf(state, words, gt),
            // Who reads this folder's sealed files, said only where there are some.
            ...(status !== null && state.kind === "masked" && state.sealed > 0
              ? sealedReaderSentences(status, resolve)
              : []),
          ].map((sentence) => (
            <p key={sentence} className="text-muted-foreground text-sm">
              {sentence}
            </p>
          ))}
          {local ? (
            <div className="-ms-2.5">
              <PopoverClose
                render={<Button variant="link" size="sm" />}
                onClick={() => void navigate({ to: "/settings/privacy" })}
              >
                {gt("Privacy settings")}
              </PopoverClose>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              {gt("Runs on another computer. Change its privacy settings there.")}
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
