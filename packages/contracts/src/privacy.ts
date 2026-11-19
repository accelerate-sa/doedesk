import * as Schema from "effect/Schema";

/**
 * How personal data is found before a request reaches a model. `unconfigured` refuses model
 * requests until the user chooses; `cloud` and `selfHosted` name the detection service; `off`
 * sends requests as written.
 */
export const PrivacyMode = Schema.Literals(["unconfigured", "cloud", "selfHosted", "off"]);
export type PrivacyMode = typeof PrivacyMode.Type;

export const PrivacyLocale = Schema.Literals(["en", "ar"]);
export type PrivacyLocale = typeof PrivacyLocale.Type;

/** One published document: its version, and its address in each language it is published in. */
export const PrivacyLegalDocument = Schema.Struct({
  version: Schema.String,
  url: Schema.Struct({ en: Schema.String, ar: Schema.String }),
});
export type PrivacyLegalDocument = typeof PrivacyLegalDocument.Type;

/** The Terms of Use and Privacy Policy in force, as DoeDesk Cloud last reported them. */
export const PrivacyLegal = Schema.Struct({
  terms: PrivacyLegalDocument,
  privacy: PrivacyLegalDocument,
});
export type PrivacyLegal = typeof PrivacyLegal.Type;

/** Where the signed-in account stands on the Terms of Use. */
export const PrivacyAcceptanceStatus = Schema.Struct({
  /** The account has not accepted the Terms version required now. */
  outstanding: Schema.Boolean,
  /** With `outstanding`: DoeDesk Cloud refuses detection and reading until the account accepts. */
  blocked: Schema.Boolean,
  termsVersion: Schema.NullOr(Schema.String),
  privacyVersion: Schema.NullOr(Schema.String),
  acceptedAt: Schema.NullOr(Schema.String),
});
export type PrivacyAcceptanceStatus = typeof PrivacyAcceptanceStatus.Type;

/**
 * How an image in a request is sent. `redacted`: the image itself with a labelled black box over
 * each value. `text`: only the text read from it, masked. `withheld`: a note in its place.
 */
export const PrivacyImageHandling = Schema.Literals(["redacted", "text", "withheld"]);
export type PrivacyImageHandling = typeof PrivacyImageHandling.Type;

export const PrivacyStatus = Schema.Struct({
  mode: PrivacyMode,
  /** The gateway is running and agent traffic is routed through it. */
  active: Schema.Boolean,
  /** The signed-in account's email, or its phone number with the middle hidden. */
  accountLabel: Schema.NullOr(Schema.String),
  /** Detection service address, when `mode` is `selfHosted`. */
  endpoint: Schema.NullOr(Schema.String),
  /** Real values currently held in the vault on this device. */
  vaultSize: Schema.Number,
  /** Why the gateway is not running, when it should be. */
  problem: Schema.NullOr(Schema.String),
  /** The onboarding questions were answered or skipped. */
  profileAnswered: Schema.Boolean,
  /**
   * Provider driver kinds the user chose to use without the gateway. Their requests are not
   * masked. Optional so that a client can still read an older server's answer.
   */
  directProviders: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Provider driver kinds whose notice about masking the user has read. */
  noticesRead: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Whether Claude Code's usage reports are left on for masked sessions. */
  usageReports: Schema.optionalKey(Schema.Boolean),
  /** How images are sent. Optional so that a client can still read an older server's answer. */
  imageHandling: Schema.optionalKey(PrivacyImageHandling),
  /** Whether agents are offered the tool that reads a file as masked text. */
  readingTool: Schema.optionalKey(Schema.Boolean),
  /** The vendor switches DoeDesk sets for a masked session, exactly as set. */
  sessionSwitches: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** The signed-in account's identifier at DoeDesk Cloud. */
  accountId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** Null when no account is signed in, or DoeDesk Cloud has not yet said where it stands. */
  acceptance: Schema.optionalKey(Schema.NullOr(PrivacyAcceptanceStatus)),
  /** Null until DoeDesk Cloud has been asked. */
  legal: Schema.optionalKey(Schema.NullOr(PrivacyLegal)),
  /** The onboarding answers stored with the account. Null when there are none or they are unknown. */
  profile: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        field: Schema.NullOr(Schema.String),
        workplace: Schema.NullOr(Schema.String),
      }),
    ),
  ),
});
export type PrivacyStatus = typeof PrivacyStatus.Type;

