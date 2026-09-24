// ABOUTME: Verifies the Files panel tree: lazy per-directory listing, persisted
// ABOUTME: expansion, inline create/rename, the context menu, and mentions.
// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initI18n, setLocale } from "./i18n.js";
import { FileBrowser } from "./workspace/file-browser.js";

const ROOT = ".";

// Real locale payloads, not a hand-rolled subset: a test that stubs messages
// cannot notice a label the panel asks for and the locales never gained.
const locales = {
  en: JSON.parse(readFileSync(resolve(import.meta.dirname, "locales/en.json"), "utf-8")),
  zh: JSON.parse(readFileSync(resolve(import.meta.dirname, "locales/zh.json"), "utf-8")),
};

let originalFetch;

function dir(name, parent = "") {
  return { name, relativePath: parent ? `${parent}/${name}` : name, kind: "directory" };
}

function file(name, parent = "") {
  return { name, relativePath: parent ? `${parent}/${name}` : name, kind: "file" };
}

/** A `listFiles` adapter over a fixed tree, recording every requested path. */
function treeLister(tree) {
  return vi.fn(async (path) => ({ entries: tree[path] ?? [] }));
}

function makeBrowser({ tree = {}, options = {}, root = "/work/app" } = {}) {
  const container = document.createElement("div");
  const pathEl = document.createElement("span");
  const messageInput = document.createElement("textarea");
  const card = document.createElement("div");
  card.id = "composer-card";
  card.appendChild(messageInput);
  document.body.appendChild(card);

  const listFiles = treeLister(tree);
  const browser = new FileBrowser(container, pathEl, messageInput, {
    listFiles,
    ...options,
  });
  if (root) browser.setWorkspaceRoot(root);
  return { browser, container, pathEl, messageInput, listFiles };
}

function rowNames(container) {
  return [...container.querySelectorAll(".file-item:not(.file-edit-row) .file-name")].map(
    (el) => el.textContent,
  );
}

function rowFor(container, path) {
  return [...container.querySelectorAll(".file-item")].find((row) => row.dataset.path === path);
}

function click(element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function press(element, key) {
  element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).includes("/locales/zh.json") ? locales.zh : locales.en),
  }));
  document.cookie.split(";").forEach((cookie) => {
    const name = cookie.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  await initI18n();
  localStorage.clear();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  localStorage.clear();
  document.body.textContent = "";
});

describe("workspace reset", () => {
  test("clears the tree, the path label, and the selection", () => {
    const { browser, container, pathEl } = makeBrowser();
    browser.setWorkspaceRoot("/work/other");

    expect(browser.workspaceRoot).toBe("/work/other");
    expect(browser.selectedPath).toBe(null);
    expect(browser.directoryListings.size).toBe(0);
    expect(browser.expandedPaths.size).toBe(0);
    expect(pathEl.textContent).toBe("/work/other");
    expect(container.querySelectorAll(".file-item")).toHaveLength(0);
  });

  test("normalizes non-string input to an empty root", () => {
    const { browser, pathEl } = makeBrowser();
    browser.setWorkspaceRoot(123);
    expect(browser.workspaceRoot).toBe("");
    expect(pathEl.textContent).toBe("");
  });

  test("resets hidden-entry visibility and notifies once", () => {
    const onShowHiddenChange = vi.fn();
    const { browser } = makeBrowser({ options: { onShowHiddenChange } });
    browser.showHidden = true;
    browser.setWorkspaceRoot("/work/other");
    expect(browser.showHidden).toBe(false);
    expect(onShowHiddenChange).toHaveBeenLastCalledWith(false);
  });
});

