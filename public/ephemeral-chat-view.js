// ABOUTME: Element-scoped chat view for one ephemeral runtime: messages, tools,
// ABOUTME: composer, dialogs, and usage — reusing the shared render helpers.

import { setupVoiceInput } from "./app-voice-input.js";
import { DialogHandler } from "./dialogs.js";
import { onLocaleChange, t } from "./i18n.js";
import { MessageRenderer } from "./message-renderer.js";
import { ToolCardRenderer } from "./tool-card.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];
const SVG_NS = "http://www.w3.org/2000/svg";

function appendIcon(doc, button, paths, { fill = "none", strokeWidth = "2" } = {}) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", fill);
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", strokeWidth);
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of paths) {
    const path = doc.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  button.replaceChildren(svg);
}

/**
 * Builds an isolated DOM tree for one ephemeral chat and projects the runtime's
 * render state into it. Side Chat enables tools; Quick Chat does not. Multiple
 * views can stay alive while only one is visible.
 */
export class EphemeralChatView {
  constructor({ runtime, kind, toolsEnabled }) {
    this.runtime = runtime;
    this.kind = kind || "side-chat";
    this.toolsEnabled = toolsEnabled !== false;
    this.destroyed = false;
    this._interactionLocked = false;

    const doc = globalThis.document;
    this._doc = doc;

    this._root = doc.createElement("div");
    this._root.className = "ephemeral-chat-view";
    this._root.setAttribute("role", "tabpanel");

    this._messagesEl = doc.createElement("div");
    this._messagesEl.className = "messages ephemeral-messages";
    this._root.appendChild(this._messagesEl);

    if (this.toolsEnabled) {
      this._toolsEl = doc.createElement("div");
      this._toolsEl.className = "ephemeral-tools";
      this._root.appendChild(this._toolsEl);
    }

    this._usageEl = doc.createElement("div");
    this._usageEl.className = "ephemeral-usage";
    this._root.appendChild(this._usageEl);

    this._dialogContainer = doc.createElement("div");
    this._dialogContainer.className = "ephemeral-dialog-container hidden";
    this._root.appendChild(this._dialogContainer);

    // Composer mirrors the main chat's card and toolbar hierarchy. The scoped
    // classes avoid duplicate document IDs while deliberately reusing its style.
    this._composer = doc.createElement("div");
    this._composer.className = "composer-card ephemeral-composer";
    this._textarea = doc.createElement("textarea");
    this._textarea.className = "ephemeral-input";
    this._textarea.placeholder = t("ephemeral.placeholder");
    this._textarea.rows = 2;
    this._composer.appendChild(this._textarea);

    const toolbar = doc.createElement("div");
    toolbar.className = "composer-toolbar";
    const toolbarLeft = doc.createElement("div");
    toolbarLeft.className = "composer-toolbar-left";
    toolbar.appendChild(toolbarLeft);
    const toolbarRight = doc.createElement("div");
    toolbarRight.className = "composer-toolbar-right";

    this._modelDropdown = doc.createElement("div");
    this._modelDropdown.className = "model-dropdown";
    this._modelBtn = doc.createElement("button");
    this._modelBtn.type = "button";
    this._modelBtn.className = "model-dropdown-btn";
    this._modelBtn.dataset.role = "ephemeral-model";
    this._modelLabel = doc.createElement("span");
    this._modelLabel.className = "model-dropdown-label";
    this._modelBtn.appendChild(this._modelLabel);
    const chevron = doc.createElementNS(SVG_NS, "svg");
    chevron.classList.add("model-dropdown-chevron");
    chevron.setAttribute("aria-hidden", "true");
    chevron.setAttribute("width", "10");
    chevron.setAttribute("height", "6");
    chevron.setAttribute("viewBox", "0 0 10 6");
    chevron.setAttribute("fill", "none");
    const chevronPath = doc.createElementNS(SVG_NS, "path");
    chevronPath.setAttribute("d", "M1 1L5 5L9 1");
    chevronPath.setAttribute("stroke", "currentColor");
    chevronPath.setAttribute("stroke-width", "1.5");
    chevronPath.setAttribute("stroke-linecap", "round");
    chevronPath.setAttribute("stroke-linejoin", "round");
    chevron.appendChild(chevronPath);
    this._modelBtn.appendChild(chevron);
    this._modelMenu = doc.createElement("div");
    this._modelMenu.className = "model-dropdown-menu hidden";
    this._modelDropdown.append(this._modelBtn, this._modelMenu);
    toolbarRight.appendChild(this._modelDropdown);

    this._thinkingBtn = doc.createElement("button");
    this._thinkingBtn.type = "button";
    this._thinkingBtn.className = "thinking-tag off";
    this._thinkingBtn.dataset.role = "ephemeral-thinking";
    toolbarRight.appendChild(this._thinkingBtn);

    this._micBtn = doc.createElement("button");
    this._micBtn.type = "button";
    this._micBtn.className = "input-mic-btn ephemeral-mic";
    appendIcon(doc, this._micBtn, [
      "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z",
      "M19 10v2a7 7 0 0 1-14 0v-2",
      "M12 19v3",
    ]);
    toolbarRight.appendChild(this._micBtn);

    this._sendBtn = doc.createElement("button");
    this._sendBtn.type = "button";
    this._sendBtn.className = "ephemeral-send";
    this._sendBtn.dataset.role = "ephemeral-send";
    toolbarRight.appendChild(this._sendBtn);
    toolbar.appendChild(toolbarRight);
    this._composer.appendChild(toolbar);
    this._root.appendChild(this._composer);

    // Shared render helpers, each scoped to this view's containers.
    this.messageRenderer = new MessageRenderer(this._messagesEl);
    this.toolCardRenderer = this.toolsEnabled ? new ToolCardRenderer(this._toolsEl) : null;
    this.dialogHandler = new DialogHandler({
      container: this._dialogContainer,
      notificationContainer: this._messagesEl,
      send: (message) => {
        // The response routes back through the runtime's owner-scoped transport.
        this.runtime.respondToExtensionUi(message.id, message);
      },
    });

    this._destroyVoice = setupVoiceInput({ micBtn: this._micBtn, messageInput: this._textarea });

    this._onRenderState = (event) => this._render(event.detail);
    this._onExtensionUi = (event) => this._showExtensionDialog(event.detail.request);
    this._onKeyDown = (event) => this._handleKeyDown(event);
    this.runtime.addEventListener("renderstate", this._onRenderState);
    this.runtime.addEventListener("extensionuirequest", this._onExtensionUi);
    this._textarea.addEventListener("keydown", this._onKeyDown);
    this._onSendClick = () => {
      if (this.runtime.isStreaming) this.runtime.abort();
      else this._submit();
    };
    this._sendBtn.addEventListener("click", this._onSendClick);
    this._onModelClick = () => void this._toggleModelMenu();
    this._onThinkingClick = () => this._cycleThinkingLevel();
    this._onDocumentClick = (event) => {
      if (!this._modelDropdown.contains(event.target)) this._closeModelMenu();
    };
    this._modelBtn.addEventListener("click", this._onModelClick);
    this._thinkingBtn.addEventListener("click", this._onThinkingClick);
    this._doc.addEventListener("click", this._onDocumentClick);
    this._unsubscribeLocale = onLocaleChange(() => {
      this._renderComposerState({
        model: this.runtime.model,
        thinkingLevel: this.runtime.thinkingLevel,
        isStreaming: this.runtime.isStreaming,
      });
    });
    this._renderComposerState({
      model: this.runtime.model,
      thinkingLevel: this.runtime.thinkingLevel,
      isStreaming: this.runtime.isStreaming,
    });
  }

