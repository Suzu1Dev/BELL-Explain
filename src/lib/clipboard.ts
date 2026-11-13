/** Copy from a user gesture, including private HTTP deployments without Clipboard API. */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // The browser may deny the modern API while still allowing a user-initiated copy.
    }
  }

  const focused = document.activeElement;
  const field = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
    ? focused
    : null;
  const fieldSelection = field && field.selectionStart !== null
    ? { start: field.selectionStart, end: field.selectionEnd!, direction: field.selectionDirection }
    : null;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : [];
  const selectionDirection = selection && selection.anchorNode && selection.focusNode
    ? { anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset }
    : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.readOnly = true;
  textarea.tabIndex = -1;
  textarea.setAttribute("aria-hidden", "true");
  Object.assign(textarea.style, {
    position: "fixed", left: "0", top: "0", width: "1px", height: "1px",
    padding: "0", border: "0", opacity: "0", pointerEvents: "none", fontSize: "16px",
  });
  document.body.appendChild(textarea);
  try {
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) throw new Error("Clipboard copy was denied");
  } finally {
    textarea.remove();
    // Restoration must not turn a successful copy into an error if the reader changed.
    try {
      if (focused instanceof HTMLElement && focused.isConnected) focused.focus({ preventScroll: true });
      if (field?.isConnected && fieldSelection) {
        field.setSelectionRange(fieldSelection.start, fieldSelection.end, fieldSelection.direction ?? undefined);
      } else if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) {
          if (range.commonAncestorContainer.isConnected) selection.addRange(range);
        }
        if (ranges.length === 1 && selectionDirection?.anchor.isConnected && selectionDirection.focus.isConnected) {
          selection.setBaseAndExtent(selectionDirection.anchor, selectionDirection.anchorOffset, selectionDirection.focus, selectionDirection.focusOffset);
        }
      }
    } catch {
      // A selection may no longer exist after its source is removed from the DOM.
    }
  }
}
