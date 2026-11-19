/**
 * What DoeDesk says for each answer DoeDesk Cloud can give to a sign-in, an acceptance, an export
 * or a deletion. The service's own messages are English and written for apps; these are for the
 * person. The copy rule: each sentence says who does what to what.
 */
import { msg, useMessages } from "gt-react";

import { useSetupArabic } from "~/onboarding/setupLocale";

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

const ARABIC: ReadonlyMap<string, string> = new Map([
  [UNREACHABLE, "لم يستجب DoeDesk على هذا الجهاز. أعد المحاولة."],
  [NOT_WORKED, "لم تنجح العملية. أعد المحاولة."],
  [
    SIGN_UP_UNAVAILABLE,
    "لا يمكن إنشاء حسابات جديدة في DoeDesk Cloud من بلدك حتى الآن. وإن كان لديك حساب فسجّل الدخول كالمعتاد.",
  ],
  [
    LEGAL_UNKNOWN,
    "لم يستجب DoeDesk Cloud، فلا يستطيع DoeDesk عرض شروط الاستخدام وسياسة الخصوصية السارية. تحقّق من اتصالك.",
  ],
  [
    CLOUD_MESSAGES.invalid_acceptance!,
    "لم يستطع DoeDesk Cloud قراءة ما أرسله DoeDesk عن شروط الاستخدام. هذا خلل في DoeDesk، فحدّثه ثم أعد المحاولة.",
  ],
  [
    CLOUD_MESSAGES.terms_outdated!,
    "تغيّرت شروط الاستخدام والنموذج مفتوح، والروابط تفتح الآن النسخة الجديدة. اقرأها ووافق عليها، ثم أرسل مجددًا.",
  ],
  [
    CLOUD_MESSAGES.too_many_requests!,
    "تلقّى DoeDesk Cloud طلبات كثيرة من هنا. انتظر بضع دقائق ثم أعد المحاولة.",
  ],
  [
    CLOUD_MESSAGES.recent_sign_in_required!,
    "لا يحذف DoeDesk Cloud الحساب إلا في العشر الدقائق التي تلي تسجيل الدخول. سجّل الدخول مجددًا لحذفه.",
  ],
  [CLOUD_MESSAGES.different_account!, "هذا الرقم أو البريد لحساب آخر، ولم يحذف DoeDesk شيئًا."],
  [
    CLOUD_MESSAGES.unauthenticated!,
    "لم يعد DoeDesk Cloud يقبل تسجيل الدخول هذا. سجّل الدخول مجددًا.",
  ],
  [
    CLOUD_MESSAGES.terms_update_required!,
    "لن يفحص DoeDesk Cloud طلبات هذا الحساب حتى يقبل شروط الاستخدام.",
  ],
]);

/** Reads one of these messages in the app's language, or in Arabic inside setup shown in Arabic. */
export function usePrivacyMessage(): (message: string) => string {
  const m = useMessages();
  const arabic = useSetupArabic();
  return (message) => (arabic ? (ARABIC.get(message) ?? m(message)) : m(message));
}
