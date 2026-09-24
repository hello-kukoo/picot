// ABOUTME: Incremental live-runtime subscription and green-dot initialization.
// ABOUTME: runtime_started owner events and page boot both funnel into refresh().

import { runtimeIdForTarget } from "./ui/widget-mirror-registry.js";

export function createLiveRuntimeSubscriptions({
  transport,
  wsClient,
  sidebar,
  backgroundSessionFiles,
}) {
  const subscribed = new Set();

  async function refresh() {
    let data;
    try {
      data = await transport.runtimeInstances();
    } catch {
      return;
    }
    for (const instance of data?.instances || []) {
      if (!instance?.workspaceId || !instance?.sessionId || !instance?.instanceId) continue;
      backgroundSessionFiles.rememberInstance(instance);
      const runtimeId = runtimeIdForTarget(instance);
      if (!subscribed.has(runtimeId)) {
        subscribed.add(runtimeId);
        wsClient.subscribeRuntimeTarget(instance);
        wsClient.requestRuntimeSnapshot(instance);
      }
      // The host's event-driven mid-turn flag: a late subscriber lights the
      // green dot for an agent_start it never saw. A turn that already ended
      // reports streaming:false, so refresh never relights a dead dot.
      if (instance.streaming) {
        sidebar.setStreaming(backgroundSessionFiles.resolve(instance), true);
      }
    }
  }

  return { refresh };
}
