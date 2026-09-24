import { createIcon } from "../icons.js";

// ABOUTME: Settings → Usage "Provider Quota" section (spec 2026-09-22).
// ABOUTME: Renders normalized quota reports; owns the codex reset-credit flow.

const DISPLAY_NAMES = {
  "openai-codex": "OpenAI Codex",
  zai: "Z.ai",
  "zai-coding-cn": "Z.ai (智谱)",
  "opencode-go": "Opencode Go",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax (国内)",
  moonshotai: "Moonshot",
  "moonshotai-cn": "Moonshot (国内)",
  "ollama-cloud": "Ollama Cloud",
};

function providerDisplayName(providerId) {
  return DISPLAY_NAMES[providerId] ?? providerId;
}

function formatRelativeTime(timestamp, locale) {
  if (typeof timestamp !== "number") return "";
  const deltaMs = Date.now() - timestamp;
  const minutes = Math.round(deltaMs / 60000);
  if (minutes < 1) return locale.justNow;
  if (minutes < 60) return locale.minutesAgo.replace("{n}", String(minutes));
  const hours = Math.round(minutes / 60);
  return locale.hoursAgo.replace("{n}", String(hours));
}

/** Credit timestamps arrive as ISO strings or epoch numbers; both must render
 * as one absolute local time (spec: the confirm dialog shows expires_at
 * absolutely, since it is the last check before an irreversible charge). */
function toEpochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

function formatDateOnly(value) {
  const ms = toEpochMs(value);
  return ms === null ? "" : new Date(ms).toLocaleDateString();
}

