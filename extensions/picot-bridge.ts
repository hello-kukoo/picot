import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCustomUiBridge } from "./custom-ui-bridge";
import { handlePicotConfig } from "./picot-config";
import projectTrust from "./project-trust";
import { registerAutomaticSessionTitle } from "./session-title-auto";

type ConfigRequest = {
  id?: string;
  op?: string;
  params?: Record<string, unknown>;
};

export default function picotBridge(pi: ExtensionAPI) {
  projectTrust(pi);
  registerAutomaticSessionTitle(pi);
  // No-op while CUSTOM_UI_OVERLAY_ENABLED is false (startup TUI flash).
  registerCustomUiBridge(pi);

  // Configuration data plane. Invoked by the WebView via a native RPC prompt
  // (`/picot-config <json>`); extension commands run immediately without
  // hitting the LLM or session history. The result is streamed back through
  // `ctx.ui.notify(JSON)` and correlated by request id on the frontend
  // (see public/native/config-gateway.js).
  pi.registerCommand("picot-config", {
    description: "Picot Settings → Configuration data plane",
    handler: async (rawArguments, ctx) => {
      let request: ConfigRequest;
      try {
        request = JSON.parse(rawArguments) as ConfigRequest;
      } catch {
        return;
      }
      const id = typeof request.id === "string" ? request.id : "";
      if (!id) return;
      const respond = (payload: Record<string, unknown>) => {
        ctx.ui.notify(JSON.stringify({ __picotConfig: id, ...payload }), "info");
      };
      const op = typeof request.op === "string" ? request.op : "";
      const params = request.params && typeof request.params === "object" ? request.params : {};
      try {
        const result = await handlePicotConfig(op, params, ctx);
        respond(result as unknown as Record<string, unknown>);
      } catch (error) {
        respond({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}
