// ABOUTME: Displays host-owned subagent disk candidates and restricted read-only definitions.
// ABOUTME: Keeps scope and workspace requests isolated without asserting unverified runtime winners.

const COPY = {
  "settings.subagents.scopes.global": "Global",
  "settings.subagents.scopes.project": "Current project",
  "settings.subagents.groups.user": "Your definitions",
  "settings.subagents.groups.project": "Project definitions",
  "settings.subagents.groups.package": "Packages",
  "settings.subagents.groups.builtin": "Built-in (read-only)",
  "settings.subagents.status.candidate": "Disk candidate — runtime winner unverified",
  "settings.subagents.diskOnlyMode":
    "Disk candidates only: effectiveness and collisions are unverified.",
  "settings.subagents.state.loading": "Loading…",
  "settings.subagents.state.empty": "No agent definitions in this scope.",
  "settings.subagents.state.error": "Failed to load subagents.",
  "settings.subagents.state.conflict": "The workspace or inventory changed. Refresh and retry.",
  "settings.subagents.retry": "Retry",
  "settings.subagents.detail.runtimeName": "Runtime name",
  "settings.subagents.detail.source": "Source",
  "settings.subagents.detail.path": "File",
  "settings.subagents.detail.noFile": "No definition file (built-in)",
  "settings.subagents.detail.scope": "Scope",
  "settings.subagents.detail.savedOverride": "Saved override",
  "settings.subagents.detail.model": "Model",
  "settings.subagents.detail.thinking": "Thinking",
  "settings.subagents.detail.none": "None",
  "settings.subagents.detail.inferred": "Inferred",
  "settings.subagents.detail.overrides": "Overrides",
  "settings.subagents.detail.save": "Save",
  "settings.subagents.create.title": "New agent .md",
  "settings.subagents.create.name": "Name",
  "settings.subagents.create.description": "Description",
  "settings.subagents.create.prompt": "Prompt",
  "settings.subagents.create.submit": "Create",
  "settings.subagents.create.disabled": "Creation unavailable: runtime identity unverified.",
  "settings.subagents.detail.invalidModel": "Use a provider/model ID.",
  "settings.subagents.detail.saved":
    "Saved to disk. Reload or start a new session; verify with /subagents-models or /run.",
  "settings.subagents.detail.reloadNotice":
    "Overrides take effect in new sessions (or after /reload).",
  "settings.subagents.detail.rawLoading": "Loading definition…",
  "settings.subagents.detail.rawUnavailable": "Definition unavailable.",
  "settings.subagents.alsoIn": "Also available in: {scopes}",
};

const CONFLICT_CODES = new Set([
  "stale_generation",
  "revision_conflict",
  "inventory_revision_conflict",
  "candidate_stale",
]);

function text(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = value == null ? "" : String(value);
  return node;
}

