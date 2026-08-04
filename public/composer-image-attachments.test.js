// ABOUTME: Locks the main-chat image-attachment render path so a future
// ABOUTME: `document.createElement` typo (e.g. destructuring a `doc` field
// ABOUTME: that the caller does not pass) surfaces as a failing test instead
// ABOUTME: of a `TypeError: undefined is not an object` in the running app.

import { JSDOM } from "jsdom";
import { beforeEach, describe, expect, it } from "vitest";
import { setupComposerImageAttachments } from "./composer-image-attachments.js";

function setupDom() {
  const dom = new JSDOM(`
    <div class="composer-card">
      <input type="file" id="image-input" />
      <div class="image-previews"></div>
      <button id="attach-btn"></button>
      <textarea id="message-input"></textarea>
    </div>
  `);
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  return {
    composerCard: document.querySelector(".composer-card"),
    imageInput: document.getElementById("image-input"),
    imagePreviews: document.querySelector(".image-previews"),
    attachBtn: document.getElementById("attach-btn"),
    textarea: document.getElementById("message-input"),
  };
}

describe("setupComposerImageAttachments render path", () => {
  let refs;
  let attachments;

  beforeEach(() => {
    refs = setupDom();
    attachments = setupComposerImageAttachments({
      composerCard: refs.composerCard,
      textarea: refs.textarea,
      attachBtn: refs.attachBtn,
      imageInput: refs.imageInput,
      imagePreviews: refs.imagePreviews,
      processImageFile: async () => ({ data: "AAAA", mimeType: "image/png" }),
      processImagePayload: async () => ({ data: "BBBB", mimeType: "image/png" }),
    });
  });

  it("renders an attached image preview without throwing", async () => {
    // Stub the file input's files getter so onInputChange → addImageFiles picks up
    // one synthetic file. processImageFile is the injected mock above; the change
    // handler awaits it, so we wait a microtask before reading the DOM.
    const stubFile = { type: "image/png", name: "a.png" };
    Object.defineProperty(refs.imageInput, "files", {
      configurable: true,
      value: [stubFile],
    });
    refs.imageInput.dispatchEvent(new globalThis.window.Event("change"));
    // addImageFiles is async (awaits processImageFile); flush microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(() => attachments.renderPreviews()).not.toThrow();
    const chips = refs.imagePreviews.querySelectorAll(".image-preview");
    expect(chips.length).toBe(1);
    expect(chips[0].querySelector("img").src).toContain("data:image/png;base64,AAAA");
  });

  it("consumePendingImages returns the queued attachments and clears the list", async () => {
    const stubFile = { type: "image/png", name: "a.png" };
    Object.defineProperty(refs.imageInput, "files", {
      configurable: true,
      value: [stubFile],
    });
    refs.imageInput.dispatchEvent(new globalThis.window.Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const out = attachments.consumePendingImages();
    expect(out).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    expect(attachments.getPendingImages()).toEqual([]);
  });
});
