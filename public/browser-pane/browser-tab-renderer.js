// ABOUTME: Browser tab renderer for the file-preview panel (spec 2026-09-22):
// ABOUTME: toolbar + webview rect target, annotate flow, office watch lifecycle.

import { t } from "../i18n.js";
import {
  appendAttachmentToComposer,
  formatBrowserElementAttachment,
  formatOfficeElementAttachment,
  openAnnotationDialog,
} from "./browser-annotations.js";
import {
  closePane,
  evalPane,
  navigatePane,
  openPane,
  paneVisible,
  setPaneBottomInset,
  showPane,
} from "./browser-pane-manager.js";
import { createElementSelectorController, createPaneWebviewAdapter } from "./element-selector.js";

function isOfficeTab(tab) {
  return Boolean(tab.filePath && tab.url?.startsWith("http://127.0.0.1:"));
}

/**
 * Renderer for `kind: "browser"` tabs. The native child webview outlives
 * renderer instances (keyed by tab id in the pane manager); this object owns
 * the DOM target, toolbar, and annotation flow while its tab is mounted.
 */
export function createBrowserTabRenderer({ tab, transport }) {
  let root = null;
  let contentEl = null;
  let urlInput = null;
  let statusEl = null;
  let annotateBtn = null;
  let attached = false;
  let destroyed = false;
  const selector = createElementSelectorController({
    webviewAdapter: createPaneWebviewAdapter({
      paneId: tab.id,
      isAlive: () => paneVisible(tab.id),
      evaluate: (paneId, expression) => evalPane(paneId, expression, transport),
    }),
  });

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function setUrlBar(url) {
    if (urlInput && document.activeElement !== urlInput) urlInput.value = url;
  }

  async function navigate(url) {
    setStatus(t("files.browser.loading"));
    try {
      await navigatePane(tab.id, url, transport);
      setStatus("");
    } catch (error) {
      setStatus(`${t("files.browser.cannotOpen")}：${error?.message ?? error}`);
    }
  }

  async function restartWatch() {
    if (!isOfficeTab(tab)) return;
    setStatus(t("files.browser.restarting"));
    try {
      const response = await transport.officecliWatchStart({ file: tab.filePath });
      const url = response.url;
      tab.url = url;
      await navigate(url);
      setUrlBar(url);
    } catch (error) {
      setStatus(
        `${t("files.browser.restartFailed")}：${error?.failure ?? error?.message ?? error}`,
      );
    }
  }

  function startAnnotate() {
    if (!paneVisible(tab.id)) return;
    annotateBtn?.classList.add("active");
    setStatus(t("files.browser.pickHint"));
    selector.start({
      onFinish: async (outcome) => {
        annotateBtn?.classList.remove("active");
        setStatus("");
        if (outcome.type !== "selected") {
          // The reason distinguishes "install rejected" (unavailable) from
          // "no pick arrived" (timeout); without it a failed annotate is
          // indistinguishable in the UI from a silent no-op.
          if (outcome.type === "failed") {
            setStatus(`${t("files.browser.selectorUnavailable")}：${outcome.reason}`);
          }
          return;
        }
        const selection = outcome.selection;
        // The pane is an OS-level child webview that always paints above host
        // DOM, so the composer takes space by shortening the pane rather than
        // covering it — the annotated page stays visible while typing.
        let cardObserver = null;
        const releaseComposerSpace = () => {
          cardObserver?.disconnect();
          cardObserver = null;
          void setPaneBottomInset(tab.id, 0).catch(() => {});
        };
        let comment = null;
        try {
          comment = await openAnnotationDialog({
            docPath: selection.docPath,
            url: selection.url,
            container: contentEl,
            onMount: (card) => {
              // Reserve from the card's top edge to the container's bottom:
              // the card's own bottom margin is part of the strip, and the
              // card anchors to that edge, so the measurement is stable.
              const apply = () =>
                void setPaneBottomInset(
                  tab.id,
                  contentEl.getBoundingClientRect().bottom - card.getBoundingClientRect().top,
                ).catch(() => {});
              apply();
              // The textarea is user-resizable; keep the pane in step.
              cardObserver = new ResizeObserver(apply);
              cardObserver.observe(card);
            },
          });
        } finally {
          releaseComposerSpace();
        }
        if (comment === null) return;
        const block =
          selection.docPath && isOfficeTab(tab)
            ? formatOfficeElementAttachment(selection, comment, tab.fileName)
            : formatBrowserElementAttachment(selection, comment);
        appendAttachmentToComposer(block);
        if (selection.docPath && isOfficeTab(tab)) {
          // Server-side badge: survives refreshes, agent can `goto` it.
          transport
            .officecliWatchMark({ file: tab.filePath, path: selection.docPath })
            .catch(() => {});
        }
      },
    });
  }

  function buildToolbar() {
    const bar = document.createElement("div");
    bar.className = "browser-pane-toolbar";

    urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.className = "browser-pane-url";
    urlInput.value = tab.url;
    urlInput.placeholder = "https://…";
    urlInput.setAttribute("aria-label", "Browser address");
    urlInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        const value = urlInput.value.trim();
        if (value) void navigate(value);
      }
    });
    urlInput.addEventListener("change", () => {
      const value = urlInput.value.trim();
      if (value && /^https?:\/\//i.test(value)) void navigate(value);
    });

    annotateBtn = document.createElement("button");
    annotateBtn.type = "button";
    annotateBtn.className = "browser-pane-action";
    annotateBtn.title = t("files.browser.annotateTooltip");
    annotateBtn.textContent = t("files.browser.annotate");
    annotateBtn.addEventListener("click", startAnnotate);

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "browser-pane-action";
    refreshBtn.title = t("files.browser.refreshTooltip");
    refreshBtn.textContent = t("files.browser.refresh");
    refreshBtn.addEventListener("click", () => void navigate(tab.url));

    const actions = document.createElement("div");
    actions.className = "browser-pane-actions";
    actions.append(annotateBtn, refreshBtn);
    if (isOfficeTab(tab)) {
      const restartBtn = document.createElement("button");
      restartBtn.type = "button";
      restartBtn.className = "browser-pane-action";
      restartBtn.title = t("files.browser.restartTooltip");
      restartBtn.textContent = t("files.browser.restartWatch");
      restartBtn.addEventListener("click", () => void restartWatch());
      actions.appendChild(restartBtn);
    }

    statusEl = document.createElement("span");
    statusEl.className = "browser-pane-status";
    statusEl.textContent = "";

    bar.append(urlInput, actions, statusEl);
    return bar;
  }

  return {
    mount(container) {
      attached = true;
      root = document.createElement("div");
      root.className = "browser-tab-root";
      contentEl = document.createElement("div");
      contentEl.className = "browser-pane-content";
      root.append(buildToolbar(), contentEl);
      container.appendChild(root);
      void openPane({ paneId: tab.id, url: tab.url, container: contentEl, transport })
        .then(() => {
          if (attached && !destroyed) showPane(tab.id, true);
        })
        .catch((error) => {
          setStatus(
            `${t("files.browser.cannotOpen")}：${error?.failure ?? error?.message ?? error}`,
          );
        });
    },
    detach() {
      // Tab switch: keep the native webview alive, just hide it.
      attached = false;
      void setPaneBottomInset(tab.id, 0).catch(() => {});
      showPane(tab.id, false);
      selector.cancel();
      root?.remove();
      root = null;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      attached = false;
      void setPaneBottomInset(tab.id, 0).catch(() => {});
      selector.cancel();
      closePane(tab.id);
      root?.remove();
      root = null;
    },
  };
}
