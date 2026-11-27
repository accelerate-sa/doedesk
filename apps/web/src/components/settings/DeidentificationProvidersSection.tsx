import type { PrivacyConfigureRequest, PrivacyStatus } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CloudIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldOffIcon } from "lucide-react";
import { useState } from "react";

import {
  configurePrivacy,
  refreshPrivacyProviders,
  setPrivacyStatus,
  usePrivacyProviders,
  useSignInOptions,
} from "~/privacy/privacyClient";
import { CloudSignIn } from "../privacy/PrivacySetup";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { offeredProviders, PRIVACY_SERVICES } from "./PrivacyProviders.logic";
import { PrivacyServiceRow } from "./PrivacyServiceRow";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

/**
 * Masking and what it is made of: the account, and the service that reads documents, the one
 * that finds personal data and the model for sealed files. Each is chosen on its own, signed in
 * or not.
 */
export function DeidentificationProvidersSection({ status }: { readonly status: PrivacyStatus }) {
  const searchableSetting = useSearchableSetting();
  const [busy, setBusy] = useState(false);
  const configure = (payload: PrivacyConfigureRequest) => {
    setBusy(true);
    void configurePrivacy(payload)
      .then((result) => setPrivacyStatus(result.status))
      // The row keeps showing what is in force; the person can press again.
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };
  return (
    <SettingsSection {...searchableSetting("privacy-masking")}>
      {status.problem !== null ? (
        <p className="px-4 py-3 text-sm text-destructive">{status.problem}</p>
      ) : (
        <>
          <MaskingRow status={status} busy={busy} configure={configure} />
          {status.mode === "off" ? null : (
            <>
              <AccountRow
                // Signing in or out starts the row again, with its sign-in form closed.
                key={status.mode === "cloud" ? "signed-in" : "signed-out"}
                status={status}
                busy={busy}
                configure={configure}
              />
              <ServiceRows status={status} />
            </>
          )}
        </>
      )}
    </SettingsSection>
  );
}

function MaskingRow({
  status,
  busy,
  configure,
}: {
  readonly status: PrivacyStatus;
  readonly busy: boolean;
  readonly configure: (payload: PrivacyConfigureRequest) => void;
}) {
  const gt = useGT();
  const [confirming, setConfirming] = useState(false);
  if (status.mode === "off") {
    return (
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            <ShieldOffIcon className="size-4 shrink-0 text-warning" />
            {gt("Masking is off")}
          </span>
        }
        description={gt("Your messages and files reach the AI as written.")}
        control={
          <Button size="sm" disabled={busy} onClick={() => configure({ mode: "unconfigured" })}>
            {gt("Turn on")}
          </Button>
        }
      />
    );
  }
  const ready = status.mode !== "unconfigured";
  return (
    <>
      <SettingsRow
        title={
          <span className="flex items-center gap-2">
            {ready ? (
              <ShieldCheckIcon className="size-4 shrink-0 text-success" />
            ) : (
              <ShieldAlertIcon className="size-4 shrink-0 text-warning" />
            )}
            {ready ? gt("Masking is on") : gt("Masking isn't ready")}
          </span>
        }
        description={ready ? undefined : gt("Sign in, or choose your own entity detection.")}
        control={
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
            {gt("Turn off")}
          </Button>
        }
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{gt("Turn off masking?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {status.mode === "cloud"
                ? gt(
                    "Your messages and files will reach the AI as written, and you will be signed out of DoeDesk Cloud.",
                  )
                : gt("Your messages and files will reach the AI as written.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {gt("Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                configure({ mode: "off" });
              }}
            >
              {gt("Turn off")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** The DoeDesk Cloud account. Signing out leaves every service of the person's own in use. */
function AccountRow({
  status,
  busy,
  configure,
}: {
  readonly status: PrivacyStatus;
  readonly busy: boolean;
  readonly configure: (payload: PrivacyConfigureRequest) => void;
}) {
  const gt = useGT();
  const [signingIn, setSigningIn] = useState(false);
  const signedIn = status.mode === "cloud";
  const title = (
    <span className="flex items-center gap-2">
      <CloudIcon className="size-4 shrink-0 text-muted-foreground" />
      {/* oxlint-disable-next-line t3code/no-untranslated-copy -- the product's name */}
      <bdi>DoeDesk Cloud</bdi>
    </span>
  );
  if (signedIn) {
    return (
      <SettingsRow
        title={title}
        description={
          status.accountLabel === null ? undefined : <bdi dir="ltr">{status.accountLabel}</bdi>
        }
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => configure({ mode: "unconfigured" })}
          >
            {gt("Sign out")}
          </Button>
        }
      />
    );
  }
  return (
    <SettingsRow
      title={title}
      control={
        <Button
          // The one thing to do next while nothing can detect yet.
          variant={status.mode === "unconfigured" && !signingIn ? "default" : "outline"}
          size="sm"
          aria-expanded={signingIn}
          onClick={() => setSigningIn(!signingIn)}
        >
          {signingIn ? gt("Cancel") : gt("Sign in")}
        </Button>
      }
    >
      {signingIn ? (
        <div className="mt-3 mb-2">
          <AccountSignIn status={status} />
        </div>
      ) : null}
    </SettingsRow>
  );
}

/** Mounted only once the person asks to sign in: reading the sign-in options asks DoeDesk Cloud. */
function AccountSignIn({ status }: { readonly status: PrivacyStatus }) {
  const options = useSignInOptions();
  return (
    <CloudSignIn
      options={options}
      // Without an answer just now, the versions in force are not known: none are shown.
      legal={options?.reached === true ? (status.legal ?? null) : null}
      onStatus={setPrivacyStatus}
    />
  );
}

function ServiceRows({ status }: { readonly status: PrivacyStatus }) {
  const gt = useGT();
  const state = usePrivacyProviders(status);
  if (state.kind === "loading") {
    return (
      <div className="px-4 py-3">
        <Spinner size="md" tone="muted" aria-label={gt("Loading")} />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="flex items-center gap-3 px-4 py-3">
        <p className="text-sm text-destructive">{gt("Could not read the privacy settings.")}</p>
        <Button variant="outline" size="sm" onClick={refreshPrivacyProviders}>
          {gt("Retry")}
        </Button>
      </div>
    );
  }
  return PRIVACY_SERVICES.map((service) => (
    <PrivacyServiceRow
      key={service}
      service={service}
      detail={{
        config: state.providers[service].config,
        catalog: offeredProviders(
          service,
          state.providers[service].catalog,
          state.providers[service].config.provider,
          status.hostedWorkerEntitled === true,
        ),
      }}
      // An older server says nothing of readiness: its services are then taken as usable.
      ready={status.providers?.[service].ready !== false}
      signedIn={status.mode === "cloud"}
    />
  ));
}
