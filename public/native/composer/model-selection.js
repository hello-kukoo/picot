// ABOUTME: Compares provider-scoped model identities for composer selection state.
// ABOUTME: Keeps duplicate model IDs from different providers distinguishable.

export function isSelectedModel(model, selection) {
  return Boolean(
    model?.provider &&
      model?.id &&
      model.provider === selection?.provider &&
      model.id === selection?.modelId,
  );
}

/**
 * Split visibility-filtered models into the starred (scoped) section and the
 * remaining enabled models. Scoped order follows the stored enabledModels
 * order; ids that no longer resolve to a visible model are dropped so hidden
 * or unavailable stars never render.
 */
/** Keep only models the user has explicitly enabled in the Picot catalog.
 *
 * Visibility is opt-in. A catalog that cannot be read must not silently fall
 * back to "everything available" — that would undo the user's curation exactly
 * when the bridge is least trustworthy. Fail closed instead; the next
 * successful refresh repopulates the picker.
 */
export function filterModelsByCatalogVisibility(models, catalog) {
  if (!Array.isArray(models)) return [];
  if (!catalog?.ok || !Array.isArray(catalog.data?.providers)) return [];

  const visibleKeys = new Set();
  for (const provider of catalog.data.providers) {
    for (const model of provider.models ?? []) {
      if (model.available && model.visible === true) {
        visibleKeys.add(`${model.provider || provider.provider}/${model.id}`);
      }
    }
  }
  return models.filter((model) => visibleKeys.has(`${model.provider}/${model.id}`));
}

export function splitModelsByScope(models, scopedModelIds) {
  if (!Array.isArray(models)) return { scoped: [], remaining: [] };
  const byId = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
  const scoped = (Array.isArray(scopedModelIds) ? scopedModelIds : [])
    .map((id) => byId.get(id))
    .filter(Boolean);
  const scopedIds = new Set(scoped.map((model) => `${model.provider}/${model.id}`));
  return {
    scoped,
    remaining: models.filter((model) => !scopedIds.has(`${model.provider}/${model.id}`)),
  };
}
