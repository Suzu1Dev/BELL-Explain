import strings from "./code-related-notes-strings.json" with { type: "json" };
import type { RelatedNote } from "../lib/related-notes";

export type CodeRelatedNotesLocale = "zh-TW" | "en";
export type CodeBlockCopy = (typeof strings)["zh-TW"]["codeBlock"];
export type RelatedNotesCopy = (typeof strings)["zh-TW"]["relatedNotes"];

export function resolveCodeRelatedNotesLocale(): CodeRelatedNotesLocale {
  if (typeof window === "undefined") return "zh-TW";
  const param = new URLSearchParams(window.location.search).get("lang");
  if (param === "en") return "en";
  if (param === "zh-TW") return "zh-TW";
  if (typeof document !== "undefined" && document.documentElement?.lang?.toLowerCase().startsWith("en")) return "en";
  return "zh-TW";
}

function bundle(locale = resolveCodeRelatedNotesLocale()) {
  return strings[locale];
}

export function codeBlockCopy(locale = resolveCodeRelatedNotesLocale()): CodeBlockCopy {
  return bundle(locale).codeBlock;
}

export function relatedNotesCopy(locale = resolveCodeRelatedNotesLocale()): RelatedNotesCopy {
  return bundle(locale).relatedNotes;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  );
}

export function formatCodeRegionAria(
  language: string | undefined,
  highlightRange?: { startLine: number; endLine: number },
  locale = resolveCodeRelatedNotesLocale(),
): string {
  const copy = codeBlockCopy(locale);
  const resolvedLanguage = language?.trim() || "";
  if (highlightRange) {
    return fill(copy.highlightRegionAria, {
      language: resolvedLanguage || copy.defaultLanguage,
      startLine: highlightRange.startLine,
      endLine: highlightRange.endLine,
    });
  }
  if (!resolvedLanguage) {
    return locale === "en" ? copy.defaultLanguage : fill(copy.regionAria, { language: copy.defaultLanguage });
  }
  return fill(copy.regionAria, { language: resolvedLanguage });
}

const RELATION_LABEL_KEYS: Record<RelatedNote["kind"], keyof RelatedNotesCopy["labels"]> = {
  "links-to": "linksTo",
  "linked-from": "linkedFrom",
  continues: "continues",
  "continued-by": "continuedBy",
};

export function formatRelationLabel(
  kind: RelatedNote["kind"],
  locale = resolveCodeRelatedNotesLocale(),
): string {
  return relatedNotesCopy(locale).labels[RELATION_LABEL_KEYS[kind]];
}

export function formatShowRemaining(
  count: number,
  locale = resolveCodeRelatedNotesLocale(),
): string {
  const copy = relatedNotesCopy(locale);
  return fill(count === 1 ? copy.showRemainingOne : copy.showRemaining, { count });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const [ZH_BACKLINK_PREFIX, ZH_BACKLINK_SUFFIX] = strings["zh-TW"].relatedNotes.sectionBacklink.split("{section}");
const ZH_SECTION_BACKLINK_RE = new RegExp(`^${escapeRegExp(ZH_BACKLINK_PREFIX)}(.*)${escapeRegExp(ZH_BACKLINK_SUFFIX)}$`);
const BUILTIN_CONTINUES_REASON = strings["zh-TW"].relatedNotes.reasons.continues;
const BUILTIN_CONTINUED_BY_REASON = strings["zh-TW"].relatedNotes.reasons.continuedBy;

export function localizeRelationSection(
  item: Pick<RelatedNote, "kind" | "section">,
  locale = resolveCodeRelatedNotesLocale(),
): string | undefined {
  if (!item.section || locale === "zh-TW") return item.section;
  if (item.kind === "linked-from") {
    const match = ZH_SECTION_BACKLINK_RE.exec(item.section);
    if (match) {
      return fill(relatedNotesCopy(locale).sectionBacklink, { section: match[1] });
    }
  }
  return item.section;
}

export function localizeRelationReason(
  item: Pick<RelatedNote, "kind" | "reason">,
  locale = resolveCodeRelatedNotesLocale(),
): string {
  if (locale === "zh-TW") return item.reason;
  const copy = relatedNotesCopy(locale);
  if (item.kind === "continues" && item.reason === BUILTIN_CONTINUES_REASON) {
    return copy.reasons.continues;
  }
  if (item.kind === "continued-by" && item.reason === BUILTIN_CONTINUED_BY_REASON) {
    return copy.reasons.continuedBy;
  }
  return item.reason;
}

export function formatRelationTooltip(
  item: RelatedNote,
  locale = resolveCodeRelatedNotesLocale(),
): string {
  return [
    formatRelationLabel(item.kind, locale),
    localizeRelationSection(item, locale),
    localizeRelationReason(item, locale),
  ]
    .filter(Boolean)
    .join(" · ");
}
