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

  /** Modal confirm listing each credit with its absolute granted/expires time. */
  function confirmReset(credits) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "file-preview-dialog-overlay";
      const dialog = document.createElement("div");
      dialog.className = "file-preview-dialog";
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      const heading = document.createElement("h3");
      heading.textContent = locale.resetDialogTitle;
      const body = document.createElement("p");
      body.textContent = locale.resetDialogBody;
      const list = document.createElement("div");
      list.className = "quota-credits";
      if (credits.length > 0) {
        for (const credit of credits) {
          const row = document.createElement("div");
          row.className = "quota-credit-row";
          row.textContent = `${locale.creditGranted.replace("{time}", formatAbsoluteTime(credit?.granted_at))} · ${locale.creditExpires.replace("{time}", formatAbsoluteTime(credit?.expires_at))}`;
          list.append(row);
        }
      } else {
        const row = document.createElement("div");
        row.className = "quota-credit-row";
        row.textContent = locale.creditUnknown;
        list.append(row);
      }
      const actions = document.createElement("div");
      actions.className = "file-preview-dialog-actions";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "file-preview-dialog-button";
      cancel.textContent = locale.dialogCancel;
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "file-preview-dialog-button primary";
      confirm.textContent = locale.dialogConfirm;
      actions.append(cancel, confirm);
      dialog.append(heading, body, list, actions);
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
      cancel.addEventListener("click", () => finish(false));
      confirm.addEventListener("click", () => finish(true));
      confirm.focus();
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
