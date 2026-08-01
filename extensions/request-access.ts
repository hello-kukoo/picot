// ABOUTME: Defines network-boundary decisions for the embedded HTTP and WebSocket surfaces.
// ABOUTME: Keeps loopback authentication policy pure, shared by Node and Bun adapters.

const LOOPBACK_ONLY_ROUTES = new Set([
  "POST /api/rpc",
  "PUT /api/files/content",
  "POST /api/open",
  "POST /api/sessions/delete-batch",
  "POST /api/sessions/rename",
  "POST /api/sessions/switch",
  "POST /api/workspace/open",
  "GET /api/agent-config",
  "PUT /api/agent-config",
  "GET /api/models-config",
  "PUT /api/models-config",
  "POST /api/chat-telegram/validate",
  "POST /api/chat-telegram/bind",
  "GET /api/chat-telegram/doctor",
  "GET /api/chat-config",
  "PUT /api/chat-config",
  "GET /api/super-agent/tasks",
  "PUT /api/super-agent/tasks",
  "GET /api/super-agent/projects",
  "GET /api/home",
  "GET /api/file-mentions",
  // Skills install transport is host-to-primary only: it scans arbitrary
  // local directories and writes settings, so it must never be reachable
  // from the LAN surface. The Bearer secret is a defense-in-depth second
  // factor, not the boundary itself.
  "POST /api/skill-install-scan",
  "POST /api/skill-install-links",
]);

function isLoopbackIpv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.slice(1).every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

export function isLoopbackAddress(address: unknown): boolean {
  if (typeof address !== "string") return false;
  const normalized = address.trim().toLowerCase();
  if (!normalized) return false;
  if (isLoopbackIpv4(normalized) || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) return isLoopbackIpv4(normalized.slice("::ffff:".length));
  return false;
}

export function isLoopbackOnlyApiRequest(urlPath: string, method: string): boolean {
  if (typeof urlPath !== "string" || typeof method !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(urlPath, "http://localhost");
  } catch {
    return true;
  }

  if (parsed.pathname === "/api/files" && parsed.searchParams.get("scope") === "picker") {
    return true;
  }

  return LOOPBACK_ONLY_ROUTES.has(`${method.toUpperCase()} ${parsed.pathname}`);
}
