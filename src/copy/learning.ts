import strings from "./ui-strings.json";

type Localized<T> = T extends { "zh-TW": string; en: string } ? string : T extends object ? { [K in keyof T]: Localized<T[K]> } : T;
export type LearningCopy = Localized<typeof strings>;

function localize<T>(value: T, locale: "zh-TW" | "en"): Localized<T> {
  if (value && typeof value === "object") {
    if ("zh-TW" in value && "en" in value) return value["zh-TW" in value && locale in value ? locale : "zh-TW"] as Localized<T>;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, localize(entry, locale)])) as Localized<T>;
  }
  return value as Localized<T>;
}

export function learningCopy(): LearningCopy {
  const locale = typeof window !== "undefined" && (new URLSearchParams(window.location.search).get("lang") === "en" || document.documentElement.lang.startsWith("en")) ? "en" : "zh-TW";
  return localize(strings, locale);
}

export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));
}