describe("lazy listing", () => {
  const tree = {
    [ROOT]: [dir("src"), file("README.md")],
    src: [file("main.ts", "src")],
  };

  test("fetches only the root on load, with the root spelled as a dot", async () => {
    const { browser, listFiles, container } = makeBrowser({ tree });
    await browser.load();

    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(listFiles).toHaveBeenCalledWith(ROOT);
    expect(rowNames(container)).toEqual(["src", "README.md"]);
    expect(browser.hasListing()).toBe(true);
  });

  test("expanding a directory fetches only that directory", async () => {
    const { browser, listFiles, container } = makeBrowser({ tree });
    await browser.load();
    listFiles.mockClear();

    await browser.setDirectoryExpanded("src", true);

    expect(listFiles).toHaveBeenCalledTimes(1);
    expect(listFiles).toHaveBeenCalledWith("src");
    expect(rowNames(container)).toEqual(["src", "main.ts", "README.md"]);
  });

  test("re-expanding a collapsed directory costs no I/O", async () => {
    const { browser, listFiles } = makeBrowser({ tree });
    await browser.load();
    await browser.setDirectoryExpanded("src", true);
    await browser.setDirectoryExpanded("src", false);
    listFiles.mockClear();

    await browser.setDirectoryExpanded("src", true);

    expect(listFiles).not.toHaveBeenCalled();
  });

  test("expanding two directories at once keeps each reply with its own path", async () => {
    const two = {
      [ROOT]: [dir("src"), dir("docs")],
      src: [file("main.ts", "src")],
      docs: [file("guide.md", "docs")],
    };
    const pending = new Map();
    const listFiles = vi.fn((path) =>
      path === ROOT
        ? Promise.resolve({ entries: two[ROOT] })
        : new Promise((resolve) => {
            pending.set(path, () => resolve({ entries: two[path] ?? [] }));
          }),
    );
    const { browser, container } = makeBrowser({ tree: two, options: { listFiles } });
    await browser.load();

    const expanding = Promise.all([
      browser.setDirectoryExpanded("src", true),
      browser.setDirectoryExpanded("docs", true),
    ]);
    // Answer out of order: the later request settles first.
    pending.get("docs")();
    await Promise.resolve();
    pending.get("src")();
    await expanding;

    expect(rowNames(container)).toEqual(["src", "main.ts", "docs", "guide.md"]);
  });

  test("a second expand while one is in flight does not double-request", async () => {
    const single = { [ROOT]: [dir("src")], src: [] };
    const listFiles = treeLister(single);
    const { browser } = makeBrowser({ tree: single, options: { listFiles } });
    await browser.load();
    listFiles.mockClear();

    await Promise.all([
      browser.setDirectoryExpanded("src", true),
      browser.setDirectoryExpanded("src", true),
    ]);

    expect(listFiles.mock.calls.filter(([path]) => path === "src")).toHaveLength(1);
  });

  test("collapsing drops the descendants' expanded state but keeps the cache", async () => {
    const nested = {
      [ROOT]: [dir("src")],
      src: [dir("ui", "src")],
      "src/ui": [file("panel.ts", "src/ui")],
    };
    const { browser, container } = makeBrowser({ tree: nested });
    await browser.load();
    await browser.setDirectoryExpanded("src", true);
    await browser.setDirectoryExpanded("src/ui", true);
    expect(rowNames(container)).toEqual(["src", "ui", "panel.ts"]);

    await browser.setDirectoryExpanded("src", false);

    expect(browser.expandedPaths.has("src/ui")).toBe(false);
    expect(browser.directoryListings.has("src/ui")).toBe(true);
    expect(rowNames(container)).toEqual(["src"]);
  });

  test("a stale response cannot repopulate a switched workspace", async () => {
    let resolveFirst;
    const listFiles = vi
      .fn()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValue({ entries: [file("second.md")] });
    const { browser, container } = makeBrowser({ options: { listFiles } });

    const pending = browser.load();
    browser.setWorkspaceRoot("/work/other");
    await browser.load();
    resolveFirst({ entries: [file("first.md")] });
    await pending;

    expect(rowNames(container)).toEqual(["second.md"]);
  });

  test("refresh re-fetches every directory the tree is showing", async () => {
    const { browser, listFiles } = makeBrowser({ tree });
    await browser.load();
    await browser.setDirectoryExpanded("src", true);
    listFiles.mockClear();

    await browser.refresh();

    expect(listFiles.mock.calls.map(([path]) => path).sort()).toEqual([ROOT, "src"]);
  });

  test("does nothing without a workspace root", async () => {
    const { browser, listFiles } = makeBrowser({ root: "" });
    await browser.load();
    expect(listFiles).not.toHaveBeenCalled();
  });
});

