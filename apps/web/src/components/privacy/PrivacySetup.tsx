import type {
  PrivacyAccountDeleted,
  PrivacyConfigureRequest,
  PrivacyLegal,
  PrivacySignInMethod,
  PrivacySignInPurpose,
  PrivacySignInRequest,
  PrivacySignInResult,
  PrivacyStatus,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { MailIcon, ShieldCheckIcon, ShieldOffIcon, SmartphoneIcon } from "lucide-react";
import { type FormEvent, useEffect, useEffectEvent, useId, useState } from "react";

import { CONSENT_WORDS, SIGNUP_WORDING_ID } from "~/doedesk/consentWords";
import {
  CLOUD_MESSAGES,
  LEGAL_UNKNOWN,
  NOT_WORKED,
  SIGN_UP_UNAVAILABLE,
  UNREACHABLE,
  usePrivacyMessage,
} from "~/doedesk/privacyMessages";
import { useInSetup } from "~/onboarding/setupLocale";
import {
  configurePrivacy,
  refreshSignInOptions,
  type SignInOptions,
  signInToCloud,
  useConsentLocale,
  useSignInOptions,
} from "~/privacy/privacyClient";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { ConsentBlock, ConsentLanguageSwitch, ConsentSentence } from "./ConsentText";

const LINK_CLASS =
  "text-xs text-muted-foreground underline decoration-current/40 underline-offset-2 hover:text-foreground";

/**
 * Chooses how personal data is found before anything is sent to a model: a DoeDesk account, or
 * a detection service the user runs. Used by the welcome page and by Settings.
 */
export function PrivacySetup({
  status,
  onStatus,
  allowTurningOff = false,
}: {
  readonly status: PrivacyStatus;
  readonly onStatus: (status: PrivacyStatus) => void;
  /** Settings offers turning masking off; the welcome page does not. */
  readonly allowTurningOff?: boolean;
}) {
  const gt = useGT();
  const m = usePrivacyMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ownService, setOwnService] = useState(false);

  const configure = async (payload: PrivacyConfigureRequest) => {
    setBusy(true);
    setError(null);
    const result = await configurePrivacy(payload).catch(() => null);
    setBusy(false);
    if (result === null) {
      setError(m(UNREACHABLE));
      return;
    }
    onStatus(result.status);
    if (!result.ok) setError(result.message ?? m(NOT_WORKED));
  };

  if (status.problem !== null) {
    return <p className="py-2 text-sm text-destructive">{status.problem}</p>;
  }

  if (status.mode === "cloud" || status.mode === "selfHosted") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <ShieldCheckIcon className="size-5 shrink-0 text-success" />
          <div className="min-w-0">
            <p className="text-sm text-foreground">{gt("Masking is on")}</p>
            <p className="truncate text-xs text-muted-foreground">
              <bdi>{(status.mode === "cloud" ? status.accountLabel : status.endpoint) ?? ""}</bdi>
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void configure({ mode: "unconfigured" })}
        >
          {status.mode === "cloud" ? gt("Sign out") : gt("Disconnect")}
        </Button>
      </div>
    );
  }

  if (status.mode === "off") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <ShieldOffIcon className="size-5 shrink-0 text-warning" />
          <div className="min-w-0">
            <p className="text-sm text-foreground">{gt("Masking is off")}</p>
            <p className="text-xs text-muted-foreground">
              {gt("Your messages and files reach the AI as written.")}
            </p>
          </div>
        </div>
        <Button size="sm" disabled={busy} onClick={() => void configure({ mode: "unconfigured" })}>
          {gt("Turn on")}
        </Button>
      </div>
    );
  }

  return (
    <SignedOut
      status={status}
      onStatus={onStatus}
      allowTurningOff={allowTurningOff}
      busy={busy}
      error={error}
      ownService={ownService}
      onOwnService={setOwnService}
      configure={configure}
    />
  );
}

