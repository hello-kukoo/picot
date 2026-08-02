// ABOUTME: Verifies local action icons use one accessible Lucide-style SVG contract.
// ABOUTME: Icons are decorative; their buttons own localized accessible names.
import { expect, test } from "vitest";
import { createIcon, setButtonIcon } from "./icons.js";

test("creates local action icons with the shared SVG contract", () => {
  const icon = createIcon("save", { size: 14 });
  expect(icon?.getAttribute("viewBox")).toBe("0 0 24 24");
  expect(icon?.getAttribute("stroke")).toBe("currentColor");
  expect(icon?.getAttribute("stroke-linecap")).toBe("round");
  expect(icon?.getAttribute("aria-hidden")).toBe("true");
});

test("creates icons in a supplied document for isolated views", () => {
  const ownerDocument = document.implementation.createHTMLDocument("isolated");
  const icon = createIcon("arrow-up", { document: ownerDocument, size: 12 });
  expect(icon?.ownerDocument).toBe(ownerDocument);
  expect(icon?.getAttribute("width")).toBe("12");
});

test("replaces decorative button content without changing its accessible name", () => {
  const button = document.createElement("button");
  button.setAttribute("aria-label", "Save file");
  button.textContent = "Save";
  setButtonIcon(button, "save");
  expect(button.getAttribute("aria-label")).toBe("Save file");
  expect(button.querySelector("svg")).not.toBeNull();
});

test("exposes distinct maximize, minimize and text-collapse action glyphs", () => {
  // Panel enlarge (maximize) and panel restore (minimize) must never share a
  // glyph, and Context Compact must use its own text-collapse glyph rather
  // than overloading restore.
  const maximize = createIcon("maximize");
  const minimize = createIcon("minimize");
  const compact = createIcon("text-collapse");
  for (const icon of [maximize, minimize, compact]) {
    expect(icon, "action icon must exist").not.toBeNull();
    expect(icon?.querySelectorAll("*").length).toBeGreaterThan(0);
  }
  expect(maximize?.isEqualNode(minimize)).toBe(false);
  expect(compact?.isEqualNode(minimize)).toBe(false);
  expect(compact?.isEqualNode(maximize)).toBe(false);
});

test("refresh keeps the original sidebar arc geometry without spinning", () => {
  const button = document.createElement("button");
  setButtonIcon(button, "refresh-cw");
  const icon = button.querySelector("svg");
  expect(icon).not.toBeNull();
  expect(icon?.querySelector("path")?.getAttribute("d")).toBe(
    "M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8",
  );
  expect(icon?.classList.contains("spin")).toBe(false);
  expect(icon?.classList.contains("spinning")).toBe(false);
});

test("sidebar and File panel icons match the approved prototype geometry", () => {
  expect(createIcon("folder-plus")?.querySelector("path")?.getAttribute("d")).toBe(
    "M4 5a2 2 0 0 1 2-2h4l2 3h6a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z",
  );
  expect(createIcon("message-circle")?.querySelectorAll("path").length).toBe(2);
  expect(createIcon("message-square")?.querySelector("path")?.getAttribute("d")).toBe(
    "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z",
  );
  expect(createIcon("arrow-up")?.querySelector("path")?.getAttribute("d")).toBe(
    "M12 19V5M5 12l7-7 7 7",
  );
  expect(createIcon("folder-open")?.querySelector("path")?.getAttribute("d")).toContain(
    "M6 14l1.5-2.9",
  );
});

test("every action glyph follows the 24x24 currentColor round-stroke contract", () => {
  for (const name of [
    "maximize",
    "minimize",
    "text-collapse",
    "refresh-cw",
    "box",
    "arrow-up",
    "arrow-right",
  ]) {
    const icon = createIcon(name);
    expect(icon, `${name} must exist`).not.toBeNull();
    expect(icon?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(icon?.getAttribute("stroke")).toBe("currentColor");
    expect(icon?.getAttribute("stroke-linecap")).toBe("round");
    expect(icon?.getAttribute("stroke-linejoin")).toBe("round");
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  }
});