describe("persisted expansion", () => {
  const nested = {
    [ROOT]: [dir("src"), dir("docs")],
    src: [dir("ui", "src")],
    "src/ui": [],
    docs: [],
  };

  test("is keyed per workspace root", async () => {
    const { browser } = makeBrowser({ tree: nested });
    await browser.load();
    await browser.setDirectoryExpanded("docs", true);

    const first = makeBrowser({ tree: nested, root: "/work/other" });
    await first.browser.load();

    expect(first.browser.expandedPaths.size).toBe(0);
    expect(browser.expandedPaths.has("docs")).toBe(true);
  });

  test("restores the open directories, parents before children", async () => {
    localStorage.setItem("picot-file-tree-expanded:/work/app", JSON.stringify(["src/ui", "src"]));
    const { browser, container } = makeBrowser({ tree: nested });

    await browser.load();

    expect(browser.expandedPaths.has("src")).toBe(true);
    expect(browser.expandedPaths.has("src/ui")).toBe(true);
    expect(rowNames(container)).toEqual(["src", "ui", "docs"]);
  });

  test("never stores the root, and trims past the restore depth", async () => {
    const deep = {
      [ROOT]: [dir("a")],
      a: [dir("b", "a")],
      "a/b": [dir("c", "a/b")],
      "a/b/c": [dir("d", "a/b/c")],
      "a/b/c/d": [dir("e", "a/b/c/d")],
      "a/b/c/d/e": [dir("f", "a/b/c/d/e")],
      "a/b/c/d/e/f": [],
    };
    const { browser } = makeBrowser({ tree: deep });
    await browser.load();
    for (const path of ["a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e", "a/b/c/d/e/f"]) {
      await browser.setDirectoryExpanded(path, true);
    }

    const stored = JSON.parse(localStorage.getItem("picot-file-tree-expanded:/work/app"));
    expect(stored).not.toContain(ROOT);
    expect(stored).toContain("a/b/c/d/e");
    expect(stored).not.toContain("a/b/c/d/e/f");
  });

  test("drops a stored path that is gone or is no longer a directory", async () => {
    localStorage.setItem(
      "picot-file-tree-expanded:/work/app",
      JSON.stringify(["src", "ghost", "README.md"]),
    );
    const tree = { [ROOT]: [dir("src"), file("README.md")], src: [] };
    const { browser } = makeBrowser({ tree });

    await browser.load();

    expect(browser.expandedPaths.has("src")).toBe(true);
    expect(JSON.parse(localStorage.getItem("picot-file-tree-expanded:/work/app"))).toEqual(["src"]);
  });
});

