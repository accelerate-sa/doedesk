import type { PrivacyAccountDeleted, PrivacyStatus } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";

import { formatLongDate } from "~/timestampFormat";
import { useState } from "react";

import { CLOUD_MESSAGES, NOT_WORKED, UNREACHABLE } from "~/doedesk/privacyMessages";
import { answersSummary } from "~/doedesk/profileAnswers";
import { legalDocumentUrl } from "~/legalLinks";
import {
  accountAction,
  setPrivacyStatus,
  useConsentLocale,
  useSignInOptions,
} from "~/privacy/privacyClient";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogAction,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { useSearchableSetting } from "../settings/settingsSearch";
import { AccountRegionNotice, AccountRegionSelect, useAccountRegionChange } from "./AccountRegion";
import { accountExportFileName, methodOfAccount } from "./AccountRights.logic";
import { CloudSignIn } from "./PrivacySetup";
import { ProfileQuestions } from "./ProfileQuestions";
import { accountRegionExplained } from "./sealReader";

// In the interface's language, not the system's: the date sits inside an interface sentence.
const formatDay = formatLongDate;

const saveFile = (fileName: string, contents: string): void => {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

/** Settings, Privacy: the two documents, with the versions in force and when they were accepted. */
export function LegalDocumentsSection({ status }: { readonly status: PrivacyStatus }) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const [locale] = useConsentLocale();
  const legal = status.legal ?? null;
  const acceptance = status.mode === "cloud" ? (status.acceptance ?? null) : null;
  const version = (value: string | undefined) =>
    value === undefined || value === "" ? null : `${gt("Version")} ${value}`;
  const accepted =
    acceptance === null
      ? null
      : acceptance.acceptedAt === null || acceptance.termsVersion === null
        ? gt("This account has not accepted them yet.")
        : `${gt("This account accepted version")} ${acceptance.termsVersion} ${gt("on")} ${formatDay(acceptance.acceptedAt)}.`;
  const open = (document: "terms" | "privacy") => (
    <Button
      size="sm"
      variant="outline"
      render={
        <a
          href={legalDocumentUrl(legal, document, locale)}
          target="_blank"
          rel="noreferrer noopener"
        />
      }
    >
      {gt("Open")}
    </Button>
  );
  return (
    <SettingsSection id="privacy-documents" title={gt("Terms and privacy")}>
      <SettingsRow
        {...searchableSetting("terms-of-use")}
        title={gt("Terms of Use")}
        description={[version(legal?.terms.version), accepted].filter(Boolean).join(". ")}
        control={open("terms")}
      />
      <SettingsRow
        {...searchableSetting("privacy-policy-version")}
        title={gt("Privacy Policy")}
        description={version(legal?.privacy.version) ?? undefined}
        control={open("privacy")}
      />
    </SettingsSection>
  );
}

type Deletion =
  | { readonly step: "closed" }
  | { readonly step: "confirm" }
  | { readonly step: "signIn" }
  | { readonly step: "done"; readonly deleted: PrivacyAccountDeleted };

/**
 * Settings, Privacy: what a person can do with their DoeDesk Cloud account without writing to
 * anyone. A copy of the data, the answers to the two questions, and deleting the account.
 */
