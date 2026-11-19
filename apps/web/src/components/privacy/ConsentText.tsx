import type { PrivacyLegal, PrivacyLocale } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { CONSENT_WORDS, type ConsentPart } from "~/doedesk/consentWords";
import { legalDocumentUrl } from "~/legalLinks";
import { cn } from "~/lib/utils";

// The link colour, and underlined: a document's name must not look like the words around it.
const DOCUMENT_LINK_CLASS =
  "rounded-xs text-info-foreground underline underline-offset-2 outline-none hover:decoration-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * Sets what a person agrees to in the language they read it in. Arabic runs right to left in the
 * reading face, with the line height that face needs; the rest of the screen stays as it is.
 */
export function ConsentBlock({
  locale,
  className,
  children,
}: {
  readonly locale: PrivacyLocale;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      lang={locale}
      dir={locale === "ar" ? "rtl" : "ltr"}
      className={cn(className, locale === "ar" && "font-reading text-base leading-7")}
    >
      {children}
    </div>
  );
}

/** A sentence of the consent texts, with each document's name as a link that opens the browser. */
export function ConsentSentence({
  parts,
  locale,
  legal,
}: {
  readonly parts: ReadonlyArray<ConsentPart>;
  readonly locale: PrivacyLocale;
  readonly legal: PrivacyLegal | null | undefined;
}) {
  return parts.map((part) => {
    if (typeof part === "string") return part;
    if ("strong" in part) {
      return (
        <strong key={part.strong} className="font-semibold text-foreground">
          {part.strong}
        </strong>
      );
    }
    return (
      <a
        key={part.link}
        className={DOCUMENT_LINK_CLASS}
        href={legalDocumentUrl(legal, part.link, locale)}
        target="_blank"
        rel="noreferrer noopener"
        // Opening a document neither ticks the box around it nor sends the form.
        onClick={(event) => event.stopPropagation()}
      >
        {part.text}
      </a>
    );
  });
}

/** Switches the consent texts to the other language they are published in. */
export function ConsentLanguageSwitch({
  locale,
  onChange,
}: {
  readonly locale: PrivacyLocale;
  readonly onChange: (locale: PrivacyLocale) => void;
}) {
  const other = locale === "ar" ? "en" : "ar";
  return (
    <button
      type="button"
      lang={other}
      className={cn(
        "rounded-xs text-xs text-muted-foreground underline decoration-current/40 underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        other === "ar" && "font-reading text-sm",
      )}
      onClick={() => onChange(other)}
    >
      {CONSENT_WORDS[other].languageName}
    </button>
  );
}