describe("row interaction", () => {
  const tree = {
    [ROOT]: [dir("src"), file("README.md"), file(".env")],
    src: [file("main.ts", "src")],
  };

  test("clicking a file selects it and opens the preview", async () => {
    const onFileSelect = vi.fn();
    const { browser, container } = makeBrowser({ tree, options: { onFileSelect } });
    await browser.load();

    click(rowFor(container, "README.md"));

    expect(onFileSelect).toHaveBeenCalledWith("/work/app/README.md", {
      name: "README.md",
      path: "/work/app/README.md",
    });
    expect(browser.selectedPath).toBe("README.md");
    expect(rowFor(container, "README.md").getAttribute("aria-selected")).toBe("true");
  });

  test("clicking a directory expands it in place instead of navigating", async () => {
    const { browser, container } = makeBrowser({ tree });
    await browser.load();

    click(rowFor(container, "src"));
    await vi.waitFor(() => expect(browser.expandedPaths.has("src")).toBe(true));

    expect(browser.workspaceRoot).toBe("/work/app");
    expect(rowFor(container, "src").getAttribute("aria-expanded")).toBe("true");
    expect(rowNames(container)).toEqual(["src", "main.ts", "README.md"]);
  });

  test("hides dotfiles until the toggle is on, without a round trip", async () => {
    const { browser, listFiles, container } = makeBrowser({ tree });
    await browser.load();
    expect(rowNames(container)).toEqual(["src", "README.md"]);
    listFiles.mockClear();

    browser.setShowHidden(true);

    expect(rowNames(container)).toEqual(["src", "README.md", ".env"]);
    expect(listFiles).not.toHaveBeenCalled();
  });

  test("keyboard: arrows move, right expands, left collapses", async () => {
    const { browser, container } = makeBrowser({ tree });
    await browser.load();

    press(rowFor(container, "src"), "ArrowDown");
    expect(browser.selectedPath).toBe("README.md");

    press(rowFor(container, "README.md"), "ArrowUp");
    expect(browser.selectedPath).toBe("src");

    press(rowFor(container, "src"), "ArrowRight");
    await Promise.resolve();
    expect(browser.expandedPaths.has("src")).toBe(true);

    press(rowFor(container, "src"), "ArrowLeft");
    expect(browser.expandedPaths.has("src")).toBe(false);
  });

  test("keyboard: Enter opens a file preview", async () => {
    const onFileSelect = vi.fn();
    const { browser, container } = makeBrowser({ tree, options: { onFileSelect } });
    await browser.load();

    press(rowFor(container, "README.md"), "Enter");

    expect(onFileSelect).toHaveBeenCalledWith("/work/app/README.md", {
      name: "README.md",
      path: "/work/app/README.md",
    });
  });

  test("keyboard: only the selected row is reachable by Tab", async () => {
    const { browser, container } = makeBrowser({ tree });
    await browser.load();
    click(rowFor(container, "README.md"));

    const reachable = [...container.querySelectorAll('.file-item[tabindex="0"]')];
    expect(reachable).toHaveLength(1);
    expect(reachable[0].dataset.path).toBe("README.md");
  });

  test("renders a chevron for directories only", async () => {
    const { browser, container } = makeBrowser({ tree });
    await browser.load();

    expect(rowFor(container, "src").querySelector(".file-disclosure svg")).toBeTruthy();
    expect(rowFor(container, "README.md").querySelector(".file-disclosure svg")).toBeFalsy();
  });

  test("each row carries its indent level for the CSS depth rule", async () => {
    const nested = {
      [ROOT]: [dir("src")],
      src: [dir("ui", "src")],
      "src/ui": [file("panel.ts", "src/ui")],
    };
    const { browser, container } = makeBrowser({ tree: nested });
    await browser.load();
    await browser.setDirectoryExpanded("src", true);
    await browser.setDirectoryExpanded("src/ui", true);

    expect(rowFor(container, "src").style.getPropertyValue("--file-depth")).toBe("0");
    expect(rowFor(container, "src/ui").style.getPropertyValue("--file-depth")).toBe("1");
    expect(rowFor(container, "src/ui/panel.ts").style.getPropertyValue("--file-depth")).toBe("2");
  });
});

