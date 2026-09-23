// ABOUTME: Element selector ported from Paseo (spec 2026-09-22): IIFE injection,
// ABOUTME: 200ms polling, session tokens, Esc cancel, plus data-path doc anchors.

const SELECTOR_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 200;

/**
 * Build the self-contained selector IIFE. Pure DOM JavaScript, zero
 * dependencies; injected via the pane eval bridge. The script installs
 * hover-highlight + capture-blocking listeners and leaves the picked element
 * (or a cancellation marker) on `window.__picotSelectorResult`.
 *
 * Ported from Paseo's element-selector.electron.ts with one enhancement: the
 * captured element reports the nearest `[data-path]` ancestor (officecli
 * watch pages anchor every rendered node to its document-tree path).
 */
export function buildElementSelectorScript(sessionToken) {
  const token = JSON.stringify(sessionToken);
  return `
    (function() {
      var sessionToken = ${token};
      if (document.readyState === 'loading' || !document.head || !document.documentElement) {
        return { installed: false, reason: 'document-loading', sessionToken: sessionToken };
      }
      if (window.__picotSelector) { window.__picotSelector.destroy(); }
      window.__picotSelectorResult = null;
      var style = document.createElement('style');
      style.textContent = [
        '.__picot-hover { outline: 2px solid #3b82f6 !important; outline-offset: 2px !important; cursor: crosshair !important; }',
        '.__picot-select-mode, .__picot-select-mode * { cursor: crosshair !important; pointer-events: auto !important; user-select: none !important; }',
        '.__picot-select-mode *, .__picot-select-mode *::before, .__picot-select-mode *::after { animation: none !important; transition: none !important; }',
        '.__picot-select-mode a, .__picot-select-mode button, .__picot-select-mode input, .__picot-select-mode select, .__picot-select-mode textarea, .__picot-select-mode [role="button"], .__picot-select-mode [onclick] { pointer-events: none !important; }',
        '.__picot-select-mode iframe, .__picot-select-mode video, .__picot-select-mode audio { pointer-events: none !important; }',
        '.__picot-hover-label { position: fixed; z-index: 2147483647; pointer-events: none; max-width: 360px; padding: 4px 8px; border-radius: 6px; background: rgba(24,24,27,0.96); color: #fff; font: 500 11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; box-shadow: 0 2px 10px rgba(0,0,0,0.35); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
        '.__picot-hover-label .__picot-tag { color: #93c5fd; }',
        '.__picot-hover-label .__picot-id { color: #fca5a5; }',
        '.__picot-hover-label .__picot-cls { color: #fcd34d; }',
        '.__picot-hover-label .__picot-dim { color: #a1a1aa; margin-left: 6px; }',
        '.__picot-hover-label .__picot-comp { color: #86efac; margin-left: 6px; }',
      ].join('\\n');
      document.head.appendChild(style);
      document.documentElement.classList.add('__picot-select-mode');
      var hoverLabel = document.createElement('div');
      hoverLabel.className = '__picot-hover-label';
      hoverLabel.style.display = 'none';
      document.documentElement.appendChild(hoverLabel);
      var last = null;
      function escapeHtml(value) {
        return String(value).replace(/[&<>"]/g, function(ch) {
          return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&quot;';
        });
      }
      function describeElement(el) {
        var tag = el.tagName ? el.tagName.toLowerCase() : 'node';
        var parts = ['<span class="__picot-tag">' + escapeHtml(tag) + '</span>'];
        if (el.id) {
          parts.push('<span class="__picot-id">#' + escapeHtml(el.id) + '</span>');
        }
        if (el.classList && el.classList.length) {
          var cls = Array.prototype.slice.call(el.classList, 0, 2)
            .filter(function(c) { return c.indexOf('__picot') !== 0; })
            .map(function(c) { return '.' + escapeHtml(c); })
            .join('');
          if (cls) parts.push('<span class="__picot-cls">' + cls + '</span>');
        }
        var comp = getReactSource(el);
        if (comp && comp.componentName) {
          parts.push('<span class="__picot-comp">&lt;' + escapeHtml(comp.componentName) + '&gt;</span>');
        }
        var rect = el.getBoundingClientRect();
        parts.push('<span class="__picot-dim">' + Math.round(rect.width) + '×' + Math.round(rect.height) + '</span>');
        return { html: parts.join(''), rect: rect };
      }
      function positionLabel(rect, e) {
        var lw = hoverLabel.offsetWidth || 0;
        var lh = hoverLabel.offsetHeight || 0;
        var top = rect.top - lh - 6;
        if (top < 4) top = rect.bottom + 6;
        if (top + lh > window.innerHeight - 4) top = Math.max(4, e.clientY - lh - 6);
        var left = rect.left;
        if (left + lw > window.innerWidth - 4) left = Math.max(4, window.innerWidth - lw - 4);
        if (left < 4) left = 4;
        hoverLabel.style.top = Math.round(top) + 'px';
        hoverLabel.style.left = Math.round(left) + 'px';
      }
      function onMove(e) {
        e.preventDefault();
        e.stopPropagation();
        if (last) last.classList.remove('__picot-hover');
        var el = e.target;
        el.classList.add('__picot-hover');
        last = el;
        try {
          var info = describeElement(el);
          hoverLabel.innerHTML = info.html;
          hoverLabel.style.display = 'block';
          positionLabel(info.rect, e);
        } catch (err) {
          hoverLabel.style.display = 'none';
        }
      }
      function buildSelector(el) {
        if (el.id) return '#' + el.id;
        var path = [];
        while (el && el.nodeType === 1) {
          var seg = el.tagName.toLowerCase();
          if (el.id) { path.unshift('#' + el.id); break; }
          var sib = el, nth = 1;
          while (sib = sib.previousElementSibling) { if (sib.tagName === el.tagName) nth++; }
          if (nth > 1) seg += ':nth-of-type(' + nth + ')';
          path.unshift(seg);
          el = el.parentElement;
        }
        return path.join(' > ');
      }
      function getReactSource(el) {
        var keys = Object.keys(el);
        for (var i = 0; i < keys.length; i++) {
          if (keys[i].startsWith('__reactFiber$') || keys[i].startsWith('__reactInternalInstance$')) {
            var fiber = el[keys[i]];
            while (fiber) {
              if (fiber._debugSource) {
                return {
                  fileName: fiber._debugSource.fileName || null,
                  lineNumber: fiber._debugSource.lineNumber || null,
                  columnNumber: fiber._debugSource.columnNumber || null,
                  componentName: (fiber.type && (typeof fiber.type === 'string' ? fiber.type : fiber.type.displayName || fiber.type.name)) || null
                };
              }
              if (fiber._debugOwner) { fiber = fiber._debugOwner; }
              else if (fiber.return) { fiber = fiber.return; }
              else break;
            }
          }
        }
        return null;
      }
      function getParentChain(el, depth) {
        var chain = [];
        var cur = el.parentElement;
        for (var i = 0; i < (depth || 5) && cur; i++) {
          var desc = cur.tagName.toLowerCase();
          if (cur.id) desc += '#' + cur.id;
          if (cur.className && typeof cur.className === 'string') { var cls = cur.className.trim().replace(/  +/g, ' ').split(' ').slice(0,2).join('.'); if (cls) desc += '.' + cls; }
          chain.push(desc);
          cur = cur.parentElement;
        }
        return chain;
      }
      function getChildSummary(el, max) {
        var kids = [];
        for (var i = 0; i < Math.min(el.children.length, max || 8); i++) {
          var c = el.children[i];
          var desc = c.tagName.toLowerCase();
          if (c.id) desc += '#' + c.id;
          kids.push(desc);
        }
        if (el.children.length > (max || 8)) kids.push('...(' + el.children.length + ' total)');
        return kids;
      }
      function getRelevantStyles(el) {
        var cs = window.getComputedStyle(el);
        var pick = ['display','position','width','height','color','background-color','font-size','font-family','padding','margin','border','flex','grid-template-columns','gap','overflow','opacity','z-index'];
        var out = {};
        pick.forEach(function(p) {
          var v = cs.getPropertyValue(p);
          if (v && v !== 'none' && v !== 'normal' && v !== 'auto' && v !== '0px' && v !== 'rgba(0, 0, 0, 0)') out[p] = v;
        });
        return out;
      }
      function captureSelection(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        var el = e.target;
        if (last) last.classList.remove('__picot-hover');
        hoverLabel.style.display = 'none';
        var attrs = {};
        for (var i = 0; i < el.attributes.length; i++) {
          attrs[el.attributes[i].name] = el.attributes[i].value;
        }
        var pathEl = el.closest('[data-path]');
        var rect = el.getBoundingClientRect();
        var result = {
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || '').substring(0, 500),
          selector: buildSelector(el),
          attributes: attrs,
          url: location.href,
          outerHTML: el.outerHTML.substring(0, 2000),
          computedStyles: getRelevantStyles(el),
          __picotSessionToken: sessionToken,
          docPath: pathEl ? pathEl.dataset.path : null,
          boundingRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          reactSource: getReactSource(el),
          parentChain: getParentChain(el, 5),
          children: getChildSummary(el, 8)
        };
        destroy();
        window.__picotSelectorResult = result;
      }
      function onClick(e) {
        captureSelection(e);
      }
      function onPointerDown(e) {
        captureSelection(e);
      }
      function onKey(e) {
        if (e.key === 'Escape') {
          destroy();
          window.__picotSelectorResult = { __cancelled: true, __picotSessionToken: sessionToken };
        }
      }
      function destroy() {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('keydown', onKey, true);
        document.documentElement.classList.remove('__picot-select-mode');
        if (last) last.classList.remove('__picot-hover');
        if (hoverLabel.parentNode) hoverLabel.parentNode.removeChild(hoverLabel);
        style.remove();
        window.__picotSelector = null;
      }
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      document.addEventListener('keydown', onKey, true);
      window.__picotSelector = { destroy: destroy, sessionToken: sessionToken };
      return { installed: true, sessionToken: sessionToken };
    })()
  `;
}

