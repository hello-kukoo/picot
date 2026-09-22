// ABOUTME: Settings → General embedded-Pi PATH toggle: system-wide marker
// ABOUTME: block (POSIX rc) / user Path registry value (Windows), applied by
// ABOUTME: the host op; this module only renders state and forwards clicks.

import { t } from "../i18n.js";

/**
 * @param {{
 *   transport: {piPathStatus: () => Promise<any>, piPathConfigure: (enabled: boolean) => Promise<any>},
 *   toggle: HTMLButtonElement,
 *   note: HTMLElement,
 * }} options
 */
export function setupPiPathToggle({ transport, toggle, note }) {
  function render(status) {
    const on = status?.enabled === true;
    toggle.classList.toggle("on", on);
    toggle.setAttribute("aria-pressed", String(on));
    // Q5/Q10: dev builds and unsupported shells show an explanatory note
    // instead of a clickable toggle.
    if (status?.dev) {
      toggle.disabled = true;
      note.textContent = t("settings.piPath.devOnly");
    } else if (status && !status.shellSupported) {
      toggle.disabled = true;
      note.textContent = t("settings.piPath.unsupportedShell", {
        shell: status.shell || "",
      });
    } else {
      toggle.disabled = false;
      note.textContent = t("settings.piPath.description");
    }
  }

  async function refresh() {
    try {
      render(await transport.piPathStatus());
    } catch (error) {
      toggle.disabled = true;
      note.textContent = error?.message || String(error);
    }
  }

  toggle.addEventListener("click", async () => {
    if (toggle.disabled) return;
    const next = !toggle.classList.contains("on");
    toggle.disabled = true;
    try {
      await transport.piPathConfigure(next);
      await refresh();
    } catch (error) {
      // Surface the host's refusal (conflict, unsupported shell) inline and
      // re-enable so the state stays readable.
      note.textContent = error?.message || String(error);
      toggle.disabled = false;
    }
  });

  void refresh();
  return { refresh };
}
