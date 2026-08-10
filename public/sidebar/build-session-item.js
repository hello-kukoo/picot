// ABOUTME: Shared DOM builder for a single session row.
// ABOUTME: Consumed by the normal sidebar, the focus sidebar, and the archived section.
import { t } from "../i18n.js";

export function getSessionDisplayTitle(session) {
  return session?.name || session?.firstMessage || t("sidebar.emptySession");
}

/**
 * Relative timestamp for a session row ("Just now", "2h ago", weekday, …).
 * Shared by the normal sidebar and the focus sidebar so both render the same
 * time label.
 */
export function formatSessionTime(isoTimestamp) {
  try {
    const date = new Date(isoTimestamp);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const days = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t("sidebar.justNow");
    if (diffMins < 60) return t("sidebar.minutesAgo", { minutes: diffMins });
    if (diffHours < 24) return t("sidebar.hoursAgo", { hours: diffHours });
    if (days === 1) return t("sidebar.yesterday");
    if (days < 7) return date.toLocaleDateString([], { weekday: "long" });
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

export function buildSessionItem({
  session,
  project,
  isActive = false,
  isUnread = false,
  isStreaming = false,
  isArchived = false,
  isPinned = false,
  showPinButton = true,
  showArchiveButton = true,
  showDeleteButton = false,
  archiveDisabledReason = null,
  projectSearchText = "",
  formattedTime = "",
  onSelect = null,
  onPinToggle = null,
  onArchiveToggle = null,
  onDelete = null,
  onRename = null,
  onContextMenu = null,
  createIcon = null,
}) {
  const item = document.createElement("div");
  item.className = "session-item";
  item.dataset.filePath = session.filePath;
  item.dataset.projectSearchText = projectSearchText;
  item.dataset.name = String(session.name || "").toLowerCase();
  item.dataset.firstMessage = String(session.firstMessage || "").toLowerCase();

  if (isActive) item.classList.add("active");
  if (isUnread) item.classList.add("unread");
  if (isStreaming) item.classList.add("streaming");

  const title = getSessionDisplayTitle(session);
  const pinBtnLabel = isPinned ? t("sidebar.unpinSession") : t("sidebar.pinSession");
  const archiveBtnLabel = isArchived ? t("sidebar.unarchiveSession") : t("sidebar.archiveSession");

  const titleRow = document.createElement("div");
  titleRow.className = "session-title-row";
  const titleElement = document.createElement("div");
  titleElement.className = "session-title";
  titleElement.title = title;
  titleElement.textContent = title;
  titleRow.appendChild(titleElement);
  if (session.tmux) {
    const tmuxTag = document.createElement("span");
    tmuxTag.className = "session-tag tmux-tag";
    tmuxTag.textContent = "tmux";
    titleRow.appendChild(tmuxTag);
  }
  const actionSlot = document.createElement("span");
  actionSlot.className = "session-action-slot";
  const timeElement = document.createElement("span");
  timeElement.className = "session-time";
  timeElement.textContent = formattedTime;
  actionSlot.appendChild(timeElement);
  titleRow.appendChild(actionSlot);
  item.appendChild(titleRow);

  if (typeof onSelect === "function") {
    item.addEventListener("click", () => onSelect(session, project));
  }
  if (typeof onContextMenu === "function") {
    item.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onContextMenu(event, item, session);
    });
  }

  if (showPinButton) {
    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "session-pin-btn";
    pinBtn.title = pinBtnLabel;
    pinBtn.setAttribute("aria-label", pinBtnLabel);
    pinBtn.setAttribute("aria-pressed", String(isPinned));
    const pinIcon = document.createElement("span");
    pinIcon.className = "session-pin-icon";
    pinIcon.setAttribute("aria-hidden", "true");
    if (typeof createIcon === "function") {
      const pinGlyph = createIcon("pin", { size: 13 });
      if (pinGlyph) pinIcon.replaceChildren(pinGlyph);
    }
    pinBtn.appendChild(pinIcon);
    pinBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (typeof onPinToggle === "function") onPinToggle(session.filePath);
    });
    actionSlot.appendChild(pinBtn);
  }

  if (showArchiveButton) {
    const archiveBtn = document.createElement("button");
    archiveBtn.type = "button";
    archiveBtn.className = "session-archive-btn";
    if (archiveDisabledReason) {
      archiveBtn.disabled = true;
      archiveBtn.classList.add("disabled");
      archiveBtn.title = archiveDisabledReason;
      archiveBtn.setAttribute("aria-label", archiveDisabledReason);
    } else {
      archiveBtn.title = archiveBtnLabel;
      archiveBtn.setAttribute("aria-label", archiveBtnLabel);
    }
    if (typeof createIcon === "function") archiveBtn.appendChild(createIcon("archive"));
    archiveBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (archiveBtn.disabled) return;
      if (typeof onArchiveToggle === "function") onArchiveToggle(session.filePath);
    });
    actionSlot.appendChild(archiveBtn);
  }

  if (typeof onRename === "function") {
    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "session-rename-btn";
    const renameLabel = t("sidebar.rename");
    renameBtn.title = renameLabel;
    renameBtn.setAttribute("aria-label", renameLabel);
    if (typeof createIcon === "function") {
      const renameIcon = createIcon("pencil", { size: 13 });
      if (renameIcon) renameBtn.replaceChildren(renameIcon);
      else renameBtn.replaceChildren();
    } else {
      renameBtn.replaceChildren();
    }
    renameBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      onRename(session.filePath, session, item);
    });
    actionSlot.appendChild(renameBtn);
  }

  if (showDeleteButton) {
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "session-delete-btn";
    const deleteLabel = t("sidebar.deleteSession");
    deleteBtn.title = deleteLabel;
    deleteBtn.setAttribute("aria-label", deleteLabel);
    if (typeof createIcon === "function") deleteBtn.appendChild(createIcon("trash-2"));
    deleteBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      if (typeof onDelete === "function") onDelete(session.filePath);
    });
    actionSlot.appendChild(deleteBtn);
  }

  return item;
}
