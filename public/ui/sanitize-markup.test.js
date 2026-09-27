// ABOUTME: Security coverage for the shared markup sanitizer: model output is
// ABOUTME: untrusted and the WebView has no CSP, so every escape must die here.
import { afterEach, beforeEach, expect, test } from "vitest";
import { parseSanitizedMarkup, sanitizeMarkup } from "./sanitize-markup.js";

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(markup) {
  const fragment = parseSanitizedMarkup(markup);
  const host = document.createElement("div");
  host.appendChild(fragment);
  document.body.appendChild(host);
  return host;
}

test("strips event handlers and javascript: hrefs", () => {
  const host = mount('<p onclick="steal()">hi <a href="javascript:steal()">x</a></p>');
  const p = host.querySelector("p");
  expect(p.getAttribute("onclick")).toBeNull();
  const link = host.querySelector("a");
  expect(link.getAttribute("href")).toBeNull();
});

test("strips a javascript: xlink:href — SVG treats it as an href alias", () => {
  const host = mount('<svg><a xlink:href="javascript:steal()"><text>x</text></a></svg>');
  const link = host.querySelector("a");
  expect(link.getAttribute("xlink:href")).toBeNull();
});

test("drops base entirely — a foreign base hijacks every relative link after it", () => {
  const host = mount('<base href="https://evil.example/"><p>ok</p>');
  expect(host.querySelector("base")).toBeNull();
  expect(host.querySelector("p").textContent).toBe("ok");
});

test("removes blocked subtrees, not just the element", () => {
  const host = mount("<div><script>steal()</script><p>kept</p></div>");
  expect(host.querySelector("script")).toBeNull();
  expect(host.querySelectorAll("p")).toHaveLength(1);
});

test("keeps https/mailto/anchor hrefs and safe data: image srcs", () => {
  const host = mount(
    '<a href="https://ok.example/a">a</a><a href="mailto:x@y.z">m</a>' +
      '<a href="#sec">s</a><img src="data:image/png;base64,AAAA">',
  );
  expect(host.querySelectorAll("a[href]").length).toBe(3);
  expect(host.querySelector("img").getAttribute("src")).toMatch(/^data:image\/png/);
});

test("sanitizeMarkup works on an in-place subtree too", () => {
  const div = document.createElement("div");
  div.innerHTML = '<img src="https://ok.example/x.png" onerror="steal()">';
  sanitizeMarkup(div);
  expect(div.querySelector("img").getAttribute("onerror")).toBeNull();
  expect(div.querySelector("img").getAttribute("src")).toBe("https://ok.example/x.png");
});