function formatDateTime(value) {
  const ms = toEpochMs(value);
  if (ms === null) return "";
  return new Date(ms).toLocaleString([], {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Upstream spends the earliest-granted credit first (FIFO), so the list is
 * ordered the way it will be consumed and the first row is the next one. */
function sortCreditsFifo(credits) {
  return [...credits].sort(
    (left, right) => (toEpochMs(left?.grantedAt) ?? 0) - (toEpochMs(right?.grantedAt) ?? 0),
  );
}

function daysUntil(value) {
  const ms = toEpochMs(value);
  if (ms === null) return null;
  return Math.ceil((ms - Date.now()) / 86_400_000);
}

/** Reset stamps read like opencodex's: "重置 今天 14:26" while it is today,
 * otherwise "重置 9月26日 09:58" — an absolute stamp, never "in 3h". */
function formatResetStamp(resetAt, locale) {
  const ms = toEpochMs(resetAt);
  if (ms === null) return "";
  const at = new Date(ms);
  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  const day = sameDay ? locale.today : `${at.getMonth() + 1}月${at.getDate()}日`;
  const time = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  return `${locale.resetPrefix} ${day} ${time}`;
}

/** Usage tone: low usage is healthy, then warning, then critical. */
/** A custom window whose label is a currency amount is a balance, not a
 * percentage window (deepseek / moonshot shape). */
function isBalanceLabel(label) {
  return /[$¥€]|CNY|USD|EUR|RMB/i.test(String(label ?? ""));
}

function toneFor(percent) {
  if (percent >= 95) return "is-critical";
  if (percent >= 80) return "is-warning";
  return "is-ok";
}

function windowRow({ label, percent, resetAt }, locale) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const row = document.createElement("div");
  row.className = "quota-row";
  const name = document.createElement("span");
  name.className = "quota-row-label";
  name.textContent = label;
  const stamp = document.createElement("span");
  stamp.className = "quota-row-reset";
  stamp.textContent = formatResetStamp(resetAt, locale);
  const bar = document.createElement("div");
  bar.className = "quota-bar";
  bar.setAttribute("role", "presentation");
  const fill = document.createElement("div");
  fill.className = `quota-bar-fill ${toneFor(clamped)}`;
  fill.style.width = `${clamped}%`;
  bar.append(fill);
  const pct = document.createElement("span");
  pct.className = "quota-row-pct";
  pct.textContent = `${clamped}%`;
  row.append(name, stamp, bar, pct);
  return row;
}

/** Balance providers (deepseek / moonshot) have no percentage: the amount takes
 * the percent slot and the bar stays empty, as opencodex does. */
function balanceRow(window, locale) {
  const row = document.createElement("div");
  row.className = "quota-row is-balance";
  const name = document.createElement("span");
  name.className = "quota-row-label";
  name.textContent = locale.balance;
  const stamp = document.createElement("span");
  stamp.className = "quota-row-reset";
  const bar = document.createElement("div");
  bar.className = "quota-bar";
  const value = document.createElement("span");
  value.className = "quota-row-pct is-amount";
  value.textContent = String(window?.label ?? "");
  row.append(name, stamp, bar, value);
  return row;
}

/**
 * The quota section renderer. `seams.gateway` is the ConfigGateway
 * (provider_quota_report / codex ops); `seams.dataTransport` carries the
 * host-side reset_credit_open / reset_credit_settle ledger ops.
 */
export function createProviderQuotaPanel(seams, { locale }) {
  const reportsById = new Map();
  let loading = false;

  async function loadReports(force = false) {
    loading = true;
    render();
    try {
      // The gateway resolves with the handler payload `{ ok, data }`, not the
      // handler's own data object — the reports live one level down.
      const payload = await seams.gateway.call("provider_quota_report", { force });
      reportsById.clear();
      for (const report of payload?.data?.reports ?? []) {
        reportsById.set(report.provider, report);
      }
    } catch {
      // The section simply renders what it has; errors keep prior rows.
    } finally {
      loading = false;
      render();
    }
  }

  async function consumeResetCredit() {
    // Double-channel flow (spec): Rust ledger opens the idempotency-keyed
    // operation, pi consumes it, the ledger settles it.
    let operationId = null;
    try {
      const opened = await seams.dataTransport?.resetCreditOpen();
      operationId = opened?.operationId ?? null;
    } catch {
      return { toast: locale.toastUnavailable };
    }
    if (!operationId) return { toast: locale.toastUnavailable };
    let result;
    try {
      result = await seams.gateway.call("codex_reset_credits_consume", { operationId });
    } catch {
      await seams.dataTransport?.resetCreditSettle({ operationId, ambiguous: true });
      return { toast: locale.toastUnknown };
    }
    const payload = result?.data ?? {};
    const failure = payload.failure;
    if (failure === "ambiguous") {
      await seams.dataTransport?.resetCreditSettle({ operationId, ambiguous: true });
      return { toast: locale.toastUnknown };
    }
    if (failure === "operation_in_flight") return { toast: locale.toastInFlight };
    if (failure === "needs_login") return { toast: locale.toastNeedsLogin };
    await seams.dataTransport?.resetCreditSettle({ operationId, ambiguous: false });
    if (payload.code === "reset") return { toast: locale.toastResetDone };
    if (payload.code === "already_redeemed") return { toast: locale.toastResetDone };
    if (payload.code === "nothing_to_reset") return { toast: locale.toastNothingToReset };
    if (payload.code === "no_credit") return { toast: locale.toastNoCredit };
    return { toast: locale.toastUnknown };
  }

  /** Inspect the reset credits, then ask. Returns {confirmed} or {toast}. */
  async function decideReset() {
    let payload = null;
    try {
      payload = await seams.gateway.call("codex_reset_credits_inspect", {});
    } catch {
      return { confirmed: false, toast: locale.toastUnavailable };
    }
    const data = payload?.data ?? {};
    if (data.failure === "needs_login") return { confirmed: false, toast: locale.toastNeedsLogin };
    const credits = Array.isArray(data.credits) ? data.credits : [];
    return { confirmed: await confirmReset(credits) };
  }

  /** Reset dialog, copied from opencodex's codex reset modal (screenshot):
   * ticket-icon title, "you have N credits", one sub-card per credit with the
   * next one highlighted, a FIFO note, and a single full-width action. */
  function confirmReset(credits) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "file-preview-dialog-overlay";
      const dialog = document.createElement("div");
      dialog.className = "file-preview-dialog quota-reset-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", locale.resetDialogTitle);

      const heading = document.createElement("h3");
      heading.className = "quota-dialog-title";
      const ticket = createIcon("ticket", { size: 18 });
      if (ticket) heading.append(ticket);
      heading.append(document.createTextNode(locale.resetDialogTitle));
      const sub = document.createElement("p");
      sub.className = "quota-dialog-sub";
      sub.textContent = locale.resetDialogScope;

      const ordered = sortCreditsFifo(credits);
      const count = document.createElement("p");
      count.className = "quota-dialog-count";
      const [lead, tail] = locale.resetCreditsAvailable.split("{count}");
      const strong = document.createElement("b");
      strong.textContent = String(ordered.length);
      count.append(
        document.createTextNode(lead ?? ""),
        strong,
        document.createTextNode(tail ?? ""),
      );

      const list = document.createElement("div");
      list.className = "quota-credits";
      if (ordered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "quota-credit-row";
        empty.textContent = locale.creditNone;
        list.append(empty);
      }
      ordered.forEach((credit, index) => {
        const row = document.createElement("div");
        row.className = "quota-credit-row";
        if (index === 0) row.classList.add("is-next");
        const head = document.createElement("div");
        head.className = "quota-credit-head";
        const mark = createIcon("ticket", { size: 14 });
        if (mark) head.append(mark);
        head.append(
          document.createTextNode(
            index === 0
              ? locale.creditNext
              : locale.creditIndexed.replace("{n}", String(index + 1)),
          ),
        );
        if (index === 0) {
          const chip = document.createElement("span");
          chip.className = "quota-credit-chip";
          chip.textContent = "NEXT";
          head.append(chip);
        }
        const meta = document.createElement("div");
        meta.className = "quota-credit-meta";
        const granted = document.createElement("span");
        granted.textContent = locale.creditGranted.replace(
          "{time}",
          formatDateOnly(credit?.grantedAt),
        );
        const expires = document.createElement("span");
        const days = daysUntil(credit?.expiresAt);
        const expiresAt = formatDateTime(credit?.expiresAt);
        if (days === null) {
          expires.textContent = locale.creditUnknown;
        } else if (days <= 0) {
          expires.textContent = `${locale.creditExpires.replace("{time}", expiresAt)} ${locale.creditExpired}`;
        } else {
          expires.textContent = `${locale.creditExpires.replace("{time}", expiresAt)}${locale.creditDaysLeft.replace("{days}", String(days))}`;
        }
        meta.append(granted, expires);
        row.append(head, meta);
        list.append(row);
      });

      const note = document.createElement("p");
      note.className = "quota-dialog-note";
      note.textContent = locale.fifoNote;
      const action = document.createElement("button");
      action.type = "button";
      action.className = "quota-dialog-action";
      action.textContent = locale.dialogRedeem;
      action.disabled = ordered.length === 0;
      action.addEventListener("click", () => finish(true));

      dialog.append(heading, sub, count, list, note, action);
      overlay.append(dialog);
      document.body.append(overlay);

      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        resolve(value);
      };
      const onKeyDown = (event) => {
        if (event.key === "Escape") finish(false);
      };
      document.addEventListener("keydown", onKeyDown);
      action.focus();
    });
  }

  function renderResetArea(codexReport) {
    const credits = codexReport?.quota?.resetCredits;
    if (typeof credits !== "number" || credits <= 0) return "";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quota-reset-btn";
    button.textContent = locale.resetCredits.replace("{n}", String(credits));
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        // Inspect before charging: the dialog lists exactly which credits are
        // spent, and cancelling must leave the ledger untouched.
        const decision = await decideReset();
        if (decision.toast) {
          window.dispatchEvent(
            new CustomEvent("picot-toast", { detail: { message: decision.toast } }),
          );
          return;
        }
        if (!decision.confirmed) return;
        const outcome = await consumeResetCredit();
        window.dispatchEvent(
          new CustomEvent("picot-toast", { detail: { message: outcome.toast } }),
        );
        void loadReports(true);
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }

  function buildHead(isLoading) {
    const head = document.createElement("div");
    head.className = "quota-section-head";
    const title = document.createElement("h3");
    title.textContent = locale.sectionTitle;
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "quota-refresh-btn";
    refresh.textContent = isLoading ? locale.refreshing : locale.refresh;
    refresh.disabled = isLoading;
    refresh.addEventListener("click", () => void loadReports(true));
    head.append(title, refresh);
    return head;
  }

  function render() {
    const container = seams.container();
    if (!container) return;
    // `not_configured` = no credential resolved, so the provider is absent
    // rather than shown as unavailable (spec: 未配置的 provider 不显示).
    const reports = [...reportsById.values()].filter(
      (report) => report.failure !== "not_configured",
    );
    // Empty state hides the whole section (spec: no placeholder).
    const hasContent = reports.length > 0;
    // A settled empty state still hides the whole section (spec: no
    // placeholder), but the first probe takes seconds — hiding the section
    // while it is in flight is what made the page look blank.
    container.classList.toggle("hidden", !hasContent && !loading);
    if (!hasContent) {
      container.replaceChildren();
      if (loading) container.append(buildHead(loading));
      return;
    }
    container.replaceChildren();
    const head = buildHead(loading);

    const codex = reportsById.get("openai-codex");
    const resetButton = renderResetArea(codex);

    for (const report of reports) {
      const card = document.createElement("div");
      card.className = "quota-card";
      const name = document.createElement("div");
      name.className = "quota-card-name";
      name.textContent = providerDisplayName(report.provider);
      card.append(name);
      if (report.failure === "needs_login") {
        const note = document.createElement("div");
        note.className = "quota-failure";
        note.textContent = locale.needsLogin;
        card.append(note);
      } else if (report.failure) {
        const note = document.createElement("div");
        note.className = "quota-failure";
        note.textContent = locale.unavailable;
        card.append(note);
      }
      const quota = report.quota;
      if (quota) {
        const rows = [];
        if (typeof quota.fiveHourPercent === "number") {
          rows.push(
            windowRow(
              {
                label: locale.fiveHour,
                percent: quota.fiveHourPercent,
                resetAt: quota.fiveHourResetAt,
              },
              locale,
            ),
          );
        }
        if (typeof quota.weeklyPercent === "number") {
          rows.push(
            windowRow(
              { label: locale.weekly, percent: quota.weeklyPercent, resetAt: quota.weeklyResetAt },
              locale,
            ),
          );
        }
        if (typeof quota.monthlyPercent === "number") {
          rows.push(
            windowRow(
              {
                label: locale.monthly,
                percent: quota.monthlyPercent,
                resetAt: quota.monthlyResetAt,
              },
              locale,
            ),
          );
        }
        for (const custom of quota.customWindows ?? []) {
          rows.push(
            isBalanceLabel(custom?.label) ? balanceRow(custom, locale) : windowRow(custom, locale),
          );
        }
        const list = document.createElement("div");
        list.className = "quota-rows";
        list.append(...rows);
        card.append(list);
        const updated = document.createElement("div");
        updated.className = "quota-updated";
        updated.textContent = formatRelativeTime(quota.updatedAt, locale);
        card.append(updated);
      }
      if (report.provider === "openai-codex" && resetButton) card.append(resetButton);
      container.append(card);
    }
    container.prepend(head);
  }

  return {
    render,
    loadReports,
  };
}
