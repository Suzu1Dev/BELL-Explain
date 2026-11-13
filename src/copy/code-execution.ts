import strings from "./code-execution-strings.json" with { type: "json" };
import { resolvePracticalSearchLocale, type PracticalSearchLocale } from "./practical-search";

export type CodeExecutionCopy = (typeof strings)["zh-TW"];

export function codeExecutionCopy(
  locale: PracticalSearchLocale = resolvePracticalSearchLocale(),
): CodeExecutionCopy {
  return strings[locale];
}

export function fillExecCopy(
  template: string,
  values: Record<string, string | number>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}
