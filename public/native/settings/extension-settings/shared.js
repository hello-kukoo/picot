// ABOUTME: Shared row primitives for the per-package extension settings renderers.
// ABOUTME: Ported verbatim from features-v3 package-extension-settings.js.

/** General-page row contract: label left, control (+ trailing) right. */
export function fieldRow(labelText, control, trailing) {
  const row = document.createElement("div");
  row.className = "settings-row";
  const label = document.createElement("span");
  label.className = "settings-label";
  label.textContent = labelText;
  const controls = document.createElement("span");
  controls.className = "pkg-ext-controls";
  controls.append(control);
  if (trailing) controls.appendChild(trailing);
  row.append(label, controls);
  return row;
}
