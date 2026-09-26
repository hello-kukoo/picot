// ABOUTME: Guards composer textareas against WKWebView's arrow-key text
// ABOUTME: insertion: an arrow keyDown that the editing layer does not consume
// ABOUTME: comes back from AppKit as insertText with the legacy C0 encoding
// ABOUTME: (U+001C left, U+001D right, U+001E up, U+001F down), so a caret
// ABOUTME: sitting at the text end accumulates invisible control characters.

const isC0ArrowCode = (code) => code >= 0x1c && code <= 0x1f;

const containsC0Arrow = (text) => {
  for (let i = 0; i < text.length; i += 1) {
    if (isC0ArrowCode(text.charCodeAt(i))) return true;
  }
  return false;
};

const stripC0Arrows = (text) => {
  let kept = "";
  for (let i = 0; i < text.length; i += 1) {
    if (!isC0ArrowCode(text.charCodeAt(i))) kept += text[i];
  }
  return kept;
};

/**
 * Install the guard on one composer textarea. `beforeinput` blocks the
 * insertion when WebKit honors preventDefault; an `input` pass strips any
 * that slipped through (AppKit's insertText can bypass the beforeinput
 * contract), restoring the caret to the same reading position.
 */
export function guardComposerArrowInsertion(textarea) {
  if (!textarea || typeof textarea.addEventListener !== "function") return () => {};
  const onBeforeInput = (event) => {
    if (event.inputType !== "insertText" || typeof event.data !== "string") return;
    if (containsC0Arrow(event.data)) event.preventDefault();
  };
  const onInput = () => {
    const { value } = textarea;
    if (!containsC0Arrow(value)) return;
    const caret = textarea.selectionStart ?? value.length;
    const keptBeforeCaret = stripC0Arrows(value.slice(0, caret)).length;
    textarea.value = stripC0Arrows(value);
    textarea.setSelectionRange(keptBeforeCaret, keptBeforeCaret);
  };
  textarea.addEventListener("beforeinput", onBeforeInput);
  textarea.addEventListener("input", onInput);
  return () => {
    textarea.removeEventListener("beforeinput", onBeforeInput);
    textarea.removeEventListener("input", onInput);
  };
}