describe("drag to composer", () => {
  const tree = { [ROOT]: [dir("src"), file("README.md")], src: [] };

  function drag(container, path, { dx = 8 } = {}) {
    const row = rowFor(container, path);
    const card = document.getElementById("composer-card");
    const target = {};
    const originalContains = card.contains;
    const originalFromPoint = document.elementFromPoint;
    card.contains = (element) => element === target;
    document.elementFromPoint = () => target;
    try {
      // Drive the real listener path: mousedown on the row, then the document
      // listeners the panel installed for the gesture.
      row.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }),
      );
      document.dispatchEvent(new MouseEvent("mousemove", { clientX: dx, clientY: 0 }));
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: dx, clientY: 0 }));
    } finally {
      card.contains = originalContains;
      document.elementFromPoint = originalFromPoint;
    }
  }

  test("a file inserts a bare relative mention", async () => {
    const { browser, container, messageInput } = makeBrowser({ tree });
    await browser.load();
    drag(container, "README.md");
    expect(messageInput.value).toBe("@README.md");
  });

  test("a directory inserts a trailing-slash mention", async () => {
    const { browser, container, messageInput } = makeBrowser({ tree });
    await browser.load();
    drag(container, "src");
    expect(messageInput.value).toBe("@src/");
  });
});

describe("mentions", () => {
  test("a directory keeps its trailing slash", () => {
    const { browser } = makeBrowser({ root: "/work/app" });
    expect(browser.toMentionPath("/work/app/src", { isDirectory: true })).toBe("@src/");
    expect(browser.toMentionPath("/work/app/src")).toBe("@src");
  });

  test("rejects paths that are not representable relative to the root", () => {
    const { browser } = makeBrowser({ root: "/work/app" });
    expect(browser.toMentionPath("/work/app")).toBe(null);
    expect(browser.toMentionPath("")).toBe(null);
    expect(browser.toMentionPath(null)).toBe(null);
  });

  test("rejects traversal and cross-drive paths", () => {
    const { browser } = makeBrowser({ root: "/work/app" });
    expect(browser.toMentionPath("/work/app/../other/a.ts")).toBe(null);
    browser.workspaceRoot = "C:\\proj";
    expect(browser.toMentionPath("D:\\shared\\a.ts")).toBe(null);
  });

  test("normalizes Windows separators", () => {
    const { browser } = makeBrowser({ root: "C:\\proj" });
    expect(browser.toMentionPath("c:\\proj\\src\\a.ts")).toBe("@src/a.ts");
  });
});

