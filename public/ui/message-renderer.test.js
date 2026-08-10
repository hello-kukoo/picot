import { beforeEach, describe, expect, it, vi } from "vitest";
import { initI18n, setLocale } from "../i18n.js";
import { formatMessageTime, MessageRenderer } from "./message-renderer.js";

const enMessages = {
  messages: {
    copyMessage: "Copy message",
    thinking: "Thinking",
    attachedImage: "Attached image",
    copy: "Copy",
    copied: "Copied!",
  },
  app: {
    welcome: "Welcome to Picot",
    welcomeHint: "Type a message...",
    currentWorkspace: "Current workspace:",
  },
  shortcuts: { focusInput: "Focus input", abort: "Abort" },
};
const zhMessages = {
  messages: {
    copyMessage: "复制消息",
    thinking: "思考中",
    attachedImage: "附件图片",
    copy: "复制",
    copied: "已复制！",
  },
  app: {
    welcome: "欢迎使用 Picot",
    welcomeHint: "输入消息...",
    currentWorkspace: "当前工作区：",
  },
  shortcuts: { focusInput: "聚焦输入", abort: "中止" },
};

beforeEach(async () => {
  vi.unstubAllGlobals();
  document.cookie.split(";").forEach((c) => {
    const name = c.split("=")[0].trim();
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/locales/en.json")) {
        return { ok: true, status: 200, json: async () => enMessages };
      }
      if (u.includes("/locales/zh.json")) {
        return { ok: true, status: 200, json: async () => zhMessages };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  await initI18n();
});

describe("MessageRenderer streaming markdown preview", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("renders markdown live during streaming updates", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "hello **bold te");

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold te</strong>");
  });

  it("finalizes from the raw text, not the rendered DOM", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "a **bold** word and `code`");
    renderer.finalizeStreamingMessage(el);

    const content = el.querySelector(".message-content");
    expect(content.innerHTML).toContain("<strong>bold</strong>");
    expect(content.innerHTML).toContain("<code>code</code>");
  });

  it("does not add a copy footer to empty finalized streaming messages", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);

    renderer.finalizeStreamingMessage(el);

    expect(el.querySelector(".message-footer")).toBeNull();
    expect(el.querySelector(".message-copy-btn")).toBeNull();
  });

  it("keeps a partial code block previewing as a code block", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "```js\nconst a = 1;");

    const content = el.querySelector(".message-content");
    expect(content.querySelector(".code-block-wrapper")).not.toBeNull();
    expect(content.textContent).toContain("const a = 1;");
  });

  it("preserves the thinking block while streaming text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingThinking(el, "pondering...");
    renderer.updateStreamingMessage(el, "some *italic");

    expect(el.querySelector(".streaming-thinking")).not.toBeNull();
    expect(el.querySelector(".streaming-text").innerHTML).toContain("<em>italic</em>");
  });

  it("does not render raw HTML from streamed text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "`<script>alert(1)</script>`");

    const content = el.querySelector(".message-content");
    expect(content.querySelector("script")).toBeNull();
  });

  it("copies assistant text without thinking label or content", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const el = renderer.renderAssistantMessage(
      {
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "Visible answer" },
        ],
      },
      false,
      true,
    );

    el.querySelector(".message-copy-btn").click();

    expect(writeText).toHaveBeenCalledWith("Visible answer");
  });

  it("removes unsafe HTML attributes and URL schemes from user markdown", () => {
    const el = renderer.renderUserMessage({
      content:
        '<img src="javascript:alert(1)" onerror="alert(2)"><a href="javascript:alert(3)">link</a>',
    });

    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelector("img").getAttribute("src")).toBeNull();
    expect(el.querySelector("img").getAttribute("onerror")).toBeNull();
    expect(el.querySelector("a").getAttribute("href")).toBeNull();
  });

  it("highlights keyword matches across rendered messages", () => {
    renderer.renderUserMessage({ content: "Alpha beta gamma" }, true);
    renderer.renderAssistantMessage({ content: "Beta appears twice: beta." }, false, true);

    const count = renderer.highlightSearchQuery("beta");
    const marks = container.querySelectorAll("mark");

    expect(count).toBe(3);
    expect(marks).toHaveLength(3);
    expect(marks[0].textContent.toLowerCase()).toBe("beta");
  });

  it("scrolls the first highlighted match into view", () => {
    renderer.renderAssistantMessage({ content: "jump to keyword" }, false, true);

    let scrolled = false;
    Element.prototype.scrollIntoView = () => {
      scrolled = true;
    };

    const count = renderer.highlightSearchQuery("keyword");

    expect(count).toBe(1);
    expect(scrolled).toBe(true);
  });
});

