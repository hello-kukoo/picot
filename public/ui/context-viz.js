import { t } from "../i18n.js";
import { createIcon } from "../icons.js";

export function setupContextViz({
  tokenUsageEl,
  contextViz,
  contextBar,
  contextLegend,
  contextVizUsed,
  contextVizTotal,
  getUsage,
  getContextWindowSize,
  requestCompact = () => false,
  getCompactState = () => "idle",
}) {
  function formatTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  }

  function updateContextViz() {
    const lastUsage = getUsage();
    const contextWindowSize = getContextWindowSize();
    if (!lastUsage || !contextWindowSize) {
      contextBar.replaceChildren();
      contextLegend.replaceChildren();
      contextVizUsed.textContent = "";
      contextVizTotal.textContent = "";
      return;
    }

    const input = lastUsage.input || 0;
    const cacheRead = lastUsage.cacheRead || 0;
    const total = contextWindowSize;
    const freshInput = input;
    const totalUsed = freshInput + cacheRead;
    const free = Math.max(0, total - totalUsed);

    const segments = [
      { key: "cache", label: t("context.cached"), tokens: cacheRead, color: "cache" },
      { key: "messages", label: t("context.input"), tokens: freshInput, color: "messages" },
      { key: "free", label: t("context.available"), tokens: free, color: "free" },
    ];

    contextBar.replaceChildren();
    for (const seg of segments) {
      if (seg.tokens <= 0) continue;
      const pct = (seg.tokens / total) * 100;
      const el = document.createElement("div");
      el.className = `context-bar-segment ${seg.color}`;
      el.style.width = `${pct}%`;
      el.title = t("context.tooltip", { label: seg.label, tokens: formatTokens(seg.tokens) });
      contextBar.appendChild(el);
    }

    contextLegend.replaceChildren();
    for (const seg of segments) {
      const item = document.createElement("div");
      item.className = "context-legend-item";
      const left = document.createElement("span");
      left.className = "context-legend-left";
      const dot = document.createElement("span");
      dot.className = `context-legend-dot ${seg.color}`;
      left.append(dot, document.createTextNode(seg.label));
      const value = document.createElement("span");
      value.className = "context-legend-value";
      value.textContent = formatTokens(seg.tokens);
      item.append(left, value);
      contextLegend.append(item);
    }

    const pct = Math.round((totalUsed / total) * 100);
    contextVizUsed.textContent = t("context.used", { pct });
    contextVizTotal.textContent = `${formatTokens(totalUsed)} / ${formatTokens(total)}`;
  }

  // Portal the popover to <body> so it escapes the header's stacking context
  // (z-index: 10). Without this, the file preview panel covers it. We move
  // the element once at setup and re-position it with fixed coordinates on
  // every open so it tracks the button even if the header layout shifts.
  if (contextViz.parentElement && contextViz.parentElement !== document.body) {
    document.body.appendChild(contextViz);
  }

  function positionAndShow() {
    const rect = tokenUsageEl.getBoundingClientRect();
    contextViz.style.position = "fixed";
    contextViz.style.top = `${rect.bottom + 8}px`;
    // Right-align the popover's right edge with the button's right edge.
    contextViz.style.right = `${window.innerWidth - rect.right}px`;
    contextViz.style.left = "auto";
    contextViz.classList.remove("hidden");
  }

  tokenUsageEl.addEventListener("click", (e) => {
    e.stopPropagation();
    const isHidden = contextViz.classList.contains("hidden");
    if (isHidden) {
      updateContextViz();
      positionAndShow();
    } else {
      contextViz.classList.add("hidden");
    }
  });

  document.addEventListener("click", (e) => {
    if (!contextViz.contains(e.target) && e.target !== tokenUsageEl) {
      contextViz.classList.add("hidden");
    }
  });

  const compactBtn = document.getElementById("context-viz-compact");

  function sync() {
    updateContextViz();
    if (!compactBtn) return;
    const busy = getCompactState() !== "idle";
    compactBtn.disabled = busy;
    const compactIcon = createIcon("text-collapse", { size: 14 });
    const compactLabel = document.createTextNode(busy ? t("status.compacting") : t("misc.compact"));
    compactBtn.replaceChildren();
    if (compactIcon) compactBtn.append(compactIcon, compactLabel);
    else compactBtn.appendChild(compactLabel);
    compactBtn.setAttribute("aria-busy", String(busy));
  }

  if (compactBtn) {
    compactBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (getCompactState() === "idle") requestCompact();
      sync();
    });
  }

  _updateFn = sync;
  return {
    sync,
    invalidateUsage() {
      contextViz.classList.add("hidden");
      updateContextViz();
    },
  };
}

let _updateFn = null;

export function repaintContextViz() {
  _updateFn?.();
}
