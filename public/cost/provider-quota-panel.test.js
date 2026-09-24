// ABOUTME: Provider quota panel tests (spec 2026-09-22) — render contract,
// ABOUTME: empty-state hiding, and the reset-credit double-channel flow.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createProviderQuotaPanel } from "./provider-quota-panel.js";

const locale = {
  sectionTitle: "Provider Quota",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  fiveHour: "5-hour limit",
  weekly: "Weekly limit",
  monthly: "30-day limit",
  needsLogin: "Re-login required",
  unavailable: "Temporarily unavailable",
  justNow: "just now",
  minutesAgo: "{n}m ago",
  hoursAgo: "{n}h ago",
  resetsInHours: "resets in {n}h",
  resetsInDays: "resets in {n}d",
  resetCredits: "Reset quota ({n} left)",
  resetDialogTitle: "Reset quota",
  resetDialogBody: "This spends one reset credit and cannot be undone.",
  creditGranted: "Granted {time}",
  creditExpires: "Expires {time}",
  creditUnknown: "Expiry unknown",
  resetsInMinutes: "resets in {n}m",
  resetsAt: "resets {when}",
  used: "{n}% used",
  resetDialogScope: "OpenAI Codex plan",
  dialogRedeem: "Use 1 credit",
  creditIndexed: "Credit #{n}",
  resetPrefix: "Resets",
  today: "today",
  balance: "Balance",
  resetCreditsAvailable: "You have {count} available reset credits.",
  creditNext: "Up next",
  creditDaysLeft: " ({days} days left)",
  creditExpired: "(expired)",
  creditNone: "No reset credits available",
  creditEarnHint: "Reset credits are granted by the plan.",
  fifoNote: "The earliest credit is used first.",
  confirmResetDesc: "This spends one of your {count} reset credits and cannot be undone.",
  confirmWhichCredit: "Will spend the credit granted {date}.",
  irreversible: "This cannot be undone.",
  dialogProceed: "Continue",
  dialogConfirm: "Reset now",
  dialogCancel: "Cancel",
  toastUnavailable: "Cannot open the reset operation right now",
  toastUnknown:
    "Result unknown: it may already have applied. Retrying is safe — the same request id is reused, so the server reports if it already applied.",
  toastInFlight: "An operation is already in progress",
  toastNeedsLogin: "Re-login required before resetting",
  toastResetDone: "Quota reset",
  toastNothingToReset: "Nothing to reset",
  toastNoCredit: "No reset credits left",
};

const DAY = 86_400;
const NOW_SEC = Math.floor(Date.now() / 1000);

let container;

/** Drives the two-step reset dialog to its confirm button. Every ledger op is a
 * stub in this suite, so no real reset credit can be spent. */
async function confirmResetDialog() {
  container.querySelector(".quota-reset-chip").click();
  await advance();
  // Single screen: the action button is the only step (screenshot layout).
  document.querySelector(".quota-dialog-action").click();
  await advance();
}

function advance() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  // A dialog left open would leak into the next case's assertions.
  for (const overlay of document.querySelectorAll(".file-preview-dialog-overlay")) {
    overlay.remove();
  }
});

const SAMPLE_CREDITS = [{ grantedAt: 1_760_000_000, expiresAt: 1_790_000_000 }];

function makeSeams({ reports = [], consumeResult, openError, inspectData } = {}) {
  const gateway = {
    call: vi.fn(async (op) => {
      // The gateway resolves with the handler payload `{ ok, data }` — the
      // shape extensions/picot-config.ts returns and models-page.js reads.
      if (op === "provider_quota_report") return { ok: true, data: { reports } };
      if (op === "codex_reset_credits_inspect") {
        return { ok: true, data: inspectData ?? { credits: SAMPLE_CREDITS } };
      }
      if (op === "codex_reset_credits_consume") {
        return { ok: true, data: consumeResult ?? { code: "reset" } };
      }
      return {};
    }),
  };
  const dataTransport = {
    resetCreditOpen: vi.fn(async () => {
      if (openError) throw openError;
      return { operationId: "op-uuid-1" };
    }),
    resetCreditSettle: vi.fn(async () => ({})),
  };
  return {
    gateway,
    dataTransport,
    container: () => container,
  };
}

