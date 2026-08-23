// ABOUTME: Header pill that surfaces available extension package updates.
// ABOUTME: Consumes counts pushed by the package manager's update probe; opens Settings → Extensions on click.

import { onLocaleChange, t } from "../../i18n.js";

export function setupUpdateIndicator({ buttonEl, onOpen } = {}) {
  if (!buttonEl) return { setCount: () => {} };

  let count = 0;

  function render() {
    buttonEl.classList.toggle("hidden", count <= 0);
    const tip = t("header.extensionUpdatesAvailable");
    buttonEl.title = tip;
    buttonEl.setAttribute("aria-label", `${tip} (${count})`);
    const badge = buttonEl.querySelector(".update-indicator-count");
    if (badge) badge.textContent = String(count);
  }

  buttonEl.addEventListener("click", () => onOpen?.());
  onLocaleChange(render);
  render();

  return {
    // Push-only by design: the installed-packages page owns the actual update
    // probe, and this pill only mirrors its result (mirrors picot-v3 behavior).
    setCount(next) {
      if (typeof next !== "number" || !Number.isFinite(next)) return;
      count = Math.max(0, Math.floor(next));
      render();
    },
  };
}
