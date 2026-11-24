import { useEffect, useState } from "react";

import { reloadPrivacyStatus, usePrivacyStatus, useUsageData } from "~/privacy/privacyClient";
import { watchesRefusedHosts } from "./privacyComposerBanners.logic";
import { ProviderMaskingNoticeOnce } from "./ProviderMasking";
import { TermsAcceptanceSheet, termsAcceptanceDue } from "./TermsAcceptanceSheet";
import { usageDataChoiceDue, UsageDataChoiceOnce } from "./UsageData";

// How often the app asks its own server whether DoeDesk Cloud has refused the account's requests,
// and, under a rule that refuses hosts, which hosts it refused.
const STATUS_CHECK_MS = 15_000;

/**
 * The questions DoeDesk has to put to a person outside any one screen, one at a time and in this
 * order: accepting the Terms of Use, the usage-data choice, then the notice about masking for a
 * provider, which waits until a chat with that provider starts. Mounted once for the whole app.
 */
export function PrivacyPrompts({
  onWelcome,
}: {
  /** The welcome page shows the usage-data choice itself, so no dialog is opened over it. */
  readonly onWelcome: boolean;
}) {
  const privacy = usePrivacyStatus();
  const usage = useUsageData();
  const status = privacy.kind === "ready" ? privacy.status : null;
  const [termsLater, setTermsLater] = useState(false);
  // Open from the moment the choice is due until the person continues, whatever they tick, and
  // shown once in a session.
  const [usagePrompt, setUsagePrompt] = useState<"idle" | "open" | "done">("idle");
  if (onWelcome && usagePrompt === "open") setUsagePrompt("idle");
  if (usagePrompt === "idle" && !onWelcome && usageDataChoiceDue(usage)) setUsagePrompt("open");

  const watched = status?.mode === "cloud" || watchesRefusedHosts(status);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer re-reads the server's status while an account is signed in or hosts can be refused, so a refusal brings up the sheet or the line by the composer
  useEffect(() => {
    if (!watched) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void reloadPrivacyStatus().catch(() => undefined);
    }, STATUS_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [watched]);

  if (status !== null && termsAcceptanceDue(status)) {
    const blocked = status.acceptance?.blocked === true;
    if (blocked || !termsLater) {
      return (
        <TermsAcceptanceSheet
          status={status}
          onLater={blocked ? undefined : () => setTermsLater(true)}
        />
      );
    }
  }
  if (!onWelcome && usagePrompt === "open" && usage !== null) {
    return <UsageDataChoiceOnce status={usage} onDone={() => setUsagePrompt("done")} />;
  }
  return <ProviderMaskingNoticeOnce />;
}
