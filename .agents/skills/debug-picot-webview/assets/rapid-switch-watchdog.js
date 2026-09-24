// ABOUTME: TEMPORARY round-4 diagnostic; delete after use. Autonomously drives
// ABOUTME: rapid same-workspace session switching and reports the config gate state.

(() => {
  const ENDPOINT = "http://127.0.0.1:45799/diag";
  const S = {
    t0: Date.now(),
    bursts: 0,
    switches: 0,
    snapshots: 0,
    probes: 0,
    responses: 0,
    rejections: 0,
    opened: false,
    lastTriples: [],
    snapsIn: 0,
    clickThrows: 0,
    inTriples: [],
    lastVerdict: "-",
  };

  const send = (line) => {
    try {
      fetch(ENDPOINT, { mode: "no-cors", method: "POST", body: line }).catch(() => {});
    } catch {
      /* best effort */
    }
  };

  // Observe the wire without touching production code.
  const origSend = WebSocket.prototype.send;
  const seen = new Set();
  WebSocket.prototype.send = function patchedSend(raw) {
    try {
      const frame = JSON.parse(raw);
      if (frame.type === "runtime_snapshot_request") {
        S.snapshots += 1;
        const t = frame.target || {};
        S.lastTriples.push(
          `${String(t.sessionId || "")
            .split("/")
            .pop()}@${String(t.instanceId || "none").slice(-6)}`,
        );
        if (S.lastTriples.length > 12) S.lastTriples.shift();
      }
      if (frame.type === "runtime_request" && frame.command?.type === "get_state") S.probes += 1;
    } catch {
      /* non-JSON frames are not ours */
    }
    if (!seen.has(this)) {
      seen.add(this);
      this.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message.type === "runtime_response") S.responses += 1;
          if (message.type === "runtime_snapshot") {
            S.snapsIn += 1;
            const t = message.target || {};
            S.inTriples.push(
              `${String(t.sessionId || "")
                .split("/")
                .pop()}@${String(t.instanceId || "none").slice(-6)}`,
            );
            if (S.inTriples.length > 12) S.inTriples.shift();
          }
          if (message.type === "runtime_response" && message.response?.success === false) {
            S.rejections += 1;
          }
        } catch {
          /* ignore */
        }
      });
    }
    return origSend.call(this, raw);
  };

  const sessionRows = () => [...document.querySelectorAll(".session-item[data-file-path]")];

  /** Rows of ONE workspace: the sidebar nests rows in `.workspace-group`, so the
   *  burst stays inside a single workspace. */
  const oneWorkspaceRows = () => {
    const groups = [...document.querySelectorAll(".workspace-group")];
    const withRows = groups
      .map((group) => [...group.querySelectorAll(".session-item[data-file-path]")])
      .filter((rows) => rows.length >= 2);
    withRows.sort((a, b) => b.length - a.length);
    return withRows[0] ?? null;
  };

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function ensureSession() {
    if (!document.body.classList.contains("landing-mode")) return "in-workspace";
    // Landing groups start collapsed: expand the first one that has sessions.
    const headers = [...document.querySelectorAll(".workspace-group .workspace-header")];
    for (const header of headers.slice(0, 3)) {
      header.click();
      await wait(500);
      if (sessionRows().length > 0) break;
    }
    const row = sessionRows()[0];
    if (!row) return `no-rows-on-landing(groups=${headers.length})`;
    S.opened = true;
    row.click();
    return "clicked-first-row";
  }

  /** Click a sidebar row that is not the active session and confirm the switch
   *  actually landed: rows are re-rendered, so a stale reference silently
   *  no-ops and would fake a closed gate. */
  async function clickDifferentSession(group) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rows = group ? [...group.querySelectorAll(".session-item[data-file-path]")] : [];
      const active = document.querySelector(".session-item.active")?.dataset?.filePath;
      const next = rows.find(
        (el) => !el.classList.contains("active") && el.dataset.filePath !== active,
      );
      if (!next) return false;
      try {
        next.click();
      } catch (error) {
        S.clickThrows += 1;
        send(`R4 click threw: ${String(error).slice(0, 80)}`);
        await wait(200);
        continue;
      }
      await wait(2000);
      if (document.querySelector(".session-item.active")?.dataset?.filePath !== active) return true;
    }
    return false;
  }

  async function burst() {
    let rows = oneWorkspaceRows();
    if (!rows) {
      // Sidebar groups start collapsed on the session page too: expand before
      // giving up, and always report a bail (silence is unreadable).
      for (const header of [
        ...document.querySelectorAll(".workspace-group .workspace-header"),
      ].slice(0, 3)) {
        header.click();
        await wait(500);
        rows = oneWorkspaceRows();
        if (rows) break;
      }
    }
    if (!rows) {
      S.lastVerdict = "need >=2 sessions in one workspace";
      send(`R4 burst=${S.bursts} BAIL ${S.lastVerdict} rows=${sessionRows().length}`);
      report();
      return;
    }
    S.bursts += 1;
    const before = {
      snapshots: S.snapshots,
      probes: S.probes,
      responses: S.responses,
      rejections: S.rejections,
      snapsIn: S.snapsIn,
    };
    const perClick = [];
    const pool = rows.slice(0, 5);
    // The group is pinned for the whole burst: clicking a row from ANOTHER
    // workspace navigates across host origins and would fake a stuck page.
    const group = pool[0]?.closest(".workspace-group") ?? null;
    const n = 6;
    let realSwitches = 0;
    for (let i = 0; i < n; i += 1) {
      const snap0 = S.snapshots;
      const probe0 = S.probes;
      send(
        `R4 click#${i + 1} begin target=${String(
          group?.querySelector(".session-item:not(.active)[data-file-path]")?.dataset?.filePath ||
            "?",
        )
          .split("/")
          .pop()}`,
      );
      const t0 = performance.now();
      const landed = await clickDifferentSession(group);
      const dt = Math.round(performance.now() - t0);
      if (landed) realSwitches += 1;
      perClick.push(`${landed ? "" : "X"}${S.snapshots - snap0}/${S.probes - probe0}/${dt}ms`);
      if (dt > 500) send(`R4 click#${i + 1} SLOW ${dt}ms`);
    }
    S.switches += n;
    // Let the last switch's opener land before judging the gate.
    await wait(2500);
    const ready = globalThis.__picotSessionView?.configReady?.() ?? null;
    const modelOptions = -2;
    const active = document.querySelector(".session-item.active")?.dataset?.filePath ?? "?";
    S.lastVerdict = ready === true ? "gate OPEN" : ready === false ? "gate CLOSED" : "no seam";
    send(
      `R4 burst=${S.bursts} n=${n} realSwitches=${realSwitches} snapDelta=${S.snapshots - before.snapshots} probeDelta=${S.probes - before.probes} respDelta=${S.responses - before.responses} rejectedDelta=${S.rejections - before.rejections} pool=${pool.length} modelOptions=${modelOptions} clickThrows=${S.clickThrows} triples=[${S.lastTriples.join(",")}] snapsIn=${S.snapsIn - before.snapsIn} inTriples=[${S.inTriples.join(",")}] ready=${ready} verdict=${S.lastVerdict} perClick(X=noLand,snap/probe)=[${perClick.join(",")}] active=${active.split("/").pop()}`,
    );
    report();
  }

  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:2147483647;" +
    "background:#000;color:#0f0;font:12px/1.5 ui-monospace,monospace;padding:8px 12px;" +
    "border-radius:6px;white-space:pre-wrap;pointer-events:none;text-align:center";
  function report() {
    if (!box.isConnected) return;
    box.textContent = [
      `R4 auto-burst: bursts=${S.bursts} switches=${S.switches} snapshots=${S.snapshots} probes=${S.probes} responses=${S.responses}`,
      `last: ${S.lastVerdict}`,
    ].join("\n");
  }

  const bar2 = document.createElement("div");
  bar2.style.cssText =
    "position:fixed;left:50%;top:34px;transform:translateX(-50%);z-index:2147483647;pointer-events:auto";
  const burstBtn = document.createElement("button");
  burstBtn.type = "button";
  burstBtn.textContent = "burst: warming up";
  burstBtn.style.cssText =
    "pointer-events:auto;cursor:pointer;padding:6px 10px;border-radius:6px;border:1px solid #888;" +
    "background:#111;color:#eee;font:12px ui-monospace,monospace";
  burstBtn.addEventListener("click", () => {
    void burst();
  });
  bar2.appendChild(burstBtn);

  const attach = () => {
    document.body?.appendChild(box);
    document.body?.appendChild(bar2);
    // A hidden window throttles timers (Safari clamps background timers), which
    // fakes a "blocked main thread". Focus our own window first.
    (async () => {
      try {
        await globalThis.__TAURI__?.window?.getCurrentWindow().setFocus();
        send("R4 setFocus ok");
      } catch (error) {
        send(`R4 setFocus failed: ${String(error).slice(0, 60)}`);
      }
    })();
    // Heartbeat: if these stop while a burst is in flight, the page's main
    // thread is stuck (a frozen renderer), not merely a stalled promise chain.
    let hb = 0;
    let lastHb = performance.now();
    setInterval(() => {
      const now = performance.now();
      const gap = Math.round(now - lastHb);
      lastHb = now;
      send(
        `R4 hb ${++hb} gap=${gap}ms vis=${document.visibilityState} focus=${document.hasFocus() ? 1 : 0}`,
      );
    }, 1000);
    send("R4 boot");
    report();
    (async () => {
      await wait(3000);
      const state = await ensureSession();
      send(`R4 ensureSession=${state}`);
      await wait(2500);
      const baseline = -2; // dropdown probe disabled: it hangs the page in the broken state
      send(
        `R4 baseline modelOptions=${baseline} ready=${globalThis.__picotSessionView?.configReady?.() ?? null}`,
      );
      // Burst is manual from here on: an automatic one stalls the app.
      burstBtn.textContent = "burst now (will stall)";
      await burst();
      send("R4 auto-burst done");
    })();
  };
  if (document.body) attach();
  else document.addEventListener("DOMContentLoaded", attach);
})();
