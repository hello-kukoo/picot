// ABOUTME: Toolbar mobile-connect button + QR modal over the native pairing
// ABOUTME: controls: token minted on open, QR rendered client-side from
// ABOUTME: `${lanUrl}/pair.html#p=<token>` — no server-side dataUrl route.

import { t } from "./i18n.js";

/**
 * Wire the header QR button and modal. The button only appears when the
 * running host actually listens beyond loopback (mobileAccessInfo), and every
 * open mints a fresh 5-minute pairing token exactly like the Settings card.
 */
export function setupLanQr({ transport, setButtonIcon, replaceButtonGlyph, openExternalLink }) {
  const button = document.getElementById("lan-qr-btn");
  const modal = document.getElementById("lan-qr-modal");
  if (!button || !modal) return () => {};
  const backdrop = document.getElementById("lan-qr-modal-backdrop");
  const closeBtn = document.getElementById("lan-qr-modal-close");
  const loading = document.getElementById("lan-qr-loading");
  const canvas = document.getElementById("lan-qr-canvas");
  const openLink = document.getElementById("lan-qr-open-link");

  setButtonIcon?.(button, "smartphone", { size: 16 });
  if (closeBtn) setButtonIcon?.(closeBtn, "x", { size: 14 });
  replaceButtonGlyph?.(openLink, "external-link", { size: 14 });

  let pairUrl = "";

  function closeModal() {
    modal.classList.add("hidden");
  }

  async function openModal() {
    modal.classList.remove("hidden");
    if (loading) {
      loading.style.display = "";
      loading.textContent = t("lanQr.generating");
    }
    if (canvas) canvas.classList.add("hidden");
    if (openLink) openLink.classList.add("hidden");
    pairUrl = "";
    try {
      const [info, pairing] = await Promise.all([
        transport.mobileAccessInfo(),
        transport.mobilePairingCreate(),
      ]);
      const lanUrl = Array.isArray(info?.lanUrls) ? info.lanUrls[0] || "" : "";
      const token = pairing?.pairingToken || "";
      if (!lanUrl || !token) throw new Error("mobile pairing unavailable");
      pairUrl = `${lanUrl}/pair.html#p=${encodeURIComponent(token)}`;
      const qr = globalThis.PicotQr;
      if (!qr?.toCanvas || !canvas) throw new Error("QR renderer unavailable");
      canvas.classList.remove("hidden");
      await qr.toCanvas(canvas, pairUrl, { width: 200 });
      if (loading) loading.style.display = "none";
      if (openLink) openLink.classList.remove("hidden");
    } catch {
      if (loading) {
        loading.textContent = t("misc.qrUnavailable");
        loading.style.display = "";
      }
      if (canvas) canvas.classList.add("hidden");
      if (openLink) openLink.classList.add("hidden");
    }
  }

  button.addEventListener("click", () => void openModal());
  backdrop?.addEventListener("click", closeModal);
  closeBtn?.addEventListener("click", closeModal);
  openLink?.addEventListener("click", () => {
    if (pairUrl) openExternalLink(pairUrl);
  });
  const onKeydown = (event) => {
    if (event.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
  };
  document.addEventListener("keydown", onKeydown);

  // Visibility follows the RUNNING host: LAN-bound and reachable → show.
  async function refreshVisibility() {
    try {
      const info = await transport.mobileAccessInfo();
      const reachable =
        Boolean(info?.enabled) && Array.isArray(info?.lanUrls) && info.lanUrls.length > 0;
      button.classList.toggle("hidden", !reachable);
    } catch {
      button.classList.add("hidden");
    }
  }
  void refreshVisibility();

  return { refreshVisibility, close: closeModal };
}
