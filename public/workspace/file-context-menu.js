// ABOUTME: Transient right-click menu for the Files panel tree. Presentation
// ABOUTME: only — callers supply localized labels and the action for each item.

let openMenu = null;
let closeOpenMenu = null;

/** Close whatever menu is showing, if any. Safe to call at any time. */
export function closeContextMenu() {
  closeOpenMenu?.();
}

/**
 * Show a menu at a viewport point.
 *
 * `items` is `[{ label, onSelect, disabled }]`; a falsy entry renders a
 * separator. The returned function closes the menu, and so does Escape, a click
 * anywhere outside, a scroll, or opening another menu.
 */
export function showContextMenu({ clientX, clientY, items, label = "" }) {
  closeContextMenu();
  if (!items?.length) return () => {};

  const menu = document.createElement("div");
  menu.className = "sidebar-context-menu file-context-menu";
  menu.setAttribute("role", "menu");
  if (label) menu.setAttribute("aria-label", label);

  for (const item of items) {
    if (!item) {
      const separator = document.createElement("div");
      separator.className = "context-menu-separator";
      separator.setAttribute("role", "separator");
      menu.append(separator);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "context-menu-item";
    button.setAttribute("role", "menuitem");
    button.textContent = item.label;
    button.disabled = Boolean(item.disabled);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      close();
      item.onSelect?.();
    });
    menu.append(button);
  }

  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  // Keep the menu on screen: a right-click near an edge would otherwise open it
  // partly outside the window, where the clipped items cannot be clicked.
  menu.style.left = `${Math.max(8, Math.min(clientX, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(clientY, window.innerHeight - rect.height - 8))}px`;

  const onDocumentMouseDown = (event) => {
    if (!menu.contains(event.target)) close();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") close();
  };

  function close() {
    if (openMenu !== menu) return;
    openMenu = null;
    closeOpenMenu = null;
    document.removeEventListener("mousedown", onDocumentMouseDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", close, true);
    menu.remove();
  }

  openMenu = menu;
  closeOpenMenu = close;
  document.addEventListener("mousedown", onDocumentMouseDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", close, true);
  return close;
}
