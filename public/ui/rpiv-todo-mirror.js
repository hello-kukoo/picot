import { t } from "../i18n.js";

const TODO_TOOL_NAME = "todo";
const TODO_WIDGET_KEY = "rpiv-todos";
const EMPTY_STATE = Object.freeze({ tasks: Object.freeze([]), nextId: 1 });
const STATUS_LABELS = {
  pending: "pending",
  in_progress: "in progress",
  completed: "completed",
  deleted: "deleted",
};
const STATUS_GLYPHS = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
  deleted: "✗",
};

export function isRpivTodoWidgetRequest(request) {
  return request?.method === "setWidget" && request.widgetKey === TODO_WIDGET_KEY;
}

export function isRpivTodoCommandNotify(message) {
  const text = String(message ?? "");
  return (
    text === "No todos yet. Ask the agent to add some!" ||
    /^\d+\/\d+ completed/m.test(text) ||
    text.includes("── Pending ──") ||
    text.includes("── In Progress ──") ||
    text.includes("── Completed ──")
  );
}

export function isRpivTodoDetails(value) {
  if (!value || typeof value !== "object") return false;
  const details = value;
  if (!Array.isArray(details.tasks)) return false;
  if (typeof details.nextId !== "number") return false;
  return details.tasks.every(isRpivTodoTask);
}

function isRpivTodoTask(value) {
  if (!value || typeof value !== "object") return false;
  return (
    typeof value.id === "number" &&
    typeof value.subject === "string" &&
    ["pending", "in_progress", "completed", "deleted"].includes(value.status)
  );
}

export function replayRpivTodoFromMessages(messages = []) {
  let state = EMPTY_STATE;
  for (const message of messages) {
    if (message?.role !== "toolResult") continue;
    if (message.toolName !== TODO_TOOL_NAME) continue;
    if (!isRpivTodoDetails(message.details)) continue;
    state = cloneTodoState(message.details);
  }
  return state;
}

function cloneTodoState(details) {
  return {
    tasks: details.tasks.map((task) => ({ ...task })),
    nextId: details.nextId,
  };
}

export class RpivTodoMirrorPanel {
  #element;
  #state = EMPTY_STATE;
  // v3 addition: tracks a pending auto-collapse timer so sticky expand()
  // calls (e.g. from the /todos command) don't keep the panel pinned
  // open after the user has moved on. Cleared in clear() and on each
  // new expand() to avoid stacking timeouts.
  #expandTimer = null;

  constructor({ container }) {
    this.#element = document.createElement("section");
    this.#element.className = "rpiv-todo-panel hidden is-collapsed";
    this.#element.setAttribute(
      "aria-label",
      t("migrated.native.features.rpivTodoMirror.textcontent.todos"),
    );
    container?.insertBefore(this.#element, container.querySelector("form"));
  }

  get element() {
    return this.#element;
  }

  hydrateFromMessages(messages) {
    this.setState(replayRpivTodoFromMessages(messages));
  }

  applyToolResult(result) {
    if (!isRpivTodoDetails(result?.details)) return false;
    this.setState(cloneTodoState(result.details));
    return true;
  }

  /** True when the panel actually renders something the user can look at. */
  get hasVisibleTasks() {
    return this.#state.tasks.some((task) => task.status !== "deleted");
  }

  setState(state) {
    this.#state = state ?? EMPTY_STATE;
    this.#render();
  }

  clear() {
    if (this.#expandTimer != null) {
      clearTimeout(this.#expandTimer);
      this.#expandTimer = null;
    }
    // Drop the sticky expand class so a follow-up setState/EMPTY_STATE
    // path doesn't leave the panel pinned open across a session switch.
    this.#element.classList.remove("is-hover-expanded");
    this.setState(EMPTY_STATE);
  }

  expand() {
    this.#element.classList.add("is-hover-expanded");
    // v3: upstream leaves the class on indefinitely (the comment in
    // public/native/app.js says "expand the panel instead of rendering
    // a duplicate system message"). In practice that means once any
    // /todos call hits, the panel stays force-expanded until the next
    // session change — the user has no way to re-collapse it. Auto-clear
    // the class after a short window so the panel returns to its hover
    // affordance.
    if (this.#expandTimer != null) clearTimeout(this.#expandTimer);
    this.#expandTimer = setTimeout(() => {
      this.#element.classList.remove("is-hover-expanded");
      this.#expandTimer = null;
    }, 3000);
  }

