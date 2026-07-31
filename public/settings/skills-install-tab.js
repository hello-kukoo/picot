// ABOUTME: Renders the opaque native local-skills installation flow in Settings.
// ABOUTME: Selects, scans, confirms, and installs sourceId-bound skill candidates only.

import { onLocaleChange, t } from "../i18n.js";

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

/** @param {{container:HTMLElement, transport:{pickSkillSource:()=>Promise<object|null>,scanSkillInstallSource:(sourceId:string)=>Promise<object>,installSkillLinks:(request:object)=>Promise<object>}, isProjectTrusted:()=>boolean, showSuccess?:(message:string)=>void, showError?:(message:string)=>void}} opts */
export function setupSkillsInstallTab({
  container,
  transport,
  isProjectTrusted,
  showSuccess,
  showError,
}) {
  let activated = false;
  let phase = "idle";
  let scan = null;
  let scope = "global";
  const selection = new Set();
  let error = null;
  const unsubscribeLocale = onLocaleChange(() => render());

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
    const candidates = node.kind === "group" ? collectCandidates(node.children ?? []) : [node];
    for (const candidate of candidates) {
      if (checked) selection.add(candidate.id);
      else selection.delete(candidate.id);
    }
    render();
  }

  async function chooseSource() {
    phase = "scanning";
    error = null;
    render();
    try {
      const picked = await transport.pickSkillSource();
      if (!picked?.sourceId) {
        phase = "idle";
        render();
        return;
      }
      scan = await transport.scanSkillInstallSource(picked.sourceId);
      selection.clear();
      for (const item of scan.defaultSelection ?? []) selection.add(item.id);
      phase = "selecting";
    } catch (cause) {
      phase = "error";
      error = cause instanceof Error ? cause.message : t("settings.installSkills.scanFailed");
      showError?.(error);
    }
    render();
  }

  function beginConfirmation() {
    if (!scan || selection.size === 0) return;
    phase = "confirming";
    render();
  }

  function cancelConfirmation() {
    phase = "selecting";
    render();
  }

  async function install() {
    if (!scan || selection.size === 0) return;
    phase = "installing";
    error = null;
    render();
    try {
      const result = await transport.installSkillLinks({
        sourceId: scan.sourceId,
        scope,
        scanRevision: scan.scanRevision,
        selection: selectedItems(),
      });
      phase = "done";
      scan = { ...scan, result };
      showSuccess?.(t("settings.installSkills.restartRequired"));
    } catch (cause) {
      phase = "error";
      error = cause instanceof Error ? cause.message : t("settings.installSkills.installFailed");
      showError?.(error);
    }
    render();
  }

  function renderNode(node) {
    const state = candidateState(node);
    const input = el("input", { type: "checkbox", class: "skills-install-checkbox" });
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

  function renderScope() {
    const projectTrusted = isProjectTrusted();
    return el("div", { class: "skills-install-scope", role: "radiogroup" }, [
      ...["global", "project"].map((value) =>
        el("label", {}, [
          el("input", {
            type: "radio",
            name: "skills-install-scope",
            value,
            checked: value === scope ? "checked" : undefined,
            disabled: value === "project" && !projectTrusted ? "disabled" : undefined,
            onChange: () => {
              scope = value;
              render();
            },
          }),
          t(`settings.installSkills.${value}`),
        ]),
      ),
      !projectTrusted
        ? el("span", {
            class: "skills-install-untrusted",
            text: t("settings.installSkills.projectUntrusted"),
          })
        : null,
    ]);
  }

  function render() {
    const content = [
      el("div", { class: "skills-install-header" }, [
        el("div", {}, [
          el("h3", { class: "settings-section-title", text: t("settings.installSkills.title") }),
          el("p", { class: "skills-install-intro", text: t("settings.installSkills.description") }),
        ]),
        el("button", {
          type: "button",
          class: "skills-install-choose",
          text: t("settings.installSkills.chooseFolder"),
          disabled: phase === "scanning" || phase === "installing" ? "disabled" : undefined,
          onClick: () => void chooseSource(),
        }),
      ]),
    ];
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
    if (
      scan &&
      (phase === "selecting" ||
        phase === "confirming" ||
        phase === "installing" ||
        phase === "done")
    ) {
      content.push(renderScope());
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
      } else if (phase === "confirming") {
        content.push(
          el("div", { class: "skills-install-confirmation", role: "alertdialog" }, [
            el("p", {
              text: t("settings.installSkills.confirmation", {
                count: selection.size,
                scope: t(`settings.installSkills.${scope}`),
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
          ]),
        );
      } else {
        content.push(
          el("button", {
            type: "button",
            class: "skills-install-review",
            text:
              phase === "installing"
                ? t("settings.installSkills.installing")
                : t("settings.installSkills.review"),
            disabled: selection.size === 0 || phase === "installing" ? "disabled" : undefined,
            onClick: beginConfirmation,
          }),
        );
      }
    }
    container.replaceChildren(...content);
  }

  async function activate() {
    if (activated) return;
    activated = true;
    render();
  }

  function destroy() {
    unsubscribeLocale?.();
    container.replaceChildren();
  }

  render();
  return { activate, destroy };
}
