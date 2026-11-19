/**
 * The words a person agrees to, in the two languages the documents are published in: fixed text
 * from the consent specification, never run through the interface translations. Changing a
 * sentence means a new wording identifier: see docs/operations/consent-and-rights.md.
 */
import type { PrivacyLocale } from "@t3tools/contracts";

/** The notice at collection, the checkbox and the button on the sign-in form. */
export const SIGNUP_WORDING_ID = "signup-2026-11-19";
/** The sheet shown to a signed-in account that has not accepted the Terms required now. */
export const TERMS_SHEET_WORDING_ID = "terms-sheet-2026-11";
/** The unticked choice shown where usage data needs agreement first. */
export const USAGE_DATA_CHOICE_WORDING_ID = "usage-data-2026-11";
/** The notice shown where usage data is on by default. */
export const USAGE_DATA_NOTICE_WORDING_ID = "usage-data-notice-2026-11";
/** The row and switch in Settings, under Privacy. */
export const USAGE_DATA_SETTINGS_WORDING_ID = "usage-data-settings-2026-11";

export type ConsentDocument = "terms" | "privacy";

/** A sentence in pieces, so that a document's name can be a link inside it. */
export type ConsentPart =
  | string
  | { readonly link: ConsentDocument; readonly text: string }
  | { readonly strong: string };

interface ConsentWords {
  /** The language's own name, for the control that switches to it. */
  readonly languageName: string;
  readonly notice: ReadonlyArray<ConsentPart>;
  readonly checkbox: ReadonlyArray<ConsentPart>;
  readonly sendCode: string;
  readonly sendLink: string;
  readonly tickFirst: string;
  readonly sheetFirstTitle: string;
  readonly sheetFirstLead: string;
  readonly sheetUpdatedTitle: string;
  readonly sheetUpdatedLead: string;
  readonly agreeAndContinue: string;
  readonly signOut: string;
  readonly ownService: string;
  readonly usageChoice: ReadonlyArray<ConsentPart>;
  readonly usageNotice: ReadonlyArray<ConsentPart>;
  readonly usageSwitch: string;
  readonly usageSettings: string;
  readonly usageDetails: string;
  readonly installationIdentifier: string;
  readonly onboarding: ReadonlyArray<ConsentPart>;
}

export const CONSENT_WORDS: Readonly<Record<PrivacyLocale, ConsentWords>> = {
  en: {
    languageName: "English",
    notice: [
      "We use your number or email to create your account and sign you in. We record how much your account uses the service each day. Text and files sent for checking are processed on our own server in Saudi Arabia and are not stored. We do not sell your data. ",
      { link: "privacy", text: "Privacy Policy" },
    ],
    checkbox: [
      "I am 18 or older and I use DoeDesk for my work. I agree to the ",
      { link: "terms", text: "Terms of Use" },
      " and I have read the ",
      { link: "privacy", text: "Privacy Policy" },
      ".",
    ],
    sendCode: "Agree and send code",
    sendLink: "Agree and send link",
    tickFirst: "Tick the box to continue.",
    sheetFirstTitle: "Terms and privacy",
    sheetFirstLead:
      "DoeDesk now has Terms of Use and a Privacy Policy. Please read and accept them to keep using DoeDesk Cloud.",
    sheetUpdatedTitle: "Updated Terms of Use",
    sheetUpdatedLead:
      "The Terms of Use have changed. Please read and accept the new version to keep using DoeDesk Cloud.",
    agreeAndContinue: "Agree and continue",
    signOut: "Sign out",
    ownService: "Use my own detection service",
    usageChoice: [
      "Send usage data to help improve DoeDesk. It covers which features are used, never names, files or conversations, and it is not linked to your account. You can change this at any time in Settings. ",
      { link: "privacy", text: "Privacy Policy" },
    ],
    usageNotice: [
      { strong: "Usage data is on." },
      " DoeDesk sends which features are used, to help improve it. Never names, files or conversations, and not linked to your account. Turn it off here or later in Settings. ",
      { link: "privacy", text: "Privacy Policy" },
    ],
    usageSwitch: "Send usage data",
    usageSettings:
      "Which features are used. Never names, files or conversations. Not linked to your account.",
    usageDetails: "Details",
    installationIdentifier: "Installation identifier, for privacy requests",
    onboarding: [
      "Optional. Your answers are stored with your account and help us decide what to build. ",
      { link: "privacy", text: "Privacy Policy" },
    ],
  },
  ar: {
    languageName: "العربية",
    notice: [
      "نستخدم رقمك أو بريدك لإنشاء حسابك وتسجيل دخولك. ونسجّل مقدار استخدام حسابك للخدمة في كل يوم. والنصوص والملفات المرسلة للفحص نعالجها على خادمنا داخل المملكة، ولا نخزّنها. ولا نبيع بياناتك. ",
      { link: "privacy", text: "سياسة الخصوصية" },
    ],
    checkbox: [
      "عمري 18 عامًا أو أكثر، وأستخدم DoeDesk في عملي. أوافق على ",
      { link: "terms", text: "شروط الاستخدام" },
      "، وقد اطّلعت على ",
      { link: "privacy", text: "سياسة الخصوصية" },
      ".",
    ],
    sendCode: "موافق، أرسل الرمز",
    sendLink: "موافق، أرسل الرابط",
    tickFirst: "وافق على الشروط أولًا.",
    sheetFirstTitle: "الشروط والخصوصية",
    sheetFirstLead:
      "أصبح لـDoeDesk شروط استخدام وسياسة خصوصية. نرجو قراءتها وقبولها لمواصلة استخدام DoeDesk Cloud.",
    sheetUpdatedTitle: "تحديث شروط الاستخدام",
    sheetUpdatedLead:
      "تغيّرت شروط الاستخدام. نرجو قراءة النسخة الجديدة وقبولها لمواصلة استخدام DoeDesk Cloud.",
    agreeAndContinue: "موافق، متابعة",
    signOut: "تسجيل الخروج",
    ownService: "استخدام خدمة كشف خاصة بي",
    usageChoice: [
      "إرسال بيانات الاستخدام للمساعدة في تحسين DoeDesk. تشمل الخصائص المستخدمة، ولا تشمل الأسماء ولا الملفات ولا المحادثات، ولا ترتبط بحسابك. ولك تغيير ذلك متى شئت من الإعدادات. ",
      { link: "privacy", text: "سياسة الخصوصية" },
    ],
    usageNotice: [
      { strong: "بيانات الاستخدام مفعّلة." },
      " يرسل DoeDesk الخصائص المستخدمة ليعين على تحسينه. لا الأسماء ولا الملفات ولا المحادثات، ولا ترتبط بحسابك. ولك إيقافها هنا أو لاحقًا من الإعدادات. ",
      { link: "privacy", text: "سياسة الخصوصية" },
    ],
    usageSwitch: "إرسال بيانات الاستخدام",
    usageSettings: "الخصائص المستخدمة. لا الأسماء ولا الملفات ولا المحادثات. ولا ترتبط بحسابك.",
    usageDetails: "التفاصيل",
    installationIdentifier: "معرّف النسخة، لطلبات الخصوصية",
    onboarding: [
      "اختياري. تُحفظ إجابتاك مع حسابك وتساعدنا في تحديد ما نبنيه. ",
      { link: "privacy", text: "سياسة الخصوصية" },
    ],
  },
};

/** True when the first language the system lists is Arabic. */
export const prefersArabic = (languages: ReadonlyArray<string>): boolean =>
  languages[0]?.toLowerCase().split(/[-_]/)[0] === "ar";
