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
  if (PANES.has(paneId)) return PANES.get(paneId);
  const windowLabel = window.__TAURI__?.window?.getCurrentWindow?.()?.label ?? "";
  const entry = {
    paneId,
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
  await transport.browserPaneCreate({
    paneId,
    windowLabel,
    url,
    x: rect.x,
    y: rect.y,
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
  });
  entry.observer = new ResizeObserver(() => {
    entry.dirty = container.getBoundingClientRect();
    scheduleSync(entry);
  });
  entry.observer.observe(container);
  return entry;
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
        paneId: entry.paneId,
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
  void entry.transport.browserPaneSetVisible({ paneId: entry.paneId, visible }).catch(() => {});
}

/** Show/hide without destroying (tab switching keeps the page alive). */
export function showPane(paneId, visible) {
  const entry = PANES.get(paneId);
  if (entry) setVisible(entry, visible);
}

/** Destroy the child webview and stop syncing (tab close / panel teardown). */
export function closePane(paneId) {
  const entry = PANES.get(paneId);
  if (!entry) return;
  entry.dead = true;
  if (entry.rafId) cancelAnimationFrame(entry.rafId);
  entry.observer?.disconnect();
  PANES.delete(paneId);
  void entry.transport.browserPaneDestroy({ paneId }).catch(() => {});
}

/** Navigate an existing pane; also refreshes the tracked URL. */
export async function navigatePane(paneId, url, transport) {
  await transport.browserPaneNavigate({ paneId, url });
  const entry = PANES.get(paneId);
  if (entry) entry.url = url;
}

/** Promise-style executeJavaScript: resolves with the deserialized JSON
 * value of `expression`. Rejects on timeout or when the pane is gone. */
export async function evalPane(paneId, expression, transport) {
  const entry = PANES.get(paneId);
  if (!entry || entry.dead) throw new Error("pane_not_found");
  const response = await transport.browserPaneEval({ paneId, js: expression });
  let envelope = null;
  try {
    envelope = JSON.parse(response.result ?? "null");
  } catch {
    throw new Error("eval_failed");
  }
  if (envelope?.ok !== true) {
    throw new Error(envelope?.error ?? "eval_failed");
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
