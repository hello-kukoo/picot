// ABOUTME: Retained /api/* owner-aware compatibility middleware prototype (one route).
// ABOUTME: Auth via host-minted compat tokens; non-retained paths fail closed, never proxy.

// Production contract being prototyped (Gate D §5.2 / D-GAP-04): retained
// legacy /api/* routes must be host-origin, owner-aware, explicitly allow
// listed, and must NEVER silently fall back to the Pi origin or a host 404
// that looks like success. This module implements one representative route
// (GET /api/workspace-sessions — the sidebar session list) plus the fail-closed
// policy for everything else.

/** Routes explicitly retained for the transition. Anything else under /api/*
 * returns a visible stable 404 and is never forwarded anywhere. */
export const RETAINED_API_ROUTES = new Set(["GET /api/workspace-sessions"]);

export function createCompatApiMiddleware({ compatTokens, listSessions }) {
  // compatTokens: Map<token, ownerId> (minted over the authenticated WS via
  // the v2 host operation `compat_api_issue`).
  // listSessions: (ownerId, workspaceId) => sessions[] | throws
  const legacyOriginRequests = 0;

  return {
    /** Number of times anything would have been forwarded to the legacy Pi
     * origin. Must stay 0 for the lifetime of the middleware. */
    get legacyOriginRequests() {
      return legacyOriginRequests;
    },

    handle({ method, path, token, workspaceId }) {
      const route = `${method} ${path}`;
      if (!RETAINED_API_ROUTES.has(route)) {
        // Fail closed with a stable code; no proxy, no fallback.
        return { status: 404, body: { error: { code: "unimplemented_route", route } } };
      }
      const ownerId = token ? compatTokens.get(token) : undefined;
      if (!ownerId) {
        return { status: 401, body: { error: { code: "unauthenticated" } } };
      }
      if (!workspaceId) {
        return { status: 400, body: { error: { code: "invalid_workspace" } } };
      }
      let sessions;
      try {
        sessions = listSessions(ownerId, workspaceId);
      } catch (error) {
        const code = String(error?.message ?? error);
        if (code.includes("cross_workspace")) {
          return { status: 403, body: { error: { code: "cross_workspace" } } };
        }
        if (code.includes("not registered")) {
          return { status: 404, body: { error: { code: "workspace_not_found" } } };
        }
        return { status: 500, body: { error: { code: "internal_error" } } };
      }
      // Response data is scoped to the verified owner; callers never see
      // another owner's sessions.
      return { status: 200, body: { sessions } };
    },
  };
}