  #render() {
    const visibleTasks = this.#state.tasks.filter((task) => task.status !== "deleted");
    if (visibleTasks.length === 0) {
      this.#element.classList.add("hidden");
      this.#element.replaceChildren();
      return;
    }

    const completed = visibleTasks.filter((task) => task.status === "completed").length;
    const total = visibleTasks.length;
    const hasActive = visibleTasks.some(
      (task) => task.status === "pending" || task.status === "in_progress",
    );

    const header = document.createElement("div");
    header.className = "rpiv-todo-panel__header";
    const titleGroup = document.createElement("div");
    titleGroup.className = "rpiv-todo-panel__titleGroup";
    const dot = document.createElement("span");
    dot.className = `rpiv-todo-panel__dot ${hasActive ? "is-active" : ""}`;
    dot.textContent = hasActive ? "●" : "○";
    const title = document.createElement("span");
    title.className = "rpiv-todo-panel__title";
    title.textContent = t("migrated.native.features.rpivTodoMirror.textcontent.todos");
    titleGroup.append(dot, title);
    const summary = document.createElement("span");
    summary.className = "rpiv-todo-panel__summary";
    summary.textContent = `${completed}/${total}`;
    summary.dataset.expandedText = `${completed}/${total} complete`;
    header.append(titleGroup, summary);

    const displayTasks = selectDisplayTasks(visibleTasks);
    const list = document.createElement("ol");
    list.className = "rpiv-todo-panel__list";
    for (const task of displayTasks) {
      list.append(renderTask(task, shouldShowIds(visibleTasks)));
    }
    const children = [header, list];
    if (visibleTasks.length > displayTasks.length) {
      const more = document.createElement("div");
      more.className = "rpiv-todo-panel__more";
      more.textContent = `+${visibleTasks.length - displayTasks.length} more`;
      children.push(more);
    }

    this.#element.classList.toggle("is-complete", !hasActive);
    this.#element.replaceChildren(...children);
    this.#element.classList.remove("hidden");
  }
}

function shouldShowIds(tasks) {
  return tasks.some((task) => Array.isArray(task.blockedBy) && task.blockedBy.length > 0);
}

function selectDisplayTasks(tasks) {
  const maxRows = 5;
  const active = tasks.filter((task) => task.status !== "completed");
  const completed = tasks.filter((task) => task.status === "completed");
  return [...active, ...completed].slice(0, maxRows);
}

function renderTask(task, showId) {
  const item = document.createElement("li");
  item.className = `rpiv-todo-panel__task is-${task.status.replace("_", "-")}`;

  const glyph = document.createElement("span");
  glyph.className = "rpiv-todo-panel__glyph";
  glyph.textContent = STATUS_GLYPHS[task.status] ?? "•";

  const text = document.createElement("span");
  text.className = "rpiv-todo-panel__text";
  text.textContent = `${showId ? `#${task.id} ` : ""}${task.subject}`;

  item.append(glyph, text);

  if (task.status === "in_progress" && task.activeForm) {
    const active = document.createElement("span");
    active.className = "rpiv-todo-panel__meta";
    active.textContent = `(${task.activeForm})`;
    item.append(active);
  }

  if (Array.isArray(task.blockedBy) && task.blockedBy.length > 0) {
    const blocked = document.createElement("span");
    blocked.className = "rpiv-todo-panel__meta";
    blocked.textContent = `⛓ ${task.blockedBy.map((id) => `#${id}`).join(",")}`;
    item.append(blocked);
  }

  item.title = STATUS_LABELS[task.status] ?? task.status;
  return item;
}