test("renders one card per report with window bars and hides when empty", async () => {
  const seams = makeSeams({
    reports: [
      {
        provider: "openai-codex",
        source: "openai-codex:wham",
        quota: {
          fiveHourPercent: 82,
          weeklyPercent: 40,
          monthlyPercent: 10,
          resetCredits: 2,
          updatedAt: Date.now(),
        },
      },
      {
        provider: "deepseek",
        source: "deepseek:balance",
        quota: { customWindows: [{ label: "CNY 10.50", percent: 0 }], updatedAt: Date.now() },
      },
    ],
  });
  const panel = createProviderQuotaPanel(seams, { locale });
  await panel.loadReports();
  expect(container.classList.contains("hidden")).toBe(false);
  expect(container.querySelectorAll(".quota-card")).toHaveLength(2);
  const bars = container.querySelectorAll(".quota-row");
  expect(bars).toHaveLength(4); // 3 codex windows + 1 balance label
  expect(container.textContent).toContain("OpenAI Codex");
  const chip = container.querySelector(".quota-reset-chip");
  expect(chip?.textContent).toContain("2");
  expect(chip?.querySelector("svg")).not.toBeNull();
});

test("hides the whole section when no provider reports", async () => {
  const seams = makeSeams({ reports: [] });
  const panel = createProviderQuotaPanel(seams, { locale });
  await panel.loadReports();
  expect(container.classList.contains("hidden")).toBe(true);
  expect(container.querySelectorAll(".quota-card")).toHaveLength(0);
});

test("needs_login renders its note and no reset button without credits", async () => {
  const seams = makeSeams({
    reports: [{ provider: "openai-codex", source: "openai-codex:wham", failure: "needs_login" }],
  });
  const panel = createProviderQuotaPanel(seams, { locale });
  await panel.loadReports();
  expect(container.textContent).toContain("Re-login required");
  expect(container.querySelector(".quota-reset-chip")).toBeNull();
});

test("reset click runs the open→consume→settle ledger flow", async () => {
  const seams = makeSeams({
    reports: [
      {
        provider: "openai-codex",
        source: "openai-codex:wham",
        quota: { fiveHourPercent: 90, resetCredits: 1, updatedAt: Date.now() },
      },
    ],
    consumeResult: { code: "reset" },
  });
  const panel = createProviderQuotaPanel(seams, { locale });
  await panel.loadReports();
  const toasts = [];
  window.addEventListener("picot-toast", (event) => toasts.push(event.detail.message));
  await confirmResetDialog();
  expect(seams.dataTransport.resetCreditOpen).toHaveBeenCalledTimes(1);
  expect(seams.gateway.call).toHaveBeenCalledWith("codex_reset_credits_consume", {
    operationId: "op-uuid-1",
  });
  expect(seams.dataTransport.resetCreditSettle).toHaveBeenCalledWith({
    operationId: "op-uuid-1",
    ambiguous: false,
  });
  expect(toasts).toContain("Quota reset");
});

test("an ambiguous consume settles ambiguous and toasts the unknown result", async () => {
  const seams = makeSeams({
    reports: [
      {
        provider: "openai-codex",
        source: "openai-codex:wham",
        quota: { fiveHourPercent: 90, resetCredits: 1, updatedAt: Date.now() },
      },
    ],
    consumeResult: { failure: "ambiguous" },
  });
  const panel = createProviderQuotaPanel(seams, { locale });
  await panel.loadReports();
  const toasts = [];
  window.addEventListener("picot-toast", (event) => toasts.push(event.detail.message));
  await confirmResetDialog();
  expect(seams.dataTransport.resetCreditSettle).toHaveBeenCalledWith({
    operationId: "op-uuid-1",
    ambiguous: true,
  });
  expect(toasts).toContain(
    "Result unknown: it may already have applied. Retrying is safe — the same request id is reused, so the server reports if it already applied.",
  );
});

test("a failed ledger open never reaches consume", async () => {
  const seams = makeSeams({
    reports: [
      {
        provider: "openai-codex",
        source: "openai-codex:wham",
        quota: { fiveHourPercent: 90, resetCredits: 1, updatedAt: Date.now() },
      },
    ],
    openError: new Error("ledger down"),
  });
  const panel = createProviderQuotaPanel(seams, { locale });
  await panel.loadReports();
  const toasts = [];
  window.addEventListener("picot-toast", (event) => toasts.push(event.detail.message));
  await confirmResetDialog();
  // The consume op never ran; the refresh-after-attempt report call is fine.
  const consumeCalls = seams.gateway.call.mock.calls.filter(
    (args) => args[0] === "codex_reset_credits_consume",
  );
  expect(consumeCalls).toHaveLength(0);
  expect(toasts).toContain("Cannot open the reset operation right now");
});

