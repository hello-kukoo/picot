// ABOUTME: Coordinates the Installed and Community Settings > Extensions tabs.
// ABOUTME: Provides accessible roving-tabindex navigation and one-time lazy activation.

const TAB_KEYS = new Set(["ArrowLeft", "ArrowRight", "Home", "End"]);

export function setupExtensionsTabShell({ tabs, panels, activate }) {
  const tabList = [...tabs];
  if (tabList.length === 0) {
    return { select: () => {}, destroy: () => {} };
  }
  const panelMap = panels instanceof Map ? panels : new Map(Object.entries(panels));
  const activated = new Set();
  let selected = tabList.find((tab) => tab.getAttribute("aria-selected") === "true") ?? tabList[0];

  const nameFor = (tab) => tab.dataset.extensionsTab;

  function select(tab, { focus = false } = {}) {
    if (!tabList.includes(tab)) return;
    selected = tab;
    const selectedName = nameFor(tab);
    for (const candidate of tabList) {
      const active = candidate === tab;
      candidate.setAttribute("role", "tab");
      candidate.setAttribute("aria-selected", String(active));
      candidate.tabIndex = active ? 0 : -1;
      const panel = panelMap.get(nameFor(candidate));
      if (panel?.id) candidate.setAttribute("aria-controls", panel.id);
    }
    for (const [name, panel] of panelMap) {
      if (!panel) continue;
      panel.setAttribute("role", "tabpanel");
      panel.classList.toggle("hidden", name !== selectedName);
      panel.hidden = name !== selectedName;
    }
    if (!activated.has(selectedName)) {
      activated.add(selectedName);
      void activate?.(selectedName);
    }
    if (focus) tab.focus();
  }

  function onClick(event) {
    select(event.currentTarget);
  }

  function onKeyDown(event) {
    if (!TAB_KEYS.has(event.key)) return;
    event.preventDefault();
    const current = tabList.indexOf(event.currentTarget);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabList.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabList.length) % tabList.length;
    select(tabList[next], { focus: true });
  }

  for (const tab of tabList) {
    tab.addEventListener("click", onClick);
    tab.addEventListener("keydown", onKeyDown);
  }
  select(selected);

  return {
    select,
    destroy() {
      for (const tab of tabList) {
        tab.removeEventListener("click", onClick);
        tab.removeEventListener("keydown", onKeyDown);
      }
    },
  };
}
