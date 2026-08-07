// @vitest-environment node

// ABOUTME: Tests the pure skill/prompt-template expansion module that mirrors
// ABOUTME: Pi TUI's _expandSkillCommand + expandPromptTemplate byte-for-byte.

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { expandSkillOrTemplate } from "./skill-command-expansion.ts";

/** Minimal SlashCommandInfo shape the expander consumes. */
function skillCmd(name: string, filePath: string, baseDir: string = "/skills/foo") {
  return {
    name: `skill:${name}`,
    description: `${name} skill`,
    source: "skill" as const,
    sourceInfo: { path: filePath, source: "local", scope: "user" as const, baseDir },
  };
}
function templateCmd(name: string, filePath: string) {
  return {
    name,
    description: `${name} template`,
    source: "prompt" as const,
    sourceInfo: { path: filePath, source: "local", scope: "user" as const },
  };
}
function extCmd(name: string) {
  return {
    name,
    description: `${name} command`,
    source: "extension" as const,
    sourceInfo: { path: "<ext>", source: "extension", scope: "user" as const },
  };
}

const readFromFs = (p: string) => readFileSyncText(p);

// Minimal fs read helper (Node readFileSync utf-8). Defined at bottom to keep
// tests readable; mirrors what embedded-server will inject in production.
function readFileSyncText(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs");
  return fs.readFileSync(p, "utf-8");
}

describe("expandSkillOrTemplate — skill expansion", () => {
  it("expands a known skill into a <skill> block byte-identical to Pi TUI", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-skill-"));
    const skillDir = join(dir, "my-skill");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(
      skillFile,
      "---\nname: my-skill\ndescription: d\n---\nBody line 1\nBody line 2\n",
    );

    const out = expandSkillOrTemplate(
      "/skill:my-skill",
      [skillCmd("my-skill", skillFile, skillDir)],
      readFromFs,
    );

    // Pi: body = stripFrontmatter(content).trim() → "Body line 1\nBody line 2"
    expect(out).toEqual({
      kind: "expanded",
      text: `<skill name="my-skill" location="${skillFile}">\nReferences are relative to ${skillDir}.\n\nBody line 1\nBody line 2\n</skill>`,
    });
  });

  it("appends args after a blank line when present", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-skill-args-"));
    const skillDir = join(dir, "s");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(skillFile, "---\nname: s\ndescription: d\n---\nBody\n");

    const out = expandSkillOrTemplate(
      "/skill:s do the thing",
      [skillCmd("s", skillFile, skillDir)],
      readFromFs,
    );

    expect(out.kind).toBe("expanded");
    if (out.kind !== "expanded") return;
    // Pi: args = text.slice(spaceIndex+1).trim()
    expect(out.text).toBe(
      `<skill name="s" location="${skillFile}">\nReferences are relative to ${skillDir}.\n\nBody\n</skill>\n\ndo the thing`,
    );
  });

  it("follows a symlink skill file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-sym-"));
    const realDir = join(dir, "real");
    const linkDir = join(dir, "link");
    mkdirSync(realDir, { recursive: true });
    mkdirSync(linkDir, { recursive: true });
    const realFile = join(realDir, "SKILL.md");
    writeFileSync(realFile, "---\nname: sym\ndescription: d\n---\nReal Body\n");
    const linkFile = join(linkDir, "SKILL.md");
    symlinkSync(realFile, linkFile);

    const out = expandSkillOrTemplate(
      "/skill:sym",
      [skillCmd("sym", linkFile, linkDir)],
      readFromFs,
    );

    // location must be the symlink path Pi stored (not realpath), baseDir the symlink dir.
    expect(out).toEqual({
      kind: "expanded",
      text: `<skill name="sym" location="${linkFile}">\nReferences are relative to ${linkDir}.\n\nReal Body\n</skill>`,
    });
  });

  it("preserves trailing whitespace inside the trimmed body exactly as Pi does", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-ws-"));
    const skillDir = join(dir, "s");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    // Body has trailing spaces on a line and a trailing blank line.
    writeFileSync(skillFile, "---\nname: s\ndescription: d\n---\nLine A   \nLine B\n\n");

    const out = expandSkillOrTemplate("/skill:s", [skillCmd("s", skillFile, skillDir)], readFromFs);
    expect(out.kind).toBe("expanded");
    if (out.kind !== "expanded") return;
    // stripFrontmatter returns body (trimmed by extractFrontmatter's .trim() on body),
    // then _expandSkillCommand does .trim() again → "Line A   \nLine B"
    expect(out.text).toContain("Line A   \nLine B\n</skill>");
  });
});

