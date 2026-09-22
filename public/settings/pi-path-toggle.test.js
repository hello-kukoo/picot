// ABOUTME: Verifies the embedded-Pi PATH toggle: status rendering (normal,
// dev, unsupported shell), click-to-configure flow, and inline error surfacing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMessages } from "../i18n.js";
import { setupPiPathToggle } from "./pi-path-toggle.js";

setMessages({
  settings: {
    piPath: {
      enable: "Add embedded Pi to PATH",
      description: "New terminals only.",
      devOnly: "Unavailable in development builds.",
      unsupportedShell: "Shell {shell} unsupported.",
    },
  },
});

function mountDom() {
  document.body.innerHTML = `
    <button class="settings-toggle" id="toggle"></button>
    <span class="settings-label-sub" id="note"></span>
  `;
  return {
    toggle: document.getElementById("toggle"),
    note: document.getElementById("note"),
  };
}

function fakeTransport(status, configureImpl) {
  return {
    piPathStatus: vi.fn(async () => status),
    piPathConfigure: configureImpl ?? vi.fn(async () => ({})),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("status rendering", () => {
  it("reflects the enabled state and the normal note", async () => {
    const transport = fakeTransport({
      dev: false,
      shellSupported: true,
      shell: "/bin/zsh",
      enabled: true,
    });
    const { toggle, note } = mountDom();
    setupPiPathToggle({ transport, toggle, note });
    await vi.waitFor(() => expect(toggle.classList.contains("on")).toBe(true));
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.disabled).toBe(false);
    expect(note.textContent).toBe("New terminals only.");
  });

  it("disables the toggle in dev builds (Q5)", async () => {
    const transport = fakeTransport({
      dev: true,
      shellSupported: true,
      shell: "/bin/zsh",
      enabled: false,
    });
    const { toggle, note } = mountDom();
    setupPiPathToggle({ transport, toggle, note });
    await vi.waitFor(() => expect(toggle.disabled).toBe(true));
    expect(note.textContent).toBe("Unavailable in development builds.");
  });

  it("disables the toggle for unsupported shells (Q10)", async () => {
    const transport = fakeTransport({
      dev: false,
      shellSupported: false,
      shell: "/usr/local/bin/fish",
      enabled: false,
    });
    const { toggle, note } = mountDom();
    setupPiPathToggle({ transport, toggle, note });
    await vi.waitFor(() => expect(toggle.disabled).toBe(true));
    expect(note.textContent).toBe("Shell /usr/local/bin/fish unsupported.");
  });
});

describe("toggle flow", () => {
  it("configures the next state and re-renders from the host truth", async () => {
    let enabled = false;
    const transport = fakeTransport(
      { dev: false, shellSupported: true, shell: "/bin/zsh", enabled: false },
      vi.fn(async (next) => {
        enabled = next;
      }),
    );
    transport.piPathStatus.mockImplementation(async () => ({
      dev: false,
      shellSupported: true,
      shell: "/bin/zsh",
      enabled,
    }));
    const { toggle } = mountDom();
    setupPiPathToggle({ transport, toggle, note: document.getElementById("note") });
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    toggle.click();
    await vi.waitFor(() => expect(transport.piPathConfigure).toHaveBeenCalledWith(true));
    await vi.waitFor(() => expect(toggle.classList.contains("on")).toBe(true));
  });

  it("surfaces a host refusal inline and re-enables the toggle", async () => {
    const transport = fakeTransport(
      { dev: false, shellSupported: true, shell: "/bin/zsh", enabled: false },
      vi.fn(async () => {
        throw new Error("the marker block in your rc file was edited");
      }),
    );
    const { toggle, note } = mountDom();
    setupPiPathToggle({ transport, toggle, note });
    await vi.waitFor(() => expect(toggle.disabled).toBe(false));
    toggle.click();
    await vi.waitFor(() => expect(note.textContent).toContain("marker block"));
    expect(toggle.disabled).toBe(false);
    expect(toggle.classList.contains("on")).toBe(false);
  });
});
