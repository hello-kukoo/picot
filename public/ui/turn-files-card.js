// ABOUTME: Collapsible per-turn files card — one row per written file with
// ABOUTME: frozen git status badges and +N -M stats (2026-09-19 spec).
import { t } from "../i18n.js";

const SVG_NS = "http://www.w3.org/2000/svg";

const BADGE_LABEL_KEYS = {
  added: "messages.turnFilesAdded",
  modified: "messages.turnFilesModified",
  untracked: "messages.turnFilesUntracked",
};

function fileNameOf(filePath) {
  const parts = String(filePath).split("/");
  return parts[parts.length - 1] || String(filePath);
}

/**
 * `+N` / `-M` stat spans for one frozen stat, or null when it carries none.
 * `additionsCapped` means the host stopped counting before EOF, so the number
 * is a lower bound and renders as `+≥N`.
 */
function statParts(stat) {
  if (!stat) return null;
  const parts = [];
  if (stat.additions > 0) {
    parts.push({
      className: "turn-files-stat--add",
      text: stat.additionsCapped
        ? t("messages.turnFilesAtLeast", { count: stat.additions })
        : `+${stat.additions}`,
    });
  }
  if (stat.deletions > 0) {
    parts.push({ className: "turn-files-stat--del", text: `-${stat.deletions}` });
  }
  return parts.length > 0 ? parts : null;
}

/**
 * Build the turn files card. `writes` is the turn's written-path list
 * (first-write order); `statsByPath` maps each path to
 * `{ status, additions, deletions, additionsCapped }` frozen at turn end.
 *
 * `statsUnavailable` marks a failed stats query (non-git workspace, git error,
 * timeout) so the header can say so instead of looking like "nothing changed";
 * `history` marks a rebuilt transcript, where stats are absent by design and
 * therefore carry no warning. `deleted` rows are never rendered.
 */
export function renderTurnFilesCard({
  writes,
  statsByPath = null,
  statsUnavailable = false,
  history = false,
} = {}) {
  const entries = (Array.isArray(writes) ? writes : []).filter(
    (entry) => typeof entry?.filePath === "string" && entry.filePath.trim(),
  );
  if (!entries.length) return null;

  const rows = entries
    .map((entry) => ({
      path: entry.filePath,
      stat: statsByPath?.get?.(entry.filePath) ?? null,
    }))
    .filter((row) => row.stat?.status !== "deleted");
  if (!rows.length) return null;

  const card = document.createElement("div");
  card.className = "turn-files-card";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "turn-files-toggle";
  toggle.setAttribute("aria-expanded", "false");
  // The toggle's accessible name comes from its content (count + warning); the
  // title carries the stat caliber so the numbers are not read as per-turn.
  toggle.title = history ? t("messages.turnFilesHistoryNote") : t("messages.turnFilesCaliber");
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "8");
  svg.setAttribute("height", "8");
  svg.setAttribute("viewBox", "0 0 8 8");
  svg.setAttribute("fill", "currentColor");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M2 1l4 3-4 3z");
  svg.appendChild(path);
  chevron.appendChild(svg);
  const label = document.createElement("span");
  label.className = "turn-files-label";
  label.textContent = t("messages.turnFiles", { count: rows.length });
  toggle.append(chevron, label);
  if (statsUnavailable) {
    const note = document.createElement("span");
    note.className = "turn-files-note";
    note.textContent = `· ${t("messages.turnFilesUnavailable")}`;
    toggle.append(note);
  }
  toggle.addEventListener("click", () => {
    const expanded = card.classList.toggle("expanded");
    toggle.setAttribute("aria-expanded", String(expanded));
  });

  const body = document.createElement("div");
  body.className = "turn-files-body";
  for (const row of rows) {
    const { path: filePath, stat } = row;
    const el = document.createElement("button");
    el.type = "button";
    el.className = "turn-files-row";
    el.dataset.path = filePath;
    const name = fileNameOf(filePath);
    el.title = filePath;
    const openLabel = t("tools.openInPreview");

    const parts = statParts(stat);
    const accessible = [`${openLabel}: ${name}`];
    if (stat && BADGE_LABEL_KEYS[stat.status]) {
      const badge = document.createElement("span");
      badge.className = `turn-files-badge turn-files-badge--${stat.status}`;
      badge.textContent = t(BADGE_LABEL_KEYS[stat.status]);
      el.appendChild(badge);
      accessible.push(badge.textContent);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "turn-files-badge turn-files-badge--none";
      spacer.setAttribute("aria-hidden", "true");
      el.appendChild(spacer);
    }

    const nameSpan = document.createElement("span");
    nameSpan.className = "turn-files-name";
    nameSpan.textContent = name;
    el.appendChild(nameSpan);

    if (parts) {
      const stats = document.createElement("span");
      stats.className = "turn-files-stats";
      for (const part of parts) {
        const span = document.createElement("span");
        span.className = `turn-files-stat ${part.className}`;
        span.textContent = part.text;
        stats.appendChild(span);
        accessible.push(part.text);
      }
      el.appendChild(stats);
    }

    el.setAttribute("aria-label", accessible.join(" "));
    body.appendChild(el);
  }

  card.append(toggle, body);
  return card;
}

/**
 * Place the card inside the message, directly before its copy/timestamp
 * toolbar, so the toolbar stays the turn's last row. A message with no toolbar
 * (non-copyable answer, suppressed toolbar) keeps the card right after it.
 */
export function mountTurnFilesCard(messageEl, card) {
  if (!card) return;
  const actions = messageEl.querySelector(".message-actions");
  if (actions) actions.insertAdjacentElement("beforebegin", card);
  else messageEl.insertAdjacentElement("afterend", card);
}
