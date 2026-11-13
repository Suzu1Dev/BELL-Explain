import strings from "./explain-client-errors-strings.json";

function copy() {
  const locale = typeof window !== "undefined" && (new URLSearchParams(window.location.search).get("lang") === "en" || document.documentElement.lang.startsWith("en")) ? "en" : "zh-TW";
  return strings[locale];
}

export function explainApiErrors() {
  return copy().explainApiErrors;
}

export function explainMathFallback() {
  return copy().explainMathFallback;
}
