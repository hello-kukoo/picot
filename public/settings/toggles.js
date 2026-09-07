export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"];

/**
 * Reflect the current level on a segmented slider: highlight the matching dot
 * and slide the pill thumb over it. Generic across 5-dot controls — thinking
 * effort (THINKING_LEVELS) and the Appearance font-size sliders pass their
 * own `levels`; `nameFor` renders the current-level label (default: raw key).
 */
export function renderThinkingEffort(
  level,
  { thinkingSteps, thinkingMarker, thinkingName, levels = THINKING_LEVELS, nameFor },
) {
  const normalized = levels.includes(level) ? level : levels[0];
  const dots = thinkingSteps
    ? Array.from(thinkingSteps.querySelectorAll(".thinking-effort-dot"))
    : [];
  const count = dots.length || levels.length;
  let activeIdx = levels.indexOf(normalized);
  if (activeIdx < 0) activeIdx = 0;

  dots.forEach((dot, idx) => {
    const isActive = idx === activeIdx;
    dot.classList.toggle("active", isActive);
    dot.setAttribute("aria-checked", String(isActive));
  });

  if (thinkingMarker) {
    const segment = 100 / count;
    thinkingMarker.style.width = `calc(${segment}% - 6px)`;
    thinkingMarker.style.left = `calc(${activeIdx * segment}% + 3px)`;
  }

  if (thinkingName) thinkingName.textContent = nameFor ? nameFor(normalized) : normalized;
}

export function applyShowThinking(show) {
  const toggleShowThinking = document.getElementById("toggle-show-thinking");
  if (toggleShowThinking) {
    toggleShowThinking.className = `settings-toggle${show ? " on" : ""}`;
  }
  document.body.classList.toggle("hide-thinking", !show);
  localStorage.setItem("pi-studio-show-thinking", show);
}

export function setupSettingsToggles({
  toggleAutoCompact,
  thinkingSteps,
  thinkingMarker,
  thinkingName,
  toggleShowThinking,
  rpcCommand,
  getDefaultThinkingLevel,
  setDefaultThinkingLevel,
  onRuntimeLevelChanged,
  persistThinkingLevel,
  persistShowThinking,
}) {
  // Auto-compaction: the session RPC takes effect immediately; the config
  // bridge writes Pi's global default (settings.json) so new sessions
  // inherit it. The global write is skipped if the session RPC fails (UI
  // rolls back); a failed global write must not undo the live session,
  // so it is logged instead of thrown.
  toggleAutoCompact?.addEventListener("click", async () => {
    const isOn = toggleAutoCompact.classList.contains("on");
    const enabling = !isOn;
    toggleAutoCompact.className = `settings-toggle${enabling ? " on" : ""}`;
    try {
      const data = await rpcCommand({ type: "set_auto_compaction", enabled: enabling });
      if (data?.success === false) throw new Error(data.error || "set_auto_compaction failed");
    } catch (error) {
      console.error("[settings] auto-compaction change failed:", error);
      toggleAutoCompact.className = `settings-toggle${isOn ? " on" : ""}`;
      return;
    }
    try {
      await rpcCommand({ type: "set_default_auto_compaction", enabled: enabling });
    } catch (error) {
      console.error("[settings] global auto-compaction default failed:", error);
    }
  });

  // Click a dot to set the default reasoning depth for future sessions and,
  // when the active model supports it, apply that depth to the live session.
  // The flag marks a user pick that a still-in-flight get_state snapshot (sent
  // by openSettings before the click) must not overwrite when it resolves.
  let hasUserChangedLevel = false;

  thinkingSteps?.addEventListener("click", async (event) => {
    const step = event.target.closest(".thinking-effort-dot");
    if (!step) return;
    const level = step.dataset.level || "off";
    hasUserChangedLevel = true;
    // Optimistically move the marker for snappy feedback.
    renderThinkingEffort(level, { thinkingSteps, thinkingMarker, thinkingName });
    const data = await rpcCommand({ type: "set_default_thinking_level", level });
    if (data?.success) {
      const effectiveLevel = data.data?.level || level;
      setDefaultThinkingLevel?.(effectiveLevel);
      persistThinkingLevel?.(effectiveLevel);
      renderThinkingEffort(effectiveLevel, {
        thinkingSteps,
        thinkingMarker,
        thinkingName,
      });
      await applyLevelToSession(effectiveLevel);
    } else {
      renderThinkingEffort(getDefaultThinkingLevel?.() || "medium", {
        thinkingSteps,
        thinkingMarker,
        thinkingName,
      });
    }
  });

  // The Settings control owns the persisted default. Applying that default
  // to the live session is best-effort: a model without the requested level
  // (or a failed request) must not make a successful save look broken.
  async function applyLevelToSession(level) {
    try {
      const available = await rpcCommand({ type: "get_available_thinking_levels" });
      const levels = available?.data?.levels;
      if (!Array.isArray(levels) || !levels.includes(level)) return;
      const applied = await rpcCommand({ type: "set_thinking_level", level });
      onRuntimeLevelChanged?.(applied?.data?.level || level);
    } catch (error) {
      console.warn(
        "[settings] saved default thinking level but could not apply it to session:",
        error,
      );
    }
  }

  const showThinking = localStorage.getItem("pi-studio-show-thinking") !== "false";
  if (toggleShowThinking) {
    toggleShowThinking.className = `settings-toggle${showThinking ? " on" : ""}`;
  }
  if (!showThinking) document.body.classList.add("hide-thinking");

  toggleShowThinking?.addEventListener("click", () => {
    const show = !toggleShowThinking.classList.contains("on");
    applyShowThinking(show);
    persistShowThinking?.(show);
  });

  // Check-and-reset: openSettings consumes the marker when its get_state
  // response arrives, so the guard protects exactly one in-flight snapshot
  // instead of disabling thinking sync for the rest of the app's lifetime.
  function takeUserChangedLevel() {
    const changed = hasUserChangedLevel;
    hasUserChangedLevel = false;
    return changed;
  }

  return {
    getDefaultThinkingLevel,
    takeUserChangedLevel,
  };
}
