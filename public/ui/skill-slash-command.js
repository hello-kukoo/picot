// ABOUTME: Slash-trigger completion menu listing expansion-type commands (prompts + skills).
// ABOUTME: Selection inserts `/name `; Pi expands the command natively on send.
// Router-driven: the composer trigger router owns the listeners and calls
// update(trigger)/handleKeydown(event); the menu opens only when the resolved
// query has at least one candidate (C2 — an unresolvable query stays prose).
import { t } from "../i18n.js";
import { createIcon } from "../icons.js";
import { resolveActiveTrigger } from "./composer-triggers.js";

function titleCaseSkillName(name) {
  return String(name)
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function scopeLabel(scope) {
  if (scope === "project") return "Project";
  if (scope === "temporary") return "Temporary";
  return "Personal";
}

function kindIcon(kind, doc) {
  return createIcon(kind === "prompt" ? "file-text" : "box", { size: 16, document: doc });
}

export function setupSkillSlashCommand({ input, container, loadSkills }) {
  let skills = [];
  let loadPromise = null;
  let matches = [];
  let selectedIndex = 0;
  let open = false;
  let updateGeneration = 0;
  // The token span the menu is currently anchored to (start/end are indices
  // into the composer value; select() replaces exactly this span).
  let activeToken = null;

  container.setAttribute("role", "listbox");
  container.setAttribute("aria-label", t("slashCommands.listLabel"));

  function close() {
    updateGeneration += 1;
    open = false;
    matches = [];
    selectedIndex = 0;
    activeToken = null;
    container.classList.add("hidden");
    container.replaceChildren();
    input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-expanded", "false");
  }

  function select(index) {
    const entry = matches[index];
    if (!entry || !activeToken) return;
    const before = input.value.slice(0, activeToken.start);
    const after = input.value.slice(activeToken.end);
    input.value = `${before}${entry.command} ${after}`;
    const caret = activeToken.start + entry.command.length + 1;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    close();
  }

  function updateSelection() {
    const options = container.querySelectorAll(".skill-slash-option");
    options.forEach((option, index) => {
      const selected = index === selectedIndex;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-selected", String(selected));
    });
    if (matches.length > 0) {
      input.setAttribute("aria-activedescendant", `skill-slash-option-${selectedIndex}`);
      options[selectedIndex]?.scrollIntoView({ block: "nearest" });
    }
  }

  function render(token) {
    const query = token.query || "";
    matches = skills.filter((entry) => {
      if (!query) return true;
      return (
        entry.name.toLowerCase().includes(query.toLowerCase()) ||
        entry.command.toLowerCase().includes(query.toLowerCase()) ||
        entry.description.toLowerCase().includes(query.toLowerCase())
      );
    });
    if (matches.length === 0) {
      // C2: an unresolvable query is plain prose; no menu, no empty state.
      close();
      return;
    }
    selectedIndex = Math.min(selectedIndex, matches.length - 1);

    container.replaceChildren();
    matches.forEach((entry, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.id = `skill-slash-option-${index}`;
      option.className = "skill-slash-option";
      option.dataset.kind = entry.kind || "skill";
      option.classList.toggle("selected", index === selectedIndex);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(index === selectedIndex));
      const icon = document.createElement("span");
      icon.className = "skill-slash-icon";
      const iconSvg = kindIcon(entry.kind, document);
      if (iconSvg) icon.appendChild(iconSvg);
      const name = document.createElement("span");
      name.className = "skill-slash-name";
      name.textContent = titleCaseSkillName(entry.name);
      const description = document.createElement("span");
      description.className = "skill-slash-description";
      description.textContent = entry.description;
      const scope = document.createElement("span");
      scope.className = "skill-slash-scope";
      scope.textContent = scopeLabel(entry.scope);
      option.append(icon, name, description, scope);
      option.addEventListener("mouseenter", () => {
        selectedIndex = index;
        updateSelection();
      });
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => select(index));
      container.appendChild(option);
    });

    open = true;
    container.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    updateSelection();
  }

  async function ensureSkills() {
    if (!loadPromise) {
      loadPromise = Promise.resolve()
        .then(loadSkills)
        .then((loaded) => {
          skills = Array.isArray(loaded) ? loaded : [];
          return skills;
        });
    }
    const pendingLoad = loadPromise;
    try {
      await pendingLoad;
      return true;
    } catch (error) {
      console.warn("[Skills] Failed to load slash commands:", error);
      if (loadPromise === pendingLoad) loadPromise = null;
      skills = [];
      return false;
    }
  }

  function slashTokenFromInput() {
    const trigger = resolveActiveTrigger(input.value, input.selectionStart ?? input.value.length);
    return trigger?.kind === "slash" ? trigger : null;
  }

  // Router contract: update(trigger) with a resolved trigger object. A bare
  // update() re-resolves from the input (kept for direct tests).
  async function update(trigger) {
    const generation = ++updateGeneration;
    const token = trigger && trigger.kind === "slash" ? { ...trigger } : slashTokenFromInput();
    if (!token) {
      close();
      return;
    }
    activeToken = { start: token.start, end: token.end };
    const loaded = await ensureSkills();
    if (!loaded || generation !== updateGeneration) return;
    // Stale-query guard (C2): the query may have changed (or emptied) while
    // the catalog was loading — re-resolve and render only what is still live.
    const current = slashTokenFromInput();
    if (!current) {
      close();
      return;
    }
    activeToken = { start: current.start, end: current.end };
    if (generation === updateGeneration) render(current);
  }

  /**
   * Consume a keydown while the menu is open (router only calls this when
   * isOpen() reports true). Returns true when the key was consumed.
   */
  function handleKeydown(event) {
    if (event.isComposing) return false;
    if (!open) return false;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return true;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (matches.length === 0) return true;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      selectedIndex = (selectedIndex + delta + matches.length) % matches.length;
      updateSelection();
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && matches.length > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      select(selectedIndex);
      return true;
    }
    return false;
  }

  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", container.id);
  input.setAttribute("aria-expanded", "false");
  input.addEventListener("blur", () => queueMicrotask(close));

  return { close, update, isOpen: () => open, handleKeydown };
}

export { titleCaseSkillName };
