// ABOUTME: Settings → Usage "Provider Quota" section (spec 2026-09-22).
// ABOUTME: Renders normalized quota reports; owns the codex reset-credit flow.

/** A credit expiring within this many days is flagged in the list. */
const URGENT_CREDIT_DAYS = 7;

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

function formatResetAt(resetAt, locale) {
  if (typeof resetAt !== "number") return "";
  const remainingMs = resetAt - Date.now();
  if (remainingMs <= 0) return "";
  const hours = Math.floor(remainingMs / 3_600_000);
  if (hours >= 24) return locale.resetsInDays.replace("{n}", String(Math.round(hours / 24)));
  if (hours >= 1) return locale.resetsInHours.replace("{n}", String(hours));
  return locale.resetsInMinutes.replace(
    "{n}",
    String(Math.max(1, Math.round(remainingMs / 60000))),
  );
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

function formatAbsoluteTime(value) {
  const ms = toEpochMs(value);
  return ms === null ? "" : new Date(ms).toLocaleString();
}

/** Upstream spends the earliest-granted credit first (FIFO), so list them in
 * that order and mark the first as the one this reset will consume. */
function sortCreditsFifo(credits) {
  return [...credits].sort(
    (left, right) => (toEpochMs(left?.granted_at) ?? 0) - (toEpochMs(right?.granted_at) ?? 0),
  );
}

function daysUntil(value) {
  const ms = toEpochMs(value);
  if (ms === null) return null;
  return Math.ceil((ms - Date.now()) / 86_400_000);
}

/** One credit row: when it was granted, and when it expires (absolute time
 * plus the days left, which is what makes an imminent expiry visible). */
function creditRow(credit, isNext, locale) {
  const row = document.createElement("div");
  row.className = "quota-credit-row";
  if (isNext) row.classList.add("is-next");
  const head = document.createElement("div");
  head.className = "quota-credit-head";
  const granted = locale.creditGranted.replace("{time}", formatAbsoluteTime(credit?.granted_at));
  head.textContent = isNext ? `${locale.creditNext} · ${granted}` : granted;
  const expiry = document.createElement("div");
  expiry.className = "quota-credit-expiry";
  const days = daysUntil(credit?.expires_at);
  if (days === null) {
    expiry.textContent = locale.creditUnknown;
  } else if (days <= 0) {
    expiry.textContent = locale.creditExpired;
  } else {
    if (days <= URGENT_CREDIT_DAYS) row.classList.add("is-urgent");
    expiry.textContent = `${locale.creditExpires.replace("{time}", formatAbsoluteTime(credit?.expires_at))} · ${locale.creditDaysLeft.replace("{days}", String(days))}`;
  }
  row.append(head, expiry);
  return row;
}

function windowBar({ label, percent, resetAt }, locale) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const reset = formatResetAt(resetAt, locale);
  const root = document.createElement("div");
  root.className = "quota-window";
  const head = document.createElement("div");
  head.className = "quota-window-head";
  const labelEl = document.createElement("span");
  labelEl.className = "quota-window-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "quota-window-value";
  valueEl.textContent = `${clamped}%${reset ? ` \u00b7 ${reset}` : ""}`;
  head.append(labelEl, valueEl);
  const bar = document.createElement("div");
  bar.className = "quota-bar";
  bar.setAttribute("role", "presentation");
  const fill = document.createElement("div");
  let fillTone = "";
  if (clamped >= 90) fillTone = " is-critical";
  else if (clamped >= 70) fillTone = " is-warning";
  fill.className = `quota-bar-fill${fillTone}`;
  fill.style.width = `${clamped}%`;
  bar.append(fill);
  root.append(head, bar);
  return root;
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

  /** Reset dialog, ported from opencodex's codex account reset modal: step one
   * lists the credits (FIFO, the next one marked), step two confirms the spend
   * with the credit that will actually be consumed. Resolves true on confirm. */
  function confirmReset(credits) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "file-preview-dialog-overlay";
      const dialog = document.createElement("div");
      dialog.className = "file-preview-dialog quota-reset-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      dialog.setAttribute("aria-label", locale.resetDialogTitle);
      overlay.append(dialog);
      document.body.append(overlay);

      const ordered = sortCreditsFifo(credits);
      let step = "list";
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

      const paint = () => {
        dialog.replaceChildren();
        const heading = document.createElement("h3");
        heading.textContent = locale.resetDialogTitle;
        const count = document.createElement("p");
        count.className = "quota-reset-count";
        count.textContent = locale.resetCreditsAvailable.replace("{count}", String(ordered.length));
        const list = document.createElement("div");
        list.className = "quota-credits";
        if (ordered.length > 0) {
          ordered.forEach((credit, index) => {
            list.append(creditRow(credit, index === 0, locale));
          });
        } else {
          const row = document.createElement("div");
          row.className = "quota-credit-row";
          row.textContent = locale.creditNone;
          list.append(row);
        }
        const actions = document.createElement("div");
        actions.className = "file-preview-dialog-actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "file-preview-dialog-button";
        cancel.textContent = locale.dialogCancel;
        cancel.addEventListener("click", () => finish(false));

        if (step === "list") {
          if (ordered.length > 0) {
            const note = document.createElement("p");
            note.className = "quota-reset-note";
            note.textContent = locale.fifoNote;
            const proceed = document.createElement("button");
            proceed.type = "button";
            proceed.className = "file-preview-dialog-button primary";
            proceed.textContent = locale.dialogProceed;
            proceed.addEventListener("click", () => {
              step = "confirm";
              paint();
            });
            actions.append(cancel, proceed);
            dialog.append(heading, count, list, note, actions);
          } else {
            const hint = document.createElement("p");
            hint.className = "quota-reset-note";
            hint.textContent = locale.creditEarnHint;
            actions.append(cancel);
            dialog.append(heading, count, list, hint, actions);
          }
          (dialog.querySelector(".file-preview-dialog-button.primary") ?? cancel).focus();
          return;
        }

        const desc = document.createElement("p");
        desc.textContent = locale.confirmResetDesc.replace("{count}", String(ordered.length));
        const which = document.createElement("p");
        which.className = "quota-reset-note";
        if (ordered[0]) {
          which.textContent = locale.confirmWhichCredit.replace(
            "{date}",
            formatAbsoluteTime(ordered[0]?.granted_at),
          );
        }
        const irreversible = document.createElement("p");
        irreversible.className = "quota-reset-irreversible";
        irreversible.textContent = locale.irreversible;
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = "file-preview-dialog-button primary";
        confirm.textContent = locale.dialogConfirm;
        confirm.addEventListener("click", () => finish(true));
        actions.append(cancel, confirm);
        dialog.append(heading, desc, which, irreversible, actions);
        confirm.focus();
      };

      paint();
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
    container.classList.toggle("hidden", !hasContent);
    if (!hasContent) {
      container.replaceChildren();
      return;
    }
    container.replaceChildren();
    const head = document.createElement("div");
    head.className = "quota-section-head";
    const title = document.createElement("h3");
    title.textContent = locale.sectionTitle;
    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "quota-refresh-btn";
    refresh.textContent = loading ? locale.refreshing : locale.refresh;
    refresh.disabled = loading;
    refresh.addEventListener("click", () => void loadReports(true));
    head.append(title, refresh);

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
        const windows = document.createElement("div");
        windows.className = "quota-windows";
        const bars = [];
        if (typeof quota.fiveHourPercent === "number") {
          bars.push(
            windowBar(
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
          bars.push(
            windowBar(
              { label: locale.weekly, percent: quota.weeklyPercent, resetAt: quota.weeklyResetAt },
              locale,
            ),
          );
        }
        if (typeof quota.monthlyPercent === "number") {
          bars.push(
            windowBar(
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
          bars.push(windowBar(custom, locale));
        }
        windows.append(...bars);
        card.append(windows);
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
