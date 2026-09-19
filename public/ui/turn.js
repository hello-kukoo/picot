// ABOUTME: Turn section DOM — one <section class="turn"> per agent turn with
// ABOUTME: user / status / rail / answer slots (spec P1.2). Pure DOM assembly.
import { t } from "../i18n.js";
import { createProcessDetailsGroup } from "./process-group.js";
import { formatTurnDuration } from "./turn-model.js";

let localTurnCounter = 0;

/**
 * Build one turn section. The rail is a process-details group that starts
 * EXPANDED while the turn is live (items stream into it) and collapses to the
 * summarized label when the turn settles. The status row has a fixed height
 * so phase text changes (working → worked-for) never reflow the transcript.
 *
 * `modelLabel` is optional display text for the live status row.
 * `withStatus: false` builds the history variant — the same turn layout
 * minus the status header (logs carry no run duration; the live status is
 * not reconstructable), as the chat-window spec describes history rendering.
 */
export function createTurnSection({
  turnId = null,
  modelLabel = "",
  startedAt = null,
  withStatus = true,
} = {}) {
  const id = typeof turnId === "string" && turnId ? turnId : `local-${++localTurnCounter}`;

  const section = document.createElement("section");
  section.className = "turn";
  section.dataset.turnId = id;

  let status = null;
  let spinner = null;
  let statusText = null;
  if (withStatus) {
    status = document.createElement("div");
    status.className = "turn-status";
    status.setAttribute("aria-live", "polite");

    spinner = document.createElement("span");
    spinner.className = "turn-status-spinner";
    spinner.setAttribute("aria-hidden", "true");

    statusText = document.createElement("span");
    statusText.className = "turn-status-text";
    status.append(spinner, statusText);
  }

  const group = createProcessDetailsGroup();
  group.wrapper.classList.add("turn-rail");
  group.wrapper.classList.add("expanded");
  group.wrapper.querySelector(".process-details-toggle")?.setAttribute("aria-expanded", "true");

  const answer = document.createElement("div");
  answer.className = "turn-answer";

  // The user slot sits before everything else; with no status row the rail
  // wrapper is the first element to insert the user bubble before.
  const userSlotRef = status ?? group.wrapper;
  section.append(...(status ? [status] : []), group.wrapper, answer);

  let elapsedTimer = null;
  const liveParts = () => {
    const parts = [t("messages.turnWorking")];
    if (modelLabel) parts.push(modelLabel);
    if (Number.isFinite(Number(startedAt))) {
      const seconds = Math.max(0, Math.round((Date.now() - Number(startedAt)) / 1000));
      parts.push(`${seconds}s`);
    }
    return parts.join(" · ");
  };

  return {
    id,
    element: section,
    status: {
      host: status,
      setLive() {
        if (!status) return;
        status.classList.add("live");
        status.classList.remove("settled");
        statusText.textContent = liveParts();
        if (elapsedTimer) clearInterval(elapsedTimer);
        // One interval per live turn, never per render (spec P1.5). A client
        // clock can drift from the daemon's runStartedAt; the settled value
        // uses the same client clock so live and settled never disagree (D2).
        elapsedTimer = setInterval(() => {
          if (!section.isConnected) {
            clearInterval(elapsedTimer);
            elapsedTimer = null;
            return;
          }
          statusText.textContent = liveParts();
        }, 1000);
      },
      setSettled(durationMs) {
        if (!status) return;
        if (elapsedTimer) {
          clearInterval(elapsedTimer);
          elapsedTimer = null;
        }
        status.classList.remove("live");
        status.classList.add("settled");
        const label = formatTurnDuration(durationMs);
        statusText.textContent = label ? t("messages.turnWorkedFor", { duration: label }) : "";
        spinner.remove();
      },
      destroy() {
        if (elapsedTimer) {
          clearInterval(elapsedTimer);
          elapsedTimer = null;
        }
      },
    },
    rail: {
      host: group.body,
      wrapper: group.wrapper,
      setLabel(text) {
        group.setLabel(text);
      },
      setDisclosure(expanded) {
        group.wrapper.classList.toggle("expanded", expanded);
        group.wrapper
          .querySelector(".process-details-toggle")
          ?.setAttribute("aria-expanded", String(expanded));
      },
    },
    answer: {
      host: answer,
    },
    /** Claim the optimistic user bubble by moving it into the user slot. */
    claimUserElement(userEl) {
      if (!userEl?.isConnected) return false;
      section.insertBefore(userEl, userSlotRef);
      return true;
    },
    destroy() {
      this.status.destroy();
    },
  };
}
