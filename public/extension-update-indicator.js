// ABOUTME: Sidebar pill that surfaces available extension package updates.
// ABOUTME: Runs its own throttled update check and opens Settings > Extensions on click.

import { onLocaleChange, t } from "./i18n.js";

const RECHECK_INTERVAL_MS = 5 * 60 * 1000;

export function setupExtensionUpdateIndicator({
  transport,
  nativeAvailable = () => false,
  t: translate = t,
  buttonEl,
  onOpen,
} = {}) {
  if (!buttonEl) return { refresh: async () => {}, setCount: () => {} };

  let count = 0;
  let inFlight = null;
  let lastCheckedAt = 0;

  function render() {
    buttonEl.classList.toggle("hidden", count <= 0);
    const tip = translate("sidebar.extensionUpdatesAvailable");
    buttonEl.title = tip;
    buttonEl.setAttribute("aria-label", `${tip} (${count})`);
  }

  async function runCheck() {
    try {
      // check_pi_package_updates runs its own `pi list --approve` server-side,
      // so a prior client-side list would spawn a redundant subprocess.
      const updates = await transport.checkPiPackageUpdates();
      count = (Array.isArray(updates) ? updates : []).filter(
        (update) => update.available === true,
      ).length;
    } catch {
      // Keep the last known count; the Installed page check re-notifies.
    }
    render();
  }

  function refresh({ force = false } = {}) {
    if (typeof nativeAvailable === "function" && !nativeAvailable()) return Promise.resolve();
    if (!force && Date.now() - lastCheckedAt < RECHECK_INTERVAL_MS) return Promise.resolve();
    lastCheckedAt = Date.now();
    if (inFlight) return inFlight;
    inFlight = runCheck().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  function setCount(next) {
    if (typeof next !== "number" || !Number.isFinite(next)) return;
    count = next;
    render();
  }

  buttonEl.addEventListener("click", () => onOpen?.());
  onLocaleChange(render);
  render();

  return { refresh, setCount };
}
