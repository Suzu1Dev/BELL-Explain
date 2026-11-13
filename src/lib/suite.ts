// suite-contract v1 (2026-11-08; rev. f)
import { fill, suiteCopy } from "../copy/suite";
export type SuiteAppId = "explain" | "personal" | "pr" | "reader" | "campaign";
export type SuiteLinks = Partial<Record<SuiteAppId, string>>;

export interface SuiteManifest {
  schemaVersion: 1;
  appId: SuiteAppId;
  displayName: string;
  summary: string;
  links?: SuiteLinks;
}

export interface ExplainHandoff {
  text: string;
  title: string;
  from?: SuiteAppId;
  back?: string;
  truncated: boolean;
}

export function handoffKind(back: unknown): string | undefined {
  if (typeof back !== "string") return;
  const kinds = suiteCopy().handoff.kinds;
  const route = back.includes("/#/") ? back.slice(back.indexOf("/#/") + 1) : back;
  if (route.startsWith("#/tasks")) return kinds.task;
  if (route.startsWith("#/ideas")) return kinds.idea;
  if (route.startsWith("#/inbox")) return kinds.email;
  if (route.startsWith("#/events")) return kinds.event;
  if (route.startsWith("#/note/")) return kinds.note;
  if (route.startsWith("#/page/")) return kinds.page;
  if (route.startsWith("#/schedule")) return kinds.schedule;
}

export function handoffFromLine(handoff?: Pick<ExplainHandoff, "from" | "back" | "title">): string {
  const copy = suiteCopy();
  if (!handoff?.from) return copy.handoff.defaultSource;
  const name = copy.apps[handoff.from].name;
  const kind = handoffKind(handoff.back);
  const template = kind
    ? handoff.title ? copy.handoff.fromAppKindTitle : copy.handoff.fromAppKind
    : handoff.title ? copy.handoff.fromAppTitle : copy.handoff.fromApp;
  return fill(template, { name, kind: kind ?? "", title: handoff.title });
}

export const EXPLAIN_HANDOFF_KEY = "bell.suite.explain.handoff.v1";
const APP_IDS: SuiteAppId[] = ["explain", "personal", "pr", "reader", "campaign"];
// Change both together: bell-suite contracts/v1/reference.mjs ROUTES.
const ROUTES: Record<SuiteAppId, readonly string[]> = {
  explain: ["#/", "#/library", "#/graph", "#/favorites", "#/repositories", "#/review", "#/note/{id}"],
  personal: ["#/today", "#/tasks", "#/tasks/{id}", "#/events", "#/events/{id}", "#/ideas", "#/ideas/{id}", "#/inbox", "#/inbox/{id}"],
  pr: ["#/", "#/home", "#/demo", "#/repos", "#/repos/{id}", "#/discover", "#/team", "#/group", "#/learning", "#/settings", "#/runs/{id}"],
  reader: ["#/", "#/library", "#/topics", "#/page/{id}"],
  campaign: ["#/", "#/schedule", "#/tasks", "#/partners", "#/forms", "#/files", "#/meetings", "#/inspirations", "#/notes", "#/bot"],
};
const OBJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const HREF = /^#\/[A-Za-z0-9/_\-.~%:]*(?:\?[A-Za-z0-9_\-.~%=&+]*)?$/;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_HANDOFF = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const UNSAFE_TITLE = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function hashPath(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  return raw.split("?", 1)[0] || "/";
}

function clipped(value: string, max: number): { value: string; truncated: boolean } {
  const characters = Array.from(value);
  return { value: characters.slice(0, max).join(""), truncated: characters.length > max };
}

function cleanHandoff(value: string, max: number): { value: string; truncated: boolean } {
  return clipped(value.replace(/\r\n?/g, "\n").replace(UNSAFE_HANDOFF, "").trim(), max);
}

function cleanTitle(value: string): { value: string; truncated: boolean } {
  return clipped(value.replace(/\r\n?/g, "\n").replace(UNSAFE_TITLE, "").trim(), 120);
}

function decode(value: string): string {
  if (/%(?![\da-f]{2})/i.test(value)) throw new Error("Malformed URI encoding");
  return decodeURIComponent(value.replace(/\+/g, " "));
}

function validHref(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512 || !HREF.test(value) || value.includes("//")) return false;
  try {
    const decoded = decode(value);
    return !UNSAFE_TEXT.test(decoded) && !decoded.includes("\\") && !decoded.slice(2).startsWith("/");
  } catch {
    return false;
  }
}

export function safeBackRoute(value: unknown, from: unknown): string | undefined {
  if (typeof from !== "string" || !APP_IDS.includes(from as SuiteAppId) || !validHref(value)) return;
  return ROUTES[from as SuiteAppId].some(route => {
    const at = route.indexOf("{id}");
    if (at < 0) return value === route;
    const id = value.slice(at);
    return value.startsWith(route.slice(0, at)) && OBJECT_ID.test(id) && id !== "." && id !== "..";
  }) ? value : undefined;
}

export function explainNoteRoute(id: string): string {
  return safeBackRoute(`#/note/${id}`, "explain") ?? "#/library";
}

function loopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "::1" || host === "localhost") return true;
  const parts = host.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function tailnetOf(hostname: string): string | undefined {
  const labels = hostname.toLowerCase().split(".");
  return labels.length >= 4 && labels.at(-1) === "net" && labels.at(-2) === "ts" ? labels.slice(-3).join(".") : undefined;
}

