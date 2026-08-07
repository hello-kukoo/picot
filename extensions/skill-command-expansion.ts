// ABOUTME: Pure skill/prompt-template command expander mirroring Pi TUI's
// ABOUTME: _expandSkillCommand + expandPromptTemplate byte-for-byte on success.

import { parse as parseYaml } from "yaml";

/**
 * Expand a `/skill:<name>` or `/<template-name>` command into its injected
 * prompt text, byte-identical to what the embedded Pi TUI produces on the
 * success path. Unknown slash commands pass through untouched. A known command
 * whose source file cannot be read is an explicit error (Picot product
 * decision — Pi TUI instead emits an error event and returns the original text).
 *
 * Pi's ExtensionAPI exposes no expansion method, so Picot reproduces the two
 * Pi functions here:
 *   - skill:    agent-session._expandSkillCommand
 *   - template: prompt-templates.expandPromptTemplate (+ parseCommandArgs / substituteArgs)
 *
 * File reads are injected so this module stays pure and deterministic under test.
 */

/** Subset of Pi's SlashCommandInfo that this module needs. */
export type ExpansionCommand = {
  name: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: {
    path: string;
    baseDir?: string;
  };
};

export type ExpansionResult =
  | { kind: "expanded"; text: string }
  | { kind: "passthrough" }
  | { kind: "error"; message: string };

/** Injected file reader; throwing signals an unreadable source (→ error result). */
export type ExpansionFileReader = (path: string) => string;

const SKILL_PREFIX = "/skill:";

/**
 * Parse the command name (first token after the leading slash) and the raw
 * trailing args string, mirroring how Pi splits `/skill:name args...`.
 *
 * - For `/skill:foo`: name is the substring after `/skill:` up to first space.
 * - For `/<name> ...`: name is the first whitespace-delimited token after `/`.
 * - `//foo` is NOT a command (Pi/escape convention) → returns null.
 */
function parseSlashCommand(text: string): { commandName: string; argsString: string } | null {
  // A leading "//" is the Pi escape convention (literal "/"), not a command.
  if (text.startsWith("//")) return null;
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { commandName: match[1] ?? "", argsString: match[2] ?? "" };
}

/**
 * Strip YAML frontmatter from a Markdown file, returning the body exactly as
 * Pi's `stripFrontmatter` (`parseFrontmatter(content).body`) does: the body is
 * the text after the closing `\n---`, with leading/trailing whitespace trimmed
 * by Pi's `extractFrontmatter`.
 *
 * Mirrors `node_modules/@earendil-works/pi-coding-agent/dist/utils/frontmatter.js`.
 */
function stripFrontmatter(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return normalized;
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return normalized;
  // Pi parses the YAML block before exposing its body. Keep that validation so
  // a malformed known source becomes an explicit expansion error rather than
  // being sent to the model as if it were valid.
  parseYaml(normalized.slice(4, endIndex));
  return normalized.slice(endIndex + 4).trim();
}

/**
 * Parse a command-args string bash-style: whitespace-delimited with single and
 * double quotes that are removed from the captured value.
 *
 * Mirrors `parseCommandArgs` in pi's `core/prompt-templates.js`.
 */
function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuote: string | null = null;
  for (let i = 0; i < argsString.length; i += 1) {
    const char = argsString[i];
    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) args.push(current);
  return args;
}

/**
 * Substitute `$1`/`$2`…, `$@`, `$ARGUMENTS`, and the `${...}` forms into a
 * template body. Argument and default values are NOT recursively substituted.
 *
 * Mirrors `substituteArgs` in pi's `core/prompt-templates.js` exactly, including
 * the single regex and the bash-style 1-indexed slicing.
 */
