// ABOUTME: Legacy ConfigGateway adapter for private/features-v3 branch
// ABOUTME: Provides ConfigGateway-compatible interface over legacy HTTP/RPC APIs

const HEALTH_CHECK_TIMEOUT_MS = 120_000;

async function postRpc(operation, params) {
  const resp = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: operation, ...params }),
  });
  return resp.json();
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export class LegacyConfigGateway {
  async call(operation, params = {}, options = {}) {
    const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;
    try {
      switch (operation) {
        case "list_model_catalog": {
          const resp = await withTimeout(postRpc(operation), timeoutMs, operation);
          if (resp?.success && Array.isArray(resp.data?.providers)) {
            return { ok: true, data: { providers: resp.data.providers } };
          }
          return { ok: false, error: resp?.error || "Failed to load model catalog" };
        }

        case "read_models_config": {
          const resp = await withTimeout(fetch("/api/models-config"), timeoutMs, operation);
          const data = await resp.json();
          if (data?.success) {
            return { ok: true, data: { path: data.path, content: data.content } };
          }
          return { ok: false, error: data?.error || "Failed to load models.json" };
        }

        case "write_models_config": {
          const resp = await withTimeout(
            fetch("/api/models-config", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: params.content }),
            }),
            timeoutMs,
            operation,
          );
          const data = await resp.json();
          return data?.success ? { ok: true } : { ok: false, error: data?.error };
        }

        case "set_api_key": {
          const resp = await withTimeout(postRpc(operation, params), timeoutMs, operation);
          return resp?.success ? { ok: true } : { ok: false, error: resp?.error };
        }

        case "remove_api_key": {
          const resp = await withTimeout(postRpc(operation, params), timeoutMs, operation);
          return resp?.success ? { ok: true } : { ok: false, error: resp?.error };
        }

        case "check_model_health": {
          const resp = await withTimeout(postRpc(operation, params), timeoutMs, operation);
          if (resp?.success && Array.isArray(resp.data?.results)) {
            return { ok: true, data: { results: resp.data.results } };
          }
          return { ok: false, error: resp?.error || "Health check failed" };
        }

        case "get_oauth_login_capabilities": {
          const resp = await withTimeout(postRpc(operation), timeoutMs, operation);
          if (resp?.success) {
            return { ok: true, data: resp.data ?? {} };
          }
          return { ok: false, error: resp?.error || "Failed to load OAuth capabilities" };
        }

        case "logout_oauth_login": {
          const resp = await withTimeout(postRpc(operation, params), timeoutMs, operation);
          return resp?.success ? { ok: true } : { ok: false, error: resp?.error };
        }

        case "set_model_visibility": {
          const resp = await withTimeout(postRpc(operation, params), timeoutMs, operation);
          return resp?.success ? { ok: true } : { ok: false, error: resp?.error };
        }

        case "read_agent_config": {
          const resp = await withTimeout(fetch("/api/agent-config"), timeoutMs, operation);
          const data = await resp.json();
          if (data?.success) {
            return { ok: true, data: { path: data.path, content: data.content } };
          }
          return { ok: false, error: data?.error || "Failed to load agent config" };
        }

        case "write_agent_config": {
          const resp = await withTimeout(
            fetch("/api/agent-config", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: params.content }),
            }),
            timeoutMs,
            operation,
          );
          const data = await resp.json();
          return data?.success ? { ok: true } : { ok: false, error: data?.error };
        }

        case "read_agents_md": {
          const resp = await withTimeout(fetch("/api/agents-md"), timeoutMs, operation);
          const data = await resp.json();
          if (data?.success) {
            return {
              ok: true,
              data: { path: data.path, content: data.content, exists: data.exists },
            };
          }
          return { ok: false, error: data?.error || "Failed to load AGENTS.md" };
        }

        case "write_agents_md": {
          const resp = await withTimeout(
            fetch("/api/agents-md", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: params.content }),
            }),
            timeoutMs,
            operation,
          );
          const data = await resp.json();
          return data?.success ? { ok: true } : { ok: false, error: data?.error };
        }

        case "read_append_system_md": {
          const resp = await withTimeout(fetch("/api/append-system-md"), timeoutMs, operation);
          const data = await resp.json();
          if (data?.success) {
            return {
              ok: true,
              data: { path: data.path, content: data.content, exists: data.exists },
            };
          }
          return { ok: false, error: data?.error || "Failed to load APPEND_SYSTEM.md" };
        }

        case "write_append_system_md": {
          const resp = await withTimeout(
            fetch("/api/append-system-md", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: params.content }),
            }),
            timeoutMs,
            operation,
          );
          const data = await resp.json();
          return data?.success ? { ok: true } : { ok: false, error: data?.error };
        }

        case "open_external": {
          const resp = await withTimeout(
            fetch("/api/open", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filePath: params.url }),
            }),
            timeoutMs,
            operation,
          );
          if (!resp.ok) throw new Error("open failed");
          return { ok: true };
        }

        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }
}
