import { onLocaleChange, t } from "../../i18n.js";

/**
 * Desktop-only header shortcut into Settings → Remote Access.
 * Remote clients keep the button hidden; QR still lives in the settings panel.
 */
export function setupRemoteAccessHeader({ buttonEl, onOpen, visible = false } = {}) {
  if (!buttonEl) return { setVisible() {} };

  function render() {
    buttonEl.classList.toggle("hidden", !visible);
    const label = t("settings.remoteAccess");
    buttonEl.title = label;
    buttonEl.setAttribute("aria-label", label);
  }

  buttonEl.addEventListener("click", () => {
    if (!visible) return;
    onOpen?.();
  });
  onLocaleChange(render);
  render();

  return {
    setVisible(next) {
      visible = Boolean(next);
      render();
    },
  };
}
