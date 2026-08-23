/**
 * Exclusive side-panel toggle — opening one panel collapses the others.
 * Kept in a leaf module so WebView ESM linking does not depend on
 * NativeFileBrowser's export list.
 */
export function toggleExclusiveSidePanel(panel, otherPanels = []) {
  const willOpen = panel.classList.contains("collapsed");
  if (willOpen) {
    for (const other of otherPanels) other?.classList.add("collapsed");
  }
  panel.classList.toggle("collapsed", !willOpen);
  return willOpen;
}

/**
 * Toggle a named view inside a shared exclusive side panel.
 * Header Files and Git each own one view: clicking the active view closes
 * the panel; clicking the other view switches without a tab bar.
 */
export function toggleExclusiveSideView(panel, { otherPanels = [], currentView, nextView } = {}) {
  if (!panel) return { open: false, view: currentView ?? nextView };
  const isOpen = !panel.classList.contains("collapsed");
  if (isOpen && currentView === nextView) {
    panel.classList.add("collapsed");
    return { open: false, view: currentView };
  }
  for (const other of otherPanels) other?.classList.add("collapsed");
  panel.classList.remove("collapsed");
  return { open: true, view: nextView };
}