export function AccountRightsSection({ status }: { readonly status: PrivacyStatus }) {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const m = useMessages();
  const [busy, setBusy] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [editingAnswers, setEditingAnswers] = useState(false);
  const [deletion, setDeletion] = useState<Deletion>({ step: "closed" });
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const regionChange = useAccountRegionChange(status);
  const messageFor = (result: {
    readonly code: string | null;
    readonly message: string | null;
  }) => {
    const known = result.code === null ? undefined : CLOUD_MESSAGES[result.code];
    return known === undefined ? (result.message ?? m(NOT_WORKED)) : m(known);
  };

  const download = async () => {
    setBusy(true);
    setExportError(null);
    const result = await accountAction({ action: "export" }).catch(() => null);
    setBusy(false);
    if (result === null) return setExportError(m(UNREACHABLE));
    if (!result.ok || result.exported === null) return setExportError(messageFor(result));
    saveFile(accountExportFileName(new Date()), result.exported);
  };

  const deleteAccount = async () => {
    setBusy(true);
    setDeleteError(null);
    const result = await accountAction({ action: "delete" }).catch(() => null);
    setBusy(false);
    if (result === null) return setDeleteError(m(UNREACHABLE));
    if (result.deleted !== null) return setDeletion({ step: "done", deleted: result.deleted });
    // The sign-in is older than DoeDesk Cloud allows for a deletion: prove it again.
    if (result.code === "recent_sign_in_required") return setDeletion({ step: "signIn" });
    setDeleteError(messageFor(result));
  };

  const signedIn = status.mode === "cloud";
  return (
    <>
      {signedIn ? (
        <SettingsSection id="privacy-account" title={gt("DoeDesk Cloud account")}>
          {/* The region governs only DoeDesk Cloud's worker, so only an account with it sees it. */}
          {status.hostedWorkerEntitled === true ? (
            <SettingsRow
              {...searchableSetting("account-region")}
              title={gt("Region", { $context: "the DoeDesk Cloud account's region" })}
              description={
                regionChange.region === null
                  ? gt("DoeDesk Cloud has not said yet which region this account is in.")
                  : accountRegionExplained(status, regionChange.region, m)
              }
              control={<AccountRegionSelect change={regionChange} />}
            >
              <AccountRegionNotice change={regionChange} />
            </SettingsRow>
          ) : null}
          <SettingsRow
            {...searchableSetting("account-answers")}
            title={gt("Your answers")}
            description={
              answersSummary(status.profile ?? null, m) ?? gt("DoeDesk Cloud stores none.")
            }
            control={
              <Button size="sm" variant="outline" onClick={() => setEditingAnswers(true)}>
                {gt("Change")}
              </Button>
            }
          />
          <SettingsRow
            {...searchableSetting("account-export")}
            title={gt("Download my data")}
            description={
              exportError === null ? (
                gt("A file with everything DoeDesk Cloud holds about this account.")
              ) : (
                <span role="alert" className="text-destructive">
                  {exportError}
                </span>
              )
            }
            control={
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void download()}>
                {gt("Download")}
              </Button>
            }
          />
          <SettingsRow
            {...searchableSetting("account-delete")}
            title={gt("Delete my account")}
            description={gt("DoeDesk Cloud deletes this account and what it holds about it.")}
            control={
              <Button
                size="sm"
                variant="destructive-outline"
                onClick={() => {
                  setDeleteError(null);
                  setDeletion({ step: "confirm" });
                }}
              >
                {gt("Delete")}
              </Button>
            }
          />
        </SettingsSection>
      ) : null}

      <Dialog open={editingAnswers && signedIn} onOpenChange={setEditingAnswers}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{gt("Your answers")}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {/* Mounted afresh each time, so it opens on what is stored, not on the last attempt. */}
            {editingAnswers ? (
              <ProfileQuestions
                stored={status.profile ?? null}
                onStatus={(next) => {
                  setPrivacyStatus(next);
                  setEditingAnswers(false);
                }}
              />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={deletion.step !== "closed"}
        onOpenChange={(open) => (open ? undefined : setDeletion({ step: "closed" }))}
      >
        <DialogPopup>
          {deletion.step === "done" ? (
            <DeletedConfirmation
              deleted={deletion.deleted}
              onDone={() => setDeletion({ step: "closed" })}
            />
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{gt("Delete my account")}</DialogTitle>
                <DialogDescription>
                  <bdi>{status.accountLabel ?? ""}</bdi>
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                {deletion.step === "signIn" ? (
                  <ConfirmBySigningIn
                    status={status}
                    onDeleted={(deleted) => setDeletion({ step: "done", deleted })}
                  />
                ) : (
                  <DeletionExplained />
                )}
                {deleteError !== null ? (
                  <p role="alert" className="text-sm text-destructive">
                    {deleteError}
                  </p>
                ) : null}
              </DialogPanel>
              <DialogFooter>
                <DialogAction variant="outline" onClick={() => setDeletion({ step: "closed" })}>
                  {gt("Cancel")}
                </DialogAction>
                {deletion.step === "confirm" ? (
                  <Button
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void deleteAccount()}
                  >
                    {gt("Delete my account")}
                  </Button>
                ) : null}
              </DialogFooter>
            </>
          )}
        </DialogPopup>
      </Dialog>
    </>
  );
}