/**
 * The webview adapter contract: { isConnected(): boolean,
 * executeJavaScript(code): Promise<value> }. Built from the pane manager's
 * eval bridge for a live pane.
 */
export function createPaneWebviewAdapter({ paneId, isAlive, evaluate }) {
  return {
    isConnected: () => isAlive(),
    executeJavaScript: (code) => evaluate(paneId, code),
  };
}

/** Name what actually arrived instead of collapsing every mismatch into one
 * word: the pane bridge, the eval callback, and the script's own payload fail
 * in ways a single "unavailable" cannot tell apart. */
function describeValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return typeof value;
  const keys = Object.keys(value);
  return keys.length > 0 ? `object:${keys.slice(0, 4).join("|")}` : "object:empty";
}

function readSelectorInstallation(value, sessionToken) {
  if (!value || typeof value !== "object") return `unavailable:${describeValue(value)}`;
  if (value.sessionToken !== sessionToken) return "unavailable:token-mismatch";
  if (value.installed === true) return "installed";
  return value.reason === "document-loading" ? "loading" : "unavailable:not-installed";
}

/**
 * One active selection session at a time. Mirrors Paseo's controller state
 * machine: token-scoped install, 200ms polling, 30s timeout, Esc cancel.
 */
export function createElementSelectorController({ webviewAdapter }) {
  let current = null;
  let sequence = 0;

  function token() {
    sequence += 1;
    return `${sequence}:${crypto.randomUUID()}`;
  }

  /** {ok: true, value} on success; {ok: false, reason} names the failing layer. */
  async function execute(webview, code) {
    if (!webview.isConnected()) return { ok: false, reason: "pane-not-visible" };
    try {
      return { ok: true, value: await webview.executeJavaScript(code) };
    } catch (error) {
      return { ok: false, reason: `eval-error:${error?.message ?? error}` };
    }
  }

  async function install(session) {
    const probe = await execute(session.webview, buildElementSelectorScript(session.token));
    const state = probe.ok
      ? readSelectorInstallation(probe.value, session.token)
      : `unavailable:${probe.reason}`;
    if (current !== session) {
      if (state === "installed") void destroyWebview(session.webview, session.token);
      return;
    }
    if (state !== "installed") {
      finish(session, { type: "failed", reason: state }, "destroy");
      return;
    }
    session.stopPolling = watch(session, (selection) =>
      finish(session, selection ? { type: "selected", selection } : { type: "cancelled" }, null),
    );
  }

  function watch(session, onResult) {
    const { webview } = session;
    const sessionToken = session.token;
    let stopped = false;
    let timerId;
    const poll = async () => {
      const probe = await execute(
        webview,
        `window.__picotSelectorResult?.__picotSessionToken === ${JSON.stringify(sessionToken)} ? window.__picotSelectorResult : null`,
      );
      if (stopped) return;
      const result = probe.ok ? probe.value : null;
      if (!result) {
        // Kept so a session that dies at the deadline can report whether the
        // poll was reading the page at all, or failing at the bridge.
        session.probeReason = probe.ok ? undefined : probe.reason;
        timerId = setTimeout(poll, POLL_INTERVAL_MS);
        return;
      }
      session.probeReason = undefined;
      stopped = true;
      void execute(
        webview,
        `if (window.__picotSelectorResult?.__picotSessionToken === ${JSON.stringify(sessionToken)}) window.__picotSelectorResult = null;`,
      );
      const cancelled = result.__cancelled === true;
      delete result.__cancelled;
      delete result.__picotSessionToken;
      onResult(cancelled ? null : result);
    };
    timerId = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      stopped = true;
      clearTimeout(timerId);
    };
  }

  function destroyWebview(webview, sessionToken) {
    void execute(
      webview,
      `if (window.__picotSelector?.sessionToken === ${JSON.stringify(sessionToken)}) window.__picotSelector.destroy();`,
    );
  }

  function clearWebview(webview, sessionToken) {
    void execute(
      webview,
      `if (window.__picotSelector?.sessionToken === ${JSON.stringify(sessionToken)}) window.__picotSelector.destroy(); if (window.__picotSelectorResult?.__picotSessionToken === ${JSON.stringify(sessionToken)}) window.__picotSelectorResult = null;`,
    );
  }

  function finish(session, outcome, cleanup) {
    if (current !== session) return false;
    session.stopPolling?.();
    session.stopPolling = undefined;
    if (session.timeoutId !== undefined) {
      clearTimeout(session.timeoutId);
      session.timeoutId = undefined;
    }
    current = null;
    if (cleanup === "clear") clearWebview(session.webview, session.token);
    else if (cleanup === "destroy") destroyWebview(session.webview, session.token);
    session.onFinish(outcome);
    return true;
  }

  return {
    start({ onFinish }) {
      if (current) finish(current, { type: "cancelled" }, "clear");
      const session = {
        token: token(),
        webview: webviewAdapter,
        onFinish,
        stopPolling: undefined,
        timeoutId: undefined,
        probeReason: undefined,
      };
      current = session;
      session.timeoutId = setTimeout(
        () =>
          finish(session, { type: "failed", reason: session.probeReason ?? "timeout" }, "destroy"),
        SELECTOR_TIMEOUT_MS,
      );
      void install(session);
      return "started";
    },
    cancel() {
      if (current) finish(current, { type: "cancelled" }, "clear");
    },
  };
}