/**
 * What the person agreed to, exactly as the screen showed it: the versions of the two documents
 * it linked to, the language it was in, and which wording of the notice and checkbox it used.
 */
export const PrivacyAcceptance = Schema.Struct({
  termsVersion: Schema.String.check(Schema.isMaxLength(16)),
  privacyVersion: Schema.String.check(Schema.isMaxLength(16)),
  locale: PrivacyLocale,
  wordingId: Schema.String.check(Schema.isMaxLength(64)),
});
export type PrivacyAcceptance = typeof PrivacyAcceptance.Type;

/** Why a sign-in is started. Deleting the account needs a sign-in made minutes before. */
export const PrivacySignInPurpose = Schema.Literals(["signIn", "deleteAccount"]);
export type PrivacySignInPurpose = typeof PrivacySignInPurpose.Type;

/** What DoeDesk Cloud confirmed when it deleted an account. */
export const PrivacyAccountDeleted = Schema.Struct({
  accountId: Schema.String,
  deletedAt: Schema.String,
  /** Records that outlive the account, each with the day it is deleted. */
  kept: Schema.Array(Schema.Struct({ record: Schema.String, until: Schema.String })),
});
export type PrivacyAccountDeleted = typeof PrivacyAccountDeleted.Type;

/** A choice that is separate from which detection service is used. */
export const PrivacyPreferenceRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("providerRoute"),
    provider: Schema.String.check(Schema.isMaxLength(64)),
    /** True: this provider is used without the gateway, and so without masking. */
    direct: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("noticeRead"),
    provider: Schema.String.check(Schema.isMaxLength(64)),
  }),
  Schema.Struct({ kind: Schema.Literal("usageReports"), send: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("imageHandling"), handling: PrivacyImageHandling }),
  Schema.Struct({ kind: Schema.Literal("readingTool"), offered: Schema.Boolean }),
]);
export type PrivacyPreferenceRequest = typeof PrivacyPreferenceRequest.Type;

export const PrivacyConfigureRequest = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("selfHosted"),
    endpoint: Schema.String,
    token: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ mode: Schema.Literal("off") }),
  Schema.Struct({ mode: Schema.Literal("unconfigured") }),
]);
export type PrivacyConfigureRequest = typeof PrivacyConfigureRequest.Type;

export const PrivacyConfigureResult = Schema.Struct({
  ok: Schema.Boolean,
  /** What went wrong, in words the user can act on. Null when `ok`. */
  message: Schema.NullOr(Schema.String),
  status: PrivacyStatus,
});
export type PrivacyConfigureResult = typeof PrivacyConfigureResult.Type;

export const PrivacySignInMethod = Schema.Literals(["phone", "email"]);
export type PrivacySignInMethod = typeof PrivacySignInMethod.Type;

/** One step of signing in to DoeDesk Cloud with a phone code or an emailed link. */
export const PrivacySignInRequest = Schema.Union([
  Schema.Struct({ step: Schema.Literal("options") }),
  Schema.Struct({
    step: Schema.Literal("phoneStart"),
    phone: Schema.String,
    acceptance: Schema.optionalKey(PrivacyAcceptance),
    purpose: Schema.optionalKey(PrivacySignInPurpose),
  }),
  Schema.Struct({
    step: Schema.Literal("phoneVerify"),
    requestId: Schema.String,
    code: Schema.String,
  }),
  Schema.Struct({
    step: Schema.Literal("emailStart"),
    email: Schema.String,
    locale: Schema.optionalKey(Schema.String),
    acceptance: Schema.optionalKey(PrivacyAcceptance),
    purpose: Schema.optionalKey(PrivacySignInPurpose),
  }),
  Schema.Struct({ step: Schema.Literal("emailCheck"), requestId: Schema.String }),
]);
export type PrivacySignInRequest = typeof PrivacySignInRequest.Type;

