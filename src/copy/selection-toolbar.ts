import strings from "./selection-toolbar-strings.json";

export function selectionToolbarCopy() {
  const locale = typeof window !== "undefined" && (new URLSearchParams(window.location.search).get("lang") === "en" || document.documentElement.lang.startsWith("en")) ? "en" : "zh-TW";
  return strings[locale];
}