  get element() {
    return this._root;
  }

  activate() {
    this.runtime.acknowledgeVisible();
  }

  deactivate() {
    // Hiding the view does not destroy it.
  }

  focusLastMeaningfulControl() {
    if (!this.destroyed) this._textarea.focus();
  }

  setInteractionLocked(locked) {
    this._interactionLocked = Boolean(locked);
    this._textarea.disabled = this._interactionLocked;
    this._sendBtn.disabled = this._interactionLocked;
    this._micBtn.disabled = this._interactionLocked;
    this._modelBtn.disabled = this._interactionLocked;
    this._thinkingBtn.disabled = this._interactionLocked;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.runtime.removeEventListener("renderstate", this._onRenderState);
    this.runtime.removeEventListener("extensionuirequest", this._onExtensionUi);
    this._textarea.removeEventListener("keydown", this._onKeyDown);
    this._sendBtn.removeEventListener("click", this._onSendClick);
    this._modelBtn.removeEventListener("click", this._onModelClick);
    this._thinkingBtn.removeEventListener("click", this._onThinkingClick);
    this._doc.removeEventListener("click", this._onDocumentClick);
    this._unsubscribeLocale?.();
    this.messageRenderer?.destroy();
    this.toolCardRenderer?.destroy();
    this.dialogHandler?.destroy();
    this._destroyVoice?.();
    this._root.remove();
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  _submit() {
    if (this.destroyed || this._interactionLocked) return;
    if (this.runtime.isStreaming) {
      this.runtime.abort();
      return;
    }
    const text = this._textarea.value.trim();
    if (!text) return;
    this.runtime.sendPrompt(text);
    this._textarea.value = "";
  }

  _handleKeyDown(event) {
    if (this.destroyed) return;
    if (event.key === "Escape" && this.runtime.isStreaming) {
      event.preventDefault();
      this.runtime.abort();
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      this._submit();
    }
  }

  _render(state) {
    if (this.destroyed || !state) return;
    this.messageRenderer.clear();
    for (const message of state.messages || []) {
      if (message.role === "user") {
        this.messageRenderer.renderUserMessage(message);
      } else if (message.role === "assistant") {
        this.messageRenderer.renderAssistantMessage(message);
      }
    }
    if (state.assistantDraft) {
      const streamingEl = this.messageRenderer.renderAssistantMessage(
        { content: state.assistantDraft.text || "" },
        true,
      );
      if (state.assistantDraft.thinking) {
        this.messageRenderer.updateStreamingThinking(streamingEl, state.assistantDraft.thinking);
      }
    }
    if (state.error) {
      this.messageRenderer.renderError(state.error);
    }

    if (this.toolCardRenderer) {
      this.toolCardRenderer.clear();
      for (const tool of state.tools || []) {
        this.toolCardRenderer.createToolCard(tool);
        this.toolCardRenderer.updateToolCard(tool);
      }
    }

    this._renderUsage(state.contextUsage);
    this._renderComposerState(state);
  }
  async _toggleModelMenu() {
    if (this._interactionLocked) return;
    if (!this._modelMenu.classList.contains("hidden")) {
      this._closeModelMenu();
      return;
    }

    this._modelMenu.replaceChildren();
    this._modelDropdown.classList.add("open");
    this._modelMenu.classList.remove("hidden");
    try {
      const models = await this.runtime.getAvailableModels();
      if (this.destroyed || this._modelMenu.classList.contains("hidden")) return;
      this._renderModelMenu(models);
    } catch {
      this._renderModelMenu([]);
    }
  }

  _closeModelMenu() {
    this._modelMenu.classList.add("hidden");
    this._modelDropdown.classList.remove("open");
  }

  _renderModelMenu(models) {
    this._modelMenu.replaceChildren();
    if (!models.length) {
      const empty = this._doc.createElement("div");
      empty.className = "model-dropdown-empty";
      empty.textContent = t("models.emptyTitle");
      this._modelMenu.appendChild(empty);
      return;
    }
    const activeModelId = this.runtime.model?.id ?? this.runtime.model?.modelId;
    for (const model of models) {
      const option = this._doc.createElement("button");
      option.type = "button";
      option.className = `model-dropdown-item${model.id === activeModelId ? " active" : ""}`;
      const name = this._doc.createElement("span");
      name.textContent = model.id || "";
      if (model.provider) {
        const provider = this._doc.createElement("span");
        provider.className = "model-dropdown-item-provider";
        provider.textContent = model.provider;
        name.appendChild(provider);
      }
      const context = this._doc.createElement("span");
      context.className = "model-dropdown-item-ctx";
      context.textContent = model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : "";
      option.append(name, context);
      option.addEventListener("click", () => {
        this.runtime.setModel(model.provider, model.id);
        this._closeModelMenu();
      });
      this._modelMenu.appendChild(option);
    }
  }

  _cycleThinkingLevel() {
    if (this._interactionLocked) return;
    const current = this.runtime.thinkingLevel || "off";
    const index = THINKING_LEVELS.indexOf(current);
    const next = THINKING_LEVELS[(index + 1) % THINKING_LEVELS.length];
    this.runtime.setThinkingLevel(next);
  }

  _renderComposerState(state) {
    const model = state?.model;
    const modelId =
      typeof model === "string" ? model : model?.id || model?.modelId || t("misc.model");
    this._modelLabel.textContent = modelId;
    this._modelBtn.title = t("input.switchModel");
    this._modelBtn.setAttribute("aria-label", t("input.switchModel"));

    const thinkingLevel = state?.thinkingLevel || "off";
    this._thinkingBtn.textContent = t("settings.thinkingCompact", { level: thinkingLevel });
    this._thinkingBtn.title = t("settings.thinkingTitle");
    this._thinkingBtn.setAttribute(
      "aria-label",
      t("settings.thinkingAriaLabel", { level: thinkingLevel }),
    );
    this._thinkingBtn.classList.toggle("off", thinkingLevel === "off");

    const sendLabel = state?.isStreaming ? t("ephemeral.abort") : t("ephemeral.send");
    this._sendBtn.title = sendLabel;
    this._sendBtn.setAttribute("aria-label", sendLabel);
    appendIcon(
      this._doc,
      this._sendBtn,
      state?.isStreaming ? ["M4 4h16v16H4z"] : ["M12 19V5", "m-7 7 7-7 7 7"],
      { fill: state?.isStreaming ? "currentColor" : "none", strokeWidth: "2.5" },
    );
    const voiceLabel = t("voice.voiceInput");
    this._micBtn.title = voiceLabel;
    this._micBtn.setAttribute("aria-label", voiceLabel);
  }

  _renderUsage(contextUsage) {
    if (!this._usageEl) return;
    const tokens = contextUsage?.used ?? contextUsage?.tokens;
    if (typeof tokens === "number") {
      this._usageEl.textContent = `${tokens} ${t("ephemeral.tokens")}`;
    } else {
      this._usageEl.textContent = "";
    }
  }

  _showExtensionDialog(request) {
    if (this.destroyed || !request) return;
    switch (request.method) {
      case "select":
        this.dialogHandler.showSelect(request);
        break;
      case "confirm":
        this.dialogHandler.showConfirm(request);
        break;
      case "input":
        this.dialogHandler.showInput(request);
        break;
      case "editor":
        this.dialogHandler.showEditor(request);
        break;
      default:
        break;
    }
  }
}