describe("expandSkillOrTemplate — prompt template expansion", () => {
  function writeTemplate(dir: string, name: string, body: string): string {
    const p = join(dir, `${name}.md`);
    writeFileSync(p, `---\ndescription: d\n---\n${body}`);
    return p;
  }

  it("expands a template by filename (no frontmatter name), stripping frontmatter, no trim", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-tpl-"));
    const p = writeTemplate(dir, "greet", "Hello world\n");

    const out = expandSkillOrTemplate("/greet", [templateCmd("greet", p)], readFromFs);
    // Pi template.content = parseFrontmatter(raw).body; extractFrontmatter trims body → "Hello world" (no trailing newline)
    expect(out).toEqual({ kind: "expanded", text: "Hello world" });
  });

  it("substitutes $1, $2 positional args", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-tpl-pos-"));
    const p = writeTemplate(dir, "pos", "First: $1, Second: $2, Missing: $3");
    const out = expandSkillOrTemplate("/pos alpha beta", [templateCmd("pos", p)], readFromFs);
    expect(out).toEqual({ kind: "expanded", text: "First: alpha, Second: beta, Missing: " });
  });

  it("substitutes $@ and $ARGUMENTS with all args joined by space", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-tpl-all-"));
    const p = writeTemplate(dir, "all", "All: $@ / Also: $ARGUMENTS");
    const out = expandSkillOrTemplate("/all a b c", [templateCmd("all", p)], readFromFs);
    expect(out).toEqual({ kind: "expanded", text: "All: a b c / Also: a b c" });
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Pi prompt-template arg syntax in test title
  it("supports ${N:-default} with empty/missing positional and ${@:-default}", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-tpl-def-"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Pi prompt-template arg syntax, not JS interpolation
    const p = writeTemplate(dir, "def", "[${1:-fallback}] [${@:-nodefault}]");
    const out = expandSkillOrTemplate("/def", [templateCmd("def", p)], readFromFs);
    expect(out).toEqual({ kind: "expanded", text: "[fallback] [nodefault]" });
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Pi prompt-template slice syntax in test title
  it("supports ${@:N} and ${@:N:L} slicing (1-indexed)", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-tpl-slice-"));
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal Pi prompt-template slice syntax, not JS interpolation
    const p = writeTemplate(dir, "sl", "From2: ${@:2} / From2Len1: ${@:2:1}");
    const out = expandSkillOrTemplate("/sl a b c d", [templateCmd("sl", p)], readFromFs);
    expect(out).toEqual({ kind: "expanded", text: "From2: b c d / From2Len1: b" });
  });

  it("parses quoted args (single and double) bash-style", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-tpl-quote-"));
    const p = writeTemplate(dir, "q", "A=$1 B=$2");
    const out = expandSkillOrTemplate(
      `/q "hello world" 'foo bar'`,
      [templateCmd("q", p)],
      readFromFs,
    );
    expect(out).toEqual({ kind: "expanded", text: "A=hello world B=foo bar" });
  });

  it("does NOT recursively substitute $-patterns inside arg values", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-tpl-norecurse-"));
    const p = writeTemplate(dir, "nr", "Result: $1");
    // Arg value literally contains "$2" — must not be re-substituted.
    const out = expandSkillOrTemplate("/nr $2", [templateCmd("nr", p)], readFromFs);
    expect(out).toEqual({ kind: "expanded", text: "Result: $2" });
  });
});

