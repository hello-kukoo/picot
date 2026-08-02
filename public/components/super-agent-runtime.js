/**
 * <super-agent-runtime> Web Component
 *
 * Owns the runtime behavior previously kept in the legacy Super Agent panel.
 * Renders its own HTML, polls /api/super-agent/tasks every 3s.
 *
 * Usage:
 *   <super-agent-runtime id="super-agent-runtime"></super-agent-runtime>
 *
 * Dispatches a custom event "sa-dispatch" with task detail when Approve is clicked.
 * The host page should listen: el.addEventListener('sa-dispatch', e => ...)
 */

import { createIcon } from "../icons.js";
import {
  ACTIVE_TASK_STATUSES,
  markTaskFinished,
  markTaskForDispatch,
  normalizeSuperAgentTasks,
} from "../super-agent/task-state.js";
import { setupResizablePanel } from "../ui/resizable-panel.js";

class SuperAgentRuntime extends HTMLElement {
  connectedCallback() {
    this._tasks = [];
    this._projects = [];
    this._filter = "all";
    this._expandedTaskIds = new Set();
    this._historyTaskIds = new Set();
    this._pollInterval = null;
    this._lastJson = null;
    this._hasLoadedOnce = false;
    this._projectsLoadedOnce = false;

    this._render();
    this._cleanupResizablePanel = setupResizablePanel(this, {
      storageKey: "pi-studio-runtime-panel-width",
      defaultWidth: 360,
      minWidth: 280,
      maxWidth: 560,
    });
    this._renderAll();
    this._bindCollapseToggle();
    this._bindGlobalControls();
    this._startPolling();
    this._loadProjects();
  }