describe("inline create and rename", () => {
  const tree = { [ROOT]: [dir("src"), file("README.md")], src: [] };

  function mutationOptions(overrides = {}) {
    return {
      createEntry: vi.fn(async (parentPath, name) => ({
        path: parentPath === ROOT ? name : `${parentPath}/${name}`,
      })),
      renameEntry: vi.fn(async (path, name) => {
        const index = path.lastIndexOf("/");
        return { path: index === -1 ? name : `${path.slice(0, index)}/${name}` };
      }),
      deleteEntry: vi.fn(async (path) => ({ deletedPath: path })),
      ...overrides,
    };
  }

  test("Enter creates the entry, refetches the parent, and selects it", async () => {
    const options = mutationOptions();
    const { browser, container, listFiles } = makeBrowser({ tree, options });
    await browser.load();
    listFiles.mockClear();

    browser.beginCreate("file");
    const input = container.querySelector(".file-edit-input");
    expect(input).toBeTruthy();
    input.value = "notes.md";
    press(input, "Enter");
    await vi.waitFor(() => expect(options.createEntry).toHaveBeenCalled());

    expect(options.createEntry).toHaveBeenCalledWith(ROOT, "notes.md", "file");
    await vi.waitFor(() => expect(browser.selectedPath).toBe("notes.md"));
    expect(listFiles).toHaveBeenCalledWith(ROOT);
  });

  test("creates inside the selected directory and keeps it open", async () => {
    const options = mutationOptions();
    const { browser, container } = makeBrowser({ tree, options });
    await browser.load();
    click(rowFor(container, "src"));

    browser.beginCreate("directory");
    const input = container.querySelector(".file-edit-input");
    input.value = "ui";
    press(input, "Enter");
    await vi.waitFor(() => expect(options.createEntry).toHaveBeenCalled());

    expect(options.createEntry).toHaveBeenCalledWith("src", "ui", "directory");
    expect(browser.expandedPaths.has("src")).toBe(true);
  });

  test("Escape cancels without calling the host", async () => {
    const options = mutationOptions();
    const { browser, container } = makeBrowser({ tree, options });
    await browser.load();

    browser.beginCreate("file");
    const input = container.querySelector(".file-edit-input");
    input.value = "discarded.md";
    press(input, "Escape");

    expect(browser.pendingEdit).toBe(null);
    expect(options.createEntry).not.toHaveBeenCalled();
    expect(container.querySelector(".file-edit-input")).toBeFalsy();
  });

  test("an empty name cancels without calling the host", async () => {
    const options = mutationOptions();
    const { browser, container } = makeBrowser({ tree, options });
    await browser.load();

    browser.beginCreate("file");
    const input = container.querySelector(".file-edit-input");
    input.value = "   ";
    press(input, "Enter");

    expect(options.createEntry).not.toHaveBeenCalled();
    expect(container.querySelector(".file-edit-input")).toBeFalsy();
  });

  test("a failed create toasts and leaves the tree intact", async () => {
    const options = mutationOptions({
      createEntry: vi.fn(async () => {
        throw Object.assign(new Error("nope"), { code: "already_exists" });
      }),
    });
    const toasts = [];
    window.addEventListener("picot-toast", (event) => toasts.push(event.detail.message));
    const { browser, container } = makeBrowser({ tree, options });
    await browser.load();

    browser.beginCreate("file");
    const input = container.querySelector(".file-edit-input");
    input.value = "README.md";
    press(input, "Enter");
    await vi.waitFor(() => expect(toasts.length).toBe(1));

    // The host's machine code picks a localized sentence; it is never spliced
    // into the UI.
    expect(toasts[0]).toBe(locales.en.files.errorAlreadyExists);
    expect(rowNames(container)).toEqual(["src", "README.md"]);
  });

  test("an unrecognized failure code falls back to the generic line", async () => {
    const options = mutationOptions({
      deleteEntry: vi.fn(async () => {
        throw Object.assign(new Error("weird"), { code: "some_new_code" });
      }),
    });
    const toasts = [];
    window.addEventListener("picot-toast", (event) => toasts.push(event.detail.message));
    const { browser } = makeBrowser({ tree, options });
    await browser.load();
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);

    await browser.deletePath("README.md", false);

    expect(toasts[0]).toBe(locales.en.files.errorGeneric);
  });

  test("renaming replaces the row's name in place", async () => {
    const options = mutationOptions();
    const { browser, container } = makeBrowser({ tree, options });
    await browser.load();

    browser.beginRename("README.md");
    const input = rowFor(container, "README.md").querySelector(".file-edit-input");
    expect(input.value).toBe("README.md");
    input.value = "GUIDE.md";
    press(input, "Enter");
    await vi.waitFor(() => expect(options.renameEntry).toHaveBeenCalled());

    expect(options.renameEntry).toHaveBeenCalledWith("README.md", "GUIDE.md");
  });

  test("renaming a directory drops its cached subtree and expansion", async () => {
    const nested = {
      [ROOT]: [dir("src")],
      src: [dir("ui", "src")],
      "src/ui": [],
    };
    const options = mutationOptions();
    const { browser, container } = makeBrowser({ tree: nested, options });
    await browser.load();
    await browser.setDirectoryExpanded("src", true);
    await browser.setDirectoryExpanded("src/ui", true);

    browser.beginRename("src");
    const input = rowFor(container, "src").querySelector(".file-edit-input");
    input.value = "lib";
    press(input, "Enter");
    await vi.waitFor(() => expect(browser.selectedPath).toBe(null));

    expect(browser.directoryListings.has("src/ui")).toBe(false);
    expect(browser.expandedPaths.has("src")).toBe(false);
    expect(browser.expandedPaths.has("src/ui")).toBe(false);
  });
});

