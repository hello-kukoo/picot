// ABOUTME: Renders the MCP sign-in dialog (browser authorization-code flow) for Settings → MCP.
// ABOUTME: Only host-provided non-secret status frames reach the DOM; credentials stay in pi's mcp-auth.json.

import { t } from "../../i18n.js";

// Reuses the models OAuth dialog's class names for layout/CSS, with its own
// prefix so queries in one dialog can never pick up the other's nodes.
const DIALOG_CLASS = "mcp-login-dialog";
const SHARED_CLASS = "oauth-login-dialog";
// Host-side fallback cadence: `pi mcp login` reports the authorization URL
// through the event bridge, but a dropped/missed frame must not strand the
// dialog, so the page polls the operation status while it is pending.
const POLL_INTERVAL_MS = 1000;
// A single poll failure can be a transient socket blip; three in a row means
// the operation is gone (host restart, expired operation) and the dialog must
// stop pretending to wait.
const POLL_FAILURE_LIMIT = 3;

/**
 * Owner-scoped MCP sign-in dialog. `start`/`cancel`/`status` call the host
 * `mcp_login_*` ops (the Rust host spawns `pi mcp login`; no session runtime is
 * involved). `subscribe` receives `mcpLoginUpdate` payloads
 * (`{ operationId, status, authUrl?, error? }`). The dialog holds no OAuth
 * protocol logic and never sees tokens.
 */
