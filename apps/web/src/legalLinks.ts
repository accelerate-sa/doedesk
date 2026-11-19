import type { PrivacyLegal, PrivacyLocale } from "@t3tools/contracts";

import type { ConsentDocument } from "./doedesk/consentWords";

export const PRIVACY_POLICY_URL = "https://doedesk.com/privacy";

/**
 * Where the two documents are published, for when DoeDesk Cloud has not been asked. The sign-in
 * form does not use these: it links to the addresses the service sent with the versions in force.
 */
const PUBLISHED: PrivacyLegal = {
  terms: {
    version: "",
    url: { en: "https://doedesk.com/terms", ar: "https://doedesk.com/ar/terms" },
  },
  privacy: {
    version: "",
    url: { en: PRIVACY_POLICY_URL, ar: "https://doedesk.com/ar/privacy" },
  },
};

export const legalDocumentUrl = (
  legal: PrivacyLegal | null | undefined,
  document: ConsentDocument,
  locale: PrivacyLocale,
): string => (legal ?? PUBLISHED)[document].url[locale];
