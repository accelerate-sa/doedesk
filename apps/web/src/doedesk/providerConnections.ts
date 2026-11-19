/**
 * Words for how DoeDesk connects to each AI company. Kept in one place so that Settings, the
 * once-only notice and the provider warnings say the same thing. The copy rule: each sentence
 * says who does what to what.
 */
export interface ProviderWords {
  /** What the user picks in the app: "Claude". */
  readonly name: string;
  /** The company's own program DoeDesk runs: "Claude Code". */
  readonly tool: string;
  /** Who receives the requests: "Anthropic". Named in full, so a sentence can start with it. */
  readonly company: string;
}

const KNOWN: Readonly<Record<string, ProviderWords>> = {
  claudeAgent: { name: "Claude", tool: "Claude Code", company: "Anthropic" },
  codex: { name: "Codex", tool: "Codex", company: "OpenAI" },
  // The registry is a list of agents made by others, not a program that sends anything itself.
  acpRegistry: {
    name: "ACP Registry agents",
    tool: "an agent from the ACP Registry",
    company: "the AI company that agent uses",
  },
};

/**
 * A provider DoeDesk has no company name for is described by what it does: its program sends
 * requests to an AI company, which the sentence names as exactly that.
 */
export const providerWords = (driver: string, label: string): ProviderWords =>
  KNOWN[driver] ?? { name: label, tool: label, company: `the AI company ${label} uses` };

/** The notice shown once when masking is first on for a provider, and again from Settings. */
export const maskingNotice = (words: ProviderWords): ReadonlyArray<string> => [
  `DoeDesk runs ${words.tool} with your own sign-in. ${words.tool} sends your requests to ${words.company}.`,
  `Before a request leaves this computer, DoeDesk replaces the personal details in it with stand-ins such as [PERSON_AB12C], and replaces images and PDFs with the text read from them. DoeDesk puts the real details back in the reply.`,
  `${capitalize(words.company)} can tell that DoeDesk changed the request after ${words.tool} wrote it.`,
  `DoeDesk found no rule of ${words.company} against this, and no report of an account that ${words.company} restricted for it. DoeDesk cannot promise that ${words.company} will not restrict your account.`,
  `If losing this account would hurt you, connect ${words.name} with an API key or a business plan instead. Those are the lower-risk ways to connect.`,
];

export const maskingNoticeTitle = (words: ProviderWords): string =>
  `What DoeDesk changes in what ${words.company} receives`;

/** Said at the point where the user turns masking off for one provider. */
export const stopMaskingWarning = (words: ProviderWords): string =>
  `DoeDesk will send your requests to ${words.company} exactly as ${words.tool} writes them. Names and other personal details in your messages and files will reach ${words.company}.`;

export const maskedRowText = (words: ProviderWords): string =>
  `DoeDesk masks personal details in what ${words.tool} sends to ${words.company}.`;

export const directRowText = (words: ProviderWords): string =>
  `Not masked. ${capitalize(words.company)} receives your messages and files as they are.`;

/**
 * Providers that sign in to a consumer plan outside the plan owner's own program. They are
 * offered only in Developer mode, and carry this warning wherever they are set up.
 */
const CONSUMER_LOGIN_WARNINGS: Readonly<Record<string, string>> = {
  antigravity:
    "Google has said that using an Antigravity sign-in with tools other than its own breaks its terms, and Google has suspended accounts for it. DoeDesk cannot make this safe. Use an API key if the Google account matters to you.",
  pi: "pi signs in to Claude, ChatGPT, Gemini and Copilot plans as its own program. Anthropic and Google say that using a plan this way breaks their terms. An API key in pi does not have this problem.",
};

export const consumerLoginWarning = (driver: string): string | undefined =>
  CONSUMER_LOGIN_WARNINGS[driver];

/** Whether the provider is offered when adding one. A provider already added stays visible. */
export const isProviderOffered = (driver: string, developerMode: boolean): boolean =>
  developerMode || CONSUMER_LOGIN_WARNINGS[driver] === undefined;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