export function setupSubagentsTab({
  container,
  transport,
  t,
  getWorkspaceIdentity,
  landingOnly = false,
  confirmDiscard = () => globalThis.confirm?.("Discard unsaved subagent changes?") ?? false,
}) {
  if (!container) throw new Error("Subagents settings container is required");
  const label = (key) => {
    const value = t?.(key);
    return value && value !== key ? value : COPY[key] || key;
  };
  let active = "global";
  let inventory = null;
  let selectedId = null;
  let raw = null;
  let loadingDetail = false;
  let error = null;
  let token = 0;
  let identityKey = null;
  let visible = false;
  let mode = "detail";
  let notice = "";
  const drafts = new Map();
  const draftKey = (id) => `${identityKey}:${active}:${id}`;
  const getDraft = (id) => drafts.get(draftKey(id)) || {};
  const setDraft = (id, patch) => drafts.set(draftKey(id), { ...getDraft(id), ...patch });
  const identity = () => (landingOnly ? null : getWorkspaceIdentity?.() || null);
  const keyOf = (value) =>
    value ? `${value.workspaceId}:${value.workspaceGeneration}` : "landing";
  const entriesForScope = () => {
    const entries = inventory?.entries || [];
    return entries.filter(
      (entry) =>
        entry.sourceScope === active ||
        entry.additionalScopes?.includes(active) ||
        (active === "global" && entry.source === "builtin"),
    );
  };

  function render() {
    container.replaceChildren();
    const frame = text("div", "subagents-view", "");
    const scopeTabs = text("div", "subagents-scopes", "");
    scopeTabs.setAttribute("role", "tablist");
    const scopes = identity() && !landingOnly ? ["global", "project"] : ["global"];
    for (const scope of scopes) {
      const button = text("button", "subagents-scope", label(`settings.subagents.scopes.${scope}`));
      button.type = "button";
      button.dataset.subagentsScope = scope;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(active === scope));
      button.tabIndex = active === scope ? 0 : -1;
      button.addEventListener("click", () => {
        if (scope !== active) {
          active = scope;
          selectedId = null;
          raw = null;
          void load();
        }
      });
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        let next = scopes[0];
        if (event.key === "End") next = scopes.at(-1);
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          const step = event.key === "ArrowRight" ? 1 : -1;
          next = scopes[(scopes.indexOf(scope) + step + scopes.length) % scopes.length];
        }
        if (next !== active) {
          active = next;
          selectedId = null;
          raw = null;
          void load();
        }
        queueMicrotask(() => container.querySelector(`[data-subagents-scope="${next}"]`)?.focus());
      });
      scopeTabs.append(button);
    }
    frame.append(scopeTabs);
    if (notice) frame.append(text("p", "subagents-feedback", notice));
    if (inventory?.resolutionContext?.mode === "disk-candidates-only")
      frame.append(text("p", "subagents-notice", label("settings.subagents.diskOnlyMode")));
    if (error) {
      const message = CONFLICT_CODES.has(error.code)
        ? label("settings.subagents.state.conflict")
        : label("settings.subagents.state.error");
      frame.append(text("p", "subagents-error", message));
      const retry = text("button", "subagents-retry", label("settings.subagents.retry"));
      retry.type = "button";
      retry.addEventListener("click", () => {
        void load();
      });
      frame.append(retry);
    } else if (!inventory) {
      frame.append(text("p", "subagents-loading", label("settings.subagents.state.loading")));
    } else {
      const layout = text("div", "subagents-layout", "");
      const master = text("div", "subagents-master", "");
      const entries = entriesForScope();
      if (!entries.length) {
        master.append(text("p", "subagents-empty", label("settings.subagents.state.empty")));
        const retry = text("button", "subagents-retry", label("settings.subagents.retry"));
        retry.type = "button";
        retry.addEventListener("click", () => {
          void load();
        });
        master.append(retry);
      }
      const add = text("button", "subagents-new", label("settings.subagents.create.title"));
      add.type = "button";
      add.addEventListener("click", () => {
        mode = "new";
        selectedId = null;
        raw = null;
        render();
      });
      master.append(add);
      for (const [source, group] of [
        ["user", "user"],
        ["project", "project"],
        ["package", "package"],
        ["builtin", "builtin"],
      ]) {
        const members = entries.filter((entry) => entry.source === source);
        if (!members.length) continue;
        master.append(
          text("h4", "subagents-group-header", label(`settings.subagents.groups.${group}`)),
        );
        for (const entry of members) {
          const row = text("button", "subagents-row", entry.runtimeName);
          row.type = "button";
          row.dataset.candidateId = entry.id;
          row.setAttribute("aria-pressed", String(selectedId === entry.id));
          row.addEventListener("click", () => {
            void select(entry);
          });
          if (entry.additionalScopes?.length) {
            const badge = text(
              "span",
              "subagents-badge",
              label("settings.subagents.alsoIn").replace(
                "{scopes}",
                entry.additionalScopes.join(", "),
              ),
            );
            row.append(badge);
          }
          master.append(row);
        }
      }
      layout.append(master);
      const detail = text("section", "subagents-detail", "");
      const selected = entries.find((entry) => entry.id === selectedId);
      if (mode === "new") {
        detail.append(text("h4", "", label("settings.subagents.create.title")));
        for (const field of ["name", "description", "prompt"]) {
          const caption = text(
            "label",
            "subagents-field",
            label(`settings.subagents.create.${field}`),
          );
          const input = text(
            field === "prompt" ? "textarea" : "input",
            "subagents-create-input",
            "",
          );
          input.name = field;
          input.value = getDraft("new")[field] || "";
          input.addEventListener("input", () => setDraft("new", { [field]: input.value }));
          caption.append(input);
          detail.append(caption);
        }
        const submit = text(
          "button",
          "subagents-create",
          label("settings.subagents.create.submit"),
        );
        submit.type = "button";
        submit.disabled = inventory.resolutionContext.mode !== "verified";
        submit.addEventListener("click", () => {
          void create();
        });
        detail.append(submit);
        if (submit.disabled)
          detail.append(
            text("p", "subagents-write-diagnostic", label("settings.subagents.create.disabled")),
          );
      } else if (selected) {
        detail.append(text("h4", "subagents-name", selected.runtimeName));
        const fields = [
          ["runtimeName", selected.runtimeName],
          ["source", selected.source],
          ["scope", selected.sourceScope],
          ["path", selected.filePath || label("settings.subagents.detail.noFile")],
        ];
        for (const [field, value] of fields) {
          const line = text("p", "subagents-field", "");
          line.append(
            text("strong", "", `${label(`settings.subagents.detail.${field}`)}: `),
            text("span", "", value),
          );
          detail.append(line);
        }
        detail.append(
          text("p", "subagents-status", label(`settings.subagents.status.${selected.status}`)),
        );
        if (selected.writeDiagnostic)
          detail.append(text("p", "subagents-write-diagnostic", selected.writeDiagnostic.message));
        if (selected.savedOverride) {
          detail.append(text("h5", "", label("settings.subagents.detail.savedOverride")));
          for (const field of ["model", "thinking"])
            detail.append(
              text(
                "p",
                "subagents-field",
                `${label(`settings.subagents.detail.${field}`)}: ${selected.savedOverride[field] ?? label("settings.subagents.detail.none")}`,
              ),
            );
        }
        if (selected.inferredValue && inventory.resolutionContext.mode === "verified") {
          detail.append(
            text(
              "p",
              "subagents-inferred",
              `${label("settings.subagents.detail.inferred")}: ${selected.inferredValue.model ?? ""} ${selected.inferredValue.thinking ?? ""} (${selected.inferredValue.source ?? ""})`,
            ),
          );
        }
        // Host write qualification and verified runtime identity jointly gate edits.
        const canEdit =
          selected.writeQualified &&
          selected.nativeOverrideSupported &&
          inventory.resolutionContext.mode === "verified";
        const form = text("div", "subagents-overrides", "");
        for (const field of ["model", "thinking"]) {
          const input = text("input", "subagents-override-input", "");
          input.setAttribute("aria-label", label(`settings.subagents.detail.${field}`));
          input.value = getDraft(selected.id)[field] ?? selected.savedOverride?.[field] ?? "";
          input.disabled = !canEdit;
          input.addEventListener("input", () => {
            setDraft(selected.id, { [field]: input.value });
            save.disabled = !canEdit;
          });
          form.append(input);
        }
        const save = text("button", "subagents-save", label("settings.subagents.detail.save"));
        save.type = "button";
        save.disabled = !canEdit || !Object.keys(getDraft(selected.id)).length;
        save.addEventListener("click", () => {
          void saveOverride(selected);
        });
        form.append(save);
        detail.append(
          form,
          text("p", "subagents-reload", label("settings.subagents.detail.reloadNotice")),
        );
        if (selected.filePath && selected.source !== "builtin") {
          if (loadingDetail)
            detail.append(text("p", "", label("settings.subagents.detail.rawLoading")));
          else if (raw !== null) detail.append(text("pre", "subagents-raw", raw));
          else detail.append(text("p", "", label("settings.subagents.detail.rawUnavailable")));
        }
      }
      layout.append(detail);
      frame.append(layout);
      if (inventory.diagnostics?.length) {
        const diagnostics = text("div", "subagents-diagnostics", "");
        for (const diagnostic of inventory.diagnostics)
          diagnostics.append(text("p", "", `${diagnostic.source}: ${diagnostic.message}`));
        frame.append(diagnostics);
      }
    }
    container.append(frame);
  }

  async function saveOverride(entry) {
    if (
      !entry.writeQualified ||
      !entry.nativeOverrideSupported ||
      inventory?.resolutionContext?.mode !== "verified"
    )
      return;
    const changes = getDraft(entry.id);
    if (changes.model && !/^[^\s/]+\/[^\s/]+$/.test(changes.model)) {
      notice = label("settings.subagents.detail.invalidModel");
      render();
      return;
    }
    const action = (field) => {
      if (changes[field] === undefined) return { op: "keep" };
      if (changes[field] === "") return { op: "clear" };
      return { op: "set", value: changes[field] };
    };
    const request = token;
    try {
      const result = await transport.setSubagentOverride({
        scope: active,
        ...(active === "project" ? identity() : {}),
        candidateId: entry.id,
        runtimeName: entry.runtimeName,
        expectedRevision: entry.settingsRevision,
        model: action("model"),
        thinking: action("thinking"),
      });
      if (request !== token || !visible) return;
      drafts.delete(draftKey(entry.id));
      inventory = result.inventory;
      notice = label("settings.subagents.detail.saved");
    } catch (failure) {
      if (request !== token || !visible) return;
      notice = CONFLICT_CODES.has(failure.code)
        ? label("settings.subagents.state.conflict")
        : String(failure.message || failure);
    }
    render();
  }

  async function create() {
    if (inventory?.resolutionContext?.mode !== "verified") return;
    const fields = getDraft("new");
    if (!fields.name?.trim() || !fields.description?.trim() || !fields.prompt?.trim()) {
      notice = label("settings.subagents.create.invalid");
      render();
      return;
    }
    const request = token;
    try {
      const result = await transport.createSubagent({
        scope: active,
        ...(active === "project" ? identity() : {}),
        ...fields,
        expectedInventoryRevision: inventory.inventoryRevision,
        expectedRevision: inventory.settingsRevisions[active],
        confirmShadowedIds: [],
      });
      if (request !== token || !visible) return;
      drafts.delete(draftKey("new"));
      inventory = result.inventory;
      mode = "detail";
      notice = label("settings.subagents.detail.saved");
    } catch (failure) {
      if (request !== token || !visible) return;
      notice = CONFLICT_CODES.has(failure.code)
        ? label("settings.subagents.state.conflict")
        : String(failure.message || failure);
    }
    render();
  }

  async function load() {
    const request = ++token;
    error = null;
    inventory = null;
    raw = null;
    loadingDetail = false;
    render();
    try {
      const result = await transport.listSubagents(
        active,
        active === "project" ? identity() : null,
      );
      if (request !== token || !visible || keyOf(identity()) !== identityKey) return;
      inventory = result;
      if (!entriesForScope().some((entry) => entry.id === selectedId)) {
        selectedId = null;
        raw = null;
      }
    } catch (failure) {
      if (request !== token || !visible) return;
      error = failure;
    }
    render();
  }

  async function select(entry) {
    selectedId = entry.id;
    mode = "detail";
    raw = null;
    loadingDetail = Boolean(entry.filePath && entry.source !== "builtin");
    const request = ++token;
    render();
    if (!loadingDetail) return;
    try {
      const result = await transport.getSubagentDetail(
        active,
        entry.id,
        active === "project" ? identity() : null,
      );
      if (request !== token || !visible || keyOf(identity()) !== identityKey) return;
      raw = result.rawDefinition ?? null;
    } catch {
      if (request !== token || !visible) return;
      raw = null;
    }
    loadingDetail = false;
    render();
  }

  return {
    async activate() {
      const current = keyOf(identity());
      if (current !== identityKey) {
        ++token;
        identityKey = current;
        inventory = null;
        selectedId = null;
        raw = null;
        active = "global";
        mode = "detail";
        notice = "";
      }
      visible = true;
      await load();
    },
    leave() {
      if (
        [...drafts].some(
          ([key, value]) => key.includes(":project:") && Object.values(value).some(Boolean),
        )
      ) {
        if (!confirmDiscard()) return false;
        for (const key of drafts.keys()) if (key.includes(":project:")) drafts.delete(key);
      }
      visible = false;
      ++token;
      return true;
    },
    resetProject() {
      ++token;
      inventory = null;
      selectedId = null;
      raw = null;
    },
  };
}
