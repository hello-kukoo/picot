// `llama` only works in pi's TUI mode; over RPC it just warns and does nothing.
// `picot-config` and `picot-custom-ui` are internal data planes the WebView
// drives itself, not commands a user would type.
const HIDDEN_NATIVE_COMMANDS = new Set(["picot-config", "picot-custom-ui", "llama"]);

function commandPath(command) {
  return command.sourceInfo?.path ?? command.path;
}

function inferCommandScope(command) {
  if (command.location) return command.location;
  if (command.sourceInfo?.scope) return command.sourceInfo.scope;
  const path = commandPath(command);
  if (typeof path === "string" && path.includes("/.pi/agent/")) return "global";
  return "global";
}

function normalizeNativeCommand(command) {
  return {
    ...command,
    type: command.source ?? "extension",
    scope: inferCommandScope(command),
    capabilityState: command.capabilityState ?? "enabled",
  };
}

export function buildCommandCatalog({ builtIns = [], nativeCommands = [] } = {}) {
  const catalog = new Map();
  for (const command of builtIns) {
    catalog.set(command.name, {
      ...command,
      type: "builtin",
      source: "picot",
      scope: "picot",
      capabilityState: command.capabilityState ?? "enabled",
    });
  }
  for (const command of nativeCommands) {
    if (HIDDEN_NATIVE_COMMANDS.has(command.name)) continue;
    if (!catalog.has(command.name)) catalog.set(command.name, normalizeNativeCommand(command));
  }
  return catalog;
}

/**
 * Resolve the catalog entry a composer line invokes, or null when the line is
 * not a slash command Picot knows about. Exported so callers that need the
 * command itself (not just the intent) parse it the same way.
 */
export function matchCatalogCommand(input, catalog) {
  const message = String(input ?? "");
  if (message.startsWith("//") || !message.startsWith("/")) return null;
  const match = /^\/([^\s]+)(?:\s+(.*))?$/s.exec(message);
  const name = match?.[1] ?? "";
  const args = match?.[2] ?? "";
  const resolvedName = name === "todo" && catalog.has("todos") ? "todos" : name;
  const command = catalog.get(resolvedName);
  return command ? { command, name, resolvedName, args } : null;
}

export function resolveComposerInput(input, catalog, options = {}) {
  const message = String(input ?? "");
  if (message.startsWith("//")) {
    return runtimeIntent("prompt", message.slice(1), options.images);
  }
  if (message.startsWith("/")) {
    const matched = matchCatalogCommand(message, catalog);
    if (!matched) return defaultRuntimeIntent(message, options);
    const { command, name, resolvedName, args } = matched;
    if (command.capabilityState !== "enabled") {
      return { kind: "rejected", reason: `Command unavailable: /${name}` };
    }
    if (options.working && command.streamingCompatible === false) {
      return {
        kind: "rejected",
        reason: `Command cannot run while the agent is working: /${name}`,
      };
    }
    if (command.type === "builtin") {
      return { kind: "builtin", action: command.action, arguments: args };
    }
    const runtimeMessage =
      resolvedName === name ? message : `/${resolvedName}${args ? ` ${args}` : ""}`;
    return runtimeIntent("prompt", runtimeMessage, options.images);
  }
  return defaultRuntimeIntent(message, options);
}

function defaultRuntimeIntent(message, options) {
  if (!options.working) return runtimeIntent("prompt", message, options.images);
  return runtimeIntent(options.altKey ? "follow_up" : "steer", message, options.images);
}

function runtimeIntent(type, message, images) {
  return {
    kind: "runtime",
    command: {
      type,
      message,
      ...(images?.length ? { images } : {}),
    },
  };
}
