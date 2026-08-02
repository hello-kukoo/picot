// ABOUTME: Provides local Lucide Icons (ISC) style SVG action icons for Picot controls.
// ABOUTME: Keeps icon DOM creation safe, same-origin, and independent of user content.

const SVG_NS = "http://www.w3.org/2000/svg";

const ICONS = {
  eye: [
    ["path", { d: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" }],
    ["circle", { cx: 12, cy: 12, r: 3 }],
  ],
  pencil: [
    ["path", { d: "M12 20h9" }],
    ["path", { d: "M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" }],
  ],
  save: [
    ["path", { d: "M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" }],
    ["path", { d: "M17 21v-8H7v8M7 3v5h8" }],
  ],
  refresh: [
    ["path", { d: "M21 12a9 9 0 0 1-15.2 6.5L3 16" }],
    ["path", { d: "M3 12A9 9 0 0 1 18.2 5.5L21 8" }],
    ["path", { d: "M3 21v-5h5M21 3v5h-5" }],
  ],
  search: [
    ["circle", { cx: 11, cy: 11, r: 8 }],
    ["path", { d: "m21 21-4.3-4.3" }],
  ],
  list: [
    ["path", { d: "M8 6h13M8 12h13M8 18h13" }],
    ["path", { d: "M3 6h.01M3 12h.01M3 18h.01" }],
  ],
  copy: [
    ["rect", { x: 9, y: 9, width: 13, height: 13, rx: 2 }],
    ["path", { d: "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" }],
  ],
  "external-link": [
    ["path", { d: "M15 3h6v6" }],
    ["path", { d: "M10 14 21 3" }],
    ["path", { d: "M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" }],
  ],
  sliders: [
    ["line", { x1: 4, y1: 6, x2: 20, y2: 6 }],
    ["line", { x1: 4, y1: 12, x2: 20, y2: 12 }],
    ["line", { x1: 4, y1: 18, x2: 20, y2: 18 }],
    ["circle", { cx: 8, cy: 6, r: 2 }],
    ["circle", { cx: 16, cy: 12, r: 2 }],
    ["circle", { cx: 10, cy: 18, r: 2 }],
  ],
  wrap: [
    ["path", { d: "M3 6h18M3 12h12a3 3 0 1 1 0 6H9" }],
    ["path", { d: "m9 15-3 3 3 3" }],
  ],
  x: [["path", { d: "M18 6 6 18M6 6l12 12" }]],
  plus: [["path", { d: "M12 5v14M5 12h14" }]],
  maximize: [
    ["path", { d: "M8 3H5a2 2 0 0 0-2 2v3" }],
    ["path", { d: "M21 8V5a2 2 0 0 0-2-2h-3" }],
    ["path", { d: "M3 16v3a2 2 0 0 0 2 2h3" }],
    ["path", { d: "M16 21h3a2 2 0 0 0 2-2v-3" }],
  ],
  "message-square-plus": [
    ["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" }],
    ["path", { d: "M12 8v6M9 11h6" }],
  ],
};

/** Append a trusted local icon. Unknown names intentionally render no SVG. */
export function createIcon(name, { size = 16 } = {}) {
  const definition = ICONS[name];
  if (!definition) return null;
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [key, value] of Object.entries({
    "aria-hidden": "true",
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    focusable: "false",
  })) {
    svg.setAttribute(key, String(value));
  }
  for (const [tag, attributes] of definition) {
    const element = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    svg.appendChild(element);
  }
  return svg;
}

/** Replace a button's decorative content without changing its accessible name. */
export function setButtonIcon(button, name, options) {
  if (!button) return;
  const icon = createIcon(name, options);
  if (icon) button.replaceChildren(icon);
}
