// ABOUTME: Browser pane lifecycle for file-preview tabs (spec 2026-09-22).
// ABOUTME: Owns child-webview rect sync (ResizeObserver → rAF), the eval bridge, and visibility.

const PANES = new Map();

/**
 * Open a browser pane: create the native child webview clipped to
 * `container`'s rect, then keep it in sync while the container resizes.
 *
 * `container` is a plain DOM element inside the file-preview content area.
 * The child webview floats above the host webview at native level, so its
 * geometry must mirror the container's window-relative rect at all times.
 */
export async function openPane({ paneId, url, container, transport }) {
  const existing = PANES.get(paneId);
  if (existing) {
    if (existing.container === container) return existing;
    existing.observer?.disconnect();
    existing.container = container;
    const rect = container.getBoundingClientRect();
    await existing.transport.browserPaneSetRect({
      paneId: existing.paneKey,
      x: rect.x,
      y: rect.y,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    });
    existing.observer = observeContainer(existing);
    return existing;
  }
  const windowLabel = currentWindowLabel();
  if (!windowLabel) {
    // A missing label cannot address the native webview; failing loudly beats
    // silently colliding with another window's pane key.
    throw new Error("window_label_unavailable");
  }
  // Panes are keyed window-qualified host-side: two workspace windows may
  // hold the same file path (and therefore the same tab id) at once.
  const entry = {
    paneId,
    paneKey: `${windowLabel}:${paneId}`,
    container,
    transport,
    url,
    visible: false,
    observer: null,
    rafId: 0,
    dirty: null,
    dead: false,
  };
  PANES.set(paneId, entry);
  const rect = container.getBoundingClientRect();
  try {
    await transport.browserPaneCreate({
      paneId: entry.paneKey,
      windowLabel,
      url,
      x: rect.x,
      y: rect.y,
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    });
  } catch (error) {
    // A failed create must not leave a usable-looking entry behind: later
    // opens would short-circuit on it and every eval would miss the pane.
    PANES.delete(paneId);
    throw error;
  }
  entry.observer = observeContainer(entry);
  return entry;
}

function observeContainer(entry) {
  const observer = new ResizeObserver(() => {
    entry.dirty = entry.container.getBoundingClientRect();
    scheduleSync(entry);
  });
  observer.observe(entry.container);
  return observer;
}

function currentWindowLabel() {
  return window.__TAURI__?.window?.getCurrentWindow?.()?.label ?? "";
}

/** Coalesce resize bursts to one native rect update per animation frame. */
function scheduleSync(entry) {
  if (entry.rafId || entry.dead) return;
  entry.rafId = requestAnimationFrame(() => {
    entry.rafId = 0;
    const rect = entry.dirty;
    entry.dirty = null;
    if (!rect || entry.dead) return;
    void entry.transport
      .browserPaneSetRect({
        paneId: entry.paneKey,
        x: rect.x,
        y: rect.y,
        width: Math.max(1, rect.width),
        height: Math.max(1, rect.height),
      })
      .catch(() => {});
    // A collapsed panel reports a zero-width rect; hide rather than pin a
    // sliver of native webview over the UI.
    if (rect.width < 2 || rect.height < 2) {
      setVisible(entry, false);
    }
  });
}

function setVisible(entry, visible) {
  if (entry.dead || entry.visible === visible) return;
  entry.visible = visible;
  void entry.transport.browserPaneSetVisible({ paneId: entry.paneKey, visible }).catch(() => {});
}

/** Push the container's current geometry after an explicit layout transition. */
export async function syncPane(paneId) {
  const entry = PANES.get(paneId);
  if (!entry || entry.dead) return;
  const rect = entry.container.getBoundingClientRect();
  await entry.transport.browserPaneSetRect({
    paneId: entry.paneKey,
    x: rect.x,
    y: rect.y,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
  });
}

/** Show/hide without destroying (tab switching keeps the page alive). */
export function showPane(paneId, visible) {
  const entry = PANES.get(paneId);
  if (entry) setVisible(entry, visible);
}

/** Hide all native panes when their DOM host is collapsed or replaced. */
export function hideAllPanes() {
  for (const entry of PANES.values()) setVisible(entry, false);
}

/** Destroy the child webview and stop syncing (tab close / panel teardown). */
export function closePane(paneId) {
  const entry = PANES.get(paneId);
  if (!entry) return;
  entry.dead = true;
  if (entry.rafId) cancelAnimationFrame(entry.rafId);
  entry.observer?.disconnect();
  PANES.delete(paneId);
  void entry.transport.browserPaneDestroy({ paneId: entry.paneKey }).catch(() => {});
}

/** Navigate an existing pane; also refreshes the tracked URL. */
export async function navigatePane(paneId, url, transport) {
  const entry = PANES.get(paneId);
  await transport.browserPaneNavigate({ paneId: entry?.paneKey ?? paneId, url });
  if (entry) entry.url = url;
}

/** The envelope's encoding depth is not fixed: `eval_with_callback`
 * re-serializes the JavaScript return value, so the bridge can hand back the
 * envelope as an object or as one-or-more nested JSON strings. Unwrap until it
 * stops being a string instead of assuming a depth. */
function unwrapEnvelope(raw) {
  let value = raw;
  for (let depth = 0; depth < 3 && typeof value === "string"; depth += 1) {
    try {
      value = JSON.parse(value);
    } catch {
      break;
    }
  }
  return value;
}

/** `data_response` resolution returns the frame's own `result` value, so what
 * arrives here is the envelope itself. A wrapped `{ result }` shape also occurs
 * when the frame carries other payload fields; accept both. */
function evalEnvelope(response) {
  if (response && typeof response === "object" && !("ok" in response) && "result" in response) {
    return response.result;
  }
  return response;
}

function describeEnvelope(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return typeof value;
  const keys = Object.keys(value);
  return keys.length > 0 ? `keys:${keys.slice(0, 5).join("|")}` : "empty-object";
}

/** Promise-style executeJavaScript: resolves with the deserialized JSON
 * value of `expression`. Rejects on timeout or when the pane is gone. */
export async function evalPane(paneId, expression, transport) {
  const entry = PANES.get(paneId);
  if (!entry || entry.dead) throw new Error("pane_not_found");
  const response = await transport.browserPaneEval({ paneId: entry.paneKey, js: expression });
  const envelope = unwrapEnvelope(evalEnvelope(response));
  if (envelope?.ok !== true) {
    // The shape is the diagnosis; never collapse it to a bare "eval_failed".
    throw new Error(envelope?.error ?? `eval_failed:${describeEnvelope(envelope)}`);
  }
  return envelope.value ?? null;
}

/** The URL the pane was last navigated to (host-side truth lives in Rust). */
export function paneUrl(paneId) {
  return PANES.get(paneId)?.url ?? null;
}

/** Whether the pane's container currently intersects the visible layout. */
export function paneVisible(paneId) {
  const entry = PANES.get(paneId);
  return Boolean(entry?.visible && !entry.dead);
}
