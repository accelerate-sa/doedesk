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

/**
 * The model that reads sealed documents. `cloud`: the one DoeDesk Cloud hosts, at the upstream for
 * the account's region. `custom`: the person's own server, which is any address that speaks Chat
 * Completions or Responses. `off`: none.
 */
export const PrivacyWorkerKind = Schema.Literals(["off", "cloud", "custom"]);
export type PrivacyWorkerKind = typeof PrivacyWorkerKind.Type;

/**
 * Where DoeDesk Cloud runs the hosted worker for an account: Saudi Arabia, the European Union, or
 * with no region restriction. It decides only the worker's upstream, which DoeDesk Cloud resolves.
 */
export const PrivacyAccountRegion = Schema.Literals(["sa", "eu", "global"]);
export type PrivacyAccountRegion = typeof PrivacyAccountRegion.Type;

export const PrivacyWorkerDriver = Schema.Literals(["chatCompletions", "responses"]);
export type PrivacyWorkerDriver = typeof PrivacyWorkerDriver.Type;

/** The worker as a settings screen shows it. The key is never part of it. */
export const PrivacyWorkerStatus = Schema.Struct({
  kind: PrivacyWorkerKind,
  /** The address sealed documents are sent to, unmasked. Null when no worker is connected. */
  address: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  driver: Schema.NullOr(PrivacyWorkerDriver),
  reasoningEffort: Schema.NullOr(Schema.String),
  /** A worker is connected and has not stopped answering. */
  available: Schema.Boolean,
  /** Where the worker's server said it handled the last call, when it says so. */
  servedFrom: Schema.NullOr(Schema.String),
  /** `cloud` only: the account region whose worker is used. Optional for an older server. */
  region: Schema.optionalKey(Schema.NullOr(PrivacyAccountRegion)),
  /** The worker's server last said it was busy, with this many calls waiting. Not a failure. */
  busy: Schema.optionalKey(Schema.NullOr(Schema.Struct({ waiting: Schema.Number }))),
  /**
   * DoeDesk Cloud's worker was the one in use and the signed-in account does not have it. Sealed
   * files stay sealed; nothing reads them until the person connects a server of their own.
   */
  notIncluded: Schema.optionalKey(Schema.Boolean),
});
export type PrivacyWorkerStatus = typeof PrivacyWorkerStatus.Type;

/**
 * Which hosts other than model hosts agents may reach. The gateway restores masked values in what
 * a model writes, so a command the model runs can carry them to any host it can reach. Sealed
 * values are never restored in a command, so sealing a document does not change this rule.
 */
export const PrivacyEgressPolicy = Schema.Literals(["open", "allowlist", "closed"]);
export type PrivacyEgressPolicy = typeof PrivacyEgressPolicy.Type;

export const PrivacyStatus = Schema.Struct({
  mode: PrivacyMode,
  /** The worker that reads sealed documents. Optional so a client can read an older server's answer. */
  worker: Schema.optionalKey(PrivacyWorkerStatus),
  /** The rule the person chose for hosts that are not AI hosts. */
  egress: Schema.optionalKey(
    Schema.Struct({
      policy: PrivacyEgressPolicy,
      hosts: Schema.Array(Schema.String),
      /** Hosts the rule refused since the app started and that are still refused, newest first. */
      refused: Schema.optionalKey(
        Schema.Array(Schema.Struct({ host: Schema.String, at: Schema.String })),
      ),
    }),
  ),
  /** Sealed documents held on this device, over all projects. */
  sealedDocuments: Schema.optionalKey(Schema.Number),
  /**
   * Turns that have not started yet because a file is still arriving in a sealed folder of
   * their project: the folder's name and how many files are waited for.
   */
  sealingBeforeTurn: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ project: Schema.String, folder: Schema.String, files: Schema.Number }),
    ),
  ),
  /** Whether the worker also checks every text for references and names the first check missed. */
  secondPass: Schema.optionalKey(Schema.Boolean),
  /**
   * Whether public web pages an agent fetches, and web search results, are checked for new
   * personal data. False: only values already known are replaced in them.
   */
  webResultsChecked: Schema.optionalKey(Schema.Boolean),
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
  /** The signed-in account's region. Null when signed out, or DoeDesk Cloud has not yet said. */
  accountRegion: Schema.optionalKey(Schema.NullOr(PrivacyAccountRegion)),
  /**
   * DoeDesk Cloud's hosted worker is included for the signed-in account: an organization has it
   * under an agreement. Missing reads as false: an older server, or a DoeDesk Cloud that does
   * not say. Without it the worker is the person's own server, or none.
   */
  hostedWorkerEntitled: Schema.optionalKey(Schema.Boolean),
  /**
   * False: the account has DoeDesk Cloud's worker and DoeDesk Cloud offers none in its region
   * yet. Nothing is sent there or to another region; the person can connect a server of their
   * own. Missing reads as offered: an older server.
   */
  hostedWorkerOffered: Schema.optionalKey(Schema.Boolean),
  /**
   * DoeDesk Cloud's worker for the account's region, as DoeDesk Cloud names it: who runs the
   * model, and where. Shown as it is when the app has no sentence of its own for that operator.
   */
  hostedWorker: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ host: Schema.String, location: Schema.String })),
  ),
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
  Schema.Struct({ kind: Schema.Literal("secondPass"), on: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("webResults"), check: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("egress"),
    policy: PrivacyEgressPolicy,
    hosts: Schema.Array(Schema.String.check(Schema.isMaxLength(253))).check(
      Schema.isMaxLength(200),
    ),
  }),
  /** Lets one refused host through: until the app closes, or for good by adding it to the list. */
  Schema.Struct({
    kind: Schema.Literal("allowHost"),
    host: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(253)),
    lasting: Schema.Boolean,
  }),
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

