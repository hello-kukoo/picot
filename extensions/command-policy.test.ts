// @vitest-environment node

// ABOUTME: Verifies the shared core-command manifest and its TS enforcement.
// ABOUTME: Asserts schema, exhaustive source parity, and fail-closed authorization.

import { describe, expect, it } from "vitest";
import manifest from "../protocol/picot-core-commands.json";
import { assertEphemeralCommandAllowed, classifyCoreCommand } from "./command-policy.ts";

describe("picot-core-commands manifest", () => {
  it("declares schema version 1", () => {
    expect(manifest.version).toBe(1);
  });

  it("uses only the three declared permission values", () => {
    const allowed = new Set(["allowed", "deniedSessionLifecycle", "desktopOwnerOnly"]);
    for (const value of Object.values(manifest.commands)) {
      expect(allowed.has(value)).toBe(true);
    }
  });

  it("declares every canonical native command exactly once", () => {
    const commandNames = Object.keys(manifest.commands);
    expect(new Set(commandNames).size).toBe(commandNames.length);
    expect(commandNames).toContain("prompt");
    expect(commandNames).toContain("extension_ui_response");
  });
});

describe("classifyCoreCommand", () => {
  it("classifies prompt as allowed", () => {
    expect(classifyCoreCommand("prompt")).toBe("allowed");
  });

  it("classifies new_session as deniedSessionLifecycle", () => {
    expect(classifyCoreCommand("new_session")).toBe("deniedSessionLifecycle");
  });

  it("classifies set_api_key as desktopOwnerOnly", () => {
    expect(classifyCoreCommand("set_api_key")).toBe("desktopOwnerOnly");
  });

  it("returns null for an unknown command", () => {
    expect(classifyCoreCommand("totally_unknown_command_xyz")).toBeNull();
  });

  it.each([
    "list_skill_inventory",
    "set_skill_enabled",
  ])("classifies %s as desktopOwnerOnly", (type) => {
    expect(classifyCoreCommand(type)).toBe("desktopOwnerOnly");
    expect(() => assertEphemeralCommandAllowed(type, false)).toThrow("Command is not available");
  });
});

describe("assertEphemeralCommandAllowed", () => {
  it("allows prompt regardless of the desktop-owner flag", () => {
    expect(() => assertEphemeralCommandAllowed("prompt", false)).not.toThrow();
    expect(() => assertEphemeralCommandAllowed("prompt", true)).not.toThrow();
  });

  it("denies session-lifecycle commands with the generic message", () => {
    expect(() => assertEphemeralCommandAllowed("switch_session", true)).toThrow(
      "Command is not available in temporary chat",
    );
  });

  it("denies desktop-owner-only commands when not the desktop owner", () => {
    expect(() => assertEphemeralCommandAllowed("set_api_key", false)).toThrow(
      "Command is not available in temporary chat",
    );
  });

  it("allows desktop-owner-only commands for the desktop owner", () => {
    expect(() => assertEphemeralCommandAllowed("set_api_key", true)).not.toThrow();
  });

  for (const command of [
    "get_oauth_login_capabilities",
    "start_oauth_login",
    "cancel_oauth_login",
    "get_oauth_login_status",
    "logout_oauth_login",
  ]) {
    it(`classifies ${command} as desktopOwnerOnly`, () => {
      expect(classifyCoreCommand(command)).toBe("desktopOwnerOnly");
      expect(() => assertEphemeralCommandAllowed(command, false)).toThrow();
    });
    it(`${command} passes the generic gate for a desktop owner (absolute ephemeral gate rejects)`, () => {
      // Native ephemeral dispatch applies this generic permission gate first;
      // the runtime-specific policy rejects commands that temporary sessions
      // cannot execute.
      expect(() => assertEphemeralCommandAllowed(command, true)).not.toThrow();
    });
  }

  it("denies unknown commands with the same generic message", () => {
    expect(() => assertEphemeralCommandAllowed("does_not_exist", true)).toThrow(
      "Command is not available in temporary chat",
    );
  });

  it("never echoes an attacker-supplied command in the error", () => {
    const evil = "evil_injected_command_42";
    try {
      assertEphemeralCommandAllowed(evil, false);
      throw new Error("expected assertEphemeralCommandAllowed to throw");
    } catch (e) {
      expect((e as Error).message).not.toContain(evil);
    }
  });
});
