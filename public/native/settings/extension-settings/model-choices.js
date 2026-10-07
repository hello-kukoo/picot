// ABOUTME: Model-picker helpers shared by the bridge-plane extension settings pages.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js.

import { t } from "../../../i18n.js";
import {
  filterModelsByCatalogVisibility,
  splitModelsByScope,
} from "../../composer/model-selection.js";

/**
 * The composer's model list, from the composer's own two sources: the Picot
 * catalog (per-model enable/visibility) and the workspace-scoped model ids.
 * Both surfaces read them over the bridge — workspace runtime or landing
 * config runtime — so a picker here and the composer cannot drift apart.
 */
export async function loadModelChoices(configGateway) {
  if (!configGateway) return { models: [], scopedIds: [] };
  const [catalog, scoped] = await Promise.all([
    configGateway.call("list_model_catalog").catch(() => null),
    configGateway.call("list_scoped_models").catch(() => null),
  ]);
  // Same rule as the composer: an unreadable catalog fails closed instead of
  // re-exposing every available model after the user curated the list.
  if (!catalog?.ok) return { models: [], scopedIds: [], catalogOk: false };
  const listed = (catalog.data?.providers ?? []).flatMap((provider) => provider.models ?? []);
  return {
    models: filterModelsByCatalogVisibility(listed, catalog),
    scopedIds: scoped?.ok && Array.isArray(scoped.data?.modelIds) ? scoped.data.modelIds : [],
    catalogOk: true,
  };
}

/** An empty picker reads as broken; say why, with the composer's copy. */
export function noteWhenCatalogUnavailable(target, choices) {
  if (choices.catalogOk || choices.models.length > 0) return;
  const note = document.createElement("p");
  note.className = "settings-help";
  note.textContent = t("models.unavailableHelp");
  target.appendChild(note);
}

function modelDisplayName(model) {
  const key = `${model.provider}/${model.id}`;
  return model.name && model.name !== model.id ? `${model.name} (${key})` : key;
}

/** Composer parity: scoped models first, then every other enabled model. */
export function appendModelOptions(select, { models, scopedIds }) {
  const { scoped, remaining } = splitModelsByScope(models, scopedIds);
  for (const [label, group] of [
    [t("models.scoped"), scoped],
    [t("models.allEnabled"), remaining],
  ]) {
    if (group.length === 0) continue;
    const optgroup = document.createElement("optgroup");
    optgroup.label = label;
    for (const model of group) {
      const option = document.createElement("option");
      option.value = `${model.provider}/${model.id}`;
      option.textContent = modelDisplayName(model);
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
}