/** What deleting the account removes, what is kept, and what it does not touch. */
function DeletionExplained() {
  const gt = useGT();
  return (
    <div className="grid gap-4 text-sm text-foreground">
      <div className="grid gap-1.5">
        <p className="font-medium">{gt("DoeDesk Cloud deletes, at once")}</p>
        <ul className="list-disc space-y-1 ps-5 text-muted-foreground">
          <li>{gt("Your mobile number or email address, and the account itself.")}</li>
          <li>{gt("Your answers to the two questions.")}</li>
          <li>{gt("Every sign-in to this account, on every device.")}</li>
          <li>{gt("The records of how much this account used DoeDesk Cloud.")}</li>
        </ul>
      </div>
      <div className="grid gap-1.5">
        <p className="font-medium">{gt("DoeDesk Cloud keeps")}</p>
        <ul className="list-disc space-y-1 ps-5 text-muted-foreground">
          <li>
            {gt(
              "For five years, the record that this account accepted the Terms of Use: the versions, the language and the time. It names the account by an identifier only, with no number, address or name.",
            )}
          </li>
          <li>{gt("For up to 30 days, the copies in the hosting provider's backups.")}</li>
        </ul>
      </div>
      <div className="grid gap-1.5">
        <p className="font-medium">{gt("Deleting the account does not delete")}</p>
        <ul className="list-disc space-y-1 ps-5 text-muted-foreground">
          <li>
            {gt(
              "Your files, your chats and the stand-ins on this computer. DoeDesk Cloud never had them.",
            )}
          </li>
          <li>
            {gt(
              "Usage data, which is not linked to your account. To stop it and discard its identifier, turn off Usage data on this page.",
            )}
          </li>
          <li>
            {gt(
              "Emails you sent to DoeDesk. They are deleted 12 months after the matter is closed.",
            )}
          </li>
        </ul>
      </div>
      <p className="text-muted-foreground">
        {gt(
          "Nobody can undo this. Afterwards you can create a new account with the same number or address.",
        )}
      </p>
    </div>
  );
}

/** The sign-in that proves who is asking. Completing it deletes the account. */
function ConfirmBySigningIn({
  status,
  onDeleted,
}: {
  readonly status: PrivacyStatus;
  readonly onDeleted: (deleted: PrivacyAccountDeleted) => void;
}) {
  const m = useMessages();
  const gt = useGT();
  const options = useSignInOptions();
  const method = methodOfAccount(status.accountLabel);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-foreground">{m(CLOUD_MESSAGES.recent_sign_in_required!)}</p>
      <p className="text-sm text-muted-foreground">
        {method === "phone"
          ? gt("When you enter the code, DoeDesk Cloud deletes the account.")
          : gt("When you open the emailed link and confirm it, DoeDesk Cloud deletes the account.")}
      </p>
      <CloudSignIn
        // The account signs in one way: by the number or the address it was created with.
        options={options === null ? null : { ...options, methods: [method] }}
        legal={status.legal ?? null}
        onStatus={setPrivacyStatus}
        purpose="deleteAccount"
        onDeleted={onDeleted}
      />
    </div>
  );
}

function DeletedConfirmation({
  deleted,
  onDone,
}: {
  readonly deleted: PrivacyAccountDeleted;
  readonly onDone: () => void;
}) {
  const gt = useGT();
  const proof = deleted.kept.find((entry) => entry.record === "terms_acceptance");
  return (
    <>
      <DialogHeader>
        <DialogTitle>{gt("DoeDesk Cloud deleted the account")}</DialogTitle>
        <DialogDescription>
          {gt(
            "This computer is signed out. Keep the identifier below if you may need to refer to the account.",
          )}
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <dl className="grid gap-3 text-sm">
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">{gt("Account identifier")}</dt>
            <dd>
              <code className="text-xs break-all text-foreground select-all">
                {deleted.accountId}
              </code>
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-muted-foreground">{gt("Deleted on")}</dt>
            <dd className="text-foreground">{formatDay(deleted.deletedAt)}</dd>
          </div>
          {proof === undefined ? null : (
            <div className="grid gap-0.5">
              <dt className="text-muted-foreground">
                {gt("Record that the account accepted the Terms of Use, kept until")}
              </dt>
              <dd className="text-foreground">{formatDay(proof.until)}</dd>
            </div>
          )}
        </dl>
      </DialogPanel>
      <DialogFooter>
        <DialogAction onClick={onDone}>{gt("Done")}</DialogAction>
      </DialogFooter>
    </>
  );
}