/** Why one's own detection service could not be connected, for the app to say in its language. */
export const PrivacyServiceProblem = Schema.Struct({
  kind: Schema.Literals([
    "address",
    "unreachable",
    "timeout",
    "busy",
    "allowance",
    "failing",
    "signIn",
    "refused",
    "unreadable",
  ]),
  host: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
});
export type PrivacyServiceProblem = typeof PrivacyServiceProblem.Type;

export const PrivacyConfigureResult = Schema.Struct({
  ok: Schema.Boolean,
  /** What went wrong, in words the user can act on. Null when `ok`. */
  message: Schema.NullOr(Schema.String),
  problem: Schema.optional(PrivacyServiceProblem),
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
  /** Changes where the hosted worker runs. Takes effect with the next question about a sealed file. */
  Schema.Struct({ action: Schema.Literal("setRegion"), region: PrivacyAccountRegion }),
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
  /**
   * Names an entry the client words itself, in its own language; `reason` says the same in
   * English for a client that does not know the name. Absent from an older server.
   */
  notice: Schema.optionalKey(Schema.String),
  /**
   * For a request that was not sent: its method and its path without the query, so the person
   * can see which one it was. Absent from an older server and for a request that was sent.
   */
  request: Schema.optionalKey(Schema.String),
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
  /** False for a value of a sealed document: masking it cannot be stopped. */
  removable: Schema.optionalKey(Schema.Boolean),
});
export type PrivacyVaultEntry = typeof PrivacyVaultEntry.Type;

export const PrivacyVault = Schema.Struct({
  entries: Schema.Array(PrivacyVaultEntry),
  /**
   * Values the person stopped masking: they are sent as written. Each keeps the stand-in it had,
   * which is still restored where a model writes it. Optional so a client can read an older server.
   */
  unmasked: Schema.optionalKey(Schema.Array(PrivacyVaultEntry)),
});
export type PrivacyVault = typeof PrivacyVault.Type;

/**
 * Stops masking one value, for a word that is not personal data, or masks it again. From the next
 * request on the value is sent as written, or replaced again, in every conversation.
 */
export const PrivacyVaultRequest = Schema.Struct({
  action: Schema.Literals(["stopMasking", "maskAgain"]),
  /** The stand-in of the entry, such as `[ORG_PGCQH]`. */
  token: Schema.String.check(Schema.isMaxLength(32)),
});
export type PrivacyVaultRequest = typeof PrivacyVaultRequest.Type;

export const PrivacyVaultResult = Schema.Struct({
  /** False when no such entry exists, or it belongs to a sealed document. */
  ok: Schema.Boolean,
  vault: PrivacyVault,
  status: PrivacyStatus,
});
export type PrivacyVaultResult = typeof PrivacyVaultResult.Type;

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

