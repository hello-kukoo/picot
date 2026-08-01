// ABOUTME: Verifies the native dialog promise resolves for every method and timeout path.
// ABOUTME: Covers confirm/select/input/editor rendering, cancellation, and cleanup.
import { afterEach, expect, test } from "vitest";
import { showNativeDialog } from "./dialog.js";

function makeContainer() {
  const container = document.createElement("div");
  container.classList.add("hidden");
  document.body.replaceChildren(container);
  return container;
}

afterEach(() => {
  document.body.replaceChildren();
});

test("confirm dialog resolves true on Yes and cleans up the container", async () => {
  const container = makeContainer();
  const promise = showNativeDialog({ method: "confirm", message: "Are you sure?" }, container);
  expect(container.classList.contains("hidden")).toBe(false);
  const yes = [...container.querySelectorAll("button")].find((b) => b.textContent === "Yes");
  yes.click();
  const result = await promise;
  expect(result).toEqual({ confirmed: true });
  expect(container.classList.contains("hidden")).toBe(true);
  expect(container.children.length).toBe(0);
});

test("confirm dialog resolves false on No", async () => {
  const container = makeContainer();
  const promise = showNativeDialog({ method: "confirm", message: "?" }, container);
  const no = [...container.querySelectorAll("button")].find((b) => b.textContent === "No");
  no.click();
  expect(await promise).toEqual({ confirmed: false });
});

test("select dialog resolves the chosen value from rendered options", async () => {
  const container = makeContainer();
  const promise = showNativeDialog(
    {
      method: "select",
      options: ["red", "green", "blue"],
    },
    container,
  );
  const opts = [...container.querySelectorAll(".dialog-option")];
  expect(opts.map((o) => o.textContent)).toEqual(["red", "green", "blue"]);
  opts[1].click();
  expect(await promise).toEqual({ value: "green" });
});

test("select dialog with no options renders nothing and cancel returns cancelled", async () => {
  const container = makeContainer();
  const promise = showNativeDialog({ method: "select", options: [] }, container);
  const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancel");
  cancel.click();
  expect(await promise).toEqual({ cancelled: true });
});

test("input dialog renders an input with prefill and placeholder, submits value", async () => {
  const container = makeContainer();
  const promise = showNativeDialog(
    {
      method: "input",
      prefill: "hello",
      placeholder: "type here",
    },
    container,
  );
  const input = container.querySelector(".dialog-input");
  expect(input.value).toBe("hello");
  expect(input.placeholder).toBe("type here");
  input.value = "typed";
  const submit = [...container.querySelectorAll("button")].find((b) => b.textContent === "Submit");
  submit.click();
  expect(await promise).toEqual({ value: "typed" });
});

test("editor dialog renders a textarea with Save button", async () => {
  const container = makeContainer();
  const promise = showNativeDialog(
    {
      method: "editor",
      prefill: "multi\nline",
    },
    container,
  );
  const textarea = container.querySelector(".dialog-textarea");
  expect(textarea.tagName).toBe("TEXTAREA");
  expect(textarea.value).toBe("multi\nline");
  const save = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save");
  save.click();
  expect(await promise).toEqual({ value: "multi\nline" });
});

test("Cancel button always resolves cancelled regardless of method", async () => {
  const container = makeContainer();
  const promise = showNativeDialog({ method: "input" }, container);
  const cancel = [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancel");
  cancel.click();
  expect(await promise).toEqual({ cancelled: true });
});

test("timeout auto-cancels the dialog after the specified delay", async () => {
  const container = makeContainer();
  const promise = showNativeDialog({ method: "confirm", message: "?", timeout: 50 }, container);
  expect(container.classList.contains("hidden")).toBe(false);
  const result = await promise;
  expect(result).toEqual({ cancelled: true });
  expect(container.classList.contains("hidden")).toBe(true);
});

test("finishing once clears the timeout so a later manual finish does not double-resolve", async () => {
  const container = makeContainer();
  const promise = showNativeDialog({ method: "input", timeout: 5000 }, container);
  const input = container.querySelector(".dialog-input");
  input.value = "fast";
  const submit = [...container.querySelectorAll("button")].find((b) => b.textContent === "Submit");
  submit.click();
  expect(await promise).toEqual({ value: "fast" });
  // Container should already be cleaned up by the manual finish.
  expect(container.children.length).toBe(0);
});

test("default title falls back per method when no title provided", async () => {
  const container = makeContainer();
  const p1 = showNativeDialog({ method: "confirm", message: "x" }, container);
  expect(container.querySelector(".dialog-title").textContent).toBe("Confirm");
  [...container.querySelectorAll("button")].find((b) => b.textContent === "No").click();
  await p1;

  const p2 = showNativeDialog({ method: "editor" }, container);
  expect(container.querySelector(".dialog-title").textContent).toBe("Editor");
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click();
  await p2;

  const p3 = showNativeDialog({ method: "input" }, container);
  expect(container.querySelector(".dialog-title").textContent).toBe("Input");
  [...container.querySelectorAll("button")].find((b) => b.textContent === "Cancel").click();
  await p3;
});

test("explicit request title overrides the default", async () => {
  const container = makeContainer();
  const promise = showNativeDialog(
    { method: "confirm", title: "Delete workspace?", message: "x" },
    container,
  );
  expect(container.querySelector(".dialog-title").textContent).toBe("Delete workspace?");
  [...container.querySelectorAll("button")].find((b) => b.textContent === "No").click();
  await promise;
});
