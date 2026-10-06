// ABOUTME: Settings → General embedded-Pi PATH toggle UI: renders host state and
// ABOUTME: forwards clicks. The host op owns the rc marker block (POSIX) and the
// ABOUTME: user Path registry value (Windows), so this module never writes files.

import { t } from "../../i18n.js";

/**
 * @param {{
 *   control: { piPathStatus: () => Promise<any>, piPathConfigure: (enabled: boolean) => Promise<any> },
 *   toggle: HTMLButtonElement,
 *   note: HTMLElement,
 * }} options
 */
export function setupPiPathToggle({ control, toggle, note }) {
  function render(status) {
    const on = status?.enabled === true;
    toggle.classList.toggle("on", on);
    toggle.setAttribute("aria-pressed", String(on));
    // Development builds and unsupported shells explain themselves instead of
    // offering a toggle that would either write target/debug into the user's rc
    // or fail on click.
    if (status?.dev) {
      toggle.disabled = true;
      note.textContent = t("settings.piPath.devOnly");
    } else if (status && !status.shellSupported) {
      toggle.disabled = true;
      note.textContent = t("settings.piPath.unsupportedShell", { shell: status.shell || "" });
    } else {
      toggle.disabled = false;
      note.textContent = t("settings.piPath.description");
    }
  }

  async function refresh() {
    try {
      render(await control.piPathStatus());
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
      await control.piPathConfigure(next);
      await refresh();
    } catch (error) {
      // Surface the host's refusal (rc conflict) inline and keep the state
      // readable rather than leaving the toggle stuck mid-flight.
      note.textContent = error?.message || String(error);
      toggle.disabled = false;
    }
  });

  void refresh();
  return { refresh };
}