describe("MessageRenderer locale change", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("updates copy button aria-label and title on locale change without re-rendering content", async () => {
    const el = renderer.renderAssistantMessage({ content: "hello **world**" }, false);
    const copyBtn = el.querySelector(".message-copy-btn");
    expect(copyBtn.getAttribute("aria-label")).toBe("Copy message");

    const contentHtmlBefore = el.querySelector(".message-content").innerHTML;

    await setLocale("zh");

    expect(copyBtn.getAttribute("aria-label")).toBe("复制消息");
    expect(copyBtn.title).toBe("复制消息");
    // Content must not be re-rendered on locale change.
    expect(el.querySelector(".message-content").innerHTML).toBe(contentHtmlBefore);
  });

  it("toggles thinking content within its own message element", () => {
    const el = renderer.renderAssistantMessage({
      content: [{ type: "thinking", thinking: "pondering" }],
    });
    const toggle = el.querySelector("[data-thinking-toggle]");
    const content = el.querySelector(".thinking-content");
    expect(toggle.getAttribute("id")).toBeNull();
    toggle.click();
    expect(content.classList.contains("expanded")).toBe(true);
    toggle.click();
    expect(content.classList.contains("expanded")).toBe(false);
  });

  it("updates thinking label text on locale change", async () => {
    const el = renderer.renderAssistantMessage(
      {
        content: [
          { type: "text", text: "answer" },
          { type: "thinking", thinking: "pondering" },
        ],
      },
      false,
    );
    const labelEl = el.querySelector(".thinking-label-text");
    expect(labelEl.textContent).toBe("Thinking");

    await setLocale("zh");

    expect(labelEl.textContent).toBe("思考中");
  });

  it("re-renders welcome on locale change when .welcome exists", async () => {
    renderer.renderWelcome({ workspacePath: "/home/user/project" });
    expect(container.querySelector(".welcome")).not.toBeNull();
    expect(container.textContent).toContain("Welcome to Picot");

    await setLocale("zh");

    expect(container.querySelector(".welcome")).not.toBeNull();
    expect(container.textContent).toContain("欢迎使用 Picot");
  });

  it("does not re-render streaming content on locale change and preserves _streamingRawText", async () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "partial **bold** text");
    expect(el._streamingRawText).toBe("partial **bold** text");

    const contentHtmlBefore = el.querySelector(".message-content").innerHTML;

    await setLocale("zh");

    expect(el._streamingRawText).toBe("partial **bold** text");
    expect(el.querySelector(".message-content").innerHTML).toBe(contentHtmlBefore);
  });
});

describe("MessageRenderer teardown", () => {
  it("clear() keeps the renderer live so a locale change still re-renders", async () => {
    const container = document.createElement("div");
    const renderer = new MessageRenderer(container);
    renderer.renderWelcome({});
    renderer.clear();
    renderer.renderWelcome({});
    await setLocale("zh");
    expect(container.querySelector(".welcome p").textContent).toBe("欢迎使用 Picot");
  });

  it("destroy() stops locale re-renders, removes the scroll listener, and is idempotent", async () => {
    const container = document.createElement("div");
    const removeSpy = vi.spyOn(container, "removeEventListener");
    const renderer = new MessageRenderer(container);
    renderer.renderWelcome({});
    const welcomeP = container.querySelector(".welcome p");
    expect(welcomeP.textContent).toBe("Welcome to Picot");

    renderer.destroy();
    expect(() => renderer.destroy()).not.toThrow();
    expect(removeSpy).toHaveBeenCalled();
    // No re-render after destroy: the welcome stays English.
    await setLocale("zh");
    expect(welcomeP.textContent).toBe("Welcome to Picot");
  });
});

describe("formatMessageTime", () => {
  it("returns HH:MM for a timestamp on the same calendar day", () => {
    const now = new Date();
    const sameDay = new Date(now).setHours(14, 32, 0, 0);
    expect(formatMessageTime(sameDay)).toBe("14:32");
  });

  it("returns MM/DD HH:MM for a timestamp on a different day", () => {
    const old = new Date(2020, 0, 9, 9, 5); // Jan 9 2020, 09:05
    expect(formatMessageTime(old.getTime())).toBe("01/09 09:05");
  });

  it("returns empty string for invalid / missing input", () => {
    expect(formatMessageTime(null)).toBe("");
    expect(formatMessageTime(undefined)).toBe("");
    expect(formatMessageTime(NaN)).toBe("");
    expect(formatMessageTime("not-a-date")).toBe("");
    // 1e20 is finite but out of Date's valid range → Invalid Date.
    expect(formatMessageTime(1e20)).toBe("");
  });
});

