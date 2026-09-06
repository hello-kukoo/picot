/**
 * CodeMirror editor lifecycle wrapper.
 *
 * Creates and manages a single CodeMirror instance with line numbers,
 * configurable read-only/editable mode, line wrapping, search, and
 * go-to-line support. The EditorView ref is private; callers interact
 * through the returned API object.
 *
 * Source imports @codemirror/* directly — Vitest resolves from node_modules;
 * the browser import map redirects to vendor bundles at runtime.
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { closeSearchPanel, openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState } from "@codemirror/state";
import { oneDarkHighlightStyle } from "@codemirror/theme-one-dark";
import { EditorView, highlightActiveLine, keymap, lineNumbers } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { languageExtensionForPath } from "./file-language.js";
import { getLocale, onLocaleChange } from "./i18n.js";

/**
 * GitHub Light token colors (github-vscode-theme Light Default palette).
 * Used when the preview theme is forced or resolves to light; the dark side
 * stays on oneDark.
 */
const githubLightHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "#6e7781" },
  {
    tag: [
      t.keyword,
      t.modifier,
      t.operatorKeyword,
      t.definitionKeyword,
      t.controlKeyword,
      t.moduleKeyword,
      t.operator,
    ],
    color: "#cf222e",
  },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#0a3069" },
  {
    tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color, t.constant(t.name)],
    color: "#0550ae",
  },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "#8250df" },
  { tag: [t.typeName, t.className, t.namespace], color: "#953800" },
  { tag: [t.propertyName, t.attributeName, t.self, t.labelName], color: "#0550ae" },
  { tag: [t.tagName, t.standard(t.tagName)], color: "#116329" },
  { tag: [t.variableName, t.punctuation, t.separator, t.bracket], color: "#24292f" },
  { tag: t.heading, color: "#0550ae", fontWeight: "bold" },
  { tag: [t.link, t.url], color: "#0a3069", textDecoration: "underline" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.invalid, color: "#82071e" },
]);

function highlightExtensionFor(mode) {
  return syntaxHighlighting(mode === "light" ? githubLightHighlightStyle : oneDarkHighlightStyle);
}

/** Current-line highlight is an edit-mode affordance only. */
function activeLineExtensionFor(readOnly) {
  return readOnly ? [] : highlightActiveLine();
}

// Resolved highlight mode for every editor in this window. New editors pick
// it up at creation; setEditorHighlightTheme reconfigures live ones.
let editorHighlightMode = "dark";
const editorHighlightCompartments = new Map();

/**
 * Switch the CodeMirror syntax palette for every editor in this window
 * ("light" | "dark", already resolved from the preview theme preference).
 */
export function setEditorHighlightTheme(mode) {
  const next = mode === "light" ? "light" : "dark";
  if (next === editorHighlightMode) return;
  editorHighlightMode = next;
  for (const [view, compartment] of editorHighlightCompartments) {
    view.dispatch({
      effects: compartment.reconfigure(highlightExtensionFor(editorHighlightMode)),
    });
  }
}

const SEARCH_PHRASES = {
  zh: {
    Find: "查找",
    Replace: "替换",
    next: "下一个",
    previous: "上一个",
    all: "全部",
    "match case": "区分大小写",
    regexp: "正则表达式",
    "by word": "全词匹配",
    replace: "替换",
    "replace all": "全部替换",
    close: "关闭",
    "current match": "当前匹配项",
    "replaced match on line $": "已替换第 $ 行的匹配项",
    "replaced $ matches": "已替换 $ 个匹配项",
    "Go to line": "跳转到行",
    go: "跳转",
  },
};

function searchPhrasesForLocale(locale) {
  return SEARCH_PHRASES[locale] || {};
}

export function createCodeEditor({
  container,
  value = "",
  filePath,
  readOnly = true,
  wrapLines = false,
  onChange,
  onViewReady,
  onViewDestroy,
} = {}) {
  if (!container) throw new Error("container is required");

  const editableCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();
  const wrapCompartment = new Compartment();
  const languageCompartment = new Compartment();
  const highlightCompartment = new Compartment();
  const activeLineCompartment = new Compartment();
  const searchPhrasesCompartment = new Compartment();
  const languageExt = languageExtensionForPath(filePath || "");
  const extensions = [
    lineNumbers(),
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    search(),
    keymap.of(searchKeymap),
    editableCompartment.of(EditorView.editable.of(!readOnly)),
    readOnlyCompartment.of(EditorState.readOnly.of(readOnly)),
    searchPhrasesCompartment.of(EditorState.phrases.of(searchPhrasesForLocale(getLocale()))),
    wrapCompartment.of(wrapLines ? EditorView.lineWrapping : []),
    languageCompartment.of(languageExt ? [languageExt] : []),
    highlightCompartment.of(highlightExtensionFor(editorHighlightMode)),
    activeLineCompartment.of(activeLineExtensionFor(readOnly)),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && typeof onChange === "function") {
        onChange(update.state.doc.toString());
      }
    }),
  ];

  const view = new EditorView({
    state: EditorState.create({
      doc: value,
      extensions,
    }),
    parent: container,
  });
  editorHighlightCompartments.set(view, highlightCompartment);

  const unsubscribeLocale = onLocaleChange((locale) => {
    view.dispatch({
      effects: searchPhrasesCompartment.reconfigure(
        EditorState.phrases.of(searchPhrasesForLocale(locale)),
      ),
    });
  });

  if (typeof onViewReady === "function") {
    onViewReady(view);
  }

  return {
    getValue() {
      return view.state.doc.toString();
    },

    setValue(newValue) {
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: newValue,
        },
      });
    },

    focus() {
      view.focus();
    },

    openSearch() {
      openSearchPanel(view);
    },

    closeSearch() {
      closeSearchPanel(view);
    },

    /**
     * Scroll to and select a specific line number (1-indexed).
     * Returns true if the line exists, false otherwise.
     */
    goToLine(lineNumber) {
      if (!Number.isInteger(lineNumber) || lineNumber < 1) return false;
      const lineCount = view.state.doc.lines;
      if (lineNumber > lineCount) return false;
      const line = view.state.doc.line(lineNumber);
      view.dispatch({
        selection: { anchor: line.from, head: line.to },
        scrollIntoView: true,
      });
      view.focus();
      return true;
    },

    setReadOnly(newReadOnly) {
      view.dispatch({
        effects: [
          editableCompartment.reconfigure(EditorView.editable.of(!newReadOnly)),
          readOnlyCompartment.reconfigure(EditorState.readOnly.of(newReadOnly)),
          activeLineCompartment.reconfigure(activeLineExtensionFor(newReadOnly)),
        ],
      });
    },

    setWrapLines(enabled) {
      view.dispatch({
        effects: wrapCompartment.reconfigure(enabled ? EditorView.lineWrapping : []),
      });
    },

    destroy() {
      unsubscribeLocale();
      editorHighlightCompartments.delete(view);
      if (typeof onViewDestroy === "function") {
        onViewDestroy();
      }
      view.destroy();
    },

    get view() {
      return view;
    },
  };
}
