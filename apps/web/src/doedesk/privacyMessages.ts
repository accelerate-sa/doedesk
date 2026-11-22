/**
 * What DoeDesk says for each answer DoeDesk Cloud can give to a sign-in, an acceptance, an export
 * or a deletion. The service's own messages are English and written for apps; these are for the
 * person. The copy rule: each sentence says who does what to what.
 */
import { msg, useMessages } from "gt-react";

export const UNREACHABLE = msg("Could not reach the DoeDesk service on this computer. Try again.");
export const NOT_WORKED = msg("Something went wrong. Try again.");

export const SIGN_UP_UNAVAILABLE = msg(
  "New DoeDesk Cloud accounts are not available in your country yet. If you already have an account, you can still sign in.",
);

export const LEGAL_UNKNOWN = msg(
  "Could not reach DoeDesk Cloud to load the current Terms of Use and Privacy Policy. Check your internet connection and try again.",
);

/** Messages by DoeDesk Cloud's error code. A code that is not here keeps the service's own words. */
export const CLOUD_MESSAGES: Readonly<Record<string, string>> = {
  invalid_acceptance: msg(
    "DoeDesk Cloud could not read the Terms of Use data sent by this app. This is a problem in DoeDesk; update DoeDesk to the latest version and try again.",
  ),
  terms_outdated: msg(
    "The Terms of Use were updated while this screen was open. Review the new version using the link below, tick the box, and try again.",
  ),
  signup_unavailable: SIGN_UP_UNAVAILABLE,
  too_many_requests: msg("Too many attempts. Wait a few minutes, then try again."),
  recent_sign_in_required: msg(
    "An account can only be deleted within 10 minutes of signing in. Sign in again to continue.",
  ),
  different_account: msg(
    "That phone number or email belongs to a different account. Nothing was deleted.",
  ),
  unauthenticated: msg("DoeDesk Cloud no longer accepts this sign-in. Sign in again."),
  terms_update_required: msg(
    "DoeDesk Cloud will not check requests for this account until you accept the current Terms of Use.",
  ),
};

/** Reads one of these messages in the app's active language. */
export function usePrivacyMessage(): (message: string) => string {
  return useMessages();
}
