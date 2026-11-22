import { isolateLeftToRight } from "@t3tools/shared/textDirection";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/**
 * Words for how DoeDesk connects to each AI company. Kept in one place so that Settings, the
 * once-only notice and the provider warnings say the same thing. The copy rule: each sentence
 * says who does what to what.
 */
export interface ProviderWords {
  // Each may be a `msg()` string; resolve with `resolveProviderWords` before showing one.
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
    name: msg("ACP Registry agents"),
    tool: msg("an agent from the ACP Registry"),
    company: msg("the AI company that agent uses"),
  },
};

/**
 * A provider DoeDesk has no company name for is described by what it does: its program sends
 * requests to an AI company, which the sentence names as exactly that.
 */
export const providerWords = (driver: string, label: string): ProviderWords =>
  KNOWN[driver] ?? {
    name: label,
    tool: label,
    company: msg("the AI company {label} uses", { label }),
  };

/** The words in the UI language. Names such as "Anthropic" are not in a catalog and stay. */
export const resolveProviderWords = (
  words: ProviderWords,
  resolve: MessageResolver = m,
): ProviderWords => ({
  name: resolve(words.name),
  tool: resolve(words.tool),
  company: resolve(words.company),
});

const sentenceWords = (words: ProviderWords, resolve: MessageResolver) => {
  const { name, tool, company } = resolveProviderWords(words, resolve);
  return { name, tool, company, Company: capitalize(company), Tool: capitalize(tool) };
};

/** The notice shown once when masking is first on for a provider, and again from Settings. */
export const maskingNotice = (
  words: ProviderWords,
  resolve: MessageResolver = m,
): ReadonlyArray<string> => {
  const { name, tool, company, Company, Tool } = sentenceWords(words, resolve);
  return [
    resolve(
      msg("DoeDesk runs {tool} with your own sign-in. {Tool} sends your requests to {company}.", {
        tool,
        Tool,
        company,
      }),
    ),
    resolve(
      msg(
        "Before a request leaves this computer, DoeDesk replaces the personal details in it with stand-ins such as {example}, and replaces images and PDFs with the text read from them. DoeDesk puts the real details back in the reply.",
        { example: isolateLeftToRight("[PERSON_AB12C]") },
      ),
    ),
    resolve(
      msg("{Company} can tell that DoeDesk changed the request after {tool} wrote it.", {
        Company,
        tool,
      }),
    ),
    resolve(
      msg(
        "DoeDesk found no rule of {company} against this, and no report of an account that {company} restricted for it. DoeDesk cannot promise that {company} will not restrict your account.",
        { company },
      ),
    ),
    resolve(
      msg(
        "If losing this account would hurt you, connect {name} with an API key or a business plan instead. Those are the lower-risk ways to connect.",
        { name },
      ),
    ),
  ];
};

export const maskingNoticeTitle = (words: ProviderWords, resolve: MessageResolver = m): string =>
  resolve(
    msg("What DoeDesk changes in what {company} receives", {
      company: sentenceWords(words, resolve).company,
    }),
  );

/** Said at the point where the user turns masking off for one provider. */
export const stopMaskingWarning = (words: ProviderWords, resolve: MessageResolver = m): string => {
  const { tool, company } = sentenceWords(words, resolve);
  return resolve(
    msg(
      "DoeDesk will send your requests to {company} exactly as {tool} writes them. Names and other personal details in your messages and files will reach {company}.",
      { company, tool },
    ),
  );
};

export const maskedRowText = (words: ProviderWords, resolve: MessageResolver = m): string => {
  const { tool, company } = sentenceWords(words, resolve);
  return resolve(
    msg("DoeDesk masks personal details in what {tool} sends to {company}.", { tool, company }),
  );
};

export const directRowText = (words: ProviderWords, resolve: MessageResolver = m): string =>
  resolve(
    msg("Not masked. {Company} receives your messages and files as they are.", {
      Company: sentenceWords(words, resolve).Company,
    }),
  );

/**
 * Providers that sign in to a consumer plan outside the plan owner's own program. They are
 * offered only in Developer mode, and carry this warning wherever they are set up.
 */
const CONSUMER_LOGIN_WARNINGS: Readonly<Record<string, string>> = {
  antigravity: msg(
    "Google has said that using an Antigravity sign-in with tools other than its own breaks its terms, and Google has suspended accounts for it. DoeDesk cannot make this safe. Use an API key if the Google account matters to you.",
  ),
  pi: msg(
    "pi signs in to Claude, ChatGPT, Gemini and Copilot plans as its own program. Anthropic and Google say that using a plan this way breaks their terms. An API key in pi does not have this problem.",
  ),
};

export const consumerLoginWarning = (
  driver: string,
  resolve: MessageResolver = m,
): string | undefined => {
  const warning = CONSUMER_LOGIN_WARNINGS[driver];
  return warning === undefined ? undefined : resolve(warning);
};

/** Whether the provider is offered when adding one. A provider already added stays visible. */
export const isProviderOffered = (driver: string, developerMode: boolean): boolean =>
  developerMode || CONSUMER_LOGIN_WARNINGS[driver] === undefined;

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
