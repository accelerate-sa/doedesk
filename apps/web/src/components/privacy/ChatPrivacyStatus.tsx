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

const labelOf = (state: ChatMaskingState, gt: Translate): string => {
  switch (state.kind) {
    case "masked":
      return state.sealed > 0
        ? gt("Masked · {count} sealed", { count: state.sealed })
        : gt("Masked", { $context: "status of a chat: personal details in it are masked" });
    case "notMasked":
      return gt("Not masked", { $context: "status of a chat: it is sent without masking" });
    case "unconfirmed":
      return gt("Masking not confirmed");
    case "notSending":
      return gt("Not sending", { $context: "status of a chat: its requests are held back" });
  }
};

/** What is known about this chat's protection, one sentence each. */
const sentencesOf = (state: ChatMaskingState, words: Words, gt: Translate): Array<string> => {
  const { name, tool, company } = words;
  switch (state.kind) {
    case "masked":
      return [
        gt(
          "Before this chat's requests reach {company}, DoeDesk replaces the personal details it finds with stand-ins.",
          { company },
        ),
        ...(state.sealed > 0
          ? [
              gt(
                "{count, plural, one {This folder has {count} sealed file.} other {This folder has {count} sealed files.}}",
                { count: state.sealed },
              ),
            ]
          : []),
      ];
    case "notMasked":
      return [
        state.reason === "off"
          ? gt(
              "Masking is turned off. Your messages and files in this chat reach {company} as they are.",
              { company },
            )
          : gt(
              "Masking is turned off for {name}. Your messages and files in this chat reach {company} as they are.",
              { name, company },
            ),
      ];
    case "unconfirmed":
      return [
        state.reason === "unseen"
          ? gt(
              "DoeDesk rewrote no request of this chat's last turn. If {tool} sent that turn somewhere DoeDesk does not check, it was sent as written.",
              { tool },
            )
          : gt(
              "DoeDesk has not been tested with {tool}. If {tool} sends requests in a format DoeDesk does not recognize, they are sent as written.",
              { tool },
            ),
      ];
    case "notSending":
      switch (state.reason) {
        case "notSetUp":
          return [
            gt("Masking is not set up yet, so DoeDesk sends nothing to {company}.", { company }),
          ];
        case "terms":
          return [
            gt(
              "DoeDesk Cloud checks requests only after you accept the current Terms of Use, so nothing is sent.",
            ),
          ];
        case "stopped":
          return [
            gt("DoeDesk's masking service is not running, so nothing is sent to {company}.", {
              company,
            }),
          ];
        case "blocked":
          return [
            gt(
              "DoeDesk cannot mask what {tool} sends, so nothing is sent. To use {name} without masking, open Privacy settings.",
              { tool, name },
            ),
          ];
      }
  }
};

/**
 * The state of this chat's protection, beside the composer: masked, not masked and why, not
 * confirmed, or held back. It reads what the app already holds and asks the server nothing.
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
            size="xs"
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
          size="xs"
          className={state.kind === "notSending" ? "text-warning" : undefined}
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
            <div>
              <PopoverClose
                render={<Button variant="link" size="sm" />}
                onClick={() => void navigate({ to: "/settings/privacy" })}
              >
                {gt("Privacy settings")}
              </PopoverClose>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">
              {gt("This chat runs on another computer. Its privacy settings are set there.")}
            </p>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