  disconnectedCallback() {
    clearInterval(this._pollInterval);
    clearTimeout(this._retryTimer);
    this._cleanupResizablePanel?.();
    document.removeEventListener("sa-open-runtime", this._handleOpenRuntime);
    document.removeEventListener("keydown", this._handleGlobalKeyDown);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  _render() {
    const header = document.createElement("div");
    header.className = "runtime-header app-side-panel-header";
    header.id = "runtime-header";
    const title = document.createElement("span");
    title.className = "runtime-title";
    title.textContent = "Tasks";
    const close = createRuntimeButton("", "collapse", "icon-btn app-side-panel-close-btn", "x", 14);
    close.dataset.collapseBtn = "";
    close.title = "Close";
    close.setAttribute("aria-label", "Close activity panel");
    header.append(title, close);

    const filters = document.createElement("div");
    filters.className = "runtime-filters";
    filters.dataset.filters = "";
    for (const [filter, label, countAttribute] of [
      ["all", "All", null],
      ["pending", "Pending", "pendingCount"],
      ["running", "Running", "runningCount"],
      ["done", "Done", "doneCount"],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `runtime-filter${filter === "all" ? " active" : ""}`;
      button.dataset.filter = filter;
      button.textContent = label;
      if (countAttribute) {
        const count = document.createElement("span");
        count.dataset[countAttribute] = "";
        count.textContent = "0";
        button.append(" ", count);
      }
      filters.appendChild(button);
    }

    const taskList = document.createElement("div");
    taskList.className = "runtime-task-list";
    taskList.dataset.taskList = "";
    const bulkActions = document.createElement("div");
    bulkActions.className = "runtime-bulk-actions";
    bulkActions.dataset.bulkActions = "";
    this.replaceChildren(header, filters, taskList, bulkActions);

    // Default closed; only reopen automatically when the user explicitly left it open.
    if (localStorage.getItem("sa-runtime-collapsed") !== "0") {
      this.classList.add("collapsed");
    }

    this.querySelector("[data-filters]").addEventListener("click", (e) => {
      const btn = e.target.closest(".runtime-filter");
      if (!btn) return;
      this._filter = btn.dataset.filter;
      this.querySelectorAll(".runtime-filter").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      this._renderTasks();
    });
  }

  _bindCollapseToggle() {
    const toggle = () => {
      const collapsed = this.classList.toggle("collapsed");
      localStorage.setItem("sa-runtime-collapsed", collapsed ? "1" : "0");
    };
    this.querySelector("[data-collapse-btn]")?.addEventListener("click", toggle);
  }

  _bindGlobalControls() {
    this._handleOpenRuntime = (event) => {
      this._openPanel(event.detail?.filter);
    };
    this._handleGlobalKeyDown = (event) => {
      if (!event.metaKey || !event.shiftKey || event.key.toLowerCase() !== "i") return;
      if (isTypingTarget(event.target)) return;
      event.preventDefault();
      const collapsed = this.classList.toggle("collapsed");
      localStorage.setItem("sa-runtime-collapsed", collapsed ? "1" : "0");
    };
    document.addEventListener("sa-open-runtime", this._handleOpenRuntime);
    document.addEventListener("keydown", this._handleGlobalKeyDown);
  }

  _openPanel(filter = null) {
    this.classList.remove("collapsed");
    localStorage.setItem("sa-runtime-collapsed", "0");
    if (filter) this._setFilter(filter);
  }

  _setFilter(filter) {
    this._filter = filter;
    this.querySelectorAll(".runtime-filter").forEach((b) => {
      b.classList.toggle("active", b.dataset.filter === filter);
    });
    this._renderTasks();
  }

  // ── Polling ───────────────────────────────────────────────────────────────

  _startPolling() {
    this._retryDelay = 400;
    this._poll();
    this._pollInterval = setInterval(() => this._poll(), 3000);
  }

  async _poll() {
    try {
      const res = await fetch("/api/super-agent/tasks");
      if (!res.ok) {
        this._scheduleRetry();
        return;
      }
      const json = await res.text();
      this._hasLoadedOnce = true;
      this._retryDelay = 400;
      if (json === this._lastJson) return;
      this._lastJson = json;
      this._tasks = normalizeSuperAgentTasks(JSON.parse(json).tasks || []);
      this._renderAll();
    } catch {
      this._scheduleRetry();
    }
  }

  async _loadProjects() {
    try {
      const res = await fetch("/api/super-agent/projects");
      if (!res.ok) return;
      const data = await res.json();
      this._projects = Array.isArray(data.projects) ? data.projects : [];
      this._projectsLoadedOnce = true;
      this._renderTasks();
    } catch {
      this._projects = [];
    }
  }

  // The embedded pi server can still be warming up its extension routes
  // right after a fresh workspace/session spawn even though /api/health
  // already answered (see wait_for_endpoint in pi_manager.rs). Rather than
  // waiting out the full 3s interval on a failed/errored first poll, retry
  // quickly with backoff until we've loaded successfully once.
  _scheduleRetry() {
    if (this._hasLoadedOnce) return;
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => this._poll(), this._retryDelay);
    this._retryDelay = Math.min(this._retryDelay * 2, 3000);
  }

  async _save() {
    await fetch("/api/super-agent/tasks", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tasks: this._tasks }),
    });
    this._lastJson = null;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  async _approve(taskId) {
    const task = this._tasks.find((t) => t.id === taskId);
    if (!task || !isDispatchableProjectPath(task.targetProject)) return;
    const index = this._tasks.findIndex((t) => t.id === taskId);
    this._tasks[index] = markTaskForDispatch(task);
    await this._save();
    this._renderAll();
    this.dispatchEvent(
      new CustomEvent("sa-dispatch", { detail: this._tasks[index], bubbles: true }),
    );
  }

  _selectProject(taskId, targetProject) {
    const index = this._tasks.findIndex((t) => t.id === taskId);
    if (index < 0) return;
    const project = this._projects.find((item) => item.cwd === targetProject);
    this._tasks[index] = {
      ...this._tasks[index],
      targetProject,
      dispatch: {
        ...(this._tasks[index].dispatch || {}),
        targetProject,
      },
      routingConfidence: "user_selected",
      routingReason: project
        ? `Selected in Picot Runtime panel from project registry (${project.name}).`
        : "Selected in Picot Runtime panel.",
    };
    this._renderTasks();
  }

  async _dismiss(taskId) {
    this._tasks = this._tasks.filter((t) => t.id !== taskId);
    await this._save();
    this._renderAll();
  }

  async _forceCancel(taskId) {
    const index = this._tasks.findIndex((t) => t.id === taskId);
    if (index < 0) return;
    this._tasks[index] = markTaskFinished(this._tasks[index], {
      status: "failed",
      failReason: "Manually cancelled from Runtime panel.",
    });
    await this._save();
    this._renderAll();
  }

  async _approveAll() {
    const readyTasks = this._tasks.filter(
      (task) => task.status === "pending" && isDispatchableProjectPath(task.targetProject),
    );
    if (readyTasks.length === 0) return;
    const readyIds = new Set(readyTasks.map((task) => task.id));
    this._tasks = this._tasks.map((task) =>
      readyIds.has(task.id) ? markTaskForDispatch(task) : task,
    );
    await this._save();
    this._renderAll();
    for (const task of this._tasks) {
      if (readyIds.has(task.id)) {
        this.dispatchEvent(new CustomEvent("sa-dispatch", { detail: task, bubbles: true }));
      }
    }
  }

  async _clearDone() {
    const nextTasks = this._tasks.filter((task) => task.status !== "done");
    if (nextTasks.length === this._tasks.length) return;
    this._tasks = nextTasks;
    await this._save();
    this._renderAll();
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  _renderAll() {
    const pending = this._tasks.filter((t) => t.status === "pending").length;
    const running = this._tasks.filter((t) => ACTIVE_TASK_STATUSES.has(t.status)).length;
    const done = this._tasks.filter((t) => t.status === "done").length;

    const q = (sel) => this.querySelector(sel);
    q("[data-pending-count]").textContent = pending;
    q("[data-running-count]").textContent = running;
    q("[data-done-count]").textContent = done;

    this._renderBulkActions();

    // Update sidebar entry badge (outside this component)
    const badge = document.getElementById("super-agent-badge");
    if (badge) {
      const urgent = pending + running;
      badge.textContent = urgent;
      badge.classList.toggle("hidden", urgent === 0);
    }

    this._renderTasks();
  }

  _renderTasks() {
    const list = this.querySelector("[data-task-list]");
    if (!list) return;
    list.replaceChildren();

    if (!this._hasLoadedOnce) {
      const empty = document.createElement("div");
      empty.className = "runtime-empty";
      empty.textContent = "Connecting…";
      list.appendChild(empty);
      return;
    }

    const order = { pending: 0, needs_input: 1, blocked: 2, running: 3, failed: 4, done: 5 };
    const filtered = [...this._tasks]
      .filter((task) => {
        if (this._filter === "all") return true;
        if (this._filter === "running") return ACTIVE_TASK_STATUSES.has(task.status);
        return task.status === this._filter;
      })
      .sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4));

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "runtime-empty";
      empty.textContent = `No tasks${this._filter !== "all" ? ` with status "${this._filter}"` : ""}…`;
      list.appendChild(empty);
      return;
    }

    filtered.forEach((task) => {
      list.appendChild(this._buildCard(task));
    });
    this._bindCardEvents(list);
  }

  _renderBulkActions() {
    const container = this.querySelector("[data-bulk-actions]");
    if (!container) return;
    const ready = this._tasks.filter(
      (task) => task.status === "pending" && isDispatchableProjectPath(task.targetProject),
    ).length;
    const done = this._tasks.filter((task) => task.status === "done").length;
    container.replaceChildren();

    const approve = createRuntimeButton(`Approve ${ready}`, "approve-all", "sa-btn sa-btn-approve");
    approve.disabled = ready === 0;
    const clear = createRuntimeButton("Clear Done", "clear-done", "sa-btn sa-btn-dismiss");
    clear.disabled = done === 0;
    container.append(approve, clear);
    approve.addEventListener("click", (event) => {
      event.stopPropagation();
      this._approveAll();
    });
    clear.addEventListener("click", (event) => {
      event.stopPropagation();
      this._clearDone();
    });
  }

  _buildCard(task) {
    const isExpanded = this._expandedTaskIds.has(task.id);
    const card = document.createElement("div");
    card.className = `runtime-task-card status-${task.status} ${isExpanded ? "is-expanded" : "is-collapsed"}`;
    card.dataset.taskId = String(task.id);
    card.setAttribute("role", "button");
    card.tabIndex = 0;
    card.setAttribute("aria-expanded", String(isExpanded));

    const header = document.createElement("div");
    header.className = "runtime-task-header";
    const status = document.createElement("span");
    status.className = "runtime-status-dot";
    const title = document.createElement("span");
    title.className = "runtime-task-title";
    title.textContent = task.title || "(untitled)";
    const expandIcon = document.createElement("span");
    expandIcon.className = "runtime-task-expand-icon";
    expandIcon.setAttribute("aria-hidden", "true");
    header.append(status, title, this._quickActions(task), expandIcon);
    card.appendChild(header);

    if (!isExpanded) return card;

    const body = document.createElement("div");
    if (task.description) {
      const description = document.createElement("div");
      description.className = "runtime-task-desc";
      description.appendChild(formatTaskDescription(task.description));
      body.appendChild(description);
    }
    const source = sourceNode(task);
    if (source) body.appendChild(source);

    const hasTargetProject = isDispatchableProjectPath(task.targetProject);
    const projectName = task.targetProject?.split("/").pop() || "";
    if (task.status === "pending") {
      body.appendChild(this._projectPicker(task));
      const actions = document.createElement("div");
      actions.className = "runtime-approve-row";
      actions.appendChild(
        createRuntimeButton("Prompt AI", "prompt-task", "sa-btn", null, 14, task.id),
      );
      if (hasTargetProject) {
        actions.appendChild(
          createRuntimeButton("Approve", "approve", "sa-btn sa-btn-approve", null, 14, task.id),
        );
      }
      actions.appendChild(
        createRuntimeButton("Dismiss", "dismiss", "sa-btn sa-btn-dismiss", "x", 14, task.id),
      );
      body.appendChild(actions);
    } else if (task.status === "done" || task.status === "running") {
      if (hasTargetProject) body.appendChild(targetNode("Target", projectName));
      if (task.dispatch?.childPort) {
        const actions = document.createElement("div");
        actions.className = "runtime-approve-row";
        actions.appendChild(
          createRuntimeButton(
            "View Session",
            "view-session",
            "sa-btn",
            "arrow-right",
            14,
            task.id,
            true,
          ),
        );
        if (task.status === "running") {
          actions.appendChild(
            createRuntimeButton(
              "Force Cancel",
              "force-cancel",
              "sa-btn sa-btn-dismiss",
              null,
              14,
              task.id,
            ),
          );
        }
        body.appendChild(actions);
      } else if (task.status === "running") {
        const actions = document.createElement("div");
        actions.className = "runtime-approve-row";
        actions.appendChild(
          createRuntimeButton(
            "Force Cancel",
            "force-cancel",
            "sa-btn sa-btn-dismiss",
            null,
            14,
            task.id,
          ),
        );
        body.appendChild(actions);
      }
    } else if (["failed", "blocked", "needs_input"].includes(task.status)) {
      const error = document.createElement("div");
      error.className = "runtime-task-error";
      error.textContent = task.result?.failReason || task.failReason || "Waiting for input.";
      body.appendChild(error);
      if (hasTargetProject) {
        body.appendChild(targetNode("Project", projectName));
        const actions = document.createElement("div");
        actions.className = "runtime-approve-row";
        actions.appendChild(
          createRuntimeButton("Retry", "retry", "sa-btn sa-btn-approve", null, 14, task.id),
        );
        actions.appendChild(
          createRuntimeButton("Dismiss", "dismiss", "sa-btn sa-btn-dismiss", null, 14, task.id),
        );
        body.appendChild(actions);
      } else {
        const missing = document.createElement("div");
        missing.className = "runtime-task-missing-target";
        missing.textContent = "Choose a project when creating this task.";
        const actions = document.createElement("div");
        actions.className = "runtime-approve-row";
        actions.appendChild(
          createRuntimeButton("Dismiss", "dismiss", "sa-btn sa-btn-dismiss", null, 14, task.id),
        );
        body.append(missing, actions);
      }
    }
    const history = this._history(task);
    if (history) body.appendChild(history);
    card.appendChild(body);
    return card;
  }

  _quickActions(task) {
    const wrapper = document.createElement("span");
    wrapper.className = "runtime-quick-actions";
    if (task.status === "pending") {
      wrapper.appendChild(
        createRuntimeButton("Prompt AI", "prompt-task", "sa-btn", null, 14, task.id),
      );
      if (isDispatchableProjectPath(task.targetProject)) {
        wrapper.appendChild(
          createRuntimeButton("Approve", "approve", "sa-btn sa-btn-approve", null, 14, task.id),
        );
      }
      wrapper.appendChild(
        createRuntimeButton("Dismiss", "dismiss", "sa-btn sa-btn-dismiss", null, 14, task.id),
      );
    } else if (task.status === "done") {
      wrapper.appendChild(
        createRuntimeButton("Clear", "dismiss", "sa-btn sa-btn-dismiss", null, 14, task.id),
      );
    }
    return wrapper;
  }

  _history(task) {
    if (!Array.isArray(task.events) || task.events.length === 0) return null;
    const container = document.createElement("div");
    container.className = "runtime-task-history";
    container.appendChild(
      createRuntimeButton("History", "toggle-history", "sa-btn", null, 14, task.id),
    );
    if (this._historyTaskIds.has(task.id)) {
      const list = document.createElement("div");
      list.className = "runtime-task-history-list";
      task.events.forEach((event) => {
        const item = document.createElement("div");
        item.className = "runtime-task-history-item";
        const at = document.createElement("span");
        at.textContent = formatHistoryTimestamp(event.at);
        const type = document.createElement("strong");
        type.textContent = event.type || event.status || "event";
        const message = document.createElement("p");
        message.textContent = event.message || event.status || "";
        item.append(at, type, message);
        list.appendChild(item);
      });
      container.appendChild(list);
    }
    return container;
  }

  _projectPicker(task) {
    const targetProject = String(task.targetProject || "");
    const projectOptions = [...this._projects];
    if (targetProject && !projectOptions.some((project) => project.cwd === targetProject)) {
      projectOptions.unshift({
        name: targetProject.split("/").pop() || targetProject,
        cwd: targetProject,
        status: "unknown",
      });
    }
    const label = document.createElement("label");
    label.className = "runtime-project-picker";
    const hint = document.createElement("span");
    hint.textContent = targetProject
      ? `Project: ${targetProject.split("/").pop() || targetProject}`
      : this._projectsLoadedOnce
        ? "Choose a project before approval."
        : "Loading projects…";
    const select = document.createElement("select");
    select.className = "runtime-project-select";
    select.dataset.action = "select-project";
    select.dataset.taskId = String(task.id);
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Choose a project…";
    select.appendChild(empty);
    projectOptions.forEach((project) => {
      const option = document.createElement("option");
      option.value = project.cwd;
      option.textContent = `${project.name || project.cwd}${project.status === "running" ? " · running" : ""}`;
      option.selected = project.cwd === targetProject;
      select.appendChild(option);
    });
    label.append(hint, select);
    return label;
  }

  _bindCardEvents(list) {
    list.querySelectorAll(".runtime-task-card").forEach((card) => {
      const toggle = () => {
        const { taskId } = card.dataset;
        if (this._expandedTaskIds.has(taskId)) {
          this._expandedTaskIds.delete(taskId);
        } else {
          this._expandedTaskIds.add(taskId);
        }
        this._renderTasks();
      };
      card.addEventListener("click", (e) => {
        if (e.target.closest("button, input, select, textarea, a")) return;
        toggle();
      });
      card.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (e.target.closest("button, input, select, textarea, a")) return;
        e.preventDefault();
        toggle();
      });
    });

    list.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const { action, taskId } = el.dataset;
        if (action === "approve" || action === "retry") {
          this._approve(taskId);
        } else if (action === "dismiss") {
          this._dismiss(taskId);
        } else if (action === "prompt-task") {
          const task = this._tasks.find((item) => item.id === taskId);
          if (task) {
            this.dispatchEvent(new CustomEvent("sa-prompt-task", { detail: task, bubbles: true }));
          }
        } else if (action === "approve-all") {
          this._approveAll();
        } else if (action === "clear-done") {
          this._clearDone();
        } else if (action === "force-cancel") {
          this._forceCancel(taskId);
        } else if (action === "view-session") {
          const task = this._tasks.find((item) => item.id === taskId);
          if (task) {
            this.dispatchEvent(new CustomEvent("sa-view-session", { detail: task, bubbles: true }));
          }
        } else if (action === "toggle-history") {
          if (this._historyTaskIds.has(taskId)) {
            this._historyTaskIds.delete(taskId);
          } else {
            this._historyTaskIds.add(taskId);
          }
          this._renderTasks();
        } else if (action === "select-project") {
          this._selectProject(taskId, el.value);
        }
      });
    });

    list.querySelectorAll('[data-action="select-project"]').forEach((el) => {
      el.addEventListener("change", (e) => {
        e.stopPropagation();
        this._selectProject(el.dataset.taskId, el.value);
      });
    });
  }
}

