// ABOUTME: Collapsible wrapper that folds a turn's thinking/tool-call noise into one row.
// ABOUTME: Mirrors pi-web's "Process details" group — collapsed by default, expands on click.

import { t } from "../i18n.js";

const CHEVRON_ICON =
  '<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true"><path d="M2 1l4 3-4 3z"/></svg>';

/**
 * Build a collapsed-by-default "Process details" group. Callers append
 * process content (thinking blocks, tool cards) into `body`, then call
 * `setLabel` once the final counts are known.
 */
export function createProcessDetailsGroup() {
  const wrapper = document.createElement("div");
  wrapper.className = "process-details-group";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "process-details-toggle";
  toggle.setAttribute("aria-expanded", "false");

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.innerHTML = CHEVRON_ICON;

  const label = document.createElement("span");
  label.className = "process-details-label";

  toggle.append(chevron, label);

  const body = document.createElement("div");
  body.className = "process-details-body";

  wrapper.append(toggle, body);

  toggle.addEventListener("click", () => {
    const expanded = wrapper.classList.toggle("expanded");
    toggle.setAttribute("aria-expanded", String(expanded));
  });

  return {
    wrapper,
    body,
    setLabel(text) {
      label.textContent = text;
    },
  };
}

/** Build the localized "Process details · N steps · M tool calls" summary line. */
export function summarizeProcessGroup(stepCount, toolCallCount) {
  const parts = [
    t("messages.processDetails"),
    stepCount === 1
      ? t("messages.processStep", { count: stepCount })
      : t("messages.processSteps", { count: stepCount }),
  ];
  if (toolCallCount > 0) {
    parts.push(
      toolCallCount === 1
        ? t("messages.processToolCall", { count: toolCallCount })
        : t("messages.processToolCalls", { count: toolCallCount }),
    );
  }
  return parts.join(" · ");
}