export function safeSuiteOrigin(value: unknown, currentHostname = ""): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\/[^/?#\\\s@*]+$/i.test(value) || value.endsWith(":")) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port === "0") return;
    if (loopback(url.hostname)) return url.origin;
    const tailnet = tailnetOf(url.hostname);
    if (url.protocol !== "https:" || !tailnet || tailnet !== tailnetOf(currentHostname)) return;
    return url.origin;
  } catch {
    return;
  }
}

export function sanitizeSuiteLinks(value: unknown, currentHostname = ""): SuiteLinks {
  if (!value || typeof value !== "object") return {};
  const links: SuiteLinks = {};
  for (const app of ["personal", "pr", "reader", "campaign"] as const) {
    const origin = safeSuiteOrigin((value as Record<string, unknown>)[app], currentHostname);
    if (origin) links[app] = origin;
  }
  return links;
}

export function suiteBackHref(links: SuiteLinks, from: unknown, back: unknown, currentHostname = ""): string | undefined {
  if (typeof from !== "string" || from === "explain" || !APP_IDS.includes(from as SuiteAppId)) return;
  const origin = safeSuiteOrigin(links[from as SuiteAppId], currentHostname);
  const route = safeBackRoute(back, from);
  return origin && route ? `${origin}/${route}` : undefined;
}

export function hasExplainHandoff(hash: string): boolean {
  if (hashPath(hash) !== "/explain") return false;
  const question = hash.indexOf("?");
  if (question < 0) return false;
  const params = new URLSearchParams(hash.slice(question + 1));
  return ["text", "title", "draft", "from", "back"].some(key => params.has(key));
}

export function parseExplainHandoff(hash: string, links: SuiteLinks = {}): { present: boolean; draft?: ExplainHandoff; error?: string } {
  const errors = suiteCopy().handoff.errors;
  if (hashPath(hash) !== "/explain") return { present: false };
  const question = hash.indexOf("?");
  if (question < 0) return { present: false };
  const params = new URLSearchParams(hash.slice(question + 1));
  if (["text", "title", "draft", "from", "back"].some(key => params.getAll(key).length > 1)) {
    return { present: true, error: errors.duplicateFields };
  }
  if (!hasExplainHandoff(hash)) return { present: false };
  if (!params.has("text")) return { present: true, error: errors.missingText };
  const from = params.get("from");
  if (!from || from === "explain" || !APP_IDS.includes(from as SuiteAppId) || !links[from as SuiteAppId]) {
    return { present: true, error: errors.unlinkedSource };
  }
  const content = cleanHandoff(params.get("text") ?? "", 2000);
  if (!content.value) return { present: true, error: errors.emptyText };
  const title = cleanTitle(params.get("title") ?? "");
  const back = safeBackRoute(params.get("back"), from);
  return {
    present: true,
    draft: {
      text: content.value,
      title: title.value,
      truncated: content.truncated || title.truncated,
      from: from as SuiteAppId,
      ...(back ? { back } : {}),
    },
  };
}

export function normalizeExplainHandoff(value: unknown, links: SuiteLinks = {}): ExplainHandoff | undefined {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.text !== "string" || typeof candidate.title !== "string") return;
  const text = cleanHandoff(candidate.text, 2000);
  if (!text.value) return;
  const title = cleanTitle(candidate.title);
  const from = APP_IDS.includes(candidate.from as SuiteAppId) && candidate.from !== "explain" && links[candidate.from as SuiteAppId]
    ? candidate.from as SuiteAppId
    : undefined;
  const back = from ? safeBackRoute(candidate.back, from) : undefined;
  return {
    text: text.value,
    title: title.value,
    truncated: candidate.truncated === true || text.truncated || title.truncated,
    ...(from ? { from } : {}),
    ...(back ? { back } : {}),
  };
}

export function personalDraftHref(origin: unknown, draft: string, back: string, currentHostname = ""): string | undefined {
  const safeOrigin = safeSuiteOrigin(origin, currentHostname);
  const safeBack = safeBackRoute(back, "explain");
  if (!safeOrigin || !draft.trim()) return;
  const content = clipped(draft, 2000);
  const query = new URLSearchParams({ draft: content.value, from: "explain" });
  if (safeBack) query.set("back", safeBack);
  return `${safeOrigin}/#/tasks?${query}`;
}

export function readerDraftHref(origin: unknown, text: string, title: string, back: string, currentHostname = ""): string | undefined {
  const safeOrigin = safeSuiteOrigin(origin, currentHostname);
  const safeBack = safeBackRoute(back, "explain");
  if (!safeOrigin || !text.trim()) return;
  const content = clipped(text, 2000);
  const clean = cleanTitle(title);
  const query = new URLSearchParams({ text: content.value, from: "explain" });
  if (clean.value) query.set("title", clean.value);
  if (safeBack) query.set("back", safeBack);
  return `${safeOrigin}/#/read?${query}`;
}

export function prDraftHref(origin: unknown, draft: string, title: string, back: string, currentHostname = ""): string | undefined {
  const safeOrigin = safeSuiteOrigin(origin, currentHostname);
  const safeBack = safeBackRoute(back, "explain");
  if (!safeOrigin || !draft.trim()) return;
  const content = clipped(draft, 2000);
  const clean = cleanTitle(title);
  const query = new URLSearchParams({ draft: content.value, from: "explain" });
  if (clean.value) query.set("title", clean.value);
  if (safeBack) query.set("back", safeBack);
  return `${safeOrigin}/#/discover?${query}`;
}
