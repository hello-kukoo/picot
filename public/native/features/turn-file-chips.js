// ABOUTME: Renders per-turn written-file chips under the final assistant message.
// ABOUTME: Clicking a chip opens that file in the preview panel via previewfile.

import { t } from "../../i18n.js";

/**
 * @param {Array<{filePath: string}>} writes
 * @returns {HTMLElement|null} chips row, or null when nothing was written
 */
export function renderTurnFileChips(writes) {
  const entries = (Array.isArray(writes) ? writes : []).filter(
    (entry) => typeof entry?.filePath === "string" && entry.filePath.trim(),
  );
  if (!entries.length) return null;

  const row = document.createElement("div");
  row.className = "turn-file-chips";
  const label = document.createElement("span");
  label.className = "turn-file-chips-label";
  label.textContent = t("messages.turnFiles", { count: entries.length });
  row.appendChild(label);

  for (const entry of entries) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "turn-file-chip";
    const name = fileNameOf(entry.filePath);
    chip.textContent = name;
    chip.title = entry.filePath;
    chip.dataset.path = entry.filePath;
    const openLabel = t("tools.openInPreview");
    chip.setAttribute("aria-label", `${openLabel}: ${name}`);
    chip.addEventListener("click", () => {
      row.dispatchEvent(
        new CustomEvent("previewfile", { bubbles: true, detail: { path: entry.filePath } }),
      );
    });
    row.appendChild(chip);
  }
  return row;
}

function fileNameOf(filePath) {
  const parts = String(filePath).split("/");
  return parts[parts.length - 1] || String(filePath);
}
