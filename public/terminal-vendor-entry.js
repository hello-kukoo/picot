// ABOUTME: Bundles xterm and its required addons as Picot same-origin assets.
// ABOUTME: Exposes constructors without loading any remote terminal script.
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

globalThis.PicotXterm = {
  Terminal,
  FitAddon,
  SerializeAddon,
  SearchAddon,
  Unicode11Addon,
  WebglAddon,
};
