// ABOUTME: ConfigGateway for settings surfaces over the host control plane (v2).
// ABOUTME: Maps file and OAuth operations to host controls and names gaps loudly.

const HEALTH_CHECK_TIMEOUT_MS = 120_000;

// JSON settings files are host-owned and go through `settings_get`/`settings_put`,
// which keep Pi's proper-lockfile protocol, the atomic replace, and the
// backup + restart notice for model config. Maps are used because `Object.hasOwn`
// is newer than the WebKit baseline this WebView targets.
const JSON_READ_OPS = new Map([
  ["read_models_config", "models.json"],
  ["read_agent_config", "settings.json"],
]);

const JSON_WRITE_OPS = new Map([
  ["write_models_config", "models.json"],
  ["write_agent_config", "settings.json"],
]);

// Markdown instruction files are plain text: `agent_text_file_*` preserves the
// exact bytes the editor showed instead of re-serializing them.
const TEXT_READ_OPS = new Map([
  ["read_agents_md", "AGENTS.md"],
  ["read_append_system_md", "APPEND_SYSTEM.md"],
]);

const TEXT_WRITE_OPS = new Map([
  ["write_agents_md", "AGENTS.md"],
  ["write_append_system_md", "APPEND_SYSTEM.md"],
]);

// These were retired with /api/rpc and are now native host controls: the
// gateway routes them over the same v2 transport as every other surface.
const HOST_CONTROL_OPS = new Map([
  ["list_model_catalog", (transport) => transport.listModelCatalog()],
  ["set_api_key", (transport, params) => transport.setApiKey(params.provider, params.apiKey)],
  ["remove_api_key", (transport, params) => transport.removeApiKey(params.provider)],
  [
    "check_model_health",
    (transport, params) => transport.checkModelHealth(params.provider, params.modelId || ""),
  ],
  [
    "set_model_visibility",
    (transport, params) =>
      transport.setModelVisibility(params.provider, params.modelId, params.visible !== false),
  ],
]);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function unavailable(operation) {
  return {
    ok: false,
    error: `${operation} has no native runtime implementation (retired with /api/rpc)`,
  };
}

export class ConfigGateway {
  constructor({ transport = null } = {}) {
    // Injected rather than imported: the gateway must stay usable (and testable)
    // without owning transport construction order.
    this.transport = transport;
  }

  async call(operation, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
    try {
      const jsonReadFile = JSON_READ_OPS.get(operation);
      if (jsonReadFile) {
        return await this._readJson(operation, jsonReadFile, timeoutMs);
      }
      const jsonWriteFile = JSON_WRITE_OPS.get(operation);
      if (jsonWriteFile) {
        return await this._writeJson(operation, jsonWriteFile, params, timeoutMs);
      }
      const textReadFile = TEXT_READ_OPS.get(operation);
      if (textReadFile) {
        return await this._readText(operation, textReadFile, timeoutMs);
      }
      const textWriteFile = TEXT_WRITE_OPS.get(operation);
      if (textWriteFile) {
        return await this._writeText(operation, textWriteFile, params, timeoutMs);
      }
      if (operation === "open_external") {
        if (!this.transport?.openExternal) return unavailable(operation);
        await withTimeout(this.transport.openExternal(params.url), timeoutMs, operation);
        return { ok: true };
      }
      if (operation === "get_oauth_login_capabilities") {
        if (!this.transport?.getOauthLoginCapabilities) return unavailable(operation);
        const data = await withTimeout(
          this.transport.getOauthLoginCapabilities(),
          timeoutMs,
          operation,
        );
        return { ok: true, data: data ?? {} };
      }
      if (operation === "logout_oauth_login") {
        if (!this.transport?.logoutOauthLogin) return unavailable(operation);
        await withTimeout(this.transport.logoutOauthLogin(params), timeoutMs, operation);
        return { ok: true };
      }
      const hostControl = HOST_CONTROL_OPS.get(operation);
      if (hostControl) {
        if (!this.transport) return unavailable(operation);
        const data = await withTimeout(hostControl(this.transport, params), timeoutMs, operation);
        return { ok: true, data: data ?? {} };
      }
      throw new Error(`Unknown operation: ${operation}`);
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  async _readJson(operation, name, timeoutMs) {
    if (!this.transport?.settingsGet) return unavailable(operation);
    try {
      const data = await withTimeout(
        this.transport.settingsGet(name, "global"),
        timeoutMs,
        operation,
      );
      return {
        ok: true,
        data: {
          path: data?.path ?? "",
          content: JSON.stringify(data?.value ?? {}, null, 2),
          exists: true,
        },
      };
    } catch (error) {
      if (error?.code === "config_not_found") {
        return { ok: true, data: { path: "", content: "", exists: false } };
      }
      throw error;
    }
  }

  async _writeJson(operation, name, params, timeoutMs) {
    if (!this.transport?.settingsPut) return unavailable(operation);
    let value;
    try {
      value = JSON.parse(params.content ?? "{}");
    } catch {
      return { ok: false, error: "Config must be valid JSON" };
    }
    await withTimeout(this.transport.settingsPut(name, value, "global"), timeoutMs, operation);
    return { ok: true };
  }

  async _readText(operation, name, timeoutMs) {
    if (!this.transport?.agentTextFileGet) return unavailable(operation);
    try {
      const data = await withTimeout(
        this.transport.agentTextFileGet(name, "global"),
        timeoutMs,
        operation,
      );
      return {
        ok: true,
        data: { path: data?.path ?? "", content: data?.content ?? "", exists: true },
      };
    } catch (error) {
      // An absent file is a valid empty editor, not a failure: Pi creates these
      // on demand and most installs have no APPEND_SYSTEM.md at all.
      if (error?.code === "config_not_found") {
        return { ok: true, data: { path: "", content: "", exists: false } };
      }
      throw error;
    }
  }

  async _writeText(operation, name, params, timeoutMs) {
    if (!this.transport?.agentTextFilePut) return unavailable(operation);
    await withTimeout(
      this.transport.agentTextFilePut(name, params.content ?? "", "global"),
      timeoutMs,
      operation,
    );
    return { ok: true };
  }
}
