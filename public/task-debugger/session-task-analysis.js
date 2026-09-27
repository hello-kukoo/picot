// ABOUTME: In-panel task analysis -- where the time went, what failed, what got
// ABOUTME: stuck, which steps were redundant, and the model's own reading of it.

/**
 * Task analysis: a compact summary row in the Info panel rail (title + total
 * elapsed time) that opens a dialog with the full report. The report itself
 * -- phase split, findings, slowest steps -- has too many stacked sections
 * to read as an inline block in a ~280px rail; it earns a proper modal
 * instead. It stays a report on trouble, not a full run log: findings are
 * pared to the ones that explain a failure or a slow step, and the step
 * list is capped to the 5 slowest rather than every step the turn took.
 *
 * Answers the four questions a "why was this slow / why did it fail" report has
 * to answer, from the spans `turn-trace.js` recorded:
 *
 *   1. Where did the time go?  -> phase split (model / tool / compaction / idle)
 *   2. What got stuck?         -> longest span, plus spans that never ended
 *   3. Where did it fail?      -> first failing span and every later one
 *   4. What was wasted?        -> identical tool calls, retry loops, re-reads
 *
 * Turns this window watched come from the recorder; everything before that -- a
 * reopened session, a restarted app -- is rebuilt from the saved session log
 * when `loadHistoryTurns` is supplied. The two are merged with live winning
 * where they overlap (see `mergeTurnSources`), so the section is useful on the
 * first open rather than only after the next task runs.
 *
 * Nothing here decides anything about the turn: `analyze` (turn-analysis.js) is
 * a pure function and the optional AI block is the only model call, kept behind
 * its own button because it costs a real request.
 */

import { t as translate } from "../i18n.js";
import { createIcon } from "../icons.js";
import { bindDialogEscape } from "../ui/dialog-escape.js";
import { createSessionAiAnalysis } from "./session-ai-analysis.js";
import { analyzeTurns, formatMs, formatShare } from "./turn-analysis.js";
import { mergeTurnSources } from "./turn-history.js";

const PHASE_ORDER = ["model", "tool", "compaction", "idle"];