describe("expandSkillOrTemplate — passthrough", () => {
  it("passes through extension commands like /new unchanged", () => {
    const out = expandSkillOrTemplate("/new", [extCmd("new")], readFromFs);
    expect(out).toEqual({ kind: "passthrough" });
  });

  it("passes through unknown /foo", () => {
    const out = expandSkillOrTemplate("/unknown-cmd", [], readFromFs);
    expect(out).toEqual({ kind: "passthrough" });
  });

  it("passes through unknown /skill:foo (skill not in commands)", () => {
    const out = expandSkillOrTemplate("/skill:ghost", [], readFromFs);
    expect(out).toEqual({ kind: "passthrough" });
  });

  it("passes through unknown /template-name", () => {
    const out = expandSkillOrTemplate("/ghost-tpl", [], readFromFs);
    expect(out).toEqual({ kind: "passthrough" });
  });

  it("passes through non-slash text unchanged", () => {
    const out = expandSkillOrTemplate("just a normal message", [], readFromFs);
    expect(out).toEqual({ kind: "passthrough" });
  });

  it("passes through // double-slash (escape) unchanged — not treated as command", () => {
    const out = expandSkillOrTemplate("//not-a-command", [extCmd("not-a-command")], readFromFs);
    expect(out).toEqual({ kind: "passthrough" });
  });
});

describe("expandSkillOrTemplate — error on hit-but-unreadable", () => {
  it("returns error when a known skill file cannot be read", () => {
    const out = expandSkillOrTemplate(
      "/skill:ghost-file",
      [skillCmd("ghost-file", "/nonexistent/path/SKILL.md", "/nonexistent")],
      () => {
        throw new Error("ENOENT");
      },
    );
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toContain("ghost-file");
  });

  it("returns error when a known template file cannot be read", () => {
    const out = expandSkillOrTemplate(
      "/ghost-tpl",
      [templateCmd("ghost-tpl", "/nonexistent/tpl.md")],
      () => {
        throw new Error("ENOENT");
      },
    );
    expect(out.kind).toBe("error");
  });

  it("returns error when known skill frontmatter is invalid YAML", () => {
    const out = expandSkillOrTemplate(
      "/skill:broken-skill",
      [skillCmd("broken-skill", "/tmp/broken/SKILL.md")],
      () => "---\ndescription: [unterminated\n---\nBody",
    );
    expect(out).toMatchObject({ kind: "error" });
  });

  it("returns error when known template frontmatter is invalid YAML", () => {
    const out = expandSkillOrTemplate(
      "/broken-template",
      [templateCmd("broken-template", "/tmp/broken.md")],
      () => "---\ndescription: [unterminated\n---\nBody",
    );
    expect(out).toMatchObject({ kind: "error" });
  });

  it("does NOT error on unknown command — only on known-but-unreadable", () => {
    const out = expandSkillOrCommand_unknown_no_error();
    expect(out).toEqual({ kind: "passthrough" });
  });
});

// helper for the test above
function expandSkillOrCommand_unknown_no_error() {
  return expandSkillOrTemplate("/totally-unknown", [], readFromFs);
}

describe("expandSkillOrTemplate — skill name resolution", () => {
  it("matches skill by name after 'skill:' prefix (first token)", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-match-"));
    const skillDir = join(dir, "s");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(skillFile, "---\nname: s\ndescription: d\n---\nBody\n");

    const out = expandSkillOrTemplate(
      "/skill:s extra args here",
      [skillCmd("s", skillFile, skillDir)],
      readFromFs,
    );
    expect(out.kind).toBe("expanded");
    if (out.kind !== "expanded") return;
    expect(out.text).toContain('name="s"');
    expect(out.text.endsWith("\n\nextra args here")).toBe(true);
  });

  it("uses sourceInfo.baseDir for the References line, not a derived path", () => {
    const dir = mkdtempSync(join(tmpdir(), "exp-basedir-"));
    const skillDir = join(dir, "nested", "deep");
    mkdirSync(skillDir, { recursive: true });
    const skillFile = join(skillDir, "SKILL.md");
    writeFileSync(skillFile, "---\nname: deep\ndescription: d\n---\nB\n");

    const out = expandSkillOrTemplate(
      "/skill:deep",
      [skillCmd("deep", skillFile, skillDir)],
      readFromFs,
    );
    expect(out.kind).toBe("expanded");
    if (out.kind !== "expanded") return;
    expect(out.text).toContain(`References are relative to ${skillDir}.`);
  });
});
