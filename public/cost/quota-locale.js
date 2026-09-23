// ABOUTME: Locale bundle for the provider quota panel — one key set, four
// ABOUTME: languages, sourced from the shared i18n table (cost.quota.*).
import { t } from "../i18n.js";

export function quotaLocaleBundle() {
  return {
    sectionTitle: t("cost.quota.sectionTitle"),
    refresh: t("cost.quota.refresh"),
    refreshing: t("cost.quota.refreshing"),
    fiveHour: t("cost.quota.fiveHour"),
    weekly: t("cost.quota.weekly"),
    monthly: t("cost.quota.monthly"),
    needsLogin: t("cost.quota.needsLogin"),
    unavailable: t("cost.quota.unavailable"),
    justNow: t("cost.quota.justNow"),
    minutesAgo: t("cost.quota.minutesAgo"),
    hoursAgo: t("cost.quota.hoursAgo"),
    resetsInMinutes: t("cost.quota.resetsInMinutes"),
    resetsInHours: t("cost.quota.resetsInHours"),
    resetsInDays: t("cost.quota.resetsInDays"),
    resetCredits: t("cost.quota.resetCredits"),
    resetDialogTitle: t("cost.quota.resetDialogTitle"),
    resetDialogBody: t("cost.quota.resetDialogBody"),
    creditGranted: t("cost.quota.creditGranted"),
    creditExpires: t("cost.quota.creditExpires"),
    creditUnknown: t("cost.quota.creditUnknown"),
    dialogConfirm: t("cost.quota.dialogConfirm"),
    dialogCancel: t("cost.quota.dialogCancel"),
    toastUnavailable: t("cost.quota.toastUnavailable"),
    toastUnknown: t("cost.quota.toastUnknown"),
    toastInFlight: t("cost.quota.toastInFlight"),
    toastNeedsLogin: t("cost.quota.toastNeedsLogin"),
    toastResetDone: t("cost.quota.toastResetDone"),
    toastNothingToReset: t("cost.quota.toastNothingToReset"),
    toastNoCredit: t("cost.quota.toastNoCredit"),
  };
}