function isDispatchableProjectPath(path) {
  const normalized = String(path || "").replace(/\/+$/, "");
  return normalized.includes("/") && !normalized.endsWith("/.pi/agent/super-agent");
}

function createRuntimeButton(
  label,
  action,
  className,
  iconName = null,
  size = 14,
  taskId = null,
  iconAfter = false,
) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  if (action) button.dataset.action = action;
  if (taskId !== null && taskId !== undefined) button.dataset.taskId = String(taskId);
  const text = document.createElement("span");
  text.textContent = label;
  const icon = iconName ? createIcon(iconName, { size }) : null;
  if (iconAfter && icon) button.append(text, icon);
  else if (icon) button.append(icon, text);
  else if (label) button.appendChild(text);
  return button;
}

function targetNode(label, value) {
  const target = document.createElement("div");
  target.className = "runtime-task-target";
  target.append(`${label}: `);
  const strong = document.createElement("strong");
  strong.textContent = value;
  target.appendChild(strong);
  return target;
}

function sourceNode(task) {
  if (!task.source || task.source.channel === "local") return null;
  const source = document.createElement("div");
  source.className = "runtime-task-source";
  source.textContent = `Source: ${task.source.channel}`;
  return source;
}

function appendTaskInline(parent, text) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  parts.forEach((part) => {
    if (!part) return;
    const bold = part.match(/^\*\*([^*]+)\*\*$/);
    if (bold) {
      const strong = document.createElement("strong");
      strong.textContent = bold[1];
      parent.appendChild(strong);
    } else {
      parent.appendChild(document.createTextNode(part));
    }
  });
}

function formatTaskDescription(description) {
  const fragment = document.createDocumentFragment();
  for (const line of normalizeTaskDescription(description)) {
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+\.\s+(.+)$/);
    const element = document.createElement("div");
    element.className = heading
      ? "runtime-task-section-title"
      : bullet || numbered
        ? "runtime-task-list-item"
        : "runtime-task-paragraph";
    appendTaskInline(element, heading?.[1] || bullet?.[1] || numbered?.[1] || line);
    fragment.appendChild(element);
  }
  return fragment;
}

function normalizeTaskDescription(description) {
  return String(description ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+(#{1,6})\s+/g, "\n$1 ")
    .replace(/[ \t]+[-*]\s+(?=(?:\p{Extended_Pictographic}|\*\*|[A-Z0-9]))/gu, "\n- ")
    .replace(/[ \t]+(\d+)\.\s+/g, "\n$1. ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function isTypingTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, [contenteditable='true']"));
}

function formatHistoryTimestamp(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

customElements.define("super-agent-runtime", SuperAgentRuntime);
