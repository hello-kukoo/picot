// ABOUTME: TEMPORARY cold-start rail-hover diagnostic overlay; delete after use.
// ABOUTME: Splits "hit test misses the rail" from "rail repaints nothing".

(() => {
  const ENDPOINT = "http://127.0.0.1:45799/diag";
  const nav = () => document.getElementById("conv-nav");
  const track = () => document.getElementById("conv-nav-track");
  const main = () => document.querySelector(".main");
  const messages = () => document.getElementById("messages");
  const S = {
    t0: Date.now(),
    moves: 0,
    inRail: 0,
    railHover: 0,
    inTrack: 0,
    trackHover: 0,
    docEnter: 0,
    docLeave: 0,
    probeApplied: false,
    mutations: 0,
    lastMutationAt: 0,
    abMoves: 0,
    lastXY: "-",
    lastStack: "-",
    lastTarget: "-",
    dirty: true,
  };

  const desc = (el) => {
    if (!el) return "null";
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).join(".")}`
        : "";
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${cls}`;
  };
  const stackOf = (x, y) => document.elementsFromPoint(x, y).slice(0, 5).map(desc).join(" < ");
  const inside = (r, x, y) =>
    Boolean(r) && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  const send = (line) => {
    try {
      fetch(ENDPOINT, { mode: "no-cors", method: "POST", body: line }).catch(() => {});
    } catch {
      /* best effort */
    }
  };

  window.addEventListener(
    "mousemove",
    (e) => {
      S.moves += 1;
      const n = nav();
      if (!n) return;
      if (!inside(n.getBoundingClientRect(), e.clientX, e.clientY)) return;
      S.inRail += 1;
      if (n.matches(":hover")) S.railHover += 1;
      const t = track();
      if (inside(t?.getBoundingClientRect(), e.clientX, e.clientY)) {
        S.inTrack += 1;
        if (t.matches(":hover")) S.trackHover += 1;
      }
      S.lastXY = `${Math.round(e.clientX)},${Math.round(e.clientY)}`;
      S.lastStack = stackOf(e.clientX, e.clientY);
      S.lastTarget = desc(e.target);
      if (!S.probeApplied) {
        // Paint probe: an inline style the CSS :hover path does not own. Leave
        // the background alone so the logged computed background still reports
        // what the :hover rule resolved to.
        S.probeApplied = true;
        n.style.outline = "4px solid magenta";
        S.dirty = true;
      }
    },
    true,
  );
  document.addEventListener(
    "mouseenter",
    () => {
      S.docEnter += 1;
      S.dirty = true;
    },
    true,
  );
  document.addEventListener(
    "mouseleave",
    () => {
      S.docLeave += 1;
      S.dirty = true;
    },
    true,
  );
  window.addEventListener("resize", () => (S.dirty = true));

  // ── A/B: is the rail's parent scroll container (#messages) the trigger? ──
  // The rail is position:absolute with .main as its containing block, so
  // re-parenting it to .main is visually identical — only the scroll-container
  // escape goes away.
  const record = (tag) => {
    const n = nav();
    S.abMoves += 1;
    send(
      `AB ${tag} parent=${desc(n?.parentElement)} rail=${n ? `${Math.round(n.getBoundingClientRect().left)},${Math.round(n.getBoundingClientRect().top)}` : "-"} op=${desc(n?.offsetParent)}`,
    );
  };
  window.addEventListener(
    "keydown",
    (e) => {
      const isA = e.key === "F9" || (e.ctrlKey && e.shiftKey && e.code === "Digit9");
      const isB = e.key === "F10" || (e.ctrlKey && e.shiftKey && e.code === "Digit0");
      if (isA) {
        e.preventDefault();
        const n = nav();
        const m = main();
        if (n && m && n.parentElement !== m) {
          m.appendChild(n);
          record("F9->main");
        }
      } else if (isB) {
        e.preventDefault();
        const n = nav();
        const ms = messages();
        if (n && ms && n.parentElement !== ms) {
          ms.appendChild(n);
          record("F10->messages");
        }
      } else if (e.ctrlKey && e.shiftKey && ["Digit1", "Digit2", "Digit3"].includes(e.code)) {
        e.preventDefault();
        const key = e.code.slice(-1);
        overrideState[key] = !overrideState[key];
        applyOverrides();
        send(
          `OVERRIDE ${key} ${overrideState[key] ? "ON" : "off"} (${OVERRIDES[key].label}) active=[${Object.keys(
            overrideState,
          )
            .filter((k) => overrideState[k])
            .join(",")}]`,
        );
      }
    },
    true,
  );

  // ── Property-elimination experiments ────────────────────────────────────
  // The rail's raster freezes after a layout change (boot settle, window
  // resize) and is rebuilt by a focus switch. These overrides remove the
  // properties that can promote .conv-nav to a composited layer.
  // Protocol per experiment: toggle the override ON, resize the window (the
  // repro), then hover the rail.
  const OVERRIDES = {
    1: {
      label: "backdrop-filter",
      css: ".conv-nav:hover{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}",
    },
    2: {
      label: "animation+opacity/transform transition",
      css: ".conv-nav{animation:none !important;transition:background .2s var(--ease),border-color .2s var(--ease) !important}",
    },
    3: {
      label: "both",
      css: ".conv-nav{animation:none !important;transition:background .2s var(--ease),border-color .2s var(--ease) !important}.conv-nav:hover{backdrop-filter:none !important;-webkit-backdrop-filter:none !important}",
    },
  };
  const overrideState = { 1: false, 2: false, 3: false };
  const overrideEls = {};
  const applyOverrides = () => {
    for (const key of Object.keys(OVERRIDES)) {
      if (overrideState[key] && !overrideEls[key]) {
        const el = document.createElement("style");
        el.textContent = OVERRIDES[key].css;
        document.head.appendChild(el);
        overrideEls[key] = el;
      } else if (!overrideState[key] && overrideEls[key]) {
        overrideEls[key].remove();
        delete overrideEls[key];
      }
    }
  };

  const watchTrack = () => {
    const t = track();
    if (!t || typeof MutationObserver !== "function") return;
    new MutationObserver(() => {
      S.mutations += 1;
      S.lastMutationAt = Date.now();
    }).observe(t, { childList: true });
  };

  // Buttons are the only reliable trigger: macOS swallows Ctrl+Shift+<digit>
  // and F-keys before the page sees them (verified — no OVERRIDE line arrived).
  // The rail is already a direct child of .main in index.html (verified), so
  // re-parenting is not a variable. A plain DOM move inside .main does rebuild
  // the layer, which makes it the positive control: it unfreezes the rail.
  const nudge = () => {
    const n = nav();
    const target = main();
    if (!n || !target) return;
    // Restore the index.html order: .main > #messages, then #conv-nav.
    target.insertBefore(n, messages()?.nextElementSibling ?? null);
    record("NUDGE (restored to .main after #messages)");
    S.dirty = true;
  };
  const overrideOrder = [null, "3", "1", "2"];
  let overrideIdx = 0;
  const bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;left:50%;top:4px;transform:translateX(-50%);z-index:2147483647;" +
    "display:flex;gap:6px;pointer-events:auto";
  const mkBtn = (onClick) => {
    const b = document.createElement("button");
    b.type = "button";
    b.style.cssText =
      "pointer-events:auto;cursor:pointer;padding:6px 10px;border-radius:6px;" +
      "border:1px solid #888;background:#111;color:#eee;font:12px ui-monospace,monospace";
    b.addEventListener("click", onClick);
    bar.appendChild(b);
    return b;
  };
  const nudgeBtn = mkBtn(() => {
    nudge();
    refreshBar();
  });
  const overrideBtn = mkBtn(() => {
    overrideIdx = (overrideIdx + 1) % overrideOrder.length;
    for (const k of Object.keys(overrideState)) overrideState[k] = false;
    const key = overrideOrder[overrideIdx];
    if (key) overrideState[key] = true;
    applyOverrides();
    send(
      `OVERRIDE cycle idx=${overrideIdx} key=${key ?? "none"} (${key ? OVERRIDES[key].label : "none"})`,
    );
    S.dirty = true;
    refreshBar();
  });
  function refreshBar() {
    nudgeBtn.textContent = "reset (nudge DOM)";
    const key = overrideOrder[overrideIdx];
    overrideBtn.textContent = `override: ${key ? OVERRIDES[key].label : "none"}`;
  }

  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;left:50%;top:40px;transform:translateX(-50%);z-index:2147483647;" +
    "background:#000;color:#0f0;font:12px/1.45 ui-monospace,monospace;padding:8px 10px;" +
    "border-radius:6px;max-width:min(860px,94vw);white-space:pre-wrap;pointer-events:none";

  const snapshot = () => {
    const n = nav();
    if (!n) return "nav=missing";
    const r = n.getBoundingClientRect();
    const t = track();
    const tr = t?.getBoundingClientRect();
    const cs = getComputedStyle(n);
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const railNow = n.matches(":hover") ? 1 : 0;
    // The magnification wave is written into the DOM by the rail module's own
    // pointermove handler; base width is 7px.
    const widths = t ? [...t.children].map((c) => c.style.getPropertyValue("--nav-w") || "?") : [];
    const afterWidths = t ? [...t.children].map((c) => getComputedStyle(c, "::after").width) : [];
    const wide = widths.filter((w) => w !== "7px" && w !== "?").length;
    const tip = document.getElementById("conv-nav-tooltip");
    const anims = document
      .getAnimations()
      .filter((a) => n.contains(a.effect?.target) || a.effect?.target === n)
      .map((a) => {
        const name = a.animationName || a.transitionProperty || "?";
        const target = a.effect?.pseudoElement
          ? `${desc(a.effect.target)}${a.effect.pseudoElement}`
          : desc(a.effect?.target);
        return `${name}@${target}:${a.playState}:${Math.round(a.currentTime ?? -1)}`;
      });
    const op = n.offsetParent;
    const opCs = op ? getComputedStyle(op) : null;
    const elapsedSinceMutation = S.lastMutationAt
      ? Math.round((Date.now() - S.lastMutationAt) / 100) / 10
      : -1;
    return [
      `t=${Math.round((Date.now() - S.t0) / 100) / 10}s focus=${document.hasFocus() ? 1 : 0} ab=${S.abMoves}`,
      `parent=${desc(n.parentElement)}`,
      `navCount=${document.querySelectorAll("#conv-nav").length} messagesParent=${desc(messages()?.parentElement)}`,
      `moves=${S.moves} inRail=${S.inRail} railHover=${S.railHover} railHoverNow=${railNow}`,
      `inTrack=${S.inTrack} trackHover=${S.trackHover} docEnter=${S.docEnter} docLeave=${S.docLeave}`,
      `trackMutations=${S.mutations} sinceLastMutation=${elapsedSinceMutation}s`,
      `wide=${wide}/${widths.length} navw=[${widths.join(",")}]`,
      `afterW=[${afterWidths.join(",")}]`,
      `tooltip=${tip ? (tip.classList.contains("hidden") ? "hidden" : "SHOWN") : "-"}`,
      `evTarget=${S.lastTarget} probe=${S.probeApplied ? 1 : 0}`,
      `rail=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)} track=${tr ? `${Math.round(tr.left)},${Math.round(tr.top)},${Math.round(tr.width)}x${Math.round(tr.height)}` : "-"} ticks=${t ? t.children.length : -1}`,
      `cls=${n.className} op=${cs.opacity} pe=${cs.pointerEvents} bg=${cs.backgroundColor} bd=${cs.backdropFilter} tf=${cs.transform} wc=${cs.willChange}`,
      `offsetParent=${desc(op)} pos=${opCs?.position} ovf=${opCs?.overflow}`,
      `anims=[${anims.join(" ; ")}]`,
      `stackRail=${stackOf(cx, cy)}`,
      `verdict=${
        S.inRail === 0
          ? "pointer-never-in-rail"
          : S.railHover === 0
            ? "hover-never-matches=>hit-test-problem"
            : wide > 0
              ? "hover-matches+wave-in-dom=>paint-frozen"
              : "hover-matches+no-wave-in-dom=>module-handler-dead"
      }`,
    ].join(" | ");
  };

  const tick = () => {
    const text = snapshot();
    if (box.isConnected) {
      const active = Object.keys(overrideState)
        .filter((k) => overrideState[k])
        .map((k) => `${k}:${OVERRIDES[k].label}`)
        .join(" + ");
      box.textContent = `${text.replace(/\s\|\s/g, "\n")}\nOVERRIDES: ${active || "none"}`;
    }
    if (S.dirty || S.inRail > 0) {
      S.dirty = false;
      send(text);
    }
  };

  const attach = () => {
    document.body?.appendChild(box);
    document.body?.appendChild(bar);
    refreshBar();
    watchTrack();
    send(`boot ${snapshot()}`);
    setInterval(tick, 500);
  };
  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach);
})();
