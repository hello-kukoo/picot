// ABOUTME: Conversation navigator rail — registry-sourced tick window with one
// ABOUTME: hit surface, coalesced scroll spy, and column docking (spec P5).

export const NAV_PITCH = 18; // constant tick pitch (px) — never a transform
export const NAV_MAX_TICKS = 30; // at most this many ticks in the DOM
export const NAV_EDGE_ZONE_TICKS = 2; // glide when pointer/focus reaches an edge
export const NAV_BASE_WIDTH = 7;
export const NAV_HOVER_PEAK_WIDTH = 22;
export const NAV_HOVER_SIGMA = 2.4;

/**
 * P5.2 window computation: a constant-pitch window of at most `maxTicks`,
 * centered on the anchor index (active tick, or the interacting tick while
 * the pointer/focus rides an edge zone), clamped to the turn range.
 */
export function computeTickWindow({
  count,
  anchorIndex,
  activeIndex = 0,
  maxTicks = NAV_MAX_TICKS,
}) {
  if (count <= 0) return { start: 0, end: 0 };
  if (count <= maxTicks) return { start: 0, end: count };
  const anchor = Number.isInteger(anchorIndex) ? anchorIndex : (activeIndex ?? 0);
  const half = Math.floor(maxTicks / 2);
  const start = Math.max(0, Math.min(anchor - half, count - maxTicks));
  return { start, end: start + maxTicks };
}

/**
 * P5.4 reading-line pick: the active tick is the LAST turn at or above the
 * reading line (binary search), with the bottom-anchor override — within
 * `bottomAnchorPx` of the bottom the active tick is the last turn, so a short
 * final turn is never stuck one behind.
 */
export function pickActiveByOffsets({ offsets, readingLine, bottomDistance, bottomAnchorPx }) {
  if (!offsets.length) return -1;
  if (Number.isFinite(bottomDistance) && bottomDistance <= bottomAnchorPx) {
    return offsets.length - 1;
  }
  let lo = 0;
  let hi = offsets.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= readingLine) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** P5.3 pointer position → tick index (the track's single hit surface). */
export function pointerTickIndex({ pointerY, trackTop, count, pitch = NAV_PITCH }) {
  if (count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, Math.floor((pointerY - trackTop) / pitch)));
}

/** Hover width curve for a window tick (whole-rail pill preserved). */
export function tickWidthFor(distance) {
  if (distance == null) return NAV_BASE_WIDTH;
  return Math.round(
    NAV_BASE_WIDTH +
      (NAV_HOVER_PEAK_WIDTH - NAV_BASE_WIDTH) *
        Math.exp(-(distance * distance) / (2 * NAV_HOVER_SIGMA * NAV_HOVER_SIGMA)),
  );
}

/**
 * Build the rail controller. `getTurns()` returns the registry's turns in
 * order: `[{ id, promptPreview, answerPreview, entryId, mountedElement }]`.
 * `ensureTurnMounted(id) -> Promise<Element>` is the P2/P5 seam. The spy
 * recomputes offsets only when dirty (resize/mutation, debounced) and
 * coalesces scroll events into one rAF per frame.
 */
