import strings from "./annotation-card-strings.json";

export function annotationCardCopy() {
  const locale = typeof window !== "undefined" && (new URLSearchParams(window.location.search).get("lang") === "en" || document.documentElement.lang.startsWith("en")) ? "en" : "zh-TW";
  return strings[locale];
}

export function fillAnnotationCard(tpl: string, vals: Record<string, unknown>) {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => String(vals[k] ?? m));
}