describe("delete", () => {
  const tree = { [ROOT]: [dir("src"), file("README.md")], src: [] };

  // `canMutate()` gates every mutation on all three adapters being wired, the
  // same way the app wires them.
  function mutationStubs() {
    return { createEntry: vi.fn(), renameEntry: vi.fn() };
  }

  test("confirms, calls the host, and invalidates only the parent", async () => {
    const deleteEntry = vi.fn(async (path) => ({ deletedPath: path }));
    const { browser, listFiles } = makeBrowser({
      tree,
      options: { ...mutationStubs(), deleteEntry },
    });
    await browser.load();
    listFiles.mockClear();
    vi.spyOn(globalThis, "confirm").mockReturnValue(true);

    await browser.deletePath("README.md", false);

    expect(deleteEntry).toHaveBeenCalledWith("README.md");
    expect(listFiles.mock.calls.map(([path]) => path)).toEqual([ROOT]);
  });

  test("a declined confirmation never reaches the host", async () => {
    const deleteEntry = vi.fn();
    const { browser } = makeBrowser({ tree, options: { ...mutationStubs(), deleteEntry } });
    await browser.load();
    vi.spyOn(globalThis, "confirm").mockReturnValue(false);

    await browser.deletePath("README.md", false);

    expect(deleteEntry).not.toHaveBeenCalled();
  });
});

describe("mutability", () => {
  const tree = { [ROOT]: [dir("src"), file("README.md")], src: [] };
  const mutations = {
    createEntry: vi.fn(),
    renameEntry: vi.fn(),
    deleteEntry: vi.fn(),
  };

  test("is off without a workspace root", () => {
    const { browser } = makeBrowser({ root: "", options: mutations });
    expect(browser.canMutate()).toBe(false);
  });

  test("is off when the host reports no write data plane", () => {
    const { browser } = makeBrowser({
      tree,
      options: { ...mutations, writesAvailable: () => false },
    });
    expect(browser.canMutate()).toBe(false);
  });

  test("is off while a mutation is in flight", () => {
    const { browser } = makeBrowser({ tree, options: mutations });
    browser.setMutationInFlight(true);
    expect(browser.canMutate()).toBe(false);
    browser.setMutationInFlight(false);
    expect(browser.canMutate()).toBe(true);
  });

  test("reports changes so the toolbar can disable its buttons", () => {
    const onMutabilityChange = vi.fn();
    const { browser } = makeBrowser({ tree, options: { ...mutations, onMutabilityChange } });
    browser.setMutationInFlight(true);
    expect(onMutabilityChange).toHaveBeenLastCalledWith(false);
  });

  test("a disabled browser refuses to start an edit", () => {
    const { browser, container } = makeBrowser({
      tree,
      options: { ...mutations, writesAvailable: () => false },
    });
    browser.beginCreate("file");
    expect(browser.pendingEdit).toBe(null);
    expect(container.querySelector(".file-edit-input")).toBeFalsy();
  });
});

