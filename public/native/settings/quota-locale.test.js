// ABOUTME: quotaLocaleBundle wiring guard — every panel-consumed key must
// ABOUTME: resolve in the real locale table, not fall back to the raw key.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";

test("quota locale bundle resolves every key in the real en table", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      if (String(input).includes("/locales/en.json")) {
        const data = JSON.parse(
          readFileSync(join(process.cwd(), "public/locales/en.json"), "utf8"),
        );
        return new Response(JSON.stringify(data));
      }
      return new Response("{}", { status: 404 });
    }),
  );
  const { initI18n } = await import("../../i18n.js");
  await initI18n();
  const { quotaLocaleBundle } = await import("./quota-locale.js");
  const bundle = quotaLocaleBundle();
  // A missing key makes t() return the raw dotted key, which once crashed
  // formatResetStamp (locale.resetsInHours was undefined through this gap).
  const unwired = Object.entries(bundle).filter(
    ([, value]) => !value || value.startsWith("cost.quota."),
  );
  expect(unwired, `unwired keys: ${unwired.map(([k]) => k).join(", ")}`).toEqual([]);
});
