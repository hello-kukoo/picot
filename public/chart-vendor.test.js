// ABOUTME: Usage charts must load Chart.js from a same-origin vendor bundle.
// ABOUTME: Remote CDN scripts are incompatible with the desktop WebView CSP.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const root = process.cwd();
const chartBundlePath = resolve(root, "public/vendor/chart.js");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

test("cost dashboard loads Chart.js from the same-origin vendor bundle", () => {
  const html = read("public/cost.html");
  expect(html).toContain('<script src="vendor/chart.js"></script>');
  expect(html).not.toMatch(/cdn\.jsdelivr\.net/);
  expect(html).not.toMatch(/<script[^>]+src=["']https?:\/\//);
});

test("Tauri CSP keeps scripts same-origin", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  const csp = config.app?.security?.csp || "";
  expect(csp).toMatch(/script-src 'self'/);
  expect(csp).not.toMatch(/cdn\.jsdelivr\.net/);
});

test("Chart.js vendor entry exposes the chart constructor globally", () => {
  const entry = read("public/chart-vendor-entry.js");
  expect(entry).toContain('import Chart from "chart.js/auto"');
  expect(entry).toContain("globalThis.Chart = Chart");
});

test("frontend build includes the Chart.js vendor entry", () => {
  const buildScript = read("scripts/build-frontend.js");
  expect(buildScript).toContain('"public", "chart-vendor-entry.js"');
  expect(buildScript).toContain('"chart.js"');
  expect(read("package.json")).toContain('"chart.js": "4.4.3"');
});

// pretest regenerates the bundle before vitest; skip only when vitest runs
// directly without a prior build (e.g. focused runs on a clean checkout).
test.skipIf(!existsSync(chartBundlePath))(
  "generated vendor bundle stays classic-script loadable (IIFE, no module syntax)",
  () => {
    const bundle = read(chartBundlePath);
    expect(bundle.length).toBeGreaterThan(0);
    // Top-level module syntax throws a SyntaxError under a classic <script>
    // tag, and charts would silently vanish behind infobar.js's
    // typeof window.Chart guard while these tests stay green.
    expect(bundle).not.toMatch(/^[ \t]*(import|export)\b/m);
    expect(bundle).toContain("globalThis.Chart");
  },
);