export const PrivacySignInResult = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
  /** DoeDesk Cloud's error code when it refused, such as `terms_required`. */
  code: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** After `options`: false when no new account can be created where this person is. */
  signUpAvailable: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  /** After a sign-in started to delete the account: what DoeDesk Cloud confirmed. */
  deleted: Schema.optionalKey(Schema.NullOr(PrivacyAccountDeleted)),
  /** After `options`: the ways to sign in, the one to show first leading. */
  methods: Schema.NullOr(Schema.Array(PrivacySignInMethod)),
  /** After `phoneStart` and `emailStart`: names the attempt in the next step. */
  requestId: Schema.NullOr(Schema.String),
  /** After `phoneStart`: seconds until another code may be asked for. */
  resendIn: Schema.NullOr(Schema.Number),
  signedIn: Schema.Boolean,
  status: PrivacyStatus,
});
export type PrivacySignInResult = typeof PrivacySignInResult.Type;

/** What a signed-in person can do with their DoeDesk Cloud account. */
export const PrivacyAccountRequest = Schema.Union([
  /** Records that the person accepted the Terms, from the sheet shown to an account that had not. */
  Schema.Struct({ action: Schema.Literal("accept"), acceptance: PrivacyAcceptance }),
  /** Asks DoeDesk Cloud where the account stands now. */
  Schema.Struct({ action: Schema.Literal("refresh") }),
  /** Everything DoeDesk Cloud holds about the account, as a file. */
  Schema.Struct({ action: Schema.Literal("export") }),
  /** Deletes the account. Works only within minutes of a sign-in started for this purpose. */
  Schema.Struct({ action: Schema.Literal("delete") }),
]);
export type PrivacyAccountRequest = typeof PrivacyAccountRequest.Type;

export const PrivacyAccountResult = Schema.Struct({
  ok: Schema.Boolean,
  code: Schema.NullOr(Schema.String),
  message: Schema.NullOr(Schema.String),
  /** After `export`: the file's contents, as JSON text. */
  exported: Schema.NullOr(Schema.String),
  deleted: Schema.NullOr(PrivacyAccountDeleted),
  status: PrivacyStatus,
});
export type PrivacyAccountResult = typeof PrivacyAccountResult.Type;

/**
 * Usage data: which features are used. `unset` means the person has not yet seen the choice or
 * the notice, and nothing is sent.
 */
export const UsageDataState = Schema.Literals([
  "unset",
  "on_by_default_notice_shown",
  "on_consented",
  "off",
]);
export type UsageDataState = typeof UsageDataState.Type;

/** `ask`: off until the person agrees. `notice`: on by default, with the notice and the switch. */
export const UsageDataBasis = Schema.Literals(["ask", "notice"]);
export type UsageDataBasis = typeof UsageDataBasis.Type;

export const UsageDataStatus = Schema.Struct({
  state: UsageDataState,
  /** Null until the region has been decided. */
  basis: Schema.NullOr(UsageDataBasis),
  /** The random identifier events are sent under. Null while usage data is off. */
  installId: Schema.NullOr(Schema.String),
  /** Events are sent now: the choice allows it and nothing else turns it off. */
  sending: Schema.Boolean,
  /** What turns usage data off whatever the person chooses. Null when the choice decides. */
  blockedBy: Schema.NullOr(Schema.Literals(["environment", "policy"])),
});
export type UsageDataStatus = typeof UsageDataStatus.Type;

export const UsageDataRequest = Schema.Union([
  /**
   * Decides which rule applies here, from the country DoeDesk Cloud reports and from this
   * device's region and time zone. Asked at every start; changes nothing a person chose.
   */
  Schema.Struct({
    action: Schema.Literal("decide"),
    /** The device's locale, such as `en-GB`. */
    locale: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
    /** The device's time zone, such as `Europe/London`. */
    timeZone: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
  }),
  /** The person's own choice, from the first-run screen or from Settings. */
  Schema.Struct({
    action: Schema.Literal("choose"),
    on: Schema.Boolean,
    wordingId: Schema.String.check(Schema.isMaxLength(64)),
    locale: PrivacyLocale,
  }),
  /** The person continued past the notice that says usage data is on. */
  Schema.Struct({
    action: Schema.Literal("noticeShown"),
    wordingId: Schema.String.check(Schema.isMaxLength(64)),
    locale: PrivacyLocale,
  }),
]);
export type UsageDataRequest = typeof UsageDataRequest.Type;

