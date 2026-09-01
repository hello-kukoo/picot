// ABOUTME: Renders the owner-scoped OpenAI Codex device-code login dialog for Settings Models.
// ABOUTME: Shows only Pi-provided non-secret device-code events and never handles OAuth credentials.

import { t } from "../../i18n.js";
import { bindDialogEscape } from "../../ui/dialog-escape.js";

const DIALOG_CLASS = "oauth-login-dialog";

/**
 * Device-code login dialog. `command` sends v3-shaped frames through the
 * OAuth gateway; `subscribe` receives `{ event }` envelopes whose `type` uses
 * the Phase 4 mapped names (device_code / progress / complete / failed /
 * cancelled / expired). `onTerminal` fires on every terminal state so the
 * caller can refresh provider state. No token data or OAuth protocol logic
 * lives here.
 */
export function createModelsOAuthLoginDialog({
  command,
  subscribe,
  openExternal,
  copyText,
  onSuccess,
  onTerminal,
}) {
  let operationId = null;
  let backdrop = null;
  let unsubscribe = null;
  let countdownTimer = null;
  let unbindEscape = null;

  function ensureBackdrop() {
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = `${DIALOG_CLASS}-backdrop`;
      document.body.appendChild(backdrop);
    }
    backdrop.replaceChildren();
    return backdrop;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clearDialog() {
    if (backdrop) {
      backdrop.remove();
      backdrop = null;
    }
  }

  function clearCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function button(action, label, primary = false) {
    const node = el(
      "button",
      `ui-button ${primary ? "ui-button--primary" : "ui-button--secondary"}`,
      label,
    );
    node.type = "button";
    node.dataset.action = action;
    return node;
  }

  function renderBase(actions) {
    const root = ensureBackdrop();
    const panel = el("div", DIALOG_CLASS);
    const title = el("div", `${DIALOG_CLASS}-title`);
    const status = el("div", `${DIALOG_CLASS}-status`);
    panel.append(title, status);
    if (actions) {
      const row = el("div", `${DIALOG_CLASS}-actions`);
      for (const btn of actions) row.appendChild(btn);
      panel.appendChild(row);
    }
    root.appendChild(panel);
    return { root, panel, title, status };
  }

  function handleEvent({ event }) {
    if (!event || (operationId && event.operationId && event.operationId !== operationId)) return;
    switch (event.type) {
      case "device_code":
        renderDeviceCode(event);
        break;
      case "progress":
        renderProgress(event.message);
        break;
      case "complete":
        clearCountdown();
        renderSuccess();
        onSuccess?.();
        onTerminal?.();
        break;
      case "failed":
        clearCountdown();
        renderFailure(event.message);
        onTerminal?.();
        break;
      case "cancelled":
        clearCountdown();
        renderCancelled();
        onTerminal?.();
        break;
      case "expired":
        clearCountdown();
        renderExpired();
        onTerminal?.();
        break;
    }
  }

  function renderDeviceCode(event) {
    const { panel, status } = renderBase([
      button("oauth-open-browser", t("settings.models.oauth.openBrowser"), true),
      button("oauth-copy-code", t("settings.models.oauth.copyCode")),
      button("oauth-cancel", t("settings.models.oauth.cancel")),
    ]);
    panel.querySelector(`.${DIALOG_CLASS}-title`).textContent = t(
      "settings.models.oauth.signInWithChatGPT",
    );
    // URL and code are plain text nodes; the URL is captured in the click
    // closure only — never stored in a data-* attribute.
    const url = event.verificationUri;
    const userCode = event.userCode;
    const code = el("div", `${DIALOG_CLASS}-code`, userCode);
    const urlEl = el("div", `${DIALOG_CLASS}-url`, url);
    panel.insertBefore(urlEl, status);
    panel.insertBefore(code, urlEl);
    // Local countdown from the relative expiry (no cross-process clock). It
    // renders into its own node so Pi's progress messages in the status node
    // can never clobber it — and vice versa. The bridge also emits an expired
    // terminal event on its own timer; this is the UI-side fallback so the
    // dialog never sits stale after expiry.
    clearCountdown();
    const countdown = el("div", `${DIALOG_CLASS}-countdown`);
    panel.insertBefore(countdown, status);
    if (event.expiresInSeconds && event.expiresInSeconds > 0) {
      let remaining = event.expiresInSeconds;
      const render = () => {
        countdown.textContent =
          remaining > 0 ? `${remaining}s` : t("settings.models.oauth.expired");
      };
      render();
      countdownTimer = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
          clearCountdown();
          renderExpired();
          onTerminal?.();
          return;
        }
        render();
      }, 1000);
    } else {
      countdown.textContent = t("settings.models.oauth.completeInBrowser");
    }
    panel
      .querySelector('[data-action="oauth-open-browser"]')
      .addEventListener("click", () => openExternal(url));
    panel
      .querySelector('[data-action="oauth-copy-code"]')
      .addEventListener("click", () => copyText(userCode));
    panel.querySelector('[data-action="oauth-cancel"]').addEventListener("click", cancel);
  }

  function renderProgress(message) {
    const statusEl = backdrop?.querySelector(`.${DIALOG_CLASS}-status`);
    if (statusEl && message) statusEl.textContent = message;
  }

  function renderSuccess() {
    const { panel } = renderBase([button("oauth-close", t("actions.close"), true)]);
    panel.querySelector(`.${DIALOG_CLASS}-title`).textContent = t(
      "settings.models.oauth.connected",
    );
    panel.querySelector('[data-action="oauth-close"]').addEventListener("click", destroy);
  }

  function renderFailure(message) {
    const { panel, status } = renderBase([
      button("oauth-retry", t("settings.models.oauth.retry"), true),
      button("oauth-close", t("actions.close")),
    ]);
    panel.querySelector(`.${DIALOG_CLASS}-title`).textContent = t("settings.models.oauth.failed");
    status.textContent = humanizeOauthFailure(message);
    panel.querySelector('[data-action="oauth-retry"]').addEventListener("click", retry);
    panel.querySelector('[data-action="oauth-close"]').addEventListener("click", destroy);
  }

  function renderCancelled() {
    const { panel } = renderBase([button("oauth-close", t("actions.close"), true)]);
    panel.querySelector(`.${DIALOG_CLASS}-title`).textContent = t(
      "settings.models.oauth.cancelled",
    );
    panel.querySelector('[data-action="oauth-close"]').addEventListener("click", destroy);
  }

  function renderExpired() {
    const { panel } = renderBase([
      button("oauth-retry", t("settings.models.oauth.retry"), true),
      button("oauth-close", t("actions.close")),
    ]);
    panel.querySelector(`.${DIALOG_CLASS}-title`).textContent = t("settings.models.oauth.expired");
    panel.querySelector('[data-action="oauth-retry"]').addEventListener("click", retry);
    panel.querySelector('[data-action="oauth-close"]').addEventListener("click", destroy);
  }

  async function retry() {
    unsubscribe?.();
    unsubscribe = null;
    operationId = null;
    await start();
  }

  function renderPreparing() {
    const { panel } = renderBase([button("oauth-cancel", t("settings.models.oauth.cancel"))]);
    panel.querySelector(`.${DIALOG_CLASS}-title`).textContent = t(
      "settings.models.oauth.preparing",
    );
    panel.querySelector('[data-action="oauth-cancel"]').addEventListener("click", cancel);
  }

  function cancel() {
    const cancelBtn = backdrop?.querySelector('[data-action="oauth-cancel"]');
    if (cancelBtn) cancelBtn.disabled = true;
    if (!operationId) {
      destroy();
      return;
    }
    void command({ type: "cancel_oauth_login", operationId });
  }

  function onEscape() {
    if (backdrop?.querySelector('[data-action="oauth-cancel"]:not([disabled])')) {
      cancel();
      return;
    }
    destroy();
  }

  async function start() {
    // Subscribe and show the preparing dialog before the round-trip so a
    // slow start command cannot look like a dead click, and so a device
    // code that arrives immediately is not dropped (no activeHandler).
    unsubscribe?.();
    unsubscribe = subscribe(handleEvent);
    if (!unbindEscape) {
      unbindEscape = bindDialogEscape(onEscape, {
        isActive: () => Boolean(backdrop?.isConnected),
      });
    }
    renderPreparing();
    let resp;
    try {
      resp = await command({
        type: "start_oauth_login",
        provider: "openai-codex",
        method: "device_code",
      });
    } catch (error) {
      // The transport failed to deliver the command. Surface a failure
      // instead of leaving the dialog silent.
      renderFailure(error?.message || t("settings.models.oauth.failed"));
      return;
    }
    if (resp?.success && resp.data?.operationId) {
      operationId = resp.data.operationId;
    } else {
      renderFailure(resp?.error || t("settings.models.oauth.failed"));
    }
  }

  function destroy() {
    unbindEscape?.();
    unbindEscape = null;
    unsubscribe?.();
    unsubscribe = null;
    operationId = null;
    clearCountdown();
    clearDialog();
    onTerminal?.();
  }

  return { start, destroy };
}

/**
 * Defensive client-side redaction for failure messages. The bridge already
 * sanitizes, but the dialog never trusts a raw message that could carry a
 * token-like fragment into the DOM.
 */
function humanizeOauthFailure(raw) {
  const text = String(raw ?? "");
  if (
    /self.?signed certificate in certificate chain/i.test(text) ||
    /unable to verify the first certificate/i.test(text)
  ) {
    return t("settings.models.oauth.tlsUntrusted");
  }
  return sanitizeDialogMessage(raw);
}

function sanitizeDialogMessage(raw) {
  const collapsed = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const redacted = collapsed
    .replace(/\bauthorization\s*:\s*bearer\s+[^\s]+/gi, " [redacted]")
    .replace(/\bbearer\s+[^\s]+/gi, " [redacted]")
    .replace(
      /\b(?:token|refresh|access|secret|code|key|authorization)\b\s*=\s*[^\s]+/gi,
      " [redacted]",
    )
    .replace(
      /\b(?:token|refresh|access|secret|code|key|authorization)\b\s*:\s*[^\s]+/gi,
      " [redacted]",
    )
    .replace(/[?&][^\s]*/g, " [redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted || "";
}
