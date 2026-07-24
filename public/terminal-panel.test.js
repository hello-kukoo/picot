// ABOUTME: Tests for the native-only Terminal Panel: lazy first creation, remote
// ABOUTME: gating, height clamping, close-risk reporting, and DOM teardown.
import { afterEach, expect, test, vi } from "vitest";
import { TerminalPanel } from "./terminal-panel.js";

function mountedPanel(opts = {}) {
  const client = opts.client || { create: vi.fn(), closeAll: vi.fn(), checkpointAll: vi.fn() };
  const panel = new TerminalPanel({
    native: opts.native !== undefined ? opts.native : true,
    client,
    subscribeLocale: opts.subscribeLocale,
    getAvailableHeight: opts.getAvailableHeight || (() => opts.availableHeight || 800),
  });
  panel.mount({ toggleContainer: document.body, panelContainer: document.body });
  return { panel, client };
}

afterEach(() => {
  document.body.innerHTML = "";
});

test("first native expansion lazily creates one default tab", async () => {
  const { panel, client } = mountedPanel();
  expect(panel.toggleEl.classList.contains("panel-toggle-btn")).toBe(true);
  expect(panel.toggleEl.getAttribute("aria-label")).toBe("terminal.toggle");
  expect(panel.toggleEl.querySelector('rect[x="3.5"]')).not.toBeNull();
  expect(panel.toggleEl.querySelector('path[d="M7 15h10"]')).not.toBeNull();
  expect(panel.toggleEl.dataset.terminalCount).toBeUndefined();
  expect(panel.isExpanded()).toBe(false);
  await panel.expand();
  expect(client.create).toHaveBeenCalledWith("default");
});

test("remote client renders no toggle, panel, metadata, or activity", () => {
  mountedPanel({ native: false });
  expect(document.querySelector("[data-terminal-toggle]")).toBeNull();
  expect(document.querySelector("[data-terminal-panel]")).toBeNull();
});

test("resizer clamps to 160px minimum and 70 percent maximum", () => {
  const { panel } = mountedPanel({ availableHeight: 1000 });
  expect(panel.setHeight(10)).toBe(160);
  expect(panel.setHeight(900)).toBe(700);
  expect(panel.setHeight(400)).toBe(400);
});

test("resizing the panel refits the xterm viewport", () => {
  const refitAll = vi.fn();
  const { panel } = mountedPanel({ client: { refitAll } });

  panel.setHeight(360);

  expect(refitAll).toHaveBeenCalledTimes(1);
});

test("closing the final tab collapses the panel", async () => {
  const { panel } = mountedPanel();
  await panel.expand();

  panel.setTabs([]);

  expect(panel.isExpanded()).toBe(false);
  expect(panel.root.classList.contains("hidden")).toBe(true);
});

test("body resize refits xterm and destroy disconnects the observer", () => {
  const observer = { observe: vi.fn(), disconnect: vi.fn() };
  vi.stubGlobal(
    "ResizeObserver",
    vi.fn(() => observer),
  );
  const refitAll = vi.fn();
  const { panel } = mountedPanel({ client: { refitAll } });

  expect(observer.observe).toHaveBeenCalledWith(panel.bodyEl);
  globalThis.ResizeObserver.mock.calls[0][0]();
  expect(refitAll).toHaveBeenCalledTimes(1);
  panel.destroy();
  expect(observer.disconnect).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});

test("closing a running tab requires confirmation", () => {
  const close = vi.fn();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const { panel } = mountedPanel({ client: { close } });
  panel.setTabs([
    { terminalId: "t1", generation: 1, label: "zsh", profileId: "default", status: "running" },
  ]);

  panel.tabButtons.get("t1").querySelector(".terminal-tab-close").click();

  expect(confirm).toHaveBeenCalledTimes(1);
  expect(close).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  panel.tabButtons.get("t1").querySelector(".terminal-tab-close").click();
  expect(close).toHaveBeenCalledWith("t1", 1);
  confirm.mockRestore();
});

test("getCloseRisk reports only live terminals with stable labels", async () => {
  const { panel } = mountedPanel();
  await panel.expand();
  panel.setTabs([
    { terminalId: "t1", generation: 1, label: "zsh", profileId: "default", status: "running" },
    { terminalId: "t2", generation: 1, label: "gone", profileId: "default", status: "exited" },
  ]);
  const risk = panel.getCloseRisk();
  expect(risk.terminalTabs).toEqual([{ terminalId: "t1", label: "zsh" }]);
});

test("collapse retains the saved expanded height", async () => {
  const { panel } = mountedPanel({ availableHeight: 1000 });
  await panel.expand();
  panel.setHeight(300);
  panel.collapse();
  expect(panel.heightPx).toBe(300);
});

test("destroy removes toggle and panel from the DOM", async () => {
  const { panel } = mountedPanel();
  await panel.expand();
  panel.destroy();
  expect(document.querySelector("[data-terminal-toggle]")).toBeNull();
  expect(document.querySelector("[data-terminal-panel]")).toBeNull();
});

test("beforeWorkspaceTransition locks interaction and checkpoints", async () => {
  const checkpointAll = vi.fn(async () => {});
  const { panel } = mountedPanel({ client: { checkpointAll } });
  await panel.expand();
  await panel.beforeWorkspaceTransition();
  expect(checkpointAll).toHaveBeenCalledTimes(1);
  expect(panel.locked).toBe(true);
});

test("setInteractionLocked toggles the lock", () => {
  const { panel } = mountedPanel();
  panel.setInteractionLocked(true);
  expect(panel.locked).toBe(true);
  panel.setInteractionLocked(false);
  expect(panel.locked).toBe(false);
});

test("markActivity tracks background output and clearActivity resets it", () => {
  const { panel } = mountedPanel();
  panel.setTabs([
    { terminalId: "t1", generation: 1, label: "zsh", profileId: "default", status: "running" },
  ]);
  expect(panel.getProjection()).toEqual({ count: 1, hasActivity: false });
  panel.markActivity("t1");
  expect(panel.getProjection()).toEqual({ count: 1, hasActivity: true });
  expect(panel.toggleEl.classList.contains("has-activity")).toBe(false);
  expect(panel.toggleEl.dataset.terminalCount).toBeUndefined();
  panel.clearActivity("t1");
  expect(panel.getProjection()).toEqual({ count: 1, hasActivity: false });
});

test("expand clears background activity", async () => {
  const { panel } = mountedPanel();
  panel.setTabs([
    { terminalId: "t1", generation: 1, label: "zsh", profileId: "default", status: "running" },
  ]);
  panel.markActivity("t1");
  expect(panel.getProjection().hasActivity).toBe(true);
  await panel.expand();
  expect(panel.getProjection().hasActivity).toBe(false);
});

test("beforeWorkspaceTransition checkpoints even when collapsed", async () => {
  const checkpointAll = vi.fn(async () => {});
  const { panel } = mountedPanel({ client: { checkpointAll } });
  expect(panel.isExpanded()).toBe(false);
  const ok = await panel.beforeWorkspaceTransition();
  expect(ok).toBe(true);
  expect(checkpointAll).toHaveBeenCalledTimes(1);
});