/** Connects, changes or removes the worker that reads sealed documents. */
export const PrivacyWorkerRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("off") }),
  /** The worker DoeDesk Cloud hosts. Needs a signed-in account. */
  Schema.Struct({ kind: Schema.Literal("cloud") }),
  Schema.Struct({
    kind: Schema.Literal("custom"),
    /** The API root, such as `http://localhost:11434/v1`. */
    baseUrl: Schema.String.check(Schema.isMaxLength(2048)),
    apiKey: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
    model: Schema.String.check(Schema.isMaxLength(200)),
    driver: PrivacyWorkerDriver,
    reasoningEffort: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
  }),
]);
export type PrivacyWorkerRequest = typeof PrivacyWorkerRequest.Type;

/**
 * A document sealed for a project. Its name is for the person. An agent, and so the AI company,
 * is told the handle and `label`: the name with the values found in it replaced by stand-ins, or
 * the handle and the file type.
 */
export const PrivacySealedDocument = Schema.Struct({
  handle: Schema.String,
  name: Schema.String,
  /** What the AI company is told the file is called. Optional for an older server. */
  label: Schema.optionalKey(Schema.String),
  /** The person chose the handle and the file type alone for this file. */
  neutralLabel: Schema.optionalKey(Schema.Boolean),
  mediaType: Schema.String,
  characters: Schema.Number,
  lines: Schema.Number,
  addedAt: Schema.String,
  /** Where the file was moved out of when it was sealed. Unset when it was sealed from a copy. */
  origin: Schema.optionalKey(Schema.String),
  /**
   * Set while the file is sealed but has no text, so nothing can be asked about it yet. `service`:
   * the reading service did not answer, and reading it again may work as the file is.
   */
  unread: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literals(["unsupported", "noText", "tooLarge", "service"]),
      message: Schema.String,
    }),
  ),
});
export type PrivacySealedDocument = typeof PrivacySealedDocument.Type;

/** A finished file that holds sealed values, kept for the person. */
export const PrivacySealedOutput = Schema.Struct({
  name: Schema.String,
  characters: Schema.Number,
  writtenAt: Schema.String,
  filled: Schema.Number,
});
export type PrivacySealedOutput = typeof PrivacySealedOutput.Type;

/**
 * A subfolder whose files are sealed, now and as they arrive. Its sealed files are the listing's
 * documents whose `origin` lies inside `path`.
 */
export const PrivacySealedFolder = Schema.Struct({
  path: Schema.String,
  sealedAt: Schema.String,
  /** Files that could not be sealed and stay readable in the folder, each with the reason. */
  left: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String })),
  /** Every file sealed in it, now and later, is told to the AI company by handle and type alone. */
  neutralLabels: Schema.optionalKey(Schema.Boolean),
});
export type PrivacySealedFolder = typeof PrivacySealedFolder.Type;

export const PrivacySealedListing = Schema.Struct({
  documents: Schema.Array(PrivacySealedDocument),
  outputs: Schema.Array(PrivacySealedOutput),
  /** Optional so a client can read an older server's answer. */
  folders: Schema.optionalKey(Schema.Array(PrivacySealedFolder)),
  /** Answers given in clear about the most-asked document, and how many each document may give. */
  clear: Schema.Struct({ mostOnOneDocument: Schema.Number, perDocument: Schema.Number }),
});
export type PrivacySealedListing = typeof PrivacySealedListing.Type;

/**
 * One answer about a sealed document that reached the agent's model as it is. `value` holds a
 * choice or a list's size. `ran`, `failed`: the agent ran a program; `asked` is its text and
 * `value` what it was shown, or why it failed, which the agent is not told.
 */
export const PrivacyClearAnswer = Schema.Struct({
  at: Schema.String,
  handle: Schema.String,
  /** The file's name when the answer was given. Empty when it is not known. */
  document: Schema.String,
  /** The question as the agent put it. */
  asked: Schema.String,
  kind: Schema.Literals(["yes", "no", "value", "notStated", "unchecked", "ran", "failed"]),
  value: Schema.NullOr(Schema.String),
  /**
   * The worker that answered: a hosted region (`sa`, `eu`, `global`) or `custom:<host>`. Unset on
   * answers recorded before routes were.
   */
  route: Schema.optionalKey(Schema.String),
});
export type PrivacyClearAnswer = typeof PrivacyClearAnswer.Type;

const SealedProject = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const SealedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
/** As many files as one confirmation seals from the file list. */
export const MAX_SEALED_AT_ONCE = 200;
const SealedPaths = Schema.Array(SealedPath).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_SEALED_AT_ONCE),
);

/**
 * What a turn asked of sealed files, kept on the computer that holds them: the files by the
 * names they had, and every answer that reached the agent's model as it is.
 */
