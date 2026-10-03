// ABOUTME: Embeddable inline installer controller for Settings > Skills > Custom.
// ABOUTME: Scans, selects, confirms, and installs opaque sourceId-bound candidates for one fixed scope.

import { onLocaleChange, t } from "../i18n.js";
import { manageModalDialog } from "./skills-modal.js";

/** Stable modal owner: this controller only ever releases the dialog it opened. */
const MODAL_OWNER = "skills-install";
/** The only installable targets. The inventory alias "user" is never written here. */
const SCOPES = new Set(["global", "project"]);
/** Phases where an in-flight operation forbids scope changes, close, or re-submit. */
const BUSY_PHASES = new Set(["scanning", "confirming", "installing"]);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") {
      for (const [name, item] of Object.entries(value)) node.dataset[name] = item;
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "aria") {
      for (const [name, item] of Object.entries(value)) node.setAttribute(`aria-${name}`, item);
    } else if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child != null && child !== false)
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function collectCandidates(nodes) {
  return nodes.flatMap((node) =>
    node.kind === "skill" ? [node] : collectCandidates(node.children ?? []),
  );
}

/**
 * Embeddable inline install controller. The host opens it with a fixed scope;
 * this controller owns only its own container and only its own modal dialog.
 *
 * @param {Object} opts
 * @param {HTMLElement} opts.container - the inline install container (owned by this controller).
 * @param {{pickSkillSource:()=>Promise<object|null>,scanSkillInstallSource:(sourceId:string)=>Promise<object>,installSkillLinks:(request:object)=>Promise<object>}} opts.transport
 * @param {()=>boolean} [opts.isProjectTrusted] - project skills load only in a trusted workspace.
 * @param {()=>boolean} [opts.hasWorkspace] - false at landing: the project target is refused there.
 * @param {(message:string)=>void} [opts.showSuccess]
 * @param {(message:string)=>void} [opts.showError]
 * @param {(state:string)=>void} [opts.onStateChange] - fires on every phase change.
 * @param {(event:{scope:string,result:object})=>void} [opts.onInstalled] - a successful install only.
 * @param {()=>void} [opts.onClose] - the user closed the install area.
 * @returns {{open:(scope:string, opts?:{trigger?:HTMLElement|null})=>boolean, close:()=>void, destroy:()=>void, isOpen:()=>boolean, isBusy:()=>boolean}}
 */
