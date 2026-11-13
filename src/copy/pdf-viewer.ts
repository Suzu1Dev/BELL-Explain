import strings from "./pdf-viewer-strings.json";

function copy() {
  const locale = typeof window !== "undefined" && (new URLSearchParams(window.location.search).get("lang") === "en" || document.documentElement.lang.startsWith("en")) ? "en" : "zh-TW";
  return strings[locale];
}

export function pdfViewerCopy() {
  return copy().pdfViewer;
}

export function pdfViewerDocumentAria(fileName: string) {
  return pdfViewerCopy().documentAria.replace("{fileName}", fileName);
}

export function pdfViewerPageAria(page: number) {
  return pdfViewerCopy().pageAria.replace("{page}", String(page));
}
