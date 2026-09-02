// ABOUTME: Verifies the Mobile Access settings card: LAN toggle, restart hint,
// ABOUTME: and the pairing token/QR flow against a fake host transport.

import { afterEach, describe, expect, test, vi } from "vitest";
import { setupMobileAccess } from "./mobile-access.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.PicotQr;
});

function mountDom() {
  document.body.innerHTML = `
    <button class="settings-toggle" id="toggle"></button>
    <div class="mobile-access-details hidden" id="details"></div>
    <button id="pair-btn"></button>
    <div class="mobile-access-pairing hidden" id="pairing">
      <canvas id="qr"></canvas>
      <span id="token"></span>
    </div>
    <div class="mobile-restart-hint hidden" id="restart-hint"></div>
  `;
  return {
    toggle: document.getElementById("toggle"),
    details: document.getElementById("details"),
    pairBtn: document.getElementById("pair-btn"),
    pairing: document.getElementById("pairing"),
    qrCanvas: document.getElementById("qr"),
    tokenEl: document.getElementById("token"),
    restartHint: document.getElementById("restart-hint"),
  };
}

function fakeTransport({ enabled = false, prefOn = false } = {}) {
  // Stateful preference: a click must be observable through refresh().
  let pref = prefOn;
  return {
    mobileAccessInfo: vi.fn(async () => ({
      enabled,
      port: 41230,
      lanUrls: enabled ? ["http://192.168.1.10:41230"] : [],
    })),
    mobilePairingCreate: vi.fn(async () => ({
      pairingToken: "picot_pair_abc123",
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })),
    getPreference: vi.fn(async () => ({ value: pref })),
    setPreference: vi.fn(async (_key, value) => {
      pref = value;
    }),
  };
}

function mount(transport) {
  const elements = mountDom();
  const card = setupMobileAccess({ transport, ...elements });
  return { card, el: elements };
}

describe("Mobile Access card", () => {
  test("disabled runtime hides pairing controls and the restart hint", async () => {
    const { card, el } = mount(fakeTransport());
    await card.refresh();

    expect(el.toggle.classList.contains("on")).toBe(false);
    expect(el.details.classList.contains("hidden")).toBe(true);
    expect(el.restartHint.classList.contains("hidden")).toBe(true);
  });

  test("enabled pref without a restart shows the hint and hides pairing", async () => {
    const { card, el } = mount(fakeTransport({ prefOn: true, enabled: false }));
    await card.refresh();

    expect(el.toggle.classList.contains("on")).toBe(true);
    expect(el.details.classList.contains("hidden")).toBe(true);
    expect(el.restartHint.classList.contains("hidden")).toBe(false);
  });

  test("enabled runtime reveals the pairing controls and keeps the LAN url", async () => {
    const { card, el } = mount(fakeTransport({ prefOn: true, enabled: true }));
    await card.refresh();

    expect(el.toggle.classList.contains("on")).toBe(true);
    expect(el.details.classList.contains("hidden")).toBe(false);
    expect(el.restartHint.classList.contains("hidden")).toBe(true);
    expect(el.details.dataset.lanUrl).toBe("http://192.168.1.10:41230");
  });

  test("toggle flips the stored preference and re-reads runtime state", async () => {
    const transport = fakeTransport({ prefOn: false, enabled: false });
    const { card, el } = mount(transport);
    await card.refresh();

    el.toggle.click();
    await vi.waitFor(() => {
      expect(transport.setPreference).toHaveBeenCalledWith("mobile.lanAccessEnabled", true);
    });
    await card.refresh();

    expect(el.toggle.classList.contains("on")).toBe(true);
    expect(el.restartHint.classList.contains("hidden")).toBe(false);
  });

  test("pairing renders the token and a QR of the pair url", async () => {
    const toCanvas = vi.fn(async () => {});
    globalThis.PicotQr = { toCanvas };
    const transport = fakeTransport({ prefOn: true, enabled: true });
    const { card } = mount(transport);
    await card.refresh();

    const pairBtn = document.getElementById("pair-btn");
    pairBtn.click();
    await vi.waitFor(() => {
      expect(document.getElementById("pairing").classList.contains("hidden")).toBe(false);
    });

    expect(document.getElementById("token").textContent).toBe("picot_pair_abc123");
    expect(toCanvas).toHaveBeenCalledWith(
      document.getElementById("qr"),
      "http://192.168.1.10:41230/pair.html#p=picot_pair_abc123",
      expect.objectContaining({ width: 168 }),
    );
  });

  test("a refused mint surfaces the host error instead of a token", async () => {
    const transport = fakeTransport({ prefOn: true, enabled: true });
    transport.mobilePairingCreate.mockRejectedValueOnce(
      Object.assign(new Error("Enable mobile/LAN access before pairing a device"), {
        code: "mobile_access_disabled",
      }),
    );
    const { card } = mount(transport);
    await card.refresh();

    document.getElementById("pair-btn").click();
    await vi.waitFor(() => {
      expect(document.getElementById("pairing").classList.contains("hidden")).toBe(false);
    });

    expect(document.getElementById("token").textContent).toContain("Enable mobile/LAN access");
  });
});
