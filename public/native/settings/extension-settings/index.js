// ABOUTME: Per-package extension settings mounted at the bottom of the package detail pane.
// ABOUTME: Holds the package-source → renderer map; packages without a renderer render nothing.

import { renderAdvisorSettings } from "./advisor.js";
import { renderAskUserSettings } from "./ask-user.js";
import { renderCacheOptimizerSettings } from "./cache-optimizer.js";
import { renderCavemanSettings } from "./caveman.js";
import { renderFffSettings } from "./fff.js";
import { renderGoalSettings } from "./goal.js";
import { renderLensSettings } from "./lens.js";
import { renderPlanModeSettings } from "./plan-mode.js";
import { renderPonytailSettings } from "./ponytail.js";
import { renderSafetyGuardSettings } from "./safety-guard.js";
import { renderTodoSettings } from "./todo.js";
import { renderVccSettings } from "./vcc.js";
import { renderWebAccessSettings } from "./web-access.js";

/**
 * Package source → settings renderer. `dep` names what the renderer needs:
 * host-plane renderers ride the control gateway (Rust host ops), bridge
 * renderers need the config gateway (in-process model registry). A renderer
 * whose dependency is missing renders nothing.
 *
 * Host-plane renderers came from a transport that resolved with an `ok` flag;
 * the control gateway resolves with the raw frame and rejects on failure. The
 * flag is therefore added on the success path only (see withOkFlag): renderers
 * that check `ok` get their contract, and renderers that guard with try/catch
 * — or call `.catch()` themselves — keep seeing the rejection.
 */
const SETTINGS_RENDERERS = new Map([
  ["npm:@juicesharp/rpiv-todo", { dep: "control", render: renderTodoSettings }],
  ["npm:@juicesharp/rpiv-ask-user-question", { dep: "control", render: renderAskUserSettings }],
  ["npm:@dietrichgebert/ponytail", { dep: "control", render: renderPonytailSettings }],
  ["npm:@sting8k/pi-vcc", { dep: "control", render: renderVccSettings }],
  ["npm:@narumitw/pi-goal", { dep: "control", render: renderGoalSettings }],
  ["git:github.com/jonjonrankin/pi-caveman", { dep: "control", render: renderCavemanSettings }],
  ["npm:pi-cache-optimizer", { dep: "control", render: renderCacheOptimizerSettings }],
  ["npm:pi-lens", { dep: "control", render: renderLensSettings }],
  ["npm:@ff-labs/pi-fff", { dep: "control", render: renderFffSettings }],
  // Bridge plane: these pages pick a model, so they need the in-process model
  // registry through the config gateway rather than a host control op.
  ["npm:@juicesharp/rpiv-advisor", { dep: "configGateway", render: renderAdvisorSettings }],
  ["npm:@narumitw/pi-plan-mode", { dep: "configGateway", render: renderPlanModeSettings }],
  ["npm:pi-web-access", { dep: "configGateway", render: renderWebAccessSettings }],
]);
/** safety-guard reaches `pi list` as a bare ssh URL or the normalized git:
 * form, so it is matched by suffix instead of an exact source key. */
const SAFETY_GUARD_RENDERER = { dep: "configGateway", render: renderSafetyGuardSettings };

/** Every host-plane op the renderers may call. */
const HOST_CONFIG_METHODS = [
  "getFffConfig",
  "setFffConfig",
  "getTodoConfig",
  "setTodoConfig",
  "getAskUserConfig",
  "setAskUserConfig",
  "getPonytailConfig",
  "setPonytailConfig",
  "getVccConfig",
  "setVccConfig",
  "getGoalConfig",
  "setGoalConfig",
  "getCavemanConfig",
  "setCavemanConfig",
  "getCacheOptimizerConfig",
  "setCacheOptimizerConfig",
  "getLensConfig",
  "setLensConfig",
];

/** Add the `ok` flag renderers were written against, on success only. */
function withOkFlag(control) {
  if (!control) return control;
  const wrapped = Object.create(control);
  for (const method of HOST_CONFIG_METHODS) {
    if (typeof control[method] !== "function") continue;
    wrapped[method] = (...args) =>
      Promise.resolve(control[method](...args)).then((payload) =>
        payload && typeof payload === "object"
          ? { ...payload, ok: true }
          : { ok: true, data: payload },
      );
  }
  return wrapped;
}

function findSettingsRenderer(source) {
  return (
    SETTINGS_RENDERERS.get(source) ??
    (source.endsWith("datarx-safety-guard-pi.git") ? SAFETY_GUARD_RENDERER : undefined)
  );
}

/** A renderer that throws must leave a row on the detail page — never an
 * unhandled rejection. */
function appendSettingsFailure(detailEl, error) {
  const row = document.createElement("div");
  row.className = "pkg-ext-settings pkg-ext-error";
  row.textContent = String(error?.message || error);
  detailEl.appendChild(row);
}

export function renderExtensionSettings(detailEl, pkg, { control, configGateway } = {}) {
  const source = typeof pkg?.source === "string" ? pkg.source : "";
  const entry = findSettingsRenderer(source);
  if (!entry) return;
  const dependency = entry.dep === "configGateway" ? configGateway : withOkFlag(control);
  if (!dependency) return;
  try {
    Promise.resolve(entry.render(detailEl, pkg, dependency)).catch((error) =>
      appendSettingsFailure(detailEl, error),
    );
  } catch (error) {
    appendSettingsFailure(detailEl, error);
  }
}