test("reset lists credits oldest-first and highlights the next one", async () => {
  const seams = makeSeams({
    reports: [
      {
        provider: "openai-codex",
        source: "openai-codex:wham",
        quota: { fiveHourPercent: 90, resetCredits: 2, updatedAt: Date.now() },
      },
    ],
    inspectData: {
      credits: [
        { grantedAt: NOW_SEC - 3 * DAY, expiresAt: NOW_SEC + 40 * DAY },
        { grantedAt: NOW_SEC - 30 * DAY, expiresAt: NOW_SEC + 5 * DAY },
      ],
    },
  });
  const panel = createProviderQuotaPanel(seams, { locale });
  await panel.loadReports();
  container.querySelector(".quota-reset-chip").click();
  await advance();

  expect(seams.gateway.call).toHaveBeenCalledWith("codex_reset_credits_inspect", {});
  expect(document.querySelector(".quota-dialog-count")?.textContent).toContain("2");
  const rows = [...document.querySelectorAll(".quota-credit-row")];
  expect(rows).toHaveLength(2);
  const oldestGranted = new Date((NOW_SEC - 30 * DAY) * 1000).toLocaleDateString();
  expect(rows[0].classList.contains("is-next")).toBe(true);
  expect(rows[0].textContent).toContain("Up next");
  expect(rows[0].querySelector(".quota-credit-chip")?.textContent).toBe("NEXT");
  expect(rows[0].textContent).toContain("Granted");
  expect(rows[0].textContent).toContain(oldestGranted);
  expect(rows[0].textContent).toContain("Expires");
  expect(rows[0].textContent).toContain("days left");
  expect(rows[1].textContent).toContain("Credit #2");
  expect(document.querySelector(".quota-dialog-note")?.textContent).toContain("earliest");
  expect(seams.dataTransport.resetCreditOpen).not.toHaveBeenCalled();

  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await advance();
  expect(document.querySelector(".file-preview-dialog-overlay")).toBeNull();
  expect(seams.dataTransport.resetCreditOpen).not.toHaveBeenCalled();
});

test("escaping the reset dialog never touches the ledger", async () => {
  const seams = makeSeams({
    reports: [
      {
        provider: "openai-codex",
        source: "openai-codex:wham",
        quota: { fiveHourPercent: 90, resetCredits: 1, updatedAt: Date.now() },
      },
    ],
  });
  const panel = createProviderQuotaPanel(seams, { locale });
  await panel.loadReports();
  container.querySelector(".quota-reset-chip").click();
  await advance();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await advance();
  expect(document.querySelector(".file-preview-dialog-overlay")).toBeNull();
  expect(seams.dataTransport.resetCreditOpen).not.toHaveBeenCalled();
  expect(seams.dataTransport.resetCreditSettle).not.toHaveBeenCalled();
});

test("inspect reporting needs_login shows no dialog and no ledger call", async () => {
  const seams = makeSeams({
    reports: [
      {
        provider: "openai-codex",
        source: "openai-codex:wham",
        quota: { fiveHourPercent: 90, resetCredits: 1, updatedAt: Date.now() },
      },
    ],
    inspectData: { failure: "needs_login", credits: [] },
  });
  const panel = createProviderQuotaPanel(seams, { locale });
  await panel.loadReports();
  const toasts = [];
  window.addEventListener("picot-toast", (event) => toasts.push(event.detail.message));
  container.querySelector(".quota-reset-chip").click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(document.querySelector(".file-preview-dialog-overlay")).toBeNull();
  expect(toasts).toContain("Re-login required before resetting");
  expect(seams.dataTransport.resetCreditOpen).not.toHaveBeenCalled();
});

test("an unconfigured provider is absent instead of shown as unavailable", async () => {
  const seams = makeSeams({
    reports: [
      { provider: "openai-codex", source: "openai-codex:wham", failure: "not_configured" },
      { provider: "deepseek", source: "deepseek:balance", failure: "not_configured" },
      {
        provider: "opencode-go",
        source: "opencode-go:usage",
        quota: { fiveHourPercent: 42, updatedAt: Date.now() },
      },
    ],
  });
  const panel = createProviderQuotaPanel(seams, { locale });
  await panel.loadReports();
  const names = [...container.querySelectorAll(".quota-card-name")].map((el) => el.textContent);
  expect(names).toEqual(["Opencode Go"]);
  expect(container.querySelectorAll(".quota-failure")).toHaveLength(0);
});

test("shows the head while the first probe is in flight, hides when settled empty", async () => {
  const seams = makeSeams({ reports: [] });
  let release = () => {};
  seams.gateway.call = vi.fn((op) =>
    op === "provider_quota_report"
      ? new Promise((resolve) => {
          release = () => resolve({ ok: true, data: { reports: [] } });
        })
      : Promise.resolve({ ok: true, data: { credits: [] } }),
  );
  const panel = createProviderQuotaPanel(seams, { locale });
  const pending = panel.loadReports();

  // In flight: the page must not look blank (this is what "配额 page is empty"
  // looked like — the first probe takes seconds).
  expect(container.classList.contains("hidden")).toBe(false);
  expect(container.querySelector(".quota-refresh-btn")?.textContent).toBe("Refreshing…");

  release();
  await pending;
  // Settled empty still hides the whole section (spec: no placeholder).
  expect(container.classList.contains("hidden")).toBe(true);
  expect(container.querySelector(".quota-section-head")).toBeNull();
});