export const PrivacySealedTurn = Schema.Struct({
  asked: Schema.Array(
    Schema.Struct({
      handle: Schema.String,
      name: Schema.String,
      /** What the AI company was told the file is called. Absent in a record made before labels. */
      label: Schema.optionalKey(Schema.String),
    }),
  ),
  answers: Schema.Array(PrivacyClearAnswer),
});
export type PrivacySealedTurn = typeof PrivacySealedTurn.Type;

/** The person chose to tell the AI company the handle and the file type alone, not the name. */
const NeutralLabel = { neutralLabel: Schema.optionalKey(Schema.Boolean) };

/** What to do with a project's sealed documents. Every answer carries the listing afterwards. */
export const PrivacySealedRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list"), projectId: SealedProject }),
  /** Seals a file sent with the request. */
  Schema.Struct({
    action: Schema.Literal("add"),
    projectId: SealedProject,
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
    /** The file's bytes in base64. */
    data: Schema.String,
    ...NeutralLabel,
  }),
  /** Seals a file that is on the server's own disk. With `move`, it also leaves its folder. */
  Schema.Struct({
    action: Schema.Literal("addPath"),
    projectId: SealedProject,
    path: SealedPath,
    move: Schema.optionalKey(Schema.Boolean),
    ...NeutralLabel,
  }),
  /** Seals several files of the server's own disk, each moved out of its folder. */
  Schema.Struct({
    action: Schema.Literal("addPaths"),
    projectId: SealedProject,
    paths: SealedPaths,
    ...NeutralLabel,
  }),
  /**
   * Before a confirmation: what the AI company would be told each of these file names is. Names
   * only; nothing is sealed.
   */
  Schema.Struct({
    action: Schema.Literal("labels"),
    projectId: SealedProject,
    names: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))).check(
      Schema.isMaxLength(24),
    ),
  }),
  /**
   * Before sealing a file that is attached to a message, and so has no path: whether the
   * project's folder holds the file itself, and which files there would stay readable. Nothing
   * is sealed and the file is not sent: its digest and size are.
   */
  Schema.Struct({
    action: Schema.Literal("inspectCopy"),
    projectId: SealedProject,
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
    /** SHA-256 of the file's bytes, in hexadecimal. */
    sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
    size: Schema.Number,
  }),
  /** The person's choice for one sealed file: its handle and type alone, or its masked name. */
  Schema.Struct({
    action: Schema.Literal("setLabel"),
    projectId: SealedProject,
    handle: Schema.String.check(Schema.isMaxLength(32)),
    neutral: Schema.Boolean,
  }),
  /** Before sealing a file in place: what Git keeps of it, and whether chats could read it. */
  Schema.Struct({ action: Schema.Literal("inspect"), projectId: SealedProject, path: SealedPath }),
  /** Before sealing several files, or a subfolder: how many, and what the person is told. */
  Schema.Struct({
    action: Schema.Literal("inspectPaths"),
    projectId: SealedProject,
    paths: SealedPaths,
  }),
  Schema.Struct({
    action: Schema.Literal("inspectFolder"),
    projectId: SealedProject,
    path: SealedPath,
  }),
  /**
   * Seals a subfolder of the project, never the project's own folder: every file in it that can
   * be sealed, and every such file that appears in it later.
   */
  Schema.Struct({
    action: Schema.Literal("sealFolder"),
    projectId: SealedProject,
    path: SealedPath,
    /** For every file in it, now and later. */
    ...NeutralLabel,
  }),
  /** Stops sealing a folder and puts its files back as they were. */
  Schema.Struct({
    action: Schema.Literal("unsealFolder"),
    projectId: SealedProject,
    path: SealedPath,
  }),
  /** What one turn asked of sealed files. */
  Schema.Struct({
    action: Schema.Literal("turn"),
    projectId: SealedProject,
    runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
  /** Unseals: a file that was moved out of its folder is put back where it was. */
  Schema.Struct({
    action: Schema.Literal("remove"),
    projectId: SealedProject,
    handle: Schema.String.check(Schema.isMaxLength(32)),
  }),
  /** Reads a sealed file that has no text yet, from the copy that was kept when it was sealed. */
  Schema.Struct({
    action: Schema.Literal("read"),
    projectId: SealedProject,
    handle: Schema.String.check(Schema.isMaxLength(32)),
  }),
  /** Starts each document's count of clear answers again. The record of them stays. */
  Schema.Struct({ action: Schema.Literal("resetLimits"), projectId: SealedProject }),
  /** The record of every answer given in clear. */
  Schema.Struct({ action: Schema.Literal("answers"), projectId: SealedProject }),
  /** A finished file with its sealed values in place. */
  Schema.Struct({
    action: Schema.Literal("output"),
    projectId: SealedProject,
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  }),
]);
export type PrivacySealedRequest = typeof PrivacySealedRequest.Type;

