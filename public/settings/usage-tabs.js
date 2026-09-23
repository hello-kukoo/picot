// ABOUTME: Sub-tab switching for the Settings Usage page (cost / provider quota).
// ABOUTME: Delegates on document so it survives the Settings markup being rebuilt.

/**
 * Usage page sub-tabs.
 *
 * The click is delegated on `document` and the nodes are resolved per click.
 * Capturing the buttons at setup time binds handlers to the nodes that exist
 * then; the Settings markup is rebuilt/re-parented when the overlay opens, so
 * the live buttons then carry no handler and the click does nothing at all.
 */
export function setupUsageTabs({ onSelect } = {}) {
  const handler = (event) => {
    const tab = event.target?.closest?.("[data-usage-tab]");
    if (!tab) return;
    const view = tab.dataset.usageTab;
    for (const candidate of document.querySelectorAll("[data-usage-tab]")) {
      candidate.setAttribute("aria-selected", String(candidate.dataset.usageTab === view));
    }
    for (const panel of document.querySelectorAll("[data-usage-panel]")) {
      panel.classList.toggle("hidden", panel.dataset.usagePanel !== view);
    }
    onSelect?.(view);
  };
  document.addEventListener("click", handler);
  return () => document.removeEventListener("click", handler);
}
