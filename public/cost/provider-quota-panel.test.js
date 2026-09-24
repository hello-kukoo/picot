// ABOUTME: Provider quota panel tests (spec 2026-09-22) — render contract,
// ABOUTME: empty-state hiding, and the reset-credit double-channel flow.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createProviderQuotaPanel } from "./provider-quota-panel.js";

const locale = {
  sectionTitle: "Provider Quota",
  refresh: "Refresh",
  refreshing: "Refreshing…",
  fiveHour: "5h window",
  weekly: "Weekly",
  monthly: "Monthly",
  needsLogin: "Re-login required",
  unavailable: "Temporarily unavailable",
  justNow: "just now",
  minutesAgo: "{n}m ago",
  hoursAgo: "{n}h ago",
  resetsInMinutes: "resets in {n}m",
  resetsInHours: "resets in {n}h",
  resetsInDays: "resets in {n}d",
  resetCredits: "Reset quota ({n} left)",
  resetDialogTitle: "Reset quota",
  resetDialogBody: "This spends one reset credit and cannot be undone.",
  creditGranted: "Granted {time}",
  creditExpires: "Expires {time}",
  creditUnknown: "Expiry unknown",
  resetCreditsAvailable: "Reset credits available: {count}",
  creditNext: "Next to use",
  creditDaysLeft: "{days} days left",
  creditExpired: "Expired",
  creditNone: "No reset credits available",
  creditEarnHint: "Reset credits are granted by the plan.",
  fifoNote: "Credits are spent oldest first.",
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
  container.querySelector(".quota-reset-btn").click();
  await advance();
  document.querySelector(".file-preview-dialog-button.primary").click(); // continue
  await advance();
  document.querySelector(".file-preview-dialog-button.primary").click(); // confirm
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

const SAMPLE_CREDITS = [{ granted_at: 1_760_000_000, expires_at: 1_790_000_000 }];

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
  const bars = container.querySelectorAll(".quota-window");
  expect(bars).toHaveLength(4); // 3 codex windows + 1 balance label
  expect(container.textContent).toContain("OpenAI Codex");
  expect(container.textContent).toContain("Reset quota (2 left)");
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
  expect(container.querySelector(".quota-reset-btn")).toBeNull();
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

test("reset lists credits oldest-first with absolute times, then confirms", async () => {
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
        // Deliberately out of order: the list must come back oldest-first.
        // The older credit also expires within the urgency window.
        { granted_at: NOW_SEC - 3 * DAY, expires_at: NOW_SEC + 40 * DAY },
        { granted_at: NOW_SEC - 30 * DAY, expires_at: NOW_SEC + 5 * DAY },
      ],
    },
  });
  const panel = createProviderQuotaPanel(seams, { locale });
  await panel.loadReports();
  container.querySelector(".quota-reset-btn").click();
  await advance();

  // Step 1: inventory only — nothing spent.
  expect(seams.gateway.call).toHaveBeenCalledWith("codex_reset_credits_inspect", {});
  expect(document.querySelector(".quota-reset-count")?.textContent).toContain("2");
  const rows = [...document.querySelectorAll(".quota-credit-row")];
  expect(rows).toHaveLength(2);
  const oldestGranted = new Date((NOW_SEC - 30 * DAY) * 1000).toLocaleString();
  expect(rows[0].classList.contains("is-next")).toBe(true);
  expect(rows[0].textContent).toContain("Next to use");
  expect(rows[0].textContent).toContain(oldestGranted);
  expect(rows[0].textContent).toContain(new Date((NOW_SEC + 5 * DAY) * 1000).toLocaleString());
  expect(rows[0].textContent).toContain("days left");
  expect(rows[0].classList.contains("is-urgent")).toBe(true);
  expect(rows[1].classList.contains("is-next")).toBe(false);
  expect(document.querySelector(".quota-reset-note")?.textContent).toContain("oldest first");
  expect(seams.dataTransport.resetCreditOpen).not.toHaveBeenCalled();

  // Step 2: which credit this spends, and that it cannot be undone.
  document.querySelector(".file-preview-dialog-button.primary").click();
  await advance();
  const text = document.querySelector(".quota-reset-dialog")?.textContent ?? "";
  expect(text).toContain("Will spend the credit granted");
  expect(text).toContain(oldestGranted);
  expect(text).toContain("This cannot be undone.");
  expect(seams.dataTransport.resetCreditOpen).not.toHaveBeenCalled();

  // Escape abandons it; the ledger stays untouched.
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await advance();
  expect(document.querySelector(".file-preview-dialog-overlay")).toBeNull();
  expect(seams.dataTransport.resetCreditOpen).not.toHaveBeenCalled();
});

test("cancelling the reset dialog never touches the ledger", async () => {
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
  container.querySelector(".quota-reset-btn").click();
  await advance();
  // Step 1's ghost button is cancel; step 2 has its own cancel as well.
  document.querySelectorAll(".file-preview-dialog-button")[0].click();
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
  container.querySelector(".quota-reset-btn").click();
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
