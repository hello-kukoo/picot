import { createIcon } from "../icons.js";

/**
 * <sa-chat-header> Web Component
 *
 * Chat header shown when Super Agent workspace is active.
 * Mirrors the layout of the regular .header (header-left / header-right)
 * so it looks visually consistent with the rest of the app.
 *
 * Buttons call window.__saOpenSettings().
 */

class SAChatHeader extends HTMLElement {
  connectedCallback() {
    this.classList.add("header", "super-agent-chat-header");
    const headerLeft = document.createElement("div");
    headerLeft.className = "header-left";
    const sidebarButton = createHeaderButton(
      "sidebar-toggle sa-sidebar-delegate",
      "Toggle sidebar",
      "menu",
      18,
    );
    const lanButton = createHeaderButton(
      "icon-btn lan-qr-btn hidden",
      "Show mobile QR code",
      "smartphone",
      16,
    );
    lanButton.dataset.action = "lan-qr";
    const status = document.createElement("div");
    status.className = "status";
    const indicator = document.createElement("span");
    indicator.className = "status-indicator connected";
    indicator.id = "sa-status-indicator";
    const statusText = document.createElement("span");
    statusText.className = "status-text";
    statusText.id = "sa-status-text";
    statusText.textContent = "Listening";
    status.append(indicator, statusText);
    headerLeft.append(sidebarButton, lanButton, status);

    const headerRight = document.createElement("div");
    headerRight.className = "header-right";
    const telegram = document.createElement("button");
    telegram.className = "pill sa-service-pill";
    telegram.dataset.action = "telegram";
    telegram.disabled = true;
    telegram.setAttribute("aria-disabled", "true");
    telegram.title = "Telegram is not configured";
    const telegramDot = document.createElement("span");
    telegramDot.className = "sa-service-dot sa-dot-telegram";
    telegram.append(telegramDot, "Telegram");
    const runtimeButton = createHeaderButton(
      "icon-btn sa-runtime-toggle",
      "Toggle task board",
      "panel-right",
      14,
    );
    runtimeButton.dataset.action = "runtime";
    headerRight.append(telegram, runtimeButton);
    this.replaceChildren(headerLeft, headerRight);

    // Delegate sidebar toggle to the real button in .header (which has the listener)
    this.querySelector(".sa-sidebar-delegate").addEventListener("click", () => {
      document.getElementById("sidebar-toggle")?.click();
    });

    this.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;
      if (btn.disabled) return;
      const action = btn.dataset.action;
      if (action === "lan-qr") document.getElementById("lan-qr-btn")?.click();
      if (action === "telegram") window.__saOpenSettings?.(action);
      if (action === "runtime") this._toggleRuntime(btn);
    });

    this._syncLanQrButton();
    this._handleChatConfigUpdated = () => this._loadServiceStatus();
    window.addEventListener("picot-chat-config-updated", this._handleChatConfigUpdated);
    this._loadServiceStatus();
  }

  disconnectedCallback() {
    this._lanQrObserver?.disconnect();
    if (this._handleChatConfigUpdated) {
      window.removeEventListener("picot-chat-config-updated", this._handleChatConfigUpdated);
    }
  }

  _syncLanQrButton() {
    const source = document.getElementById("lan-qr-btn");
    const target = this.querySelector('[data-action="lan-qr"]');
    if (!source || !target) return;

    const sync = () => target.classList.toggle("hidden", source.classList.contains("hidden"));
    sync();

    this._lanQrObserver?.disconnect();
    this._lanQrObserver = new MutationObserver(sync);
    this._lanQrObserver.observe(source, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  async _loadServiceStatus() {
    const connectedServices = new Set();

    try {
      const res = await fetch("/api/chat-config");
      if (res.ok) {
        const data = await res.json();
        const config = JSON.parse(data?.content || "{}");
        for (const account of Object.values(config.accounts || {})) {
          if (isConfiguredAccount(account)) connectedServices.add(account.service);
        }
      }
    } catch {
      // Keep services disabled when config cannot be read.
    }

    this._setServiceConnected("telegram", connectedServices.has("telegram"));
  }

  _setServiceConnected(service, connected) {
    const button = this.querySelector(`[data-action="${service}"]`);
    if (!button) return;

    button.disabled = !connected;
    button.setAttribute("aria-disabled", connected ? "false" : "true");
    button.classList.toggle("connected", connected);
    button.title = connected
      ? `${capitalize(service)} settings`
      : `${capitalize(service)} is not configured`;
  }

  _toggleRuntime(btn) {
    const runtime = document.querySelector("super-agent-runtime");
    if (!runtime) return;
    const collapsed = runtime.classList.toggle("collapsed");
    btn.classList.toggle("active", !collapsed);
    localStorage.setItem("sa-runtime-collapsed", collapsed ? "1" : "0");
  }
}

function isConfiguredAccount(account) {
  if (!account || typeof account !== "object") return false;
  if (account.service === "telegram") return Boolean(account.botToken);
  return false;
}

function capitalize(value) {
  const text = String(value || "");
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

function createHeaderButton(className, label, iconName, size) {
  const button = document.createElement("button");
  button.className = className;
  button.title = label;
  button.setAttribute("aria-label", label);
  const icon = createIcon(iconName, { size });
  if (icon) button.appendChild(icon);
  return button;
}

customElements.define("sa-chat-header", SAChatHeader);
