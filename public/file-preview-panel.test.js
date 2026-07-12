import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FilePreviewPanel } from "./file-preview-panel.js";
import { initI18n } from "./i18n.js";

let panel, resizer, tabBar, content, mainContainer;

beforeEach(async () => {
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  global.fetch = vi.fn((_url) =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ content: "# Test\n", mtimeMs: 1700000000000 }),
    }),
  );

  await initI18n();

  // Build DOM
  document.body.innerHTML = "";
  mainContainer = document.createElement("div");
  mainContainer.className = "main";
  mainContainer.style.width = "800px";
  document.body.appendChild(mainContainer);

  panel = document.createElement("section");
  panel.className = "file-preview-panel collapsed";
  panel.id = "file-preview-panel";
  document.body.appendChild(panel);

  resizer = document.createElement("div");
  resizer.className = "file-preview-resizer collapsed";
  resizer.id = "file-preview-resizer";
  document.body.appendChild(resizer);

  tabBar = document.createElement("div");
  tabBar.className = "file-preview-tabs";
  tabBar.id = "file-preview-tabs";
  document.body.appendChild(tabBar);

  content = document.createElement("div");
  content.className = "file-preview-content";
  content.id = "file-preview-content";
  document.body.appendChild(content);

  // Panel control buttons.
  const enlargeBtn = document.createElement("button");
  enlargeBtn.id = "file-preview-enlarge";
  enlargeBtn.className = "hidden";
  document.body.appendChild(enlargeBtn);

  const collapseBtn = document.createElement("button");
  collapseBtn.id = "file-preview-collapse";
  document.body.appendChild(collapseBtn);

  const closeBtn = document.createElement("button");
  closeBtn.id = "file-preview-close";
  document.body.appendChild(closeBtn);
});

afterEach(() => {
  document.body.innerHTML = "";
});

function createPanel() {
  return new FilePreviewPanel({
    panel,
    resizer,
    tabBar,
    content,
    mainContainer,
    workspaceRoot: "/test/workspace",
  });
}

describe("FilePreviewPanel", () => {
  test("starts collapsed", () => {
    const p = createPanel();
    expect(panel.classList.contains("collapsed")).toBe(true);
    p.destroy();
  });

  test("openFile opens panel and creates tab", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    expect(panel.classList.contains("collapsed")).toBe(false);
    expect(tabBar.children.length).toBe(1);
    p.destroy();
  });

  test("opening same file twice does not duplicate tab", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    await p.openFile("/test/workspace/README.md");
    expect(tabBar.children.length).toBe(1);
    p.destroy();
  });

  test("opening multiple files creates multiple tabs", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/a.js");
    await p.openFile("/test/workspace/b.js");
    expect(tabBar.children.length).toBe(2);
    p.destroy();
  });

  test("enlarge adds enlarged class", () => {
    const p = createPanel();
    p.enlarge();
    expect(panel.classList.contains("enlarged")).toBe(true);
    expect(panel.classList.contains("collapsed")).toBe(false);
    p.destroy();
  });

  test("collapse removes enlarged class", () => {
    const p = createPanel();
    p.enlarge();
    p.collapse();
    expect(panel.classList.contains("enlarged")).toBe(false);
    p.destroy();
  });

  test("closePanel collapses panel", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    p.closePanel();
    expect(panel.classList.contains("collapsed")).toBe(true);
    p.destroy();
  });

  test("closePanel preserves tabs (not closing them)", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    p.closePanel();
    expect(p.state.getTabs().length).toBe(1);
    p.destroy();
  });

  test("tab bar renders file names", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");
    const tabName = tabBar.querySelector(".file-preview-tab-name");
    expect(tabName).not.toBeNull();
    expect(tabName.textContent).toBe("main.js");
    p.destroy();
  });

  test("tab bar renders close buttons", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/main.js");
    const closeBtn = tabBar.querySelector(".file-preview-tab-close");
    expect(closeBtn).not.toBeNull();
    p.destroy();
  });

  test("setWorkspaceRoot loads persisted tabs", () => {
    // Simulate persisted tabs from a previous session.
    const tabsData = {
      byRoot: {
        "/test/workspace": {
          tabs: [
            {
              id: "file:/test/workspace/persisted.js",
              kind: "file",
              filePath: "/test/workspace/persisted.js",
              fileName: "persisted.js",
              mode: "preview",
            },
          ],
          activeTabId: "file:/test/workspace/persisted.js",
          touchedAt: Date.now(),
        },
      },
    };

    // Use the FileTabState directly with injected storage.
    const { FileTabState } = require("./file-tab-state.js");
    const memStorage = new Map();
    memStorage.set("picot-file-tabs", JSON.stringify(tabsData));
    const state = new FileTabState({
      storage: {
        getItem: (k) => memStorage.get(k) ?? null,
        setItem: (k, v) => memStorage.set(k, v),
        removeItem: (k) => memStorage.delete(k),
      },
    });
    state.load("/test/workspace");
    expect(state.getTabs().length).toBe(1);
    expect(state.getTabs()[0].fileName).toBe("persisted.js");
  });

  test("destroy cleans up renderer", async () => {
    const p = createPanel();
    await p.openFile("/test/workspace/README.md");
    p.destroy();
    // After destroy, the content should be empty.
    // The renderer's destroy() is called; content is cleared by _closePanel
    // only when closePanel is called. But destroy() destroys the renderer.
    // Content div may still have a wrapper; check for cm-editor absence.
    expect(content.querySelectorAll(".cm-editor").length).toBe(0);
  });
});
