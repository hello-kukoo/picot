// ABOUTME: Owns the session-aggregate usage cluster in the composer (↑in ↓out ⚡cache).
// ABOUTME: Completely separate from the current-context (lastUsage) lifecycle so a
// ABOUTME: successful Compact can invalidate stale context without fabricating usage.
// ABOUTME: Session cost lives on each turn's own footer, never in the chrome.

import { createIcon } from "../icons.js";

const DEFAULT_CONTEXT_THRESHOLDS = { warning: 0.6, critical: 0.8 };

/** One icon + bare-number cluster segment (↑1.2K); icon optional. */
function appendUsageSegment(container, iconName, tokens) {
  const seg = document.createElement("span");
  seg.className = "composer-usage-seg";
  const icon = createIcon(iconName, { size: 10 });
  if (icon) seg.appendChild(icon);
  seg.appendChild(document.createTextNode(formatTokens(tokens)));
  container.appendChild(seg);
}

/** Compact a raw token count into a short suffixed string (M / K / raw). */
function formatTokens(value) {
  const n = finiteAmount(value);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function finiteAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function sum(prev, next) {
  return finiteAmount(prev) + finiteAmount(next);
}

/**
 * Build the composer's session-aggregate token cluster (sourced only from
 * `hydrateSessionStats` and post-hydration `applyLiveUsage`) plus the
 * current-context percentage (sourced independently by the caller).
 *
 * Aggregate totals are intentionally not derived from `lastUsage`/history
 * replay: repeated mirror syncs and history rendering must never increment
 * them. Only the authoritative `get_session_stats` hydration and new live
 * assistant completions for the same active session contribute.
 *
 * @param {{sessionUsageEl:HTMLElement, tokenUsageEl:HTMLElement, getContextWindowSize:()=>number, thresholds?:{warning:number,critical:number}}} deps
 * @returns {{applyLiveUsage, hydrateSessionStats, reset, sync}}
 */
export function createHeaderStatusBar({
  sessionUsageEl,
  tokenUsageEl,
  getContextWindowSize,
  thresholds = DEFAULT_CONTEXT_THRESHOLDS,
}) {
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let hydratedSessionFile = null;
  let hasHydrated = false;
  let currentUsage = null;

  function renderAggregate() {
    if (totals.input <= 0 && totals.output <= 0 && totals.cacheRead <= 0) {
      sessionUsageEl.replaceChildren();
      sessionUsageEl.removeAttribute("title");
      sessionUsageEl.classList.remove("visible");
    } else {
      // Compact icon+number segments (↑in ↓out ⚡cache): no words, the
      // title tooltip carries the semantics.
      sessionUsageEl.replaceChildren();
      appendUsageSegment(sessionUsageEl, "arrow-up", totals.input);
      appendUsageSegment(sessionUsageEl, "arrow-down", totals.output);
      // Cache reads are optional context; hide the segment at zero.
      if (totals.cacheRead > 0) appendUsageSegment(sessionUsageEl, "zap", totals.cacheRead);
      sessionUsageEl.classList.add("visible");
    }
    renderContextThreshold();
  }

  function renderContextThreshold() {
    const contextWindow = getContextWindowSize?.() ?? 0;
    tokenUsageEl?.classList.remove("warning", "critical");
    if (!currentUsage || contextWindow <= 0) return;
    const used = sum(currentUsage.input, currentUsage.cacheRead);
    const ratio = used / contextWindow;
    if (ratio >= thresholds.critical) tokenUsageEl?.classList.add("critical");
    else if (ratio >= thresholds.warning) tokenUsageEl?.classList.add("warning");
  }

  function reset() {
    totals.input = 0;
    totals.output = 0;
    totals.cacheRead = 0;
    totals.cacheWrite = 0;
    hydratedSessionFile = null;
    hasHydrated = false;
    currentUsage = null;
    tokenUsageEl?.classList.remove("visible", "warning", "critical");
    renderAggregate();
  }

  function hydrateSessionStats({ sessionFile, tokens } = {}) {
    // The authoritative aggregate. Re-hydrating the same session replaces
    // (never accumulates) so repeated mirror syncs cannot double-count.
    // A missing identity is not safe to apply because it could belong to a
    // previous session after an in-place switch.
    if (!sessionFile) return false;
    if (hydratedSessionFile && sessionFile !== hydratedSessionFile) return false;
    hydratedSessionFile = sessionFile;
    hasHydrated = true;
    // `tokens: null` is the authoritative zero state for a session with no
    // assistant usage yet; it must not leave stale totals on screen.
    totals.input = Number.isFinite(tokens?.input) ? Math.max(0, tokens.input) : 0;
    totals.output = Number.isFinite(tokens?.output) ? Math.max(0, tokens.output) : 0;
    totals.cacheRead = Number.isFinite(tokens?.cacheRead) ? Math.max(0, tokens.cacheRead) : 0;
    totals.cacheWrite = Number.isFinite(tokens?.cacheWrite) ? Math.max(0, tokens.cacheWrite) : 0;
    renderAggregate();
    return true;
  }

  function applyLiveUsage({ input, output, cacheRead, cacheWrite } = {}, { sessionFile } = {}) {
    // Live usage is accepted only after the active session identity has been
    // authoritatively hydrated. Unknown identities and the reset-to-hydration
    // race are deliberately dropped; the caller requests a fresh hydration
    // instead of risking cross-session or replay double-counting.
    if (!sessionFile || !hasHydrated || sessionFile !== hydratedSessionFile) return false;
    totals.input = sum(totals.input, finiteAmount(input));
    totals.output = sum(totals.output, finiteAmount(output));
    totals.cacheRead = sum(totals.cacheRead, finiteAmount(cacheRead));
    totals.cacheWrite = sum(totals.cacheWrite, finiteAmount(cacheWrite));
    renderAggregate();
    return true;
  }

  function sync({ currentUsage: nextUsage } = {}) {
    currentUsage = nextUsage ?? null;
    renderContextThreshold();
  }

  return { applyLiveUsage, hydrateSessionStats, reset, sync };
}