export const PrivacySealedResult = Schema.Struct({
  ok: Schema.Boolean,
  /** What went wrong, in words the person can act on. Null when `ok`. */
  message: Schema.NullOr(Schema.String),
  listing: PrivacySealedListing,
  /** After `add` and `addPath`: the handle the document was given. */
  handle: Schema.NullOr(Schema.String),
  /** After `output`: the file's text. */
  output: Schema.NullOr(Schema.String),
  /** After `inspect`: the person's own repository holds the file, so earlier versions stay readable there. */
  inGit: Schema.optionalKey(Schema.Boolean),
  /** After an inspection: chats ran in the folder while a file to be sealed was readable there. */
  seenByChats: Schema.optionalKey(Schema.Boolean),
  /** After `remove`: the file's name, where it is now, and whether it had to take another name. */
  unsealed: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      path: Schema.NullOr(Schema.String),
      renamed: Schema.Boolean,
    }),
  ),
  /** After `answers`: the record, oldest first. Optional so a client can read an older server. */
  answers: Schema.optionalKey(Schema.NullOr(Schema.Array(PrivacyClearAnswer))),
  /** After `inspectPaths` and `inspectFolder`. */
  inspected: Schema.optionalKey(
    Schema.Struct({
      /** Files the worker will be able to read, and so be asked about. */
      files: Schema.Number,
      /** Files of a kind that cannot be read: sealed all the same, and not asked about. */
      unsupported: Schema.Number,
      /** Of `files`: PDFs and images, which the reading service reads first. */
      readFirst: Schema.Number,
      /** Tracked by Git, which keeps their earlier versions readable. */
      inGit: Schema.Number,
    }),
  ),
  /**
   * After an inspection and `labels`: what the AI company would be told the first few files are
   * called. `label` is null for a name that cannot be checked now: its handle and type are sent.
   */
  labels: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, label: Schema.NullOr(Schema.String) })),
  ),
  /**
   * After `inspectCopy` and `add`, for a file that came as a copy. `original`: the file itself in
   * the project's folder, which is sealed where it lies. `readable`: files of the folder that
   * stay readable when only the copy is sealed. Paths are written from the project's folder.
   */
  copy: Schema.optionalKey(
    Schema.Struct({
      original: Schema.NullOr(Schema.String),
      readable: Schema.Array(Schema.String),
      /** False when the folder was too large to look through. */
      complete: Schema.Boolean,
    }),
  ),
  /** After `addPaths` and `sealFolder`: how many were sealed, and which were not, with the reason. */
  batch: Schema.optionalKey(
    Schema.Struct({
      sealed: Schema.Number,
      /** Of `sealed`: kept with no text yet, so nothing can be asked about them. */
      unread: Schema.optionalKey(Schema.Number),
      failed: Schema.Array(Schema.Struct({ name: Schema.String, message: Schema.String })),
    }),
  ),
  /** After `unsealFolder`: how many files went back, and which could not, with the reason. */
  folderUnsealed: Schema.optionalKey(
    Schema.Struct({
      restored: Schema.Number,
      renamed: Schema.Number,
      failed: Schema.Array(Schema.Struct({ name: Schema.String, message: Schema.String })),
    }),
  ),
  /** After `turn`: null when the turn asked nothing of sealed files, or is no longer kept. */
  turn: Schema.optionalKey(Schema.NullOr(PrivacySealedTurn)),
});
export type PrivacySealedResult = typeof PrivacySealedResult.Type;

/** As many handles as a turn's record lists. `askedCount` says when there were more. */
export const MAX_TURN_SEALED_HANDLES = 50;

/**
 * The sealed files a turn's agent asked about. Handles and counts only: the files' names and the
 * answers stay on the computer that holds the files (`PrivacySealedTurn`).
 */
const TurnSealedFiles = {
  sealedFiles: Schema.optionalKey(
    Schema.Struct({
      /** Handles in the order first asked, at most `MAX_TURN_SEALED_HANDLES`. */
      asked: Schema.Array(Schema.String),
      askedCount: Schema.Number,
      /** Answers that reached the agent's model as they are: a yes or no, a choice, and the like. */
      clear: Schema.Number,
    }),
  ),
};