let instanceSeq = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Turn a report into a paste-ready Markdown summary (bug reports, issues). */
export function buildMarkdownReport(report, t = translate) {
  const lines = [];
  lines.push(`# ${t("taskDebugger.title")}`);
  lines.push("");
  lines.push(
    `- ${t("taskDebugger.statusLabel")}: ${t(`taskDebugger.status.${report.status}`)}`,
    `- ${t("taskDebugger.totalTime")}: ${formatMs(report.totals.wallMs)}`,
    `- ${t("taskDebugger.phase.model")}: ${formatMs(report.totals.modelMs)}`,
    `- ${t("taskDebugger.phase.tool")}: ${formatMs(report.totals.toolMs)} (${report.totals.toolCalls})`,
    `- ${t("taskDebugger.phase.idle")}: ${formatMs(report.totals.idleMs)}`,
  );
  if (report.totals.wastedMs > 0) {
    lines.push(`- ${t("taskDebugger.wasted")}: ${formatMs(report.totals.wastedMs)}`);
  }
  const findings = problemFindings(report);
  if (findings.length) {
    lines.push("", `## ${t("taskDebugger.findings")}`);
    for (const finding of findings) {
      lines.push(
        `- **${t(`taskDebugger.severity.${finding.severity}`)}** ${findingText(finding, t)}`,
      );
    }
  }
  if (report.slowest.length) {
    lines.push("", `## ${t("taskDebugger.slowest")}`);
    for (const step of report.slowest) {
      lines.push(
        `- ${step.label}${step.detail ? ` (${step.detail})` : ""} - ${formatMs(step.durationMs)} (${formatShare(step.share)})`,
      );
    }
  }
  if (report.failures.length) {
    lines.push("", `## ${t("taskDebugger.failures")}`);
    for (const failure of report.failures) {
      lines.push(`- ${failure.label}: ${failure.error || t("taskDebugger.unknownError")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function findingText(finding, t) {
  return t(`taskDebugger.finding.${finding.code}`, finding.params || {});
}

/**
 * "Info" findings (tool/model-bound, compaction, "nothing stands out") are
 * commentary, not problems. The report exists to answer "why did this fail"
 * and "why did this take so long" -- keep only the findings that answer one
 * of those two questions.
 */
function problemFindings(report) {
  return report.findings.filter((finding) => finding.severity !== "info");
}

function renderSummary(report, t) {
  const section = element("section", "session-analysis-summary");
  const status = element(
    "span",
    `session-analysis-status session-analysis-status--${report.status}`,
  );
  status.textContent = t(`taskDebugger.status.${report.status}`);
  const headline = element("div", "session-analysis-headline");
  headline.append(status, element("strong", "", formatMs(report.totals.wallMs)));
  section.appendChild(headline);

  const stats = element("div", "session-analysis-stats");
  const rows = [
    [t("taskDebugger.turns"), String(report.totals.turns)],
    [t("taskDebugger.toolCalls"), String(report.totals.toolCalls)],
    [t("taskDebugger.failures"), String(report.totals.failureCount)],
    [t("taskDebugger.wasted"), formatMs(report.totals.wastedMs)],
  ];
  if (report.totals.usage.cost > 0) {
    rows.push([t("taskDebugger.cost"), `$${report.totals.usage.cost.toFixed(4)}`]);
  }
  for (const [label, value] of rows) {
    const stat = element("div", "session-analysis-stat");
    stat.append(
      element("span", "session-analysis-stat-label", label),
      element("span", "session-analysis-stat-value", value),
    );
    stats.appendChild(stat);
  }
  section.appendChild(stats);
  return section;
}

function renderPhases(report, t) {
  const section = element("section", "session-analysis-section");
  section.appendChild(element("h3", "session-analysis-heading", t("taskDebugger.timeSplit")));

  const bar = element("div", "session-analysis-bar");
  for (const kind of PHASE_ORDER) {
    const phase = report.phases.find((entry) => entry.kind === kind);
    if (!phase || phase.ms <= 0) continue;
    const segment = element(
      "span",
      `session-analysis-bar-segment session-analysis-bar-segment--${kind}`,
    );
    segment.style.flexGrow = String(phase.ms);
    segment.title = `${t(`taskDebugger.phase.${kind}`)} ${formatMs(phase.ms)}`;
    bar.appendChild(segment);
  }
  if (!bar.childElementCount) bar.appendChild(element("span", "session-analysis-bar-empty"));
  section.appendChild(bar);

  const legend = element("ul", "session-analysis-legend");
  for (const kind of PHASE_ORDER) {
    const phase = report.phases.find((entry) => entry.kind === kind);
    if (!phase) continue;
    const item = element(
      "li",
      `session-analysis-legend-item session-analysis-legend-item--${kind}`,
    );
    item.append(
      element("span", "session-analysis-legend-label", t(`taskDebugger.phase.${kind}`)),
      element(
        "span",
        "session-analysis-legend-value",
        `${formatMs(phase.ms)} · ${formatShare(phase.share)}`,
      ),
    );
    legend.appendChild(item);
  }
  section.appendChild(legend);
  return section;
}

function renderFindings(report, t) {
  const findings = problemFindings(report);
  if (!findings.length) return null;
  const section = element("section", "session-analysis-section");
  section.appendChild(element("h3", "session-analysis-heading", t("taskDebugger.findings")));
  const list = element("ul", "session-analysis-findings");
  for (const finding of findings) {
    const item = element(
      "li",
      `session-analysis-finding session-analysis-finding--${finding.severity}`,
    );
    item.append(
      element(
        "span",
        "session-analysis-finding-severity",
        t(`taskDebugger.severity.${finding.severity}`),
      ),
      element("span", "session-analysis-finding-text", findingText(finding, t)),
    );
    list.appendChild(item);
  }
  section.appendChild(list);
  return section;
}

/**
 * The report's only step-level view: the top 5 slowest steps, not the full
 * run. A turn can have dozens of steps and most of them are unremarkable --
 * showing all of them buries the ones that actually explain where the time
 * went.
 */
function renderSteps(report, t) {
  if (!report.slowest.length) return null;
  const section = element("section", "session-analysis-section");
  section.appendChild(element("h3", "session-analysis-heading", t("taskDebugger.slowest")));
  const list = element("ol", "session-analysis-steps");
  for (const step of report.slowest) {
    list.appendChild(stepRow(step, t));
  }
  section.appendChild(list);
  return section;
}

/**
 * A model step can close with no `text` block at all -- a completion that is
 * nothing but tool calls, or pure reasoning with no visible reply -- and
 * without a fallback the row shows a duration and nothing else, which reads
 * as missing data rather than as "this step didn't say anything."
 */
function stepDetail(step, t) {
  if (step.detail) return step.detail;
  if (step.kind === "model" && step.toolNames?.length) {
    return t("taskDebugger.stepToolCalls", { tools: step.toolNames.join(", ") });
  }
  if (step.kind === "model") return t("taskDebugger.stepNoOutput");
  return "";
}

function stepRow(step, t) {
  const item = element("li", `session-analysis-step session-analysis-step--${step.status}`);
  const head = element("div", "session-analysis-step-head");
  head.append(
    element("span", "session-analysis-step-label", step.label),
    element("span", "session-analysis-step-duration", formatMs(step.durationMs)),
  );
  item.appendChild(head);
  const detail = stepDetail(step, t);
  if (detail) item.appendChild(element("div", "session-analysis-step-detail", detail));
  if (step.error) item.appendChild(element("div", "session-analysis-step-error", step.error));
  if (step.status === "unfinished") {
    item.appendChild(
      element("div", "session-analysis-step-error", t("taskDebugger.neverFinished")),
    );
  }
  return item;
}

/**
 * Build the Info panel's task analysis section.
 *
 * @param {{
 *   getTurns: () => Array<object>,
 *   loadHistoryTurns?: () => Promise<Array<object>> | Array<object>,
 *   analyze?: (turns: Array<object>, options?: object) => object,
 *   resolveTurns?: () => Promise<Array<object>> | Array<object>,
 *   analyzeWithAi?: (turns: Array<object>) => Promise<string>,
 *   t?: (key: string, params?: object) => string,
 *   writeText?: (text: string) => Promise<void> | void,
 * }} options
 * @returns {{
 *   element: HTMLElement,
 *   refresh: () => Promise<void>,
 *   rerender: () => void,
 *   resetHistory: () => void,
 *   setStreaming: (value: boolean) => void,
 *   getReport: () => object | null,
 * }}
 */
export function createSessionTaskAnalysis({
  getTurns,
  loadHistoryTurns = null,
  analyze = analyzeTurns,
  resolveTurns,
  analyzeWithAi = null,
  t = translate,
  writeText = (text) => navigator.clipboard?.writeText(text),
} = {}) {
  const section = element("section", "session-analysis");
  const uid = ++instanceSeq;
  section.setAttribute("aria-labelledby", `session-analysis-heading-${uid}`);

  // Compact trigger row: the only part of the report that lives in the rail
  // permanently. It opens the dialog rather than expanding inline -- the
  // full report (phase bar, findings, step list, timeline) has too many
  // stacked sections to read as a block in a rail this narrow.
  const head = document.createElement("button");
  head.type = "button";
  head.className = "session-analysis-toggle";
  head.setAttribute("aria-haspopup", "dialog");
  const title = element("span", "session-analysis-title", t("taskDebugger.title"));
  title.id = `session-analysis-heading-${uid}`;
  const time = element("span", "session-analysis-time", "");
  const caret = element("span", "session-analysis-caret");
  caret.setAttribute("aria-hidden", "true");
  caret.append(createIcon("chevron-right", { size: 14 }));
  head.append(title, time, caret);

  // Dialog: portaled to <body>, not left as a child of `section`. The rail
  // that hosts `section` (.info-sidebar / .app-side-panel) carries its own
  // `backdrop-filter`, and a `backdrop-filter` on an ancestor creates a new
  // containing block for `position: fixed` descendants -- so a fixed dialog
  // left inside it paints relative to the narrow rail instead of the
  // viewport. Matches the pattern other dialogs in this app already use
  // (see workspace/remote-workspace-dialog.js).
  const overlay = element("div", "session-analysis-overlay hidden");
  const dialogTitleId = `session-analysis-dialog-heading-${uid}`;
  const content = element("div", "session-analysis-content hidden");
  content.setAttribute("role", "dialog");
  content.setAttribute("aria-modal", "true");
  content.setAttribute("aria-labelledby", dialogTitleId);

  const dialogHead = element("div", "session-analysis-dialog-head");
  const dialogTitle = element("span", "session-analysis-dialog-title", t("taskDebugger.title"));
  dialogTitle.id = dialogTitleId;
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className =
    "ui-icon-button ui-icon-button--xs ui-icon-button--ghost session-analysis-copy";
  copyButton.append(createIcon("clipboard", { size: 14 }));
  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className =
    "ui-icon-button ui-icon-button--sm ui-icon-button--ghost session-analysis-close";
  closeButton.append(createIcon("x", { size: 16 }));
  dialogHead.append(dialogTitle, copyButton, closeButton);

  const body = element("div", "session-analysis-body");
  content.append(dialogHead, body);
  section.append(head);
  document.body.append(overlay, content);

  let streaming = false;
  // The dialog opens on demand; the rail only ever shows the compact trigger.
  let collapsed = true;
  let lastReport = null;
  let historyTurns = [];
  let historyState = typeof loadHistoryTurns === "function" ? "idle" : "off";
  // Guards a session switch (or a concurrent refresh) from letting a stale read
  // of the previous session's log repaint the section.
  let historySeq = 0;

  const aiAnalysis =
    typeof analyzeWithAi === "function" && typeof resolveTurns === "function"
      ? createSessionAiAnalysis({
          t,
          resolveTurns,
          analyzeWithAi,
          isStreaming: () => streaming,
        })
      : null;

  function availableTurns() {
    return mergeTurnSources(historyTurns, getTurns?.() ?? []);
  }

  function selectedTurns() {
    const turns = availableTurns();
    // A turn still streaming has open spans; calling them "stuck" would be a
    // lie, so it is left out until it settles.
    return streaming ? turns.filter((turn) => turn.status !== "running") : turns;
  }

  function renderCopyButton() {
    copyButton.disabled = !lastReport;
    const label = t("taskDebugger.copyReport");
    copyButton.title = label;
    copyButton.setAttribute("aria-label", label);
  }

  function renderBody() {
    const turns = selectedTurns();
    body.replaceChildren();
    if (!turns.length) {
      const key =
        historyState === "loading"
          ? "taskDebugger.loadingHistory"
          : historyState === "failed"
            ? "taskDebugger.historyFailed"
            : "taskDebugger.noTurns";
      body.appendChild(element("p", "session-analysis-empty", t(key)));
      lastReport = null;
      return;
    }
    const report = analyze(turns);
    lastReport = report;
    body.append(
      ...[
        renderSummary(report, t),
        renderFindings(report, t),
        renderPhases(report, t),
        renderSteps(report, t),
      ].filter(Boolean),
    );
    // Rebuilt spans come from the saved log, which records no compaction and no
    // step the runtime never wrote down. Say so rather than letting a thinner
    // report read as a complete one.
    if (turns.some((turn) => turn.source === "history")) {
      body.appendChild(element("p", "session-analysis-note", t("taskDebugger.historyNote")));
    }
    if (aiAnalysis) body.appendChild(aiAnalysis.element);
  }

  function render() {
    overlay.classList.toggle("hidden", collapsed);
    content.classList.toggle("hidden", collapsed);
    head.setAttribute("aria-expanded", String(!collapsed));
    // Labels change with the locale; re-render them here rather than only at build.
    title.textContent = t("taskDebugger.title");
    dialogTitle.textContent = t("taskDebugger.title");
    renderBody();
    // The trigger always shows the whole session's total, visible without
    // opening the dialog.
    time.textContent = lastReport ? formatMs(lastReport.totals.wallMs) : "";
    renderCopyButton();
    aiAnalysis?.refresh();
  }

  function open() {
    if (!collapsed) return;
    collapsed = false;
    render();
  }

  function close() {
    if (collapsed) return;
    collapsed = true;
    render();
    head.focus();
  }

  /**
   * Re-read the saved log: a turn that ended since the last look is exactly the
   * one the user came to see, and the read is a single file.
   */
  async function refresh() {
    if (typeof loadHistoryTurns !== "function") return;
    const seq = ++historySeq;
    historyState = "loading";
    if (!historyTurns.length) render();
    try {
      const turns = await loadHistoryTurns();
      if (seq !== historySeq) return;
      historyTurns = Array.isArray(turns) ? turns : [];
      historyState = "ready";
    } catch (error) {
      if (seq !== historySeq) return;
      console.warn("[TaskAnalysis] session history rebuild failed:", error);
      historyTurns = [];
      historyState = "failed";
    }
    render();
  }

  head.addEventListener("click", () => {
    if (collapsed) open();
    else close();
  });
  overlay.addEventListener("click", close);
  closeButton.addEventListener("click", close);
  bindDialogEscape(close, { isActive: () => !collapsed });
  let copyResetTimer = null;
  copyButton.addEventListener("click", async () => {
    if (!lastReport) return;
    try {
      const result = writeText?.(buildMarkdownReport(lastReport, t));
      if (!result) throw new Error("Clipboard unavailable");
      await result;
      copyButton.title = t("taskDebugger.copied");
      copyButton.setAttribute("aria-label", t("taskDebugger.copied"));
    } catch {
      copyButton.title = t("taskDebugger.copyFailed");
      copyButton.setAttribute("aria-label", t("taskDebugger.copyFailed"));
    }
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(renderCopyButton, 1500);
  });

  render();

  return {
    element: section,
    refresh,
    /** Repaint translated labels from cached state (locale change). */
    rerender: render,
    /** A session switch invalidates the rebuilt history, not the live trace. */
    resetHistory() {
      historySeq += 1;
      historyTurns = [];
      historyState = typeof loadHistoryTurns === "function" ? "idle" : "off";
      aiAnalysis?.reset();
      collapsed = true;
      render();
    },
    /** Streaming turns are excluded: their open spans are not "stuck" yet. */
    setStreaming(value) {
      streaming = Boolean(value);
      render();
    },
    getReport: () => lastReport,
  };
}
