// ABOUTME: Turn section DOM — one <section class="turn"> per agent turn with
// ABOUTME: user / rail / card / answer / status slots (spec P1.2). Pure DOM assembly.
import { t } from "../i18n.js";
import { createProcessDetailsGroup } from "./process-group.js";
import { formatTurnDuration } from "./turn-model.js";

let localTurnCounter = 0;

/**
 * Build one turn section. The rail is a process-details group that starts
 * EXPANDED while the turn is live (items stream into it) and collapses to the
 * summarized label when the turn settles. The status row has a fixed height
 * so phase text changes (working → worked-for) never reflow the transcript,
 * and renders LAST: auto-scroll keeps the bottom edge visible, so the live
 * model + elapsed readout stays on screen while the rail and answer grow
 * above it. On settle the row moves its duration into the answer's action
 * toolbar and removes itself, so a finished turn reports one meta line.
 *
 * `modelLabel` is optional display text for the live status row.
 * `withStatus: false` builds the history variant — the same turn layout
 * minus the status row (logs carry no run duration; the live status is
 * not reconstructable) and minus the inline-card slot (history carries no
 * blocker state to rebuild), as the chat-window spec describes history
 * rendering.
 *
 * The `card` slot hosts blocking prompts that belong to this turn — the
 * datarx-safety-guard bash approval and the ask-user-question questionnaire.
 * It is the turn's LAST element: a blocking prompt reads as the newest item
 * of this turn's stream, after the answer and its footer, never hidden
 * inside the rail's collapsible disclosure.
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

  // Live turns carry the inline-card slot; history turns do not (nothing to
  // rebuild it from). `hidden` keeps an empty slot out of the turn layout.
  const card = withStatus ? document.createElement("div") : null;
  if (card) card.className = "turn-card-slot hidden";

  // The user slot sits before everything else: the rail wrapper is always the
  // first element to insert the user bubble before.
  const userSlotRef = group.wrapper;
  section.append(group.wrapper, answer, ...(status ? [status] : []), ...(card ? [card] : []));

  let elapsedTimer = null;
  // Null until a clock exists: an adopted live turn has no known run start, so
  // it counts from the first live output instead of from when it was mounted.
  // `Number(null)` is 0, which would render an epoch-sized elapsed time, so an
  // absent start is normalized before it is parsed.
  const parsedStart = startedAt === null || startedAt === undefined ? null : Number(startedAt);
  let elapsedFrom = Number.isFinite(parsedStart) ? parsedStart : null;
  const liveParts = () => {
    const parts = [t("messages.turnWorking")];
    if (modelLabel) parts.push(modelLabel);
    if (elapsedFrom !== null) {
      const seconds = Math.max(0, Math.round((Date.now() - elapsedFrom) / 1000));
      parts.push(`${seconds}s`);
    }
    return parts.join(" · ");
  };
  const startElapsedTimer = () => {
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
        startElapsedTimer();
      },
      /**
       * Start the clock on a live turn that adopted an already-running session:
       * the run began while the user was elsewhere, and a clock that counts only
       * what was watched never understates the run.
       */
      beginElapsed(from = Date.now()) {
        if (!status) return;
        elapsedFrom = Number(from);
        statusText.textContent = liveParts();
        startElapsedTimer();
      },
      setSettled(durationMs) {
        if (!status) return;
        if (elapsedTimer) {
          clearInterval(elapsedTimer);
          elapsedTimer = null;
        }
        const label = formatTurnDuration(durationMs);
        // A finished turn reports ONE line: the duration joins the answer's
        // action toolbar (… · 用时 12s) instead of stacking a second meta row
        // under it. The toolbar is the last .message-actions in the answer
        // slot — the only assistant element the streaming path gives one.
        const rows = label ? answer.querySelectorAll(".message-actions") : [];
        const actions = rows.length ? rows[rows.length - 1] : null;
        if (actions) {
          const span = document.createElement("span");
          span.className = "turn-duration";
          span.textContent = t("messages.turnWorkedFor", { duration: label });
          actions.appendChild(span);
          status.remove();
          return;
        }
        // No toolbar to merge into (aborted turn or a text-less run): keep the
        // standalone row so the phase change still lands somewhere.
        status.classList.remove("live");
        status.classList.add("settled");
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
    /** Inline blocking-prompt slot (null on the history variant). */
    card: {
      host: card,
    },
    /** Claim the optimistic user bubble by moving it into the user slot. */
    claimUserElement(userEl) {
      // No `isConnected` guard: the history fold gate renders each revealed turn
      // into a DocumentFragment, so requiring an attached node would silently
      // skip the move and leave that bubble below its own answer. Callers that
      // must not move a stale element (the live optimistic bubble) already check
      // attachment themselves before calling in.
      if (userEl?.nodeType !== 1) return false;
      section.insertBefore(userEl, userSlotRef);
      return true;
    },
    destroy() {
      this.status.destroy();
    },
  };
}