/** Not signed in: the sign-in form, or the form for a detection service the person runs. */
function SignedOut({
  status,
  onStatus,
  allowTurningOff,
  busy,
  error,
  ownService,
  onOwnService,
  configure,
}: {
  readonly status: PrivacyStatus;
  readonly onStatus: (status: PrivacyStatus) => void;
  readonly allowTurningOff: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly ownService: boolean;
  readonly onOwnService: (ownService: boolean) => void;
  readonly configure: (payload: PrivacyConfigureRequest) => Promise<void>;
}) {
  const gt = useGT();
  const options = useSignInOptions();
  // Where no account can be created, masking can still be had without one, or done without.
  const refused = options?.signUpAvailable === false;
  return (
    <div className="py-2">
      {ownService ? (
        <OwnServiceForm busy={busy} onSubmit={configure} />
      ) : (
        <CloudSignIn
          options={options}
          // Without an answer just now, the versions in force are not known: none are shown.
          legal={options?.reached === true ? (status.legal ?? null) : null}
          onStatus={onStatus}
        />
      )}
      {error !== null ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1">
        <button type="button" className={LINK_CLASS} onClick={() => onOwnService(!ownService)}>
          {ownService ? gt("Sign in to DoeDesk instead") : gt("Use my own detection service")}
        </button>
        {allowTurningOff || refused ? (
          <button
            type="button"
            disabled={busy}
            className={LINK_CLASS}
            onClick={() => void configure({ mode: "off" })}
          >
            {gt("Use DoeDesk without masking")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

type SignInStage =
  | { readonly kind: "enter" }
  | {
      readonly kind: "code";
      readonly requestId: string;
      readonly phone: string;
      readonly resendAt: number;
    }
  | { readonly kind: "link"; readonly requestId: string; readonly email: string };

/**
 * Signs in to DoeDesk Cloud. A first sign-in creates the account, so the form always shows the
 * notice and the Terms checkbox, and sends what it showed. For `deleteAccount` the sign-in only
 * proves who asks: no agreement is asked for unless DoeDesk Cloud refuses a sign-in without one.
 */
export function CloudSignIn({
  options,
  legal,
  onStatus,
  purpose = "signIn",
  onDeleted,
}: {
  readonly options: SignInOptions | null;
  readonly legal: PrivacyLegal | null;
  readonly onStatus: (status: PrivacyStatus) => void;
  readonly purpose?: PrivacySignInPurpose;
  readonly onDeleted?: (deleted: PrivacyAccountDeleted) => void;
}) {
  const gt = useGT();
  const m = usePrivacyMessage();
  const checkboxId = useId();
  const [locale, setLocale, consentSwitchOffered] = useConsentLocale();
  const inSetup = useInSetup();
  // Setup chose its language on its first step, and the consent words follow that choice.
  const languageOffered = consentSwitchOffered && !inSetup;
  const words = CONSENT_WORDS[locale];
  const [chosen, setChosen] = useState<PrivacySignInMethod | null>(null);
  const [stage, setStage] = useState<SignInStage>({ kind: "enter" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [ticked, setTicked] = useState(false);
  // Deleting an account asks for agreement only if DoeDesk Cloud will not sign in without it.
  const [agreementDemanded, setAgreementDemanded] = useState(false);
  const asksAgreement = purpose === "signIn" || agreementDemanded;

  const messageFor = (result: PrivacySignInResult): string => {
    if (result.code === "terms_required") return words.tickFirst;
    const known = result.code == null ? undefined : CLOUD_MESSAGES[result.code];
    return known === undefined ? (result.message ?? m(NOT_WORKED)) : m(known);
  };

  const run = async (payload: PrivacySignInRequest): Promise<PrivacySignInResult | null> => {
    setBusy(true);
    setError(null);
    const result = await signInToCloud(payload).catch(() => null);
    setBusy(false);
    if (result === null) {
      setError(m(UNREACHABLE));
      return null;
    }
    if (!result.ok) {
      setError(messageFor(result));
      if (result.code === "invalid_acceptance") console.error("DoeDesk Cloud:", result.message);
      if (result.code === "terms_required" || result.code === "terms_outdated") {
        // The refusal names the documents in force: show them, and ask again from an empty box.
        onStatus(result.status);
        setTicked(false);
        setAgreementDemanded(true);
      }
      if (result.code === "signup_unavailable") setStage({ kind: "enter" });
    }
    if (result.signedIn) onStatus(result.status);
    if (result.deleted != null) {
      onStatus(result.status);
      onDeleted?.(result.deleted);
    }
    return result.ok ? result : null;
  };

  const waitingFor = stage.kind === "link" ? stage.requestId : null;
  const onLinkChecked = useEffectEvent((result: PrivacySignInResult) => {
    if (result.signedIn) onStatus(result.status);
    if (result.deleted != null) {
      onStatus(result.status);
      onDeleted?.(result.deleted);
    }
    if (!result.ok) {
      setError(
        result.code == null && result.message === null
          ? gt("This sign-in link has expired. Request a new one.")
          : messageFor(result),
      );
      setTicked(false);
      setStage({ kind: "enter" });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer asks the server whether the emailed link was opened, for as long as this form waits on one
  useEffect(() => {
    if (waitingFor === null) return;
    let stopped = false;
    const timer = window.setInterval(() => {
      signInToCloud({ step: "emailCheck", requestId: waitingFor }).then(
        (result) => {
          if (!stopped) onLinkChecked(result);
        },
        // A missed check is retried by the next tick.
        () => undefined,
      );
    }, 2500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [waitingFor]);

  if (options === null) return <Spinner size="md" tone="muted" aria-label={gt("Loading")} />;
  const method = chosen ?? options.methods[0] ?? "email";

  // What the person agreed to is what the form showed: these versions, in this language.
  const acceptance =
    asksAgreement && ticked && legal !== null
      ? {
          acceptance: {
            termsVersion: legal.terms.version,
            privacyVersion: legal.privacy.version,
            locale,
            wordingId: SIGNUP_WORDING_ID,
          },
        }
      : {};
  const blocked = asksAgreement && !ticked;
  const refuseUnticked = (): boolean => {
    if (!blocked) return false;
    setError(words.tickFirst);
    return true;
  };

  const sendCode = async (event?: FormEvent) => {
    event?.preventDefault();
    if (refuseUnticked()) return;
    const result = await run({ step: "phoneStart", phone, purpose, ...acceptance });
    if (result?.requestId) {
      setCode("");
      setStage({
        kind: "code",
        requestId: result.requestId,
        phone,
        resendAt: Date.now() + (result.resendIn ?? 60) * 1000,
      });
    }
  };
  const verify = (requestId: string, value: string) =>
    void run({ step: "phoneVerify", requestId, code: value });
  const sendLink = async (event: FormEvent) => {
    event.preventDefault();
    if (refuseUnticked()) return;
    const result = await run({ step: "emailStart", email, locale, purpose, ...acceptance });
    if (result?.requestId) setStage({ kind: "link", requestId: result.requestId, email });
  };
  // The box is empty every time the form is shown again.
  const startOver = () => {
    setError(null);
    setTicked(false);
    setStage({ kind: "enter" });
  };

  // Under Arabic text the controls start where the text starts: on the right.
  const controlsDir = asksAgreement && locale === "ar" ? "rtl" : undefined;
  const agreement = !asksAgreement ? null : legal === null ? (
    <div className="grid gap-2">
      <p className="text-sm text-muted-foreground">{m(LEGAL_UNKNOWN)}</p>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={refreshSignInOptions}>
          {gt("Try again")}
        </Button>
      </div>
    </div>
  ) : (
    <div className="grid gap-2">
      <ConsentBlock locale={locale} className="grid gap-2.5 text-sm">
        <p className="text-muted-foreground">
          <ConsentSentence parts={words.notice} locale={locale} legal={legal} />
        </p>
        <div className="flex items-start gap-2.5">
          {/* The mark sits on the first line of the sentence, whatever the line height. */}
          <span className="flex h-[1lh] shrink-0 items-center">
            <Checkbox
              id={checkboxId}
              checked={ticked}
              onCheckedChange={(checked) => {
                setTicked(checked === true);
                setError(null);
              }}
            />
          </span>
          <label htmlFor={checkboxId} className="min-w-0 text-foreground">
            <ConsentSentence parts={words.checkbox} locale={locale} legal={legal} />
          </label>
        </div>
      </ConsentBlock>
      {languageOffered ? (
        <div dir={controlsDir}>
          <ConsentLanguageSwitch locale={locale} onChange={setLocale} />
        </div>
      ) : null}
    </div>
  );
  const unavailable = asksAgreement && legal === null;
  const submitLabel = (agree: string, plain: string) =>
    asksAgreement ? (
      <span lang={locale} className={locale === "ar" ? "font-reading" : undefined}>
        {agree}
      </span>
    ) : (
      plain
    );

  return (
    <div className="grid gap-3 sm:max-w-sm">
      {purpose === "signIn" && !options.signUpAvailable && stage.kind === "enter" ? (
        <p className="text-sm text-foreground">{m(SIGN_UP_UNAVAILABLE)}</p>
      ) : null}
      {stage.kind === "enter" && options.methods.length > 1 ? (
        <ToggleGroup
          aria-label={gt("Sign in with")}
          value={[method]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "phone" || next === "email") {
              setChosen(next);
              setError(null);
            }
          }}
        >
          <ToggleGroupItem value="phone">
            <SmartphoneIcon />
            {gt("Phone")}
          </ToggleGroupItem>
          <ToggleGroupItem value="email">
            <MailIcon />
            {gt("Email")}
          </ToggleGroupItem>
        </ToggleGroup>
      ) : null}

      {stage.kind === "code" ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            verify(stage.requestId, code);
          }}
        >
          <p className="text-sm text-muted-foreground">
            {gt("Enter the 6-digit code sent to")}{" "}
            <bdi className="text-foreground">{stage.phone}</bdi>
          </p>
          <Input
            dir="ltr"
            inputMode="numeric"
            autoComplete="one-time-code"
            autoFocus
            required
            maxLength={6}
            placeholder="000000"
            aria-label={gt("Verification code")}
            value={code}
            onChange={(event) => {
              const value = event.target.value.replace(/\D/g, "").slice(0, 6);
              setCode(value);
              if (value.length === 6 && !busy) verify(stage.requestId, value);
            }}
          />
          <div className="mt-1 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || code.length < 6}>
              {gt("Verify")}
            </Button>
            <ResendButton
              resendAt={stage.resendAt}
              disabled={busy}
              onResend={() => void sendCode()}
            />
            <button type="button" className={LINK_CLASS} onClick={startOver}>
              {gt("Use another number")}
            </button>
          </div>
        </form>
      ) : stage.kind === "link" ? (
        <div className="grid gap-2">
          <p className="flex items-center gap-2 text-sm text-foreground">
            <Spinner size="sm" tone="muted" />
            <span>
              {gt("Check your inbox and open the sign-in link sent to")} <bdi>{stage.email}</bdi>
            </span>
          </p>
          <div>
            <button type="button" className={LINK_CLASS} onClick={startOver}>
              {gt("Use another email")}
            </button>
          </div>
        </div>
      ) : method === "phone" ? (
        <form className="grid gap-3" onSubmit={(event) => void sendCode(event)}>
          <Input
            dir="ltr"
            type="tel"
            inputMode="tel"
            autoComplete="tel-national"
            required
            placeholder="05X XXX XXXX"
            aria-label={gt("Mobile number")}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
          {agreement}
          <div dir={controlsDir}>
            <Button type="submit" disabled={busy || blocked || unavailable}>
              {submitLabel(words.sendCode, gt("Send code"))}
            </Button>
          </div>
        </form>
      ) : (
        <form className="grid gap-3" onSubmit={(event) => void sendLink(event)}>
          <Input
            dir="ltr"
            type="email"
            autoComplete="email"
            required
            placeholder="you@company.com"
            aria-label={gt("Email")}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
          {agreement}
          <div dir={controlsDir}>
            <Button type="submit" disabled={busy || blocked || unavailable}>
              {submitLabel(words.sendLink, gt("Send link"))}
            </Button>
          </div>
        </form>
      )}

      {error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ResendButton({
  resendAt,
  disabled,
  onResend,
}: {
  readonly resendAt: number;
  readonly disabled: boolean;
  readonly onResend: () => void;
}) {
  const gt = useGT();
  const [now, setNow] = useState(() => Date.now());
  const waiting = now < resendAt;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a one-second clock for the countdown, running only while there is something to count
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting]);
  return (
    <Button type="button" variant="ghost" disabled={disabled || waiting} onClick={onResend}>
      {waiting ? (
        <span className="tabular-nums">
          {gt("Resend in {seconds}s", { seconds: Math.ceil((resendAt - now) / 1000) })}
        </span>
      ) : (
        gt("Resend code")
      )}
    </Button>
  );
}

export function OwnServiceForm({
  busy,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly onSubmit: (payload: PrivacyConfigureRequest) => Promise<void>;
}) {
  const gt = useGT();
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  return (
    <form
      className="grid gap-2 sm:max-w-sm"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({
          mode: "selfHosted",
          endpoint,
          ...(token.trim().length > 0 ? { token: token.trim() } : {}),
        });
      }}
    >
      <Input
        dir="ltr"
        type="url"
        required
        placeholder="http://localhost:8080"
        aria-label={gt("Service address")}
        value={endpoint}
        onChange={(event) => setEndpoint(event.target.value)}
      />
      <Input
        type="password"
        autoComplete="off"
        placeholder={gt("Access token (optional)")}
        aria-label={gt("Access token")}
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      <div className="mt-1">
        <Button type="submit" disabled={busy}>
          {busy ? gt("Checking…", { $context: "verifying the sign-in code" }) : gt("Connect")}
        </Button>
      </div>
    </form>
  );
}
