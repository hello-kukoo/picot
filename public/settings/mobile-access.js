// ABOUTME: Settings "Mobile Access" card: LAN bind toggle + pairing token UX.
// ABOUTME: The host mints 5-minute pairing tokens; the phone pairs itself at
// ABOUTME: /pair.html. The card reflects the RUNNING host, and surfaces the
// ABOUTME: restart hint when the preference and the runtime disagree.

const PREF_KEY = "mobile.lanAccessEnabled";

export function setupMobileAccess({
  transport,
  toggle,
  details,
  pairBtn,
  pairing,
  qrCanvas,
  tokenEl,
  restartHint,
}) {
  let countdown = null;

  function setToggleVisual(on) {
    toggle.classList.toggle("on", on);
    toggle.setAttribute("aria-pressed", String(on));
  }

  function renderQr(url) {
    const qr = globalThis.PicotQr;
    if (!url || !qr?.toCanvas) {
      qrCanvas.classList.add("hidden");
      return;
    }
    qrCanvas.classList.remove("hidden");
    qr.toCanvas(qrCanvas, url, { width: 168 }).catch(() => {
      qrCanvas.classList.add("hidden");
    });
  }

  function stopCountdown() {
    if (countdown) {
      clearInterval(countdown);
      countdown = null;
    }
  }

  function startCountdown(expiresAtMs) {
    stopCountdown();
    const update = () => {
      const remaining = Math.max(0, expiresAtMs - Date.now());
      tokenEl.dataset.expiresInSecs = String(Math.ceil(remaining / 1000));
      if (remaining <= 0) {
        stopCountdown();
        pairing.classList.add("hidden");
        void refresh();
      }
    };
    update();
    countdown = setInterval(update, 1000);
  }

  async function pairDevice() {
    const lanUrl = details.dataset.lanUrl || "";
    let result = null;
    let error = null;
    try {
      result = await transport.mobilePairingCreate();
    } catch (err) {
      error = err;
    }
    const token = result?.pairingToken || "";
    if (!token) {
      tokenEl.textContent = error?.message || "Pairing failed";
      pairing.classList.remove("hidden");
      return;
    }
    tokenEl.textContent = token;
    pairing.classList.remove("hidden");
    renderQr(lanUrl ? `${lanUrl}/pair.html#p=${encodeURIComponent(token)}` : "");
    startCountdown((Number(result.expiresAt) || 0) * 1000);
  }

  async function refresh() {
    // The card shows the RUNNING host (`info.enabled`), and the restart hint
    // fires when the saved preference disagrees with it — a flip only takes
    // effect on the next host start.
    const [info, prefValue] = await Promise.all([
      transport.mobileAccessInfo().catch(() => null),
      transport
        .getPreference(PREF_KEY)
        .then((r) => r?.value == null || r.value === true)
        .catch(() => true),
    ]);
    const enabled = Boolean(info?.enabled);
    setToggleVisual(prefValue);
    details.classList.toggle("hidden", !enabled);
    restartHint.classList.toggle("hidden", !(prefValue && !enabled));
    if (enabled) {
      details.dataset.lanUrl = Array.isArray(info.lanUrls) ? info.lanUrls[0] || "" : "";
    } else {
      stopCountdown();
      pairing.classList.add("hidden");
    }
  }

  toggle.addEventListener("click", async () => {
    const next = !toggle.classList.contains("on");
    try {
      await transport.setPreference(PREF_KEY, next);
    } finally {
      await refresh();
    }
  });

  pairBtn.addEventListener("click", () => {
    void pairDevice();
  });

  return {
    refresh,
    destroy: stopCountdown,
  };
}
