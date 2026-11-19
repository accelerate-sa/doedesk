import type { PrivacySignInMethod } from "@t3tools/contracts";

/** The name of the file a copy of the account's data is saved as. */
export const accountExportFileName = (now: Date): string =>
  `doedesk-account-${now.toISOString().slice(0, 10)}.json`;

/** An account is created with a mobile number or an email address, and signs in the same way. */
export const methodOfAccount = (accountLabel: string | null): PrivacySignInMethod =>
  accountLabel?.includes("@") === true ? "email" : "phone";