export const PrivacyProfileField = Schema.Literals([
  "legal",
  "finance",
  "government",
  "healthcare",
  "hr",
  "real_estate",
  "consulting",
  "engineering",
  "research",
  "other",
]);
export type PrivacyProfileField = typeof PrivacyProfileField.Type;

export const PrivacyProfileWorkplace = Schema.Literals([
  "self",
  "small_company",
  "large_company",
  "government",
]);
export type PrivacyProfileWorkplace = typeof PrivacyProfileWorkplace.Type;

/** Answers to the onboarding questions. All null when the user skipped them. */
export const PrivacyProfileRequest = Schema.Struct({
  field: Schema.NullOr(PrivacyProfileField),
  fieldOther: Schema.NullOr(Schema.String.check(Schema.isMaxLength(80))),
  workplace: Schema.NullOr(PrivacyProfileWorkplace),
});
export type PrivacyProfileRequest = typeof PrivacyProfileRequest.Type;

export const PrivacyActivityEntry = Schema.Struct({
  at: Schema.String,
  host: Schema.String,
  outcome: Schema.Literals(["masked", "passed", "refused", "blocked"]),
  /** Values replaced with placeholders in this request. */
  masked: Schema.Number,
  /** Images and files removed because they could not be checked. */
  withheld: Schema.Number,
  reason: Schema.NullOr(Schema.String),
});
export type PrivacyActivityEntry = typeof PrivacyActivityEntry.Type;

export const PrivacyActivity = Schema.Struct({
  entries: Schema.Array(PrivacyActivityEntry),
});
export type PrivacyActivity = typeof PrivacyActivity.Type;

export const PrivacyVaultEntry = Schema.Struct({
  /** What the model sees, such as `[PERSON_FBJD2]`. */
  token: Schema.String,
  kind: Schema.String,
  /** The real value. Shown only on this device. */
  value: Schema.String,
});
export type PrivacyVaultEntry = typeof PrivacyVaultEntry.Type;

export const PrivacyVault = Schema.Struct({
  entries: Schema.Array(PrivacyVaultEntry),
});
export type PrivacyVault = typeof PrivacyVault.Type;

/** What was sent in place of one image or document. It holds stand-ins, never the values. */
export const PrivacyRedaction = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  kind: Schema.Literals(["image", "file"]),
  /** `redacted`: the image with boxes. `text`: its masked text only. `withheld`: neither. */
  outcome: Schema.Literals(["redacted", "text", "withheld"]),
  hasImage: Schema.Boolean,
  hasText: Schema.Boolean,
  width: Schema.NullOr(Schema.Number),
  height: Schema.NullOr(Schema.Number),
  /** Boxes over values, and boxes over what could not be read. */
  valueBoxes: Schema.Number,
  unreadableBoxes: Schema.Number,
});
export type PrivacyRedaction = typeof PrivacyRedaction.Type;

export const PrivacyRedactions = Schema.Struct({
  entries: Schema.Array(PrivacyRedaction),
});
export type PrivacyRedactions = typeof PrivacyRedactions.Type;

export const PrivacyRedactionFileRequest = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(64)),
  part: Schema.Literals(["image", "text"]),
});
export type PrivacyRedactionFileRequest = typeof PrivacyRedactionFileRequest.Type;

/** One of a record's two files, for the app to save. Null when the record or the part is gone. */
export const PrivacyRedactionFile = Schema.Struct({
  file: Schema.NullOr(
    Schema.Struct({
      fileName: Schema.String,
      mediaType: Schema.String,
      /** The file's bytes in base64. */
      data: Schema.String,
    }),
  ),
});
export type PrivacyRedactionFile = typeof PrivacyRedactionFile.Type;