/**
 * What the privacy gateway did to the requests of one turn, kept on the turn. Counts only: no
 * value and no stand-in. Each number counts something the gateway did, never what it missed.
 */
export const PrivacyTurnRecord = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("masked"),
    ...TurnSealedFiles,
    /** Distinct values replaced with stand-ins in what was sent, by kind, most first. */
    replaced: Schema.Array(Schema.Struct({ kind: Schema.String, count: Schema.Number })),
    /** Requests whose content was rewritten before they were sent. */
    rewritten: Schema.Number,
    /** Requests that were not sent, because they could not be checked. */
    refused: Schema.Number,
    /** Images sent with their values covered: the most in one request of the turn. */
    redacted: Schema.Number,
    /** Images and files sent as the text read from them: the most in one request. */
    read: Schema.Number,
    /** Images and files left out: the most in one request. */
    withheld: Schema.Number,
    /** Texts left out because they held wording of a sealed document: the most in one request. */
    sealed: Schema.Number,
    /**
     * `session`: the requests named this chat. `time`: they named no chat, so the counts cover
     * every such request since the last turn counted this way, whichever chat sent it.
     */
    attribution: Schema.Literals(["session", "time"]),
  }),
  /** The turn's provider was not routed through the gateway: masking off, or off for it. */
  Schema.Struct({
    state: Schema.Literal("unmasked"),
    reason: Schema.Literals(["off", "direct"]),
    ...TurnSealedFiles,
  }),
  /**
   * The provider was started behind the gateway and the turn completed, but the gateway rewrote
   * no request it can tie to this chat. Whatever the turn sent, the gateway did not mask it.
   */
  Schema.Struct({ state: Schema.Literal("unseen"), ...TurnSealedFiles }),
]);
export type PrivacyTurnRecord = typeof PrivacyTurnRecord.Type;

export const PrivacyTurnValuesRequest = Schema.Struct({
  runId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export type PrivacyTurnValuesRequest = typeof PrivacyTurnValuesRequest.Type;

/** A turn's stand-ins beside their real values. Shown only on the device that holds the vault. */
export const PrivacyTurnValues = Schema.Struct({
  /** Null when the list for this turn is no longer kept. */
  values: Schema.NullOr(
    Schema.Array(
      Schema.Struct({
        token: Schema.String,
        kind: Schema.String,
        /** Null when the vault no longer holds the stand-in. */
        value: Schema.NullOr(Schema.String),
        /** The value comes from a sealed document. */
        sealed: Schema.Boolean,
      }),
    ),
  ),
});
export type PrivacyTurnValues = typeof PrivacyTurnValues.Type;

const KnownValuesRunId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

/**
 * `turns`: the stand-ins written into what each of these turns sent. `vault`: every value the
 * gateway replaces wherever it finds it.
 */
export const PrivacyKnownValuesRequest = Schema.Union([
  Schema.Struct({
    scope: Schema.Literal("turns"),
    runIds: Schema.Array(KnownValuesRunId).check(Schema.isMaxLength(1000)),
  }),
  Schema.Struct({ scope: Schema.Literal("vault") }),
]);
export type PrivacyKnownValuesRequest = typeof PrivacyKnownValuesRequest.Type;

/**
 * Stand-ins with every spelling of their values, for marking them where the person reads them.
 * Shown only on the device that holds the vault. Empty while masking is off.
 */
export const PrivacyKnownValues = Schema.Struct({
  /** Where two values share a spelling, the gateway writes the one that is not sealed. */
  values: Schema.Array(
    Schema.Struct({
      token: Schema.String,
      surfaces: Schema.Array(Schema.String),
      /** The value comes from a sealed document. */
      sealed: Schema.Boolean,
    }),
  ),
  /** `turns` only: the turns still kept, each with its stand-ins. */
  turns: Schema.Array(Schema.Struct({ runId: Schema.String, tokens: Schema.Array(Schema.String) })),
});
export type PrivacyKnownValues = typeof PrivacyKnownValues.Type;

/**
 * Sent when what is sealed on the server changed, however it happened; the client reads its
 * lists again. `revision` grows with each change and is never one an earlier server process
 * sent. A subscription's first event carries the count as it stands.
 */
export const PrivacySealedChange = Schema.Struct({ revision: Schema.Number });
export type PrivacySealedChange = typeof PrivacySealedChange.Type;