export function createConversationNav({
  navEl,
  trackEl,
  tooltipEl,
  tooltipQEl,
  tooltipAEl,
  tooltipSepEl,
  container,
  headerEl = null,
  getTurns,
  ensureTurnMounted,
  onSelectTurn = () => {},
  scrollOwner = null,
  t,
  document: doc = globalThis.document,
  window: win = globalThis.window,
} = {}) {
  let activeIndex = -1;
  let hoverIndex = -1;
  let windowRange = { start: 0, end: 0 };
  let offsetsDirty = true;
  let offsets = [];
  let rafScheduled = false;
  let mutationObserver = null;
  let containerResizeObserver = null;
  let ticksResizeObserver = null;
  const observedTickElements = new WeakSet();
  let debounceTimer = null;
  let tooltipHideTimer = null;
  let destroyed = false;

  const tickId = (index) => `conv-nav-tick-${index}`;

  // P5.4: a turn's own size change (streaming growth, rail disclosure) must
  // invalidate offsets just like a container resize. The observed set
  // re-syncs whenever offsets recompute; elements are never detached from the
  // observer individually (it dies with the controller instead).
  function syncTickObservers() {
    if (!ticksResizeObserver) return;
    for (const turn of ticks()) {
      const el = turn.mountedElement;
      if (!el?.isConnected || observedTickElements.has(el)) continue;
      observedTickElements.add(el);
      ticksResizeObserver.observe(el);
    }
  }

  function ticks() {
    return getTurns() ?? [];
  }

  function readingLineInfo() {
    const containerRect = container.getBoundingClientRect();
    const headerBottom = headerEl?.getBoundingClientRect?.().bottom || 0;
    // Header-aware line (better than scrollTop + 100): the true visible top
    // is the greater of the container top and the floating header's bottom.
    const visibleTopViewport = Math.max(containerRect.top, headerBottom) + 4;
    return {
      readingLine: visibleTopViewport - containerRect.top + container.scrollTop,
      bottomDistance: container.scrollHeight - container.scrollTop - container.clientHeight,
      bottomAnchorPx: Math.max(48, container.clientHeight * 0.1),
      containerRect,
    };
  }

  function recomputeOffsets() {
    const list = ticks();
    const containerRect = container.getBoundingClientRect();
    // Only CONNECTED elements join the offset list: folded turns previously
    // mapped to Infinity, which broke the sorted-input assumption of the
    // binary search once newer turns kept finite offsets. Mounted turns are
    // a contiguous suffix (folding always bites the older end), so this
    // subset stays monotonic; the picked position maps back to the absolute
    // tick index below.
    offsets = [];
    list.forEach((turn, index) => {
      const el = turn.mountedElement;
      if (!el?.isConnected) return;
      offsets.push({
        index,
        offset: el.getBoundingClientRect().top - containerRect.top + container.scrollTop,
      });
    });
    offsetsDirty = false;
    syncTickObservers();
  }

  function evaluateSpy() {
    const list = ticks();
    if (list.length === 0) {
      activeIndex = -1;
      return;
    }
    if (offsetsDirty) recomputeOffsets();
    const { readingLine, bottomDistance, bottomAnchorPx } = readingLineInfo();
    const picked = pickActiveByOffsets({
      offsets: offsets.map((entry) => entry.offset),
      readingLine,
      bottomDistance,
      bottomAnchorPx,
    });
    // The bottom anchor picks the last mounted entry — necessarily the last
    // turn, because the fold gate always mounts the newest turns.
    const next = picked >= 0 ? offsets[picked].index : -1;
    if (next !== activeIndex) {
      activeIndex = next;
      renderTicks();
    }
  }

  // rAF with a timeout fallback: test environments and hidden documents may
  // not expose requestAnimationFrame on the injected window.
  const scheduleFrame = (callback) => {
    if (typeof win?.requestAnimationFrame === "function") {
      win.requestAnimationFrame(callback);
    } else {
      setTimeout(callback, 0);
    }
  };

  function scheduleSpy() {
    if (rafScheduled || destroyed) return;
    rafScheduled = true;
    scheduleFrame(() => {
      rafScheduled = false;
      offsetsDirty = true; // a scroll changes effective offsets by definition
      evaluateSpy();
    });
  }

  function glideIfNeeded(index) {
    const list = ticks();
    if (list.length <= NAV_MAX_TICKS) return;
    const atTop = index - windowRange.start < NAV_EDGE_ZONE_TICKS;
    const atBottom = windowRange.end - 1 - index < NAV_EDGE_ZONE_TICKS;
    if (!atTop && !atBottom) return;
    windowRange = computeTickWindow({
      count: list.length,
      anchorIndex: index,
      activeIndex,
    });
    renderTicks();
  }

  function renderTicks() {
    const list = ticks();
    const hasConvs = list.length > 1;
    navEl.classList.toggle("hidden", !hasConvs);
    if (!hasConvs) {
      trackEl.replaceChildren();
      return;
    }
    if (activeIndex < 0 || activeIndex >= list.length) activeIndex = Math.max(0, activeIndex);
    if (hoverIndex >= list.length) hoverIndex = -1;
    windowRange = computeTickWindow({
      count: list.length,
      anchorIndex: hoverIndex >= 0 ? hoverIndex : activeIndex,
      activeIndex,
    });

    // Reconcile only the window's ticks (P5.2/P5.3: widths written only for
    // the overscan window; ticks are non-interactive visuals).
    trackEl.replaceChildren();
    for (let i = windowRange.start; i < windowRange.end; i += 1) {
      const tick = doc.createElement("div");
      tick.className = "conv-nav-dot";
      tick.id = tickId(i);
      tick.setAttribute("role", "option");
      tick.setAttribute("aria-selected", String(i === activeIndex));
      if (i === activeIndex) tick.classList.add("active");
      if (i === hoverIndex) tick.classList.add("hover");
      const distance = hoverIndex >= 0 ? Math.abs(i - hoverIndex) : null;
      tick.style.setProperty("--nav-w", `${tickWidthFor(distance)}px`);
      tick.style.setProperty("--nav-color", "var(--accent)");
      // The prompt preview labels the tick (P5.5) — truncated, collapsed.
      const preview = String(list[i].promptPreview ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      tick.setAttribute("aria-label", preview || `${t("messages.conversationNavigator")} ${i + 1}`);
      tick.title = "";
      trackEl.appendChild(tick);
    }
    trackEl.setAttribute("aria-activedescendant", activeIndex >= 0 ? tickId(activeIndex) : "");
  }

  function showTooltip(index) {
    const turn = ticks()[index];
    if (!turn) return;
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }
    tooltipQEl.textContent = String(turn.promptPreview ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 120);
    const answer = String(turn.answerPreview ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
    // P5.1: the answer preview comes from the registry, so settled turns
    // show question AND answer again (the DOM-walk pairing was dead).
    tooltipAEl.textContent = answer;
    tooltipAEl.style.display = answer ? "" : "none";
    tooltipSepEl.style.display = answer ? "" : "none";
    tooltipEl.classList.remove("hidden");
    const tickRect = trackEl.children[index - windowRange.start]?.getBoundingClientRect();
    if (tickRect) {
      const tipHeight = tooltipEl.offsetHeight || 90;
      const tipWidth = tooltipEl.offsetWidth || 260;
      const top = Math.max(
        8,
        Math.min(
          tickRect.top + tickRect.height / 2 - tipHeight / 2,
          win.innerHeight - tipHeight - 8,
        ),
      );
      tooltipEl.style.top = `${top}px`;
      tooltipEl.style.left = `${Math.min(tickRect.right + 8, win.innerWidth - tipWidth - 8)}px`;
    }
  }

  function hideTooltip() {
    tooltipHideTimer = setTimeout(() => tooltipEl.classList.add("hidden"), 120);
  }

  function jumpTo(index, { smooth = true } = {}) {
    const turn = ticks()[index];
    if (!turn) return Promise.resolve();
    activeIndex = index;
    renderTicks();
    return Promise.resolve(ensureTurnMounted ? ensureTurnMounted(turn.id) : turn.mountedElement)
      .catch(() => null)
      .then((element) => {
        const el = element?.isConnected ? element : turn.mountedElement;
        if (!el?.isConnected) return;
        const containerRect = container.getBoundingClientRect();
        const headerBottom = headerEl?.getBoundingClientRect?.().bottom || 0;
        const visibleTop = Math.max(containerRect.top, headerBottom);
        const delta = el.getBoundingClientRect().top - visibleTop;
        const maxScrollTop = container.scrollHeight - container.clientHeight;
        const target = Math.max(0, Math.min(container.scrollTop + delta, maxScrollTop));
        if (scrollOwner) {
          scrollOwner.scrollTo(target, { smooth });
        } else {
          container.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
        }
        onSelectTurn(turn, index);
      });
  }

  const onTrackPointerMove = (event) => {
    const list = ticks();
    const trackRect = trackEl.getBoundingClientRect();
    const index = pointerTickIndex({
      pointerY: event.clientY,
      trackTop: trackRect.top,
      count: Math.min(list.length, windowRange.end) - windowRange.start,
    });
    const absolute = windowRange.start + Math.max(0, index);
    if (absolute !== hoverIndex) {
      hoverIndex = absolute;
      glideIfNeeded(absolute);
      renderTicks();
      // Reposition (layout reads) only on tick changes — not every move.
      showTooltip(absolute);
    }
  };

  const onTrackPointerLeave = () => {
    hoverIndex = -1;
    hideTooltip();
    renderTicks();
  };

  const onTrackClick = (event) => {
    const trackRect = trackEl.getBoundingClientRect();
    const count = windowRange.end - windowRange.start;
    const index = pointerTickIndex({
      pointerY: event.clientY,
      trackTop: trackRect.top,
      count,
    });
    void jumpTo(windowRange.start + index);
  };

  let focusIndex = -1;
  const onTrackKeydown = (event) => {
    const list = ticks();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      focusIndex = Math.max(
        0,
        Math.min(list.length - 1, (focusIndex < 0 ? activeIndex : focusIndex) + delta),
      );
      hoverIndex = focusIndex;
      glideIfNeeded(focusIndex);
      renderTicks();
      showTooltip(focusIndex);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      focusIndex = event.key === "Home" ? 0 : list.length - 1;
      hoverIndex = focusIndex;
      glideIfNeeded(focusIndex);
      renderTicks();
      showTooltip(focusIndex);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void jumpTo(focusIndex >= 0 ? focusIndex : activeIndex);
      return;
    }
    if (event.key === "Escape") {
      // P5.5: Escape returns focus to the transcript — actually moving focus,
      // not merely blurring the track (a bare blur() strands it on <body>).
      event.preventDefault();
      container.focus();
    }
  };

  // Horizontal placement: the rail floats in the chat pane's LEFT GUTTER via
  // CSS `left: 16px` against its offset parent (manual-test verdict on
  // 2026-09-19: the column-edge dock double-counted the sidebar width and
  // landed mid-window). No per-resize horizontal math remains — the observer
  // below only invalidates offsets.

  function markOffsetsDirty() {
    offsetsDirty = true;
    scheduleSpy();
    renderTicks();
  }

  function onContainerScroll() {
    scheduleSpy();
  }

  // ── Wiring ──
  // The transcript is a programmatic focus target for P5.5's Escape return;
  // -1 keeps it out of the tab order.
  container.tabIndex = -1;
  trackEl.setAttribute("role", "listbox");
  trackEl.setAttribute("tabindex", "0");
  trackEl.setAttribute("aria-label", t("messages.conversationNavigator"));
  trackEl.addEventListener("pointermove", onTrackPointerMove);
  trackEl.addEventListener("pointerleave", onTrackPointerLeave);
  trackEl.addEventListener("click", onTrackClick);
  trackEl.addEventListener("keydown", onTrackKeydown);
  container.addEventListener("scroll", onContainerScroll);
  tooltipEl.addEventListener(
    "mouseenter",
    () => tooltipHideTimer && clearTimeout(tooltipHideTimer),
  );
  tooltipEl.addEventListener("mouseleave", hideTooltip);

  if (typeof win.ResizeObserver === "function") {
    containerResizeObserver = new win.ResizeObserver(() => {
      markOffsetsDirty();
    });
    containerResizeObserver.observe(container);
    ticksResizeObserver = new win.ResizeObserver(() => {
      // Same debounced invalidation as the structure-only MutationObserver.
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(markOffsetsDirty, 100);
    });
  }
  if (typeof win.MutationObserver === "function") {
    mutationObserver = new win.MutationObserver(() => {
      // Structure-only: mount/unmount invalidates offsets, debounced.
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(markOffsetsDirty, 100);
    });
    mutationObserver.observe(container, { childList: true, subtree: true });
  }
  renderTicks();
  scheduleSpy();

  return {
    getActiveIndex: () => activeIndex,
    jumpTo,
    refresh: markOffsetsDirty,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      trackEl.removeEventListener("pointermove", onTrackPointerMove);
      trackEl.removeEventListener("pointerleave", onTrackPointerLeave);
      trackEl.removeEventListener("click", onTrackClick);
      trackEl.removeEventListener("keydown", onTrackKeydown);
      container.removeEventListener("scroll", onContainerScroll);
      containerResizeObserver?.disconnect();
      ticksResizeObserver?.disconnect();
      mutationObserver?.disconnect();
      clearTimeout(debounceTimer);
      clearTimeout(tooltipHideTimer);
      trackEl.replaceChildren();
    },
  };
}
