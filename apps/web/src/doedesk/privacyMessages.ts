/**
 * What DoeDesk says for each answer DoeDesk Cloud can give to a sign-in, an acceptance, an export
 * or a deletion. The service's own messages are English and written for apps; these are for the
 * person. The copy rule: each sentence says who does what to what.
 */
import { msg } from "gt-react";

export const UNREACHABLE = msg("DoeDesk on this computer did not answer. Try again.");
export const NOT_WORKED = msg("That did not work. Try again.");

export const SIGN_UP_UNAVAILABLE = msg(
  "New DoeDesk Cloud accounts cannot be created from your country yet. If you already have an account, sign in as usual.",
);

export const LEGAL_UNKNOWN = msg(
  "DoeDesk Cloud did not answer, so DoeDesk cannot show which Terms of Use and Privacy Policy apply. Check your connection.",
);

/** Messages by DoeDesk Cloud's error code. A code that is not here keeps the service's own words. */
export const CLOUD_MESSAGES: Readonly<Record<string, string>> = {
  invalid_acceptance: msg(
    "DoeDesk Cloud could not read what DoeDesk sent about the Terms of Use. This is a fault in DoeDesk. Update DoeDesk, then try again.",
  ),
  terms_outdated: msg(
    "The Terms of Use changed while this form was open. The links now open the new version. Read it, tick the box, and send again.",
  ),
  signup_unavailable: SIGN_UP_UNAVAILABLE,
  too_many_requests: msg(
    "DoeDesk Cloud received too many requests from here. Wait a few minutes, then try again.",
  ),
  recent_sign_in_required: msg(
    "DoeDesk Cloud deletes an account only within 10 minutes of a sign-in. Sign in again to delete it.",
  ),
  different_account: msg(
    "That number or address belongs to a different account. DoeDesk deleted nothing.",
  ),
  unauthenticated: msg("DoeDesk Cloud no longer accepts this sign-in. Sign in again."),
  terms_update_required: msg(
    "DoeDesk Cloud will not check requests for this account until it has accepted the Terms of Use.",
  ),
};