describe("context menu", () => {
  const tree = { [ROOT]: [dir("src"), file("README.md")], src: [] };

  function openMenu(container, path) {
    const row = path ? rowFor(container, path) : container;
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      clientX: 10,
      clientY: 10,
      cancelable: true,
    });
    if (row) row.dispatchEvent(event);
    return [...document.querySelectorAll(".file-context-menu .context-menu-item")].map(
      (item) => item.textContent,
    );
  }

  test("a file menu offers preview, open, composer, copy, rename, delete", async () => {
    const { browser, container } = makeBrowser({ tree });
    await browser.load();
    const labels = openMenu(container, "README.md");

    expect(labels).toContain("Preview");
    expect(labels).toContain("Open in system app");
    expect(labels).toContain("Add to chat");
    expect(labels).toContain("Copy relative path");
    expect(labels).toContain("Copy absolute path");
    expect(labels).toContain("Rename");
    expect(labels).toContain("Delete");
  });

  test("a directory menu adds expand, reveal, and creation items", async () => {
    const { browser, container } = makeBrowser({ tree });
    await browser.load();
    const labels = openMenu(container, "src");

    expect(labels).toContain("Expand");
    expect(labels).toContain("Show in file manager");
    expect(labels).toContain("New file");
    expect(labels).toContain("New folder");
    expect(labels).not.toContain("Preview");
  });

  test("an empty-area menu creates at the workspace root", async () => {
    const { browser, container } = makeBrowser({ tree });
    await browser.load();
    const labels = openMenu(container, null);
    expect(labels).toEqual([
      locales.en.files.newFile,
      locales.en.files.newFolder,
      locales.en.files.refreshDirectory,
    ]);
  });

  test("write items are disabled when the host cannot mutate", async () => {
    const { browser, container } = makeBrowser({
      tree,
      options: {
        createEntry: vi.fn(),
        renameEntry: vi.fn(),
        deleteEntry: vi.fn(),
        writesAvailable: () => false,
      },
    });
    await browser.load();
    openMenu(container, "README.md");
    const items = [...document.querySelectorAll(".file-context-menu .context-menu-item")];
    const rename = items.find((item) => item.textContent === "Rename");
    expect(rename.disabled).toBe(true);
  });

  test("there is no parent-directory affordance left", () => {
    expect(document.getElementById("file-sidebar-up")).toBe(null);
  });
});

describe("unreachable workspace", () => {
  const tree = { [ROOT]: [dir("src")], src: [] };

  function failingLister() {
    return vi.fn(async () => {
      throw Object.assign(new Error("gone"), { code: "temporarily_unavailable" });
    });
  }

  test("keeps the cached tree and shows a stale banner with a retry", async () => {
    const { browser, container } = makeBrowser({ tree });
    await browser.load();
    browser.listFiles = failingLister();

    await browser.refresh();

    expect(browser.staleWorkspace).toBe(true);
    expect(browser.rootUnreachableStreak).toBe(1);
    expect(browser.expandedPaths.size).toBe(0);
    expect(container.querySelector(".file-stale-banner")).toBeTruthy();
    expect(container.querySelector(".file-stale-retry")).toBeTruthy();
  });

  test("discards the tree only after three consecutive root failures", async () => {
    const { browser } = makeBrowser({ tree });
    await browser.load();
    browser.listFiles = failingLister();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await browser.load();
    }

    expect(browser.directoryListings.size).toBe(0);
    expect(browser.rootUnreachableStreak).toBe(0);
    expect(localStorage.getItem("picot-file-tree-expanded:/work/app")).toBe(null);
  });

  test("any success clears the streak", async () => {
    const { browser } = makeBrowser({ tree });
    await browser.load();
    browser.listFiles = failingLister();
    await browser.load();
    expect(browser.rootUnreachableStreak).toBe(1);

    browser.listFiles = treeLister(tree);
    await browser.load();

    expect(browser.rootUnreachableStreak).toBe(0);
    expect(browser.staleWorkspace).toBe(false);
  });

  test("a transient child failure marks the row stale with an in-place retry", async () => {
    const { browser, container } = makeBrowser({ tree });
    await browser.load();
    browser.listFiles = vi.fn(async (path) => {
      if (path === "src") {
        throw Object.assign(new Error("gone"), { code: "temporarily_unavailable" });
      }
      return { entries: tree[path] ?? [] };
    });

    await browser.setDirectoryExpanded("src", true);

    expect(rowFor(container, "src").classList.contains("failed")).toBe(true);
    expect(rowFor(container, "src").querySelector(".file-row-retry")).toBeTruthy();
    // The root failure counter is untouched by a child failure.
    expect(browser.rootUnreachableStreak).toBe(0);
  });
});

describe("locale change", () => {
  test("repaints the status text", async () => {
    const { browser, container } = makeBrowser({ root: "" });
    browser.showFileStatus("loading");
    expect(container.querySelector(".file-loading").textContent).toBe("Loading…");

    await setLocale("zh");
    expect(container.querySelector(".file-loading").textContent).toBe("加载中…");
    await setLocale("en");
  });
});