export function setupSkillsInstallTab({
  container,
  transport,
  isProjectTrusted = () => true,
  hasWorkspace = () => true,
  showSuccess,
  showError,
  onStateChange,
  onInstalled,
  onClose,
}) {
  let phase = "idle";
  /** Non-null only while the install area is open; the fixed install target. */
  let openScope = null;
  let scan = null;
  let selection = new Set();
  let error = null;
  /** Monotonic generation guard: a slow response cannot overwrite a newer one,
   * and close/destroy invalidate every in-flight response by bumping it. */
  let scanSeq = 0;
  let emittedState = null;
  /** Control that opened the area; focus returns here on close. */
  let triggerEl = null;
  let destroyed = false;
  const unsubscribeLocale = onLocaleChange(() => render());
  /** Stable resolver for the install area's own controls after a re-render. */
  const focusRestoreTarget = () => triggerEl ?? container.querySelector(".skills-install-review");

  function isOpen() {
    return openScope !== null;
  }

  function isBusy() {
    return BUSY_PHASES.has(phase);
  }

  /** Why this controller refuses a project install, or null when it is allowed. */
  function projectBlocker() {
    // Workspace absence is the stronger reason: without a workspace there is no
    // project to trust yet, so the trust note alone would mislead.
    if (!hasWorkspace()) return t("settings.installSkills.projectNeedsWorkspace");
    if (!isProjectTrusted()) return t("settings.installSkills.projectUntrusted");
    return null;
  }

  function selectedItems() {
    if (!scan) return [];
    const nodes = new Map();
    const visit = (items) =>
      items.forEach((item) => {
        nodes.set(item.id, item);
        if (item.kind === "group") visit(item.children ?? []);
      });
    visit(scan.tree ?? []);
    return [...selection]
      .map((id) => nodes.get(id))
      .filter(Boolean)
      .map((item) => ({ kind: item.kind, id: item.id }));
  }

  function candidateState(node) {
    const children = node.kind === "group" ? collectCandidates(node.children ?? []) : [node];
    const selected = children.filter((item) => selection.has(item.id)).length;
    return {
      checked: selected === children.length && selected > 0,
      indeterminate: selected > 0 && selected < children.length,
    };
  }

  function toggleNode(node, checked) {
    if (phase === "installing") return;
    const candidates = node.kind === "group" ? collectCandidates(node.children ?? []) : [node];
    for (const candidate of candidates) {
      if (checked) selection.add(candidate.id);
      else selection.delete(candidate.id);
    }
    render();
  }

  /** Release only our own dialog; other owners' dialogs stay untouched. */
  function releaseModal() {
    manageModalDialog(null, { owner: MODAL_OWNER });
  }

  function resetSession() {
    openScope = null;
    phase = "idle";
    scan = null;
    selection = new Set();
    error = null;
  }

  /**
   * Open the inline area for a fixed install target. The scope cannot change
   * for the lifetime of the session; a second open() while open is refused.
   * @returns {boolean} whether the area opened.
   */
  function open(scope, { trigger = null } = {}) {
    if (destroyed || openScope !== null || !SCOPES.has(scope)) return false;
    openScope = scope;
    triggerEl = trigger ?? null;
    scan = null;
    selection = new Set();
    error = null;
    phase = "idle";
    const blocker = scope === "project" ? projectBlocker() : null;
    if (blocker) {
      phase = "error";
      error = blocker;
      render();
    } else {
      // The entry button is the picker trigger: opening goes straight to the
      // native folder picker, so the area never shows an idle "choose" step.
      void chooseSource();
    }
    return true;
  }

  async function chooseSource() {
    if (destroyed || openScope === null || isBusy()) return;
    const blocked = openScope === "project" ? projectBlocker() : null;
    if (blocked) {
      phase = "error";
      error = blocked;
      showError?.(blocked);
      render();
      return;
    }
    // Bumping the sequence is the stale guard for a re-pick; close/destroy bump
    // it too, so their late responses are dropped the same way.
    const seq = ++scanSeq;
    phase = "scanning";
    error = null;
    render();
    try {
      const picked = await transport.pickSkillSource();
      if (destroyed || seq !== scanSeq) return;
      if (!picked?.sourceId) {
        // Cancelling the picker aborts the install session entirely.
        close();
        return;
      }
      const next = await transport.scanSkillInstallSource(picked.sourceId);
      if (destroyed || seq !== scanSeq) return;
      scan = next;
      selection = new Set((next.defaultSelection ?? []).map((item) => item.id));
      phase = "selecting";
    } catch (cause) {
      if (destroyed || seq !== scanSeq) return;
      phase = "error";
      error = cause instanceof Error ? cause.message : t("settings.installSkills.scanFailed");
      showError?.(error);
    }
    render();
  }

  function beginConfirmation() {
    if (destroyed || !scan || selection.size === 0 || phase === "installing") return;
    phase = "confirming";
    render();
  }

  function cancelConfirmation() {
    if (phase !== "confirming") return;
    phase = "selecting";
    render();
  }

  async function install() {
    // Re-entrancy guard: a second submit while installing is a no-op, and the
    // installing phase renders no confirm control at all.
    if (destroyed || phase === "installing" || openScope === null) return;
    if (!scan || selection.size === 0) return;
    // Freeze the snapshot from the confirmation dialog so a later change cannot
    // desync what is displayed from what is submitted.
    const request = {
      sourceId: scan.sourceId,
      scope: openScope,
      scanRevision: scan.scanRevision,
      selection: selectedItems(),
    };
    const seq = scanSeq;
    const installScope = openScope;
    phase = "installing";
    error = null;
    render();
    try {
      const result = await transport.installSkillLinks(request);
      if (destroyed || seq !== scanSeq || openScope === null) return;
      phase = "done";
      scan = { ...scan, result };
      showSuccess?.(t("settings.installSkills.restartRequired"));
      onInstalled?.({ scope: installScope, result });
    } catch (cause) {
      if (destroyed || seq !== scanSeq || openScope === null) return;
      phase = "error";
      error = cause instanceof Error ? cause.message : t("settings.installSkills.installFailed");
      showError?.(error);
    }
    render();
  }

  /** Close the area and reset to idle. Refused while an install is in flight:
   * there is no cancel-install affordance. Late responses are discarded. */
  function close() {
    if (destroyed || openScope === null || phase === "installing") return;
    releaseModal();
    scanSeq += 1;
    const returnFocus = triggerEl;
    resetSession();
    triggerEl = null;
    // Re-announce the closed state even when the phase was already idle, so a
    // listener that locks on state alone reliably unlocks here.
    emittedState = null;
    render();
    returnFocus?.focus?.();
    onClose?.();
  }

  /** Tear down for good: release our dialog, drop late responses, empty our
   * container. Idempotent; does not touch other owners' dialogs. */
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    releaseModal();
    unsubscribeLocale?.();
    scanSeq += 1;
    const returnFocus = triggerEl;
    resetSession();
    triggerEl = null;
    container.replaceChildren();
    returnFocus?.focus?.();
  }

  function renderNode(node) {
    const state = candidateState(node);
    const input = el("input", {
      type: "checkbox",
      class: "skills-install-checkbox",
      "aria-label": `${node.kind === "group" ? t("settings.installSkills.group") : t("settings.installSkills.skill")}: ${node.name}${node.kind === "skill" && node.description ? ` — ${node.description}` : ""}`,
      disabled: phase === "installing" ? "disabled" : undefined,
    });
    input.checked = state.checked;
    input.indeterminate = state.indeterminate;
    input.addEventListener("change", () => toggleNode(node, input.checked));
    const row = el("div", { class: "skills-install-node", dataset: { installNode: node.id } }, [
      input,
      el("div", { class: "skills-install-node-text" }, [
        el("strong", { text: node.name }),
        node.kind === "skill" ? el("span", { text: node.description }) : null,
      ]),
    ]);
    if (node.kind !== "group") return row;
    return el("div", { class: "skills-install-group" }, [
      row,
      el("div", { class: "skills-install-children" }, (node.children ?? []).map(renderNode)),
    ]);
  }

  function renderConfirmation() {
    const confirmId = "skills-install-confirm";
    return el(
      "div",
      {
        class: "skills-install-confirmation",
        role: "alertdialog",
        "aria-modal": "true",
        "aria-labelledby": `${confirmId}-title`,
        "aria-describedby": `${confirmId}-desc`,
      },
      [
        el("h4", {
          id: `${confirmId}-title`,
          class: "skills-install-confirmation-title",
          text: t("settings.installSkills.confirmationHeading"),
        }),
        el("p", {
          id: `${confirmId}-desc`,
          text: t("settings.installSkills.confirmation", {
            count: selection.size,
            scope: t(`settings.installSkills.${openScope}`),
          }),
        }),
        el("button", {
          type: "button",
          class: "skills-install-confirm",
          text: t("settings.installSkills.confirm"),
          onClick: () => void install(),
        }),
        el("button", {
          type: "button",
          class: "skills-install-cancel",
          text: t("settings.installSkills.cancel"),
          onClick: cancelConfirmation,
        }),
      ],
    );
  }

  function renderContent() {
    const installing = phase === "installing";
    const content = [
      el("div", { class: "skills-install-header" }, [
        el("div", { class: "skills-install-header-text" }, [
          el("h3", { class: "settings-section-title", text: t("settings.installSkills.title") }),
          el("p", { class: "skills-intro", text: t("settings.installSkills.description") }),
        ]),
        // Read-only target badge: the scope is fixed at open, never a control.
        el("span", {
          class: "skills-install-target",
          text: t(`settings.installSkills.${openScope}`),
        }),
        el("button", {
          type: "button",
          class: "skills-install-close",
          text: t("settings.installSkills.close"),
          disabled: installing ? true : undefined,
          onClick: close,
        }),
      ]),
    ];
    // The re-pick affordance only exists once a scan landed (selecting) or
    // failed (error): the initial pick is triggered by the entry button.
    if (phase === "error" || phase === "selecting") {
      content.push(
        el("button", {
          type: "button",
          class: "skills-rescan skills-install-choose",
          text: t("settings.installSkills.chooseFolder"),
          onClick: () => void chooseSource(),
        }),
      );
    }
    if (phase === "scanning")
      content.push(
        el("div", { class: "skills-install-loading", text: t("settings.installSkills.scanning") }),
      );
    if (phase === "error")
      content.push(
        el("div", {
          class: "skills-install-error",
          text: error || t("settings.installSkills.scanFailed"),
        }),
      );
    if (scan && phase !== "idle" && phase !== "scanning") {
      content.push(el("div", { class: "skills-install-tree" }, (scan.tree ?? []).map(renderNode)));
      if (phase === "done") {
        const result = scan.result ?? {};
        content.push(
          el("div", {
            class: "skills-install-result",
            text: t("settings.installSkills.complete", {
              added: result.addedEntries?.length ?? 0,
              skipped: result.skippedEntries?.length ?? 0,
            }),
          }),
        );
        content.push(
          el("button", {
            type: "button",
            class: "skills-install-done",
            text: t("settings.installSkills.done"),
            onClick: close,
          }),
        );
      } else if (phase === "confirming") {
        content.push(renderConfirmation());
      } else {
        content.push(
          el("button", {
            type: "button",
            class: "skills-install-review",
            text: installing
              ? t("settings.installSkills.installing")
              : t("settings.installSkills.review"),
            disabled: selection.size === 0 || installing ? "disabled" : undefined,
            onClick: beginConfirmation,
          }),
        );
      }
    }
    return content;
  }

  function render() {
    if (destroyed) return;
    if (openScope === null) {
      container.replaceChildren();
    } else {
      container.replaceChildren(...renderContent());
    }
    if (phase === "confirming") {
      manageModalDialog(container.querySelector(".skills-install-confirmation"), {
        initialFocus: container.querySelector(".skills-install-confirm"),
        restoreFocusTo: focusRestoreTarget,
        inertRoot: document.body,
        owner: MODAL_OWNER,
        onCancel: cancelConfirmation,
      });
    } else {
      releaseModal();
    }
    if (phase !== emittedState) {
      emittedState = phase;
      onStateChange?.(phase);
    }
  }

  return { open, close, destroy, isOpen, isBusy };
}
