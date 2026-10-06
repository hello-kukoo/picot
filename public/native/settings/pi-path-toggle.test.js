// ABOUTME: Tests for the Settings → General embedded-Pi PATH toggle: host-state
// ABOUTME: rendering (dev / unsupported shell / normal), the click flow, and
// ABOUTME: inline surfacing of a host refusal.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n.js";
import { setupPiPathToggle } from "./pi-path-toggle.js";

function makeDom() {
  const toggle = document.createElement("button");
  const note = document.createElement("span");
  return { toggle, note };
}

function makeControl(overrides = {}) {
  return {
    piPathStatus: vi
      .fn()
      .mockResolvedValue({ dev: false, shellSupported: true, shell: "/bin/zsh", enabled: false }),
    piPathConfigure: vi.fn().mockResolvedValue({ message: "zshrc: updated" }),
    ...overrides,
  };
}

describe("setupPiPathToggle", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders an enabled toggle from host state", async () => {
    const { toggle, note } = makeDom();
    const control = makeControl({
      piPathStatus: vi.fn().mockResolvedValue({ dev: false, shellSupported: true, enabled: true }),
    });

    const handle = setupPiPathToggle({ control, toggle, note });
    await handle.refresh();

    expect(toggle.classList.contains("on")).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("disables the toggle in development builds and explains why", async () => {
    const { toggle, note } = makeDom();
    const control = makeControl({
      piPathStatus: vi.fn().mockResolvedValue({ dev: true, shellSupported: true, enabled: false }),
    });

    const handle = setupPiPathToggle({ control, toggle, note });
    await handle.refresh();

    expect(toggle.disabled).toBe(true);
    expect(note.textContent).not.toBe("");
  });

  it("disables the toggle for an unsupported shell and names the shell", async () => {
    const { toggle, note } = makeDom();
    const control = makeControl({
      piPathStatus: vi.fn().mockResolvedValue({
        dev: false,
        shellSupported: false,
        shell: "/bin/fish",
        enabled: false,
      }),
    });

    const handle = setupPiPathToggle({ control, toggle, note });
    await handle.refresh();

    expect(toggle.disabled).toBe(true);
    // The locale catalog is not loaded under test, so assert branch selection
    // rather than the rendered sentence: the note must not be the normal hint.
    expect(note.textContent).not.toBe(t("settings.piPath.description"));
    expect(note.textContent).not.toBe("");
  });

  it("configures the host with the flipped value on click", async () => {
    const { toggle, note } = makeDom();
    const control = makeControl();
    const handle = setupPiPathToggle({ control, toggle, note });
    await handle.refresh();

    toggle.click();
    await vi.waitFor(() => expect(control.piPathConfigure).toHaveBeenCalledWith(true));
  });

  it("surfaces a host refusal inline instead of leaving the toggle stuck", async () => {
    const { toggle, note } = makeDom();
    const control = makeControl({
      piPathConfigure: vi.fn().mockRejectedValue(new Error("zshrc: block was edited by hand")),
    });
    const handle = setupPiPathToggle({ control, toggle, note });
    await handle.refresh();

    toggle.click();
    await vi.waitFor(() => expect(note.textContent).toContain("edited by hand"));
    expect(toggle.disabled).toBe(false);
  });
});
