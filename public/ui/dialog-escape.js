// ABOUTME: Shared Escape-to-dismiss for modal dialogs, including nested overlays.

const stack = [];

function topActive() {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    if (entry.isActive()) return entry;
  }
  return null;
}

/**
 * Register Escape to dismiss the current dialog. Nested calls close the
 * topmost active dialog first. Returns an unsubscribe function; call it when
 * the dialog is dismissed by another path so the listener does not leak.
 *
 * @param {() => void} onClose
 * @param {{ isActive?: () => boolean }} [options]
 * @returns {() => void}
 */
export function bindDialogEscape(onClose, { isActive } = {}) {
  const entry = {
    onClose,
    isActive: typeof isActive === "function" ? isActive : () => true,
  };
  stack.push(entry);

  const onKeyDown = (event) => {
    if (event.key !== "Escape") return;
    if (event.defaultPrevented) return;
    if (topActive() !== entry) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    onClose();
  };
  document.addEventListener("keydown", onKeyDown, true);

  let unbound = false;
  return () => {
    if (unbound) return;
    unbound = true;
    document.removeEventListener("keydown", onKeyDown, true);
    const index = stack.lastIndexOf(entry);
    if (index >= 0) stack.splice(index, 1);
  };
}

export function dialogOwnsEscape() {
  return topActive() !== null;
}