describe("MessageRenderer action toolbar", () => {
  let container;
  let renderer;

  beforeEach(() => {
    container = document.createElement("div");
    renderer = new MessageRenderer(container);
  });

  it("renderUserMessage builds a {time, copy} actions row", () => {
    const ts = new Date().setHours(14, 32, 7, 0);
    const el = renderer.renderUserMessage({ content: "hi", timestamp: ts });

    const actions = el.querySelector(".message-actions");
    expect(actions).not.toBeNull();
    // Slot order for user: time, then copy.
    const slots = actions.children;
    expect(slots[0].classList.contains("message-time")).toBe(true);
    expect(slots[0].textContent).toBe("14:32");
    expect(slots[1].classList.contains("message-copy-btn")).toBe(true);
    expect(slots[1].type).toBe("button");
    // Full timestamp exposed via title.
    expect(slots[0].title).toContain("14:32:07");
  });

  it("omits the time span when no timestamp is provided", () => {
    const el = renderer.renderUserMessage({ content: "hi" });
    const actions = el.querySelector(".message-actions");
    expect(actions).not.toBeNull();
    expect(actions.querySelector(".message-time")).toBeNull();
    expect(actions.querySelector(".message-copy-btn")).not.toBeNull();
    expect(actions.querySelector(".message-copy-btn").type).toBe("button");
  });

  it("renderAssistantMessage builds a {copy, time, usage} actions row", () => {
    const ts = new Date().setHours(14, 32, 0, 0);
    const el = renderer.renderAssistantMessage({
      content: "hello",
      timestamp: ts,
      usage: { cost: { total: 0.0123 } },
    });

    const actions = el.querySelector(".message-actions");
    expect(actions).not.toBeNull();
    const slots = actions.children;
    expect(slots[0].classList.contains("message-copy-btn")).toBe(true);
    expect(slots[1].classList.contains("message-time")).toBe(true);
    expect(slots[2].classList.contains("message-usage")).toBe(true);
    expect(slots[2].textContent).toBe("$0.0123");
  });

  it("streaming assistant renders no toolbar", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    expect(el.querySelector(".message-actions")).toBeNull();
  });

  it("suppressToolbar=true omits the whole actions row", () => {
    const el = renderer.renderAssistantMessage(
      { content: "process", timestamp: Date.now() },
      false,
      true,
      null,
      /* suppressToolbar */ true,
    );
    expect(el.querySelector(".message-actions")).toBeNull();
    expect(el.querySelector(".message-copy-btn")).toBeNull();
  });

  it("finalizeStreamingMessage attaches a {copy, time, usage} toolbar", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.updateStreamingMessage(el, "final answer");
    renderer.finalizeStreamingMessage(el, { cost: { total: 0.05 } });

    const actions = el.querySelector(".message-actions");
    expect(actions).not.toBeNull();
    expect(actions.querySelector(".message-copy-btn")).not.toBeNull();
    expect(actions.querySelector(".message-time")).not.toBeNull();
    expect(actions.querySelector(".message-usage").textContent).toBe("$0.0500");
  });

  it("finalizeStreamingMessage adds no toolbar when there is no copyable text", () => {
    const el = renderer.renderAssistantMessage({ content: "" }, true);
    renderer.finalizeStreamingMessage(el);
    expect(el.querySelector(".message-actions")).toBeNull();
  });

  it("image-only user message still gets a toolbar row (without copy button)", () => {
    const ts = new Date().setHours(14, 32, 0, 0);
    const el = renderer.renderUserMessage({
      content: "",
      images: [{ data: "abc", mimeType: "image/png" }],
      timestamp: ts,
    });
    const actions = el.querySelector(".message-actions");
    // Toolbar exists (spec: every user message keeps its toolbar).
    expect(actions).not.toBeNull();
    // Time span is present.
    expect(actions.querySelector(".message-time")).not.toBeNull();
    // No copy button (nothing text-copyable), but the row is there for
    // future actions.
    expect(actions.querySelector(".message-copy-btn")).toBeNull();
  });
});
