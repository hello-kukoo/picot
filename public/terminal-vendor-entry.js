// ABOUTME: Bundles xterm and its required addons as Picot same-origin assets.
// ABOUTME: Exposes constructors without loading any remote terminal script.
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";

globalThis.PicotXterm = { Terminal, FitAddon, SerializeAddon };
