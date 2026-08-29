import { afterEach, describe, expect, it } from "vitest";
import { t } from "../../i18n.js";
import { setupRemoteAccessHeader } from "./remote-access-header.js";

describe("remote access header shortcut", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stays hidden for remote clients and does not open settings", () => {
    document.body.innerHTML = `<button id="remote-access-header-btn" class="hidden"></button>`;
    const onOpen = () => {
      throw new Error("remote clients must not open remote access settings");
    };
    setupRemoteAccessHeader({
      buttonEl: document.getElementById("remote-access-header-btn"),
      onOpen,
      visible: false,
    });

    const button = document.getElementById("remote-access-header-btn");
    expect(button.classList.contains("hidden")).toBe(true);
    button.click();
  });

  it("shows on desktop and opens the Remote Access settings tab", () => {
    document.body.innerHTML = `<button id="remote-access-header-btn" class="hidden"></button>`;
    const opened = [];
    setupRemoteAccessHeader({
      buttonEl: document.getElementById("remote-access-header-btn"),
      onOpen: () => opened.push("remote-access"),
      visible: true,
    });

    const button = document.getElementById("remote-access-header-btn");
    expect(button.classList.contains("hidden")).toBe(false);
    expect(button.getAttribute("aria-label")).toBe(t("settings.remoteAccess"));
    button.click();
    expect(opened).toEqual(["remote-access"]);
  });
});
