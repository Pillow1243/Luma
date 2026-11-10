import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Lang = "en" | "fa";

const STORAGE_KEY = "luma-lang";

const MESSAGES = {
  en: {
    appName: "Luma",
    tagline: "Light up your conversations.",
    signIn: "Sign in",
    createAccount: "Create account",
    displayName: "Display name",
    email: "Email",
    password: "Password",
    forgotPassword: "Forgot password?",
    sendResetLink: "Send reset link",
    backToSignIn: "Back to sign in",
    resetEmailSent: "Password reset link sent — check your inbox.",
    setNewPassword: "Set a new password",
    newPassword: "New password",
    confirmPassword: "Confirm password",
    savePassword: "Update password",
    passwordMinHint: "At least 8 characters",
    passwordsMismatch: "Passwords do not match",
    passwordUpdated: "Password updated.",
    searchChats: "Search chats or messages…",
    newChat: "New chat",
    savedMessages: "Saved Messages",
    starredMessages: "Starred Messages",
    allChats: "All",
    directChats: "Direct",
    groupsTab: "Groups",
    channelsTab: "Channels",
    archivedTab: "Archived",
    discoverChannels: "Discover channels",
    joinChannel: "Subscribe",
    requestJoin: "Request to join",
    joined: "Joined",
    noChatsTitle: "No conversations yet",
    noChatsSubtitle: "Start a direct chat, create a group, or discover a public channel.",
    offlineBanner: "You’re offline — reading cached chats. Outbox messages send on reconnect.",
    reconnectingBanner: "Reconnecting to realtime…",
    typeMessage: "Write a message…",
    secretMessagePlaceholder: "Encrypted secret message…",
    recordVoice: "Record voice message",
    recordingVoice: "Recording…",
    attachFile: "Attach file",
    send: "Send",
    online: "online",
    typing: "typing…",
    lastSeenHidden: "last seen hidden",
    secretModeOn: "Secret mode · Ratcheted E2EE",
    safetyCode: "Safety number",
    verifySafetyCode: "Mark verified",
    verified: "Verified",
    keyChangedWarning: "Peer key changed! Verify their safety number before sending.",
    profileAndSecurity: "Profile & Security",
    language: "Language",
    theme: "Appearance",
    dark: "Dark",
    light: "Light",
    securityAndSessions: "Security & Sessions",
    currentPassword: "Current password",
    changePassword: "Change password",
    signOutAllDevices: "Sign out all devices",
    signedOutEverywhere: "Signed out of all active sessions.",
    deleteAccount: "Delete account",
    deleteAccountWarn: "Permanently deletes your profile, keys, and single-user chats.",
    typeDeleteConfirm: "Type DELETE to confirm",
    notificationsTitle: "Notifications",
    enableBrowserNotifs: "Browser notifications",
    diagnostics: "System Diagnostics",
    signOut: "Sign out",
    cancel: "Cancel",
    save: "Save",
    close: "Close",
    edit: "Edit",
    reply: "Reply",
    forward: "Forward",
    copy: "Copy",
    star: "Star",
    unstar: "Unstar",
    pin: "Pin",
    unpin: "Unpin",
    deleteForMe: "Delete for me",
    deleteForEveryone: "Delete for everyone",
    report: "Report",
    pinnedMessages: "Pinned messages",
    noResults: "No results found",
  },
  fa: {
    appName: "لوما",
    tagline: "گفتگوهایتان را روشن کنید.",
    signIn: "ورود",
    createAccount: "ساخت حساب",
    displayName: "نام نمایشی",
    email: "ایمیل",
    password: "رمز عبور",
    forgotPassword: "رمز عبور را فراموش کردید؟",
    sendResetLink: "ارسال لینک بازیابی",
    backToSignIn: "بازگشت به ورود",
    resetEmailSent: "لینک بازیابی رمز عبور ارسال شد — ایمیل خود را بررسی کنید.",
    setNewPassword: "تنظیم رمز عبور جدید",
    newPassword: "رمز عبور جدید",
    confirmPassword: "تکرار رمز عبور",
    savePassword: "به‌روزرسانی رمز عبور",
    passwordMinHint: "حداقل ۸ کاراکتر",
    passwordsMismatch: "رمزهای عبور یکسان نیستند",
    passwordUpdated: "رمز عبور با موفقیت تغییر کرد.",
    searchChats: "جستجوی گفتگوها یا پیام‌ها…",
    newChat: "گفتگوی جدید",
    savedMessages: "پیام‌های ذخیره‌شده",
    starredMessages: "پیام‌های ستاره‌دار",
    allChats: "همه",
    directChats: "شخصی",
    groupsTab: "گروه‌ها",
    channelsTab: "کانال‌ها",
    archivedTab: "بایگانی",
    discoverChannels: "کشف کانال‌ها",
    joinChannel: "عضویت",
    requestJoin: "درخواست عضویت",
    joined: "عضو هستید",
    noChatsTitle: "هنوز گفتگویی ندارید",
    noChatsSubtitle: "یک گفتگوی مستقیم، گروه جدید بسازید یا کانال‌های عمومی را دنبال کنید.",
    offlineBanner: "آفلاین هستید — در حال نمایش پیام‌های ذخیره‌شده. پیام‌های صف ارسال می‌شوند.",
    reconnectingBanner: "در حال اتصال مجدد به سرور…",
    typeMessage: "پیامی بنویسید…",
    secretMessagePlaceholder: "پیام محرمانه رمزنگاری‌شده…",
    recordVoice: "ضبط پیام صوتی",
    recordingVoice: "در حال ضبط…",
    attachFile: "پیوست فایل",
    send: "ارسال",
    online: "آنلاین",
    typing: "در حال نوشتن…",
    lastSeenHidden: "آخرین بازدید مخفی است",
    secretModeOn: "حالت محرمانه · رمزنگاری پیش‌رونده",
    safetyCode: "کد امنیتی",
    verifySafetyCode: "تأیید شد",
    verified: "تأیید‌شده",
    keyChangedWarning: "کلید طرف مقابل تغییر کرده است! پیش از ارسال، کد امنیتی را بررسی کنید.",
    profileAndSecurity: "پروفایل و امنیت",
    language: "زبان",
    theme: "ظاهر",
    dark: "تاریک",
    light: "روشن",
    securityAndSessions: "امنیت و نشست‌ها",
    currentPassword: "رمز عبور فعلی",
    changePassword: "تغییر رمز عبور",
    signOutAllDevices: "خروج از همه دستگاه‌ها",
    signedOutEverywhere: "از تمام نشست‌های فعال خارج شدید.",
    deleteAccount: "حذف حساب کاربری",
    deleteAccountWarn: "پروفایل، کلیدها و گفتگوهای تک‌نفره شما برای همیشه حذف می‌شوند.",
    typeDeleteConfirm: "برای تأیید کلمه DELETE را بنویسید",
    notificationsTitle: "اعلان‌ها",
    enableBrowserNotifs: "اعلان‌های مرورگر",
    diagnostics: "وضعیت سیستم",
    signOut: "خروج",
    cancel: "لغو",
    save: "ذخیره",
    close: "بستن",
    edit: "ویرایش",
    reply: "پاسخ",
    forward: "بازارسال",
    copy: "کپی",
    star: "ستاره‌دار",
    unstar: "حذف ستاره",
    pin: "سنجاق",
    unpin: "برداشتن سنجاق",
    deleteForMe: "حذف برای من",
    deleteForEveryone: "حذف برای همه",
    report: "گزارش",
    pinnedMessages: "پیام‌های سنجاق‌شده",
    noResults: "نتیجه‌ای یافت نشد",
  },
} as const;

export type I18nKey = keyof typeof MESSAGES.en;

interface I18nCtx {
  lang: Lang;
  dir: "ltr" | "rtl";
  setLang: (lang: Lang) => void;
  t: (key: I18nKey) => string;
}

const Ctx = createContext<I18nCtx>({
  lang: "en",
  dir: "ltr",
  setLang: () => {},
  t: (key) => MESSAGES.en[key],
});

function detectInitialLang(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "fa" || saved === "en") return saved;
  } catch {
    // ignore storage restriction
  }
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectInitialLang);
  const dir: "ltr" | "rtl" = lang === "fa" ? "rtl" : "ltr";

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // ignore
    }
  }, [lang, dir]);

  const value = useMemo<I18nCtx>(
    () => ({
      lang,
      dir,
      setLang: setLangState,
      t: (key) => MESSAGES[lang][key] ?? MESSAGES.en[key],
    }),
    [lang, dir]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  return useContext(Ctx);
}
