// ABOUTME: Header toolbar popover showing the active session's file path.
// ABOUTME: Portal-to-body fixed panel with a copy action and transient labels.

import { t } from "../i18n.js";

export function setupSessionInfo({
  toggle,
  panel,
  fileValue,
  getFilePath = () => "",
  writeText = (text) => navigator.clipboard?.writeText(text),
}) {
  if (!toggle || !panel || !fileValue) return { refresh() {} };

  // Portal to <body> so the header's horizontal scroller cannot clip the
  // panel (same approach as the Context usage popover).
  if (panel.parentElement !== document.body) document.body.appendChild(panel);

  const refresh = () => {
    fileValue.textContent = getFilePath() || t("sessionInfo.inMemory");
  };

  const close = () => {
    panel.classList.add("hidden");
    toggle.setAttribute("aria-expanded", "false");
  };

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!panel.classList.contains("hidden")) {
      close();
      return;
    }
    refresh();
    const rect = toggle.getBoundingClientRect();
    panel.style.position = "fixed";
    panel.style.top = `${rect.bottom + 8}px`;
    panel.style.left = `${rect.left}px`;
    panel.style.right = "auto";
    panel.classList.remove("hidden");
    toggle.setAttribute("aria-expanded", "true");
  });

  document.addEventListener("click", (event) => {
    if (!panel.contains(event.target) && event.target !== toggle) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  for (const button of panel.querySelectorAll("[data-copy-session-field]")) {
    button.addEventListener("click", async () => {
      const value = fileValue.textContent;
      const defaultLabel = t("sessionInfo.copyFile");
      try {
        const result = writeText?.(value);
        if (!result) throw new Error("Clipboard unavailable");
        await result;
        button.title = t("sessionInfo.copied");
        button.setAttribute("aria-label", t("sessionInfo.copied"));
      } catch {
        button.title = t("sessionInfo.copyFailed");
        button.setAttribute("aria-label", t("sessionInfo.copyFailed"));
      }
      setTimeout(() => {
        button.title = defaultLabel;
        button.setAttribute("aria-label", defaultLabel);
      }, 1500);
    });
  }

  return { refresh };
}
