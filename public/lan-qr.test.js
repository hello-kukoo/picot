// ABOUTME: Verifies the toolbar mobile-connect QR: visibility follows the
// ABOUTME: running host's LAN bind, and opening mints a pairing token the
// ABOUTME: client-side QR renderer receives.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("./i18n.js", () => ({
  t: (key) => key,
  onLocaleChange: () => () => {},
}));

import { JSDOM } from "jsdom";

let dom;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><div id=root></div>", { url: "http://localhost:3001" });
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.CSS = dom.window.CSS;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete globalThis.PicotQr;
});

function mountDom({ hidden = true } = {}) {
  const button = document.createElement("button");
  button.id = "lan-qr-btn";
  if (hidden) button.classList.add("hidden");
  const modal = document.createElement("div");
  modal.id = "lan-qr-modal";
  modal.className = "lan-qr-modal hidden";
  for (const id of [
    "lan-qr-modal-backdrop",
    "lan-qr-modal-close",
    "lan-qr-loading",
    "lan-qr-canvas",
    "lan-qr-open-link",
  ]) {
    const element = document.createElement("div");
    element.id = id;
    modal.appendChild(element);
  }
  document.body.append(button, modal);
  return { button, modal };
}

describe("lan-qr toolbar", () => {
  test("stays hidden when the host is loopback-only", async () => {
    const { button } = mountDom();
    const { setupLanQr } = await import("./lan-qr.js");
    setupLanQr({
      transport: {
        mobileAccessInfo: vi.fn(async () => ({ enabled: false, lanUrls: [] })),
        mobilePairingCreate: vi.fn(),
      },
      setButtonIcon: vi.fn(),
      replaceButtonGlyph: vi.fn(),
      openExternalLink: vi.fn(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(button.classList.contains("hidden")).toBe(true);
  });

  test("shows when LAN-bound and renders the pairing QR on open", async () => {
    const { button, modal } = mountDom();
    const toCanvas = vi.fn(async () => {});
    globalThis.PicotQr = { toCanvas };
    const openExternal = vi.fn();
    const { setupLanQr } = await import("./lan-qr.js");
    setupLanQr({
      transport: {
        mobileAccessInfo: vi.fn(async () => ({
          enabled: true,
          lanUrls: ["http://192.168.1.20:4317"],
        })),
        mobilePairingCreate: vi.fn(async () => ({
          pairingToken: "tok-123",
          expiresAt: 1788317400,
        })),
      },
      setButtonIcon: vi.fn(),
      replaceButtonGlyph: vi.fn(),
      openExternalLink: openExternal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(button.classList.contains("hidden")).toBe(false);

    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(modal.classList.contains("hidden")).toBe(false);
    expect(toCanvas).toHaveBeenCalledWith(
      expect.anything(),
      "http://192.168.1.20:4317/pair.html#p=tok-123",
      { width: 200 },
    );

    const openLink = document.getElementById("lan-qr-open-link");
    openLink.click();
    expect(openExternal).toHaveBeenCalledWith("http://192.168.1.20:4317/pair.html#p=tok-123");
  });

  test("surfaces the unavailable state when pairing fails", async () => {
    const { button, modal } = mountDom();
    const { setupLanQr } = await import("./lan-qr.js");
    setupLanQr({
      transport: {
        mobileAccessInfo: vi.fn(async () => ({
          enabled: true,
          lanUrls: ["http://192.168.1.20:4317"],
        })),
        mobilePairingCreate: vi.fn(async () => {
          throw new Error("refused");
        }),
      },
      setButtonIcon: vi.fn(),
      replaceButtonGlyph: vi.fn(),
      openExternalLink: vi.fn(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(modal.classList.contains("hidden")).toBe(false);
    expect(document.getElementById("lan-qr-loading").textContent).toBe("misc.qrUnavailable");
  });
});
