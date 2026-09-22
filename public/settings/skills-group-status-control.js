// ABOUTME: Shared group-level status control for the Skills tabs (扩展包 and
// ABOUTME: 已发现): one tag-styled button carrying the 全部启用/全部禁用/
// ABOUTME: {x}/{X} 已启用 label, replacing the label-plus-switch pair that
// ABOUTME: used to sit next to each other in the group header.

import { t } from "../i18n.js";

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "disabled") node[key] = Boolean(value);
    else if (key === "dataset") {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = dv;
    } else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "aria") {
      for (const [ak, av] of Object.entries(value)) node.setAttribute(`aria-${ak}`, av);
    } else if (value !== undefined && value !== null) {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** {enabled}/{total} → the label every group-level status control shows. */
function describeGroupState(state, enabled, total) {
  if (state === "all-on") return t("settings.skills.allEnabled");
  if (state === "all-off") return t("settings.skills.allDisabled");
  return t("settings.skills.enabledCount", { enabled, total });
}

/**
 * The one group-level affordance both Skills tabs share: clicking anything not
 * fully enabled turns everything on; clicking the all-on state turns
 * everything off (the checkbox semantics it replaces).
 *
 * @param {{
 *   state: "all-on"|"all-off"|"mixed",
 *   enabled: number,
 *   total: number,
 *   disabled?: boolean,
 *   dataset?: Record<string, string>,
 *   ariaLabel: string,
 *   onToggle: (next: boolean) => void,
 * }} options
 */
export function renderGroupStatusControl({
  state,
  enabled,
  total,
  disabled = false,
  dataset = {},
  ariaLabel,
  onToggle,
}) {
  return el("div", { class: "skills-group-enable-all" }, [
    el("button", {
      type: "button",
      class: `skills-group-status ${state}`,
      text: describeGroupState(state, enabled, total),
      disabled,
      dataset,
      aria: {
        label: ariaLabel,
        pressed: String(state === "all-on"),
      },
      onClick: () => onToggle(state !== "all-on"),
    }),
  ]);
}
