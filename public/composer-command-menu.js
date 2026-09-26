// ABOUTME: Renders and manages a composer-scoped Commands menu for chat surfaces.
// ABOUTME: Anchors the menu to its button (non-modal popover, opening to the
// ABOUTME: button's right), with outside-click cleanup and above/below flip.

const ANCHOR_GAP_PX = 8;

export function setupComposerCommandMenu({
  button,
  menu,
  list,
  getCommands,
  document: doc,
  createIcon = null,
}) {
  const close = () => {
    menu.classList.add("hidden");
  };

  /**
   * Non-modal popover anchored to the button: the menu's LEFT edge aligns with
   * the button's left edge (so it opens to the right of the trigger), clamped
   * into the viewport. Vertically it opens upward while there is room (the
   * composer sits at the viewport bottom) and flips below when there is not.
   */
  const position = () => {
    const view = doc.defaultView;
    if (!view) return;
    const rect = button.getBoundingClientRect();
    const width = menu.offsetWidth;
    const maxLeft = Math.max(ANCHOR_GAP_PX, view.innerWidth - width - ANCHOR_GAP_PX);
    const left = Math.min(Math.max(ANCHOR_GAP_PX, rect.left), maxLeft);
    menu.style.position = "fixed";
    menu.style.right = "auto";
    menu.style.left = `${left}px`;
    const height = menu.offsetHeight;
    if (rect.top - ANCHOR_GAP_PX - height >= ANCHOR_GAP_PX) {
      menu.style.top = "auto";
      menu.style.bottom = `${view.innerHeight - rect.top + ANCHOR_GAP_PX}px`;
    } else {
      menu.style.bottom = "auto";
      menu.style.top = `${rect.bottom + ANCHOR_GAP_PX}px`;
    }
  };
  const open = () => {
    list.replaceChildren();
    for (const command of getCommands()) {
      const item = doc.createElement(command.desc ? "div" : "button");
      item.className = "command-item";
      item.classList.toggle("disabled", Boolean(command.disabled));
      if (command.disabled) item.setAttribute("aria-disabled", "true");
      if (item instanceof HTMLButtonElement) {
        item.type = "button";
        item.textContent = command.label;
        item.disabled = Boolean(command.disabled);
      } else {
        const icon = doc.createElement("div");
        icon.className = "command-icon";
        // Command icons are registry names rendered as SVG; fall back to raw
        // text only when a command supplies a literal glyph string.
        const iconNode =
          typeof createIcon === "function" && command.icon
            ? createIcon(command.icon, { size: 16 })
            : null;
        if (iconNode) {
          icon.appendChild(iconNode);
        } else {
          icon.textContent = command.icon || "";
        }
        const details = doc.createElement("div");
        const label = doc.createElement("div");
        label.className = "command-label";
        label.textContent = command.label;
        const description = doc.createElement("div");
        description.className = "command-desc";
        description.textContent = command.desc;
        details.append(label, description);
        item.append(icon, details);
      }
      item.addEventListener("click", async () => {
        close();
        if (!command.disabled) await command.action();
      });
      list.appendChild(item);
    }
    menu.classList.remove("hidden");
    // Measure only after the list is populated and visible.
    position();
  };
  const onButtonClick = () => {
    if (button.disabled) return;
    if (menu.classList.contains("hidden")) open();
    else close();
  };
  const onDocumentClick = (event) => {
    if (!menu.contains(event.target) && !button.contains(event.target)) close();
  };
  button.addEventListener("click", onButtonClick);
  doc.addEventListener("click", onDocumentClick);
  return {
    close,
    position,
    destroy: () => {
      button.removeEventListener("click", onButtonClick);
      doc.removeEventListener("click", onDocumentClick);
    },
  };
}