export function createMcpLoginDialog({
  name,
  start: startOperation,
  cancel: cancelOperation,
  status: statusOperation,
  subscribe,
  openExternal,
  onSuccess,
}) {
  let operationId = null;
  let authUrl = null;
  let backdrop = null;
  let unsubscribe = null;
  let pollTimer = null;
  let pollFailures = 0;
  let finished = false;
  /** Last rendered pending shape, so a 1s poll tick never rebuilds the DOM
   * (which would re-enable a cancel button the user just pressed). */
  let pendingKey = null;

  function ensureBackdrop() {
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = `${SHARED_CLASS}-backdrop ${DIALOG_CLASS}-backdrop`;
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

  function clearDialog() {
    if (backdrop) {
      backdrop.remove();
      backdrop = null;
    }
    pendingKey = null;
  }

  function renderBase(actions) {
    const root = ensureBackdrop();
    const panel = el("div", `${SHARED_CLASS} ${DIALOG_CLASS}`);
    // Every node carries the shared class (layout/CSS lives on it) and the
    // dialog-specific one (queries stay scoped to this dialog).
    const title = el("div", `${SHARED_CLASS}-title ${DIALOG_CLASS}-title`);
    const statusEl = el("div", `${SHARED_CLASS}-status ${DIALOG_CLASS}-status`);
    panel.append(title, statusEl);
    if (actions?.length) {
      const row = el("div", `${SHARED_CLASS}-actions ${DIALOG_CLASS}-actions`);
      for (const btn of actions) row.appendChild(btn);
      panel.appendChild(row);
    }
    root.appendChild(panel);
    return { root, panel, title, status: statusEl };
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  /** Release every listener/timer this dialog owns (idempotent). */
  function finish() {
    finished = true;
    stopPolling();
    unsubscribe?.();
    unsubscribe = null;
  }

  function renderPending() {
    const key = authUrl ?? "";
    if (pendingKey === key) return;
    pendingKey = key;
    const actions = [];
    if (authUrl)
      actions.push(button("oauth-open-browser", t("settings.mcp.login.openBrowser"), true));
    actions.push(button("oauth-cancel", t("settings.mcp.login.cancel")));
    const { panel, status: statusEl } = renderBase(actions);
    panel.querySelector(`.${DIALOG_CLASS}-title`).textContent = t("settings.mcp.login.title", {
      name,
    });
    if (authUrl) {
      // The URL is a plain text node; it is captured in the click closure only.
      panel.insertBefore(el("div", `${DIALOG_CLASS}-url`, authUrl), statusEl);
      panel
        .querySelector('[data-action="oauth-open-browser"]')
        .addEventListener("click", () => openExternal(authUrl));
    }
    statusEl.textContent = authUrl
      ? t("settings.mcp.login.waiting")
      : t("settings.mcp.login.preparing");
    panel.querySelector('[data-action="oauth-cancel"]').addEventListener("click", cancelLogin);
  }

  function renderFailure(message) {
    finish();
    const { panel, status: statusEl } = renderBase([
      button("oauth-retry", t("settings.mcp.login.retry"), true),
      button("oauth-close", t("actions.close")),
    ]);
    panel.querySelector(`.${DIALOG_CLASS}-title`).textContent = t("settings.mcp.login.failed");
    statusEl.textContent = sanitizeDialogMessage(message) || t("settings.mcp.login.failed");
    panel.querySelector('[data-action="oauth-retry"]').addEventListener("click", retry);
    panel.querySelector('[data-action="oauth-close"]').addEventListener("click", destroy);
  }

  function renderCancelled() {
    finish();
    const { panel } = renderBase([button("oauth-close", t("actions.close"), true)]);
    panel.querySelector(`.${DIALOG_CLASS}-title`).textContent = t("settings.mcp.login.cancelled");
    panel.querySelector('[data-action="oauth-close"]').addEventListener("click", destroy);
  }

  /** Terminal success closes the dialog: the refreshed row badge is the
   * confirmation (spec: succeeded → close + refresh status/list). */
  function complete() {
    finish();
    clearDialog();
    try {
      Promise.resolve(onSuccess?.()).catch((error) => {
        // The sign-in itself succeeded; a failed refresh must not surface as
        // an unhandled rejection or as a false sign-in failure.
        console.error("[mcp-login] refresh after sign-in failed:", error);
      });
    } catch (error) {
      console.error("[mcp-login] refresh after sign-in failed:", error);
    }
  }

  function applyStatus(next, url, error) {
    if (finished) return;
    if (typeof url === "string" && url) authUrl = url;
    switch (next) {
      case "succeeded":
        complete();
        return;
      case "failed":
        renderFailure(error);
        return;
      case "cancelled":
        renderCancelled();
        return;
      default:
        // `pending` (and any state the host adds later) keeps the dialog up;
        // the poll keeps looking for the URL until the operation settles.
        renderPending();
    }
  }

  function handleFrame(payload) {
    if (!payload || payload.operationId !== operationId) return;
    applyStatus(payload.status, payload.authUrl, payload.error);
  }

  function startPolling() {
    stopPolling();
    pollFailures = 0;
    pollTimer = setInterval(() => {
      if (!operationId || finished) return;
      Promise.resolve(statusOperation(operationId))
        .then((resp) => {
          if (finished) return;
          pollFailures = 0;
          if (resp?.ok === false) {
            renderFailure(resp.error);
            return;
          }
          applyStatus(resp?.status, resp?.authUrl, resp?.error);
        })
        .catch((error) => {
          // Fallback path only: one blip must not tear down a dialog whose
          // operation may still complete. Repeated failures mean the operation
          // is unreachable, so the dialog settles instead of spinning forever.
          pollFailures += 1;
          if (pollFailures >= POLL_FAILURE_LIMIT) {
            renderFailure(error?.message);
            return;
          }
          console.error("[mcp-login] status poll failed:", error);
        });
    }, POLL_INTERVAL_MS);
  }

  function cancelLogin() {
    if (!operationId || finished) return;
    const cancelBtn = backdrop?.querySelector('[data-action="oauth-cancel"]');
    if (cancelBtn) cancelBtn.disabled = true;
    Promise.resolve(cancelOperation(operationId)).catch((error) => {
      // A rejected cancel (unknown/terminal operation) still settles through
      // the event bridge or the poll. Re-enable the button rather than
      // trapping the user in a dialog whose only control stopped working.
      console.error("[mcp-login] cancel failed:", error);
      const retryBtn = backdrop?.querySelector('[data-action="oauth-cancel"]');
      if (retryBtn) retryBtn.disabled = false;
    });
  }

  async function retry() {
    unsubscribe?.();
    unsubscribe = null;
    operationId = null;
    authUrl = null;
    finished = false;
    await start();
  }

  async function start() {
    pendingKey = null;
    renderPending();
    // Subscribe before the start round-trip: pi emits the authorization URL
    // from the spawned process, which can beat the response frame. finish()
    // releases the subscription on any early failure.
    unsubscribe = subscribe(handleFrame);
    startPolling();

    let resp;
    try {
      resp = await startOperation();
    } catch (error) {
      renderFailure(error?.message || t("settings.mcp.login.failed"));
      return;
    }
    if (resp?.ok && resp.operationId) {
      operationId = resp.operationId;
      return;
    }
    renderFailure(resp?.error || t("settings.mcp.login.failed"));
  }

  function destroy() {
    finish();
    clearDialog();
  }

  return { start, destroy };
}

/**
 * Defensive client-side redaction for failure messages. The host already
 * sanitizes MCP failures (stderr is never persisted), but the dialog never
 * trusts a raw message that could carry a token-like fragment into the DOM.
 */
function sanitizeDialogMessage(raw) {
  const collapsed = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!collapsed) return "";
  return collapsed
    .replace(/\bauthorization\s*:\s*bearer\s+[^\s]+/gi, " [redacted]")
    .replace(/\bbearer\s+[^\s]+/gi, " [redacted]")
    .replace(
      /\b(?:token|refresh|access|secret|code|key|authorization)\b\s*[=:]\s*[^\s]+/gi,
      " [redacted]",
    )
    .replace(/[?&][^\s]*/g, " [redacted]")
    .replace(/\s+/g, " ")
    .trim();
}