function substituteArgs(content: string, args: string[]): string {
  const allArgs = args.join(" ");
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (
      _match,
      defaultTarget: string | undefined,
      defaultValue: string | undefined,
      sliceStart: string | undefined,
      sliceLength: string | undefined,
      simple: string | undefined,
    ) => {
      if (defaultTarget) {
        const value =
          defaultTarget === "@" || defaultTarget === "ARGUMENTS"
            ? allArgs
            : args[Number.parseInt(defaultTarget, 10) - 1];
        return value ? value : (defaultValue ?? "");
      }
      if (sliceStart) {
        let start = Number.parseInt(sliceStart, 10) - 1; // 0-indexed (user gives 1-indexed)
        if (start < 0) start = 0; // bash: 0 treated as 1
        if (sliceLength) {
          const length = Number.parseInt(sliceLength, 10);
          return args.slice(start, start + length).join(" ");
        }
        return args.slice(start).join(" ");
      }
      if (simple === "ARGUMENTS" || simple === "@") return allArgs;
      const index = Number.parseInt(simple ?? "", 10) - 1;
      return args[index] ?? "";
    },
  );
}

/**
 * Expand a `/skill:<name>` command. On hit, returns the Pi-identical
 * `<skill>` block (with args appended); on miss, returns passthrough; on a
 * read error of a hit file, returns an explicit error.
 */
function expandSkill(
  skillName: string,
  args: string,
  command: ExpansionCommand,
  readFile: ExpansionFileReader,
): ExpansionResult {
  const filePath = command.sourceInfo.path;
  let body: string;
  try {
    // Pi: body = stripFrontmatter(content).trim()
    body = stripFrontmatter(readFile(filePath)).trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      kind: "error",
      message: `Failed to expand skill "${skillName}" at ${filePath}: ${detail}`,
    };
  }
  const baseDir = command.sourceInfo.baseDir ?? "";
  const skillBlock = `<skill name="${skillName}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
  return { kind: "expanded", text: args ? `${skillBlock}\n\n${args}` : skillBlock };
}

/**
 * Expand a `/<template-name>` command. On hit, returns the Pi-identical
 * template body with args substituted; on miss, passthrough; on a read error
 * of a hit file, error.
 */
function expandTemplate(
  templateName: string,
  argsString: string,
  command: ExpansionCommand,
  readFile: ExpansionFileReader,
): ExpansionResult {
  const filePath = command.sourceInfo.path;
  let content: string;
  try {
    // Pi: template.content = parseFrontmatter(raw).body
    content = stripFrontmatter(readFile(filePath));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      kind: "error",
      message: `Failed to expand template "${templateName}" at ${filePath}: ${detail}`,
    };
  }
  const args = parseCommandArgs(argsString);
  return { kind: "expanded", text: substituteArgs(content, args) };
}

/**
 * Expand a slash command against the given Pi command list. Returns one of:
 *   - "expanded":   a known skill/template was expanded into prompt text
 *   - "passthrough": an extension command, an unknown `/foo`, `//escape`, or non-slash text
 *   - "error":      a known skill/template whose source file could not be read
 *
 * Lookup is by command name. Pi dedupes names at load time
 * (`dedupePrompts` / `skillMap`, first-wins), so there is at most one match;
 * `sourceInfo.path` is used only to read the file, not to disambiguate names.
 */
export function expandSkillOrTemplate(
  text: string,
  commands: ExpansionCommand[],
  readFile: ExpansionFileReader,
): ExpansionResult {
  if (!text.startsWith("/") || !text.startsWith(SKILL_PREFIX)) {
    const parsed = parseSlashCommand(text);
    if (!parsed) return { kind: "passthrough" };
    const { commandName, argsString } = parsed;

    // Template lookup: source === "prompt", name === commandName
    const template = commands.find((c) => c.source === "prompt" && c.name === commandName);
    if (template) return expandTemplate(commandName, argsString, template, readFile);

    // No skill/template match → extension command or unknown → pass through.
    return { kind: "passthrough" };
  }

  // `/skill:<name>` branch.
  const afterPrefix = text.slice(SKILL_PREFIX.length);
  const spaceIndex = afterPrefix.indexOf(" ");
  const skillName = spaceIndex === -1 ? afterPrefix : afterPrefix.slice(0, spaceIndex);
  const args = spaceIndex === -1 ? "" : afterPrefix.slice(spaceIndex + 1).trim();

  const skill = commands.find((c) => c.source === "skill" && c.name === `skill:${skillName}`);
  if (!skill) return { kind: "passthrough" };
  return expandSkill(skillName, args, skill, readFile);
}
