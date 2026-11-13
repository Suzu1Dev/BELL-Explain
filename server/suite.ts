/**
 * suite-contract v1 (2026-11-08)
 *
 * BELL Suite, Explain's side: the browser links to the sibling apps (BELL_SUITE_LINKS),
 * GET /api/suite/manifest and GET /api/suite/today. The rules are a TypeScript copy of
 * bell-suite/contracts/v1/reference.mjs; there is deliberately no import across repos.
 * A rule change goes into both, together with a new contract version.
 *
 * The sibling origins are for <a href> and location navigation only: they never widen
 * the Host/Origin guard, CSP or CORS. Both endpoints sit behind the same guard as every
 * other API, and the today feed carries only titles, counts and object references.
 */
import { Router } from "express";
import type { ReviewSummary } from "../shared/learning.js";
import type { Lesson } from "../shared/types.js";
import type { StoredLesson } from "../shared/lesson-v3.js";
import { AppError } from "./errors.js";
import type { LearningStore } from "./learning.js";
import { logEvent } from "./log.js";
import type { LessonStore } from "./store.js";

export const SUITE_APP_IDS = ["explain", "personal", "pr", "reader", "campaign"] as const;
export type SuiteAppId = (typeof SUITE_APP_IDS)[number];
/** Validated sibling browser origins; Explain never links to itself. */
export type SuiteLinks = Partial<Record<Exclude<SuiteAppId, "explain">, string>>;
const ITEM_STATES = ["due", "new", "waiting", "needs-you"] as const;
const CAPABILITY_KINDS = ["accept-handoff", "today-feed", "object-route"] as const;

export interface SuiteCapability {
  id: string;
  kind: (typeof CAPABILITY_KINDS)[number];
  route?: string;
  api?: string;
  accepts?: ["text"];
  maxChars?: number;
}
export interface SuiteManifest {
  schemaVersion: 1;
  appId: SuiteAppId;
  displayName: string;
  summary: string;
  capabilities: SuiteCapability[];
  links: SuiteLinks;
}
export interface SuiteTodayItem {
  sourceApp: SuiteAppId;
  type: string;
  id: string;
  title: string;
  href: string;
  state: (typeof ITEM_STATES)[number];
  updatedAt: string;
  dueAt?: string;
  detail?: string;
}
export interface SuiteTodayFeed {
  schemaVersion: 1;
  appId: SuiteAppId;
  generatedAt: string;
  counts: Record<string, number>;
  items: SuiteTodayItem[];
  truncated: boolean;
}

export const SUITE_LIMITS = {
  title: 120, detail: 80, href: 512, items: 5, counts: 8, countMax: 100_000,
  capabilities: 16, displayName: 40, summary: 40, links: 5, handoffText: 2000,
} as const;

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const OBJECT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const OBJECT_TYPE = /^[a-z][a-z0-9-]{0,31}$/;
const COUNT_KEY = /^[a-z][A-Za-z0-9]{0,31}$/;
const CAPABILITY_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const HREF = /^#\/[A-Za-z0-9/_\-.~%:]*(?:\?[A-Za-z0-9_\-.~%=&+]*)?$/;
const ROUTE_TEMPLATE = /^#\/[A-Za-z0-9/_\-.~{}]*$/;
const API_PATH = /^\/api\/[A-Za-z0-9/_\-.]+$/;
// C0, DEL, C1, and the bidi embedding/override/isolate controls.
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const UNSAFE_TEXT_ALL = new RegExp(UNSAFE_TEXT.source, "g");
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** A contract violation. The message names a path and a rule, never the offending value. */
export class SuiteContractError extends Error {
  constructor(message: string) { super(message); this.name = "SuiteContractError"; }
}
const fail = (path: string, message: string): never => { throw new SuiteContractError(`${path}: ${message}`); };
const length = (text: string) => [...text].length;
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function onlyKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(path, "unknown key");
}
function plain(value: unknown, path: string, max: number, optional = false) {
  if (value === undefined && optional) return;
  if (typeof value !== "string" || !value.trim()) return fail(path, "must be non-empty text");
  if (length(value) > max) fail(path, `longer than ${max}`);
  if (UNSAFE_TEXT.test(value)) fail(path, "control or bidi character");
}
function iso(value: unknown, path: string, optional = false) {
  if (value === undefined && optional) return;
  if (typeof value !== "string" || !ISO_UTC.test(value) || Number.isNaN(Date.parse(value))) fail(path, "must be ISO UTC");
}

/** A relative hash route inside the app's own origin (item href; also the handoff back rule). */
export function validSuiteHref(value: unknown, max: number = SUITE_LIMITS.href): boolean {
  if (typeof value !== "string" || value.length > max || !HREF.test(value)) return false;
  if (value.includes("//")) return false;
  let decoded: string;
  try { decoded = decodeURIComponent(value.replace(/\+/g, " ")); } catch { return false; }
  return !UNSAFE_TEXT.test(decoded) && !decoded.includes("\\") && !decoded.slice(2).startsWith("/");
}

/**
 * Contract §5.1 (rev. b): the routes each app may name, for a feed item href and
 * a handoff back alike. `{id}` is one raw segment of OBJECT_ID, never `.` or
 * `..`, so `%`, `?` and `/` cannot reach it. PR names none in v1.
 */
export const SUITE_ROUTES: Record<SuiteAppId, readonly string[]> = {
  explain: ["#/", "#/library", "#/graph", "#/favorites", "#/repositories", "#/review", "#/note/{id}"],
  personal: ["#/today", "#/tasks", "#/tasks/{id}", "#/events", "#/events/{id}", "#/ideas", "#/ideas/{id}", "#/inbox", "#/inbox/{id}"],
  pr: ["#/", "#/home", "#/demo", "#/repos", "#/repos/{id}", "#/discover", "#/team", "#/group", "#/learning", "#/settings", "#/runs/{id}"],
  reader: ["#/", "#/library", "#/topics", "#/page/{id}"],
  campaign: ["#/", "#/schedule", "#/tasks", "#/partners", "#/forms", "#/files", "#/meetings", "#/inspirations", "#/notes", "#/bot"],
};

/** An id that can fill a route's `{id}` as is: OBJECT_ID, and not `.` or `..` (§5.1). */
export function suiteRouteId(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID.test(value) && value !== "." && value !== "..";
}

/** True when `value` passes validSuiteHref and is exactly one of `app`'s allowed routes. */
export function allowedSuiteRoute(app: SuiteAppId, value: unknown, max: number = SUITE_LIMITS.href): value is string {
  if (!validSuiteHref(value, max)) return false;
  const href = value as string;
  return SUITE_ROUTES[app].some(route => {
    const at = route.indexOf("{id}");
    if (at < 0) return href === route;
    return href.startsWith(route.slice(0, at)) && suiteRouteId(href.slice(at));
  });
}

function validateItem(item: unknown, path: string, appId: SuiteAppId) {
  if (!isObject(item)) return fail(path, "must be an object");
  onlyKeys(item, path, ["sourceApp", "type", "id", "title", "href", "state", "updatedAt", "dueAt", "detail"]);
  if (item.sourceApp !== appId) fail(`${path}.sourceApp`, "must equal the feed appId");
  if (typeof item.type !== "string" || !OBJECT_TYPE.test(item.type)) fail(`${path}.type`, "invalid");
  if (typeof item.id !== "string" || !OBJECT_ID.test(item.id)) fail(`${path}.id`, "invalid");
  plain(item.title, `${path}.title`, SUITE_LIMITS.title);
  if (!allowedSuiteRoute(appId, item.href)) fail(`${path}.href`, "not one of the app's allowed routes");
  if (!(ITEM_STATES as readonly unknown[]).includes(item.state)) fail(`${path}.state`, "unknown state");
  iso(item.updatedAt, `${path}.updatedAt`);
  iso(item.dueAt, `${path}.dueAt`, true);
  plain(item.detail, `${path}.detail`, SUITE_LIMITS.detail, true);
}

/** Strict: an unknown key or any invalid item makes the whole feed invalid. */
export function validateSuiteFeed(feed: unknown, path = "feed"): SuiteTodayFeed {
  if (!isObject(feed)) return fail(path, "must be an object");
  onlyKeys(feed, path, ["schemaVersion", "appId", "generatedAt", "counts", "items", "truncated"]);
  if (feed.schemaVersion !== 1) fail(`${path}.schemaVersion`, "unsupported version");
  if (!(SUITE_APP_IDS as readonly unknown[]).includes(feed.appId)) fail(`${path}.appId`, "unknown app");
  iso(feed.generatedAt, `${path}.generatedAt`);
  if (!isObject(feed.counts)) return fail(`${path}.counts`, "must be an object");
  const keys = Object.keys(feed.counts);
  if (keys.length > SUITE_LIMITS.counts) fail(`${path}.counts`, "too many counts");
  for (const key of keys) {
    const value = feed.counts[key];
    if (!COUNT_KEY.test(key)) fail(`${path}.counts`, "invalid key");
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > SUITE_LIMITS.countMax) fail(`${path}.counts.${key}`, "must be a non-negative integer");
  }
  if (!Array.isArray(feed.items) || feed.items.length > SUITE_LIMITS.items) return fail(`${path}.items`, `at most ${SUITE_LIMITS.items}`);
  feed.items.forEach((item, index) => validateItem(item, `${path}.items[${index}]`, feed.appId as SuiteAppId));
  if (typeof feed.truncated !== "boolean") fail(`${path}.truncated`, "must be boolean");
  return feed as unknown as SuiteTodayFeed;
}

export function validateSuiteManifest(manifest: unknown, ownOrigins: readonly string[] = []): SuiteManifest {
  const path = "manifest";
  if (!isObject(manifest)) return fail(path, "must be an object");
  onlyKeys(manifest, path, ["schemaVersion", "appId", "displayName", "summary", "capabilities", "links"]);
  if (manifest.schemaVersion !== 1) fail(`${path}.schemaVersion`, "unsupported version");
  if (!(SUITE_APP_IDS as readonly unknown[]).includes(manifest.appId)) fail(`${path}.appId`, "unknown app");
  plain(manifest.displayName, `${path}.displayName`, SUITE_LIMITS.displayName);
  plain(manifest.summary, `${path}.summary`, SUITE_LIMITS.summary);
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length > SUITE_LIMITS.capabilities) return fail(`${path}.capabilities`, "invalid list");
  const ids = new Set<string>();
  manifest.capabilities.forEach((capability: unknown, index: number) => {
    const at = `${path}.capabilities[${index}]`;
    if (!isObject(capability)) return fail(at, "must be an object");
    onlyKeys(capability, at, ["id", "kind", "route", "api", "accepts", "maxChars"]);
    if (typeof capability.id !== "string" || !CAPABILITY_ID.test(capability.id) || ids.has(capability.id)) return fail(`${at}.id`, "invalid or duplicate");
    ids.add(capability.id);
    if (!(CAPABILITY_KINDS as readonly unknown[]).includes(capability.kind)) fail(`${at}.kind`, "unknown kind");
    if (capability.route !== undefined && (typeof capability.route !== "string" || !ROUTE_TEMPLATE.test(capability.route) || capability.route.includes("//"))) fail(`${at}.route`, "invalid");
    if (capability.api !== undefined && (typeof capability.api !== "string" || !API_PATH.test(capability.api) || capability.api.includes("//") || capability.api.includes(".."))) fail(`${at}.api`, "invalid");
    if (capability.kind === "accept-handoff") {
      if (!capability.route || !Array.isArray(capability.accepts) || !capability.accepts.length || capability.accepts.some(value => value !== "text")) fail(at, "accept-handoff needs route and accepts:[\"text\"]");
      if (!Number.isSafeInteger(capability.maxChars) || (capability.maxChars as number) < 1 || (capability.maxChars as number) > SUITE_LIMITS.handoffText) fail(`${at}.maxChars`, "1–2000");
    } else if (capability.accepts !== undefined || capability.maxChars !== undefined) fail(at, "accepts/maxChars only for accept-handoff");
    if (capability.kind === "today-feed" && (!capability.api || capability.route)) fail(at, "today-feed needs api only");
    if (capability.kind === "object-route" && (!capability.route || capability.api)) fail(at, "object-route needs route only");
  });
  if (!isObject(manifest.links)) return fail(`${path}.links`, "must be an object");
  for (const [appId, origin] of Object.entries(manifest.links)) {
    if (!(SUITE_APP_IDS as readonly string[]).includes(appId) || appId === manifest.appId) fail(`${path}.links`, "invalid app");
    suiteBrowserOrigin(origin, ownOrigins, `${path}.links.${appId}`);
  }
  return manifest as unknown as SuiteManifest;
}

// ── Configuration: BELL_SUITE_LINKS ────────────────────────────────────────

function loopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (bare === "::1" || bare === "localhost") return true;
  const parts = bare.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** The MagicDNS tailnet of a `<host>.<tailnet>.ts.net` name (its last three labels). */
function tailnetOf(hostname: string): string | undefined {
  const labels = hostname.toLowerCase().split(".");
  return labels.length >= 4 && labels.at(-1) === "net" && labels.at(-2) === "ts" ? labels.slice(-3).join(".") : undefined;
}
// Messages name the setting and the rule but never echo the value, which may hold credentials.
const NOT_EXACT = "必須是完整的 origin，不可包含帳號密碼、路徑（含結尾 /）、查詢、fragment、萬用字元或 port 0。";
function exactOrigin(value: unknown, label: string): URL {
  if (typeof value !== "string" || !/^https?:\/\/[^/?#\\\s@*]+$/i.test(value) || value.endsWith(":")) throw new SuiteContractError(`${label} ${NOT_EXACT}`);
  let url: URL;
  try { url = new URL(value); } catch { throw new SuiteContractError(`${label} ${NOT_EXACT}`); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.port === "0") throw new SuiteContractError(`${label} ${NOT_EXACT}`);
  return url;
}

/**
 * A sibling's browser origin: loopback (http or https), or https on a MagicDNS name in
 * the same tailnet as one of Explain's own allowed origins. Any other https host is refused.
 */
export function suiteBrowserOrigin(value: unknown, ownOrigins: readonly string[], label: string): string {
  const url = exactOrigin(value, label);
  if (loopbackHostname(url.hostname)) return url.origin;
  if (url.protocol !== "https:") throw new SuiteContractError(`${label} 不是本機位址時必須使用 https。`);
  const tailnet = tailnetOf(url.hostname);
  const own = new Set(ownOrigins.map(origin => { try { return tailnetOf(new URL(origin).hostname); } catch { return undefined; } }).filter(Boolean));
  if (!tailnet || !own.has(tailnet)) throw new SuiteContractError(`${label} 只接受與 BELL_ALLOWED_ORIGINS 同一個 tailnet 的 *.ts.net 名稱。`);
  return url.origin;
}

/** BELL_SUITE_LINKS → { appId: origin }, for personal and pr only. Throws during startup. */
export function parseSuiteLinks(value: string | undefined, ownOrigins: readonly string[], variable = "BELL_SUITE_LINKS"): SuiteLinks {
  const text = (value ?? "").trim();
  const links: SuiteLinks = {};
  if (!text) return links;
  const list = text.split(",").map(part => part.trim());
  if (list.length > SUITE_LIMITS.links) throw new SuiteContractError(`${variable} 最多可設定 ${SUITE_LIMITS.links} 筆。`);
  for (const part of list) {
    const match = /^([a-z]+)=(.+)$/.exec(part);
    if (!match) throw new SuiteContractError(`${variable} 每一筆必須是 appId=origin，以逗號分隔。`);
    const appId = match[1];
    if (appId !== "personal" && appId !== "pr" && appId !== "reader" && appId !== "campaign") throw new SuiteContractError(`${variable} 只接受 personal、pr、reader 或 campaign，不可指向 BELL Explain 自己或未知的 app。`);
    if (links[appId]) throw new SuiteContractError(`${variable} 不可重複設定 ${appId}。`);
    links[appId] = suiteBrowserOrigin(match[2], ownOrigins, `${variable} 的 ${appId}`);
  }
  return links;
}

// ── Manifest and today feed ─────────────────────────────────────────────────

export function suiteManifest(links: SuiteLinks): SuiteManifest {
  return {
    schemaVersion: 1,
    appId: "explain",
    displayName: "BELL Explain",
    summary: "理解與複習",
    capabilities: [
      { id: "explain.draft", kind: "accept-handoff", route: "#/explain", accepts: ["text"], maxChars: SUITE_LIMITS.handoffText },
      { id: "review.today", kind: "today-feed", api: "/api/suite/today" },
      { id: "review.open", kind: "object-route", route: "#/review" },
      { id: "note.open", kind: "object-route", route: "#/note/{id}" },
    ],
    links: { ...links },
  };
}

/**
 * Plain one-line text: line breaks and other whitespace become one space, C0/C1/DEL and
 * bidi controls go, and the result is clipped to `max` code points.
 */
export function cleanSuiteTitle(value: unknown, max: number = SUITE_LIMITS.title, fallback = "未命名課程"): string {
  const text = (typeof value === "string" ? value : "")
    .replace(LONE_SURROGATE, "�")
    .replace(/[\s\u0085]+/g, " ")
    .replace(UNSAFE_TEXT_ALL, "")
    .replace(/ {2,}/g, " ")
    .trim();
  return [...text].slice(0, max).join("").trim() || fallback;
}
/** The first parseable timestamp, as ISO UTC with a Z. */
function isoUtc(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    const text = new Date(time).toISOString();
    if (ISO_UTC.test(text)) return text;
  }
  return undefined;
}
const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) > 0 ? Math.min(value as number, SUITE_LIMITS.countMax) : 0);

export interface TodayFeedInput {
  lessons: readonly StoredLesson[];
  summary: ReviewSummary;
  now: Date;
  /** Ids of the built-in examples, excluded even if a copy lost its isDemo mark. */
  exampleIds?: ReadonlySet<string>;
}

/**
 * Today's review queue and the most recently updated own notes. Data minimisation: only
 * counts, ids, titles and times leave; never answers, hints, key points, note text,
 * sources, documents or file names.
 */
export function buildTodayFeed({ lessons, summary, now, exampleIds = new Set() }: TodayFeedInput): SuiteTodayFeed {
  const generatedAt = now.toISOString();
  const counts = { due: count(summary.due), newAvailable: count(summary.newAvailable), reviewedToday: count(summary.reviewedToday) };
  const detail = [counts.due ? `${counts.due} 張到期` : "", counts.newAvailable ? `${counts.newAvailable} 張新卡` : ""].filter(Boolean).join(" · ") || "今天沒有到期的複習";
  const queue: SuiteTodayItem = {
    sourceApp: "explain", type: "review-queue", id: "today", title: "今日複習", href: "#/review",
    state: counts.due ? "due" : counts.newAvailable ? "new" : "waiting", updatedAt: generatedAt, detail,
  };
  const own = lessons
    // A note whose id cannot fill #/note/{id} is left out: the sender never encodes an id,
    // and one such note must not make the whole feed invalid.
    .filter(lesson => !lesson.isDemo && !exampleIds.has(lesson.id) && suiteRouteId(lesson.id))
    .flatMap(lesson => {
      const updatedAt = isoUtc(lesson.updatedAt, lesson.createdAt);
      return updatedAt ? [{ id: lesson.id, title: lesson.title, updatedAt }] : [];
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const shown = own.slice(0, SUITE_LIMITS.items - 1);
  return {
    schemaVersion: 1,
    appId: "explain",
    generatedAt,
    counts,
    items: [queue, ...shown.map((lesson): SuiteTodayItem => ({
      sourceApp: "explain", type: "lesson", id: lesson.id, title: cleanSuiteTitle(lesson.title),
      // Contract §5.1: the raw id (suiteRouteId, filtered above); the note page's decode leaves it as is.
      href: `#/note/${lesson.id}`, state: "waiting", updatedAt: lesson.updatedAt,
    }))],
    truncated: own.length > shown.length,
  };
}

export interface SuiteRouterOptions {
  store: LessonStore;
  learning?: LearningStore;
  examples: readonly Lesson[];
  links?: SuiteLinks;
  /** Explain's own allowed origins: a tailnet link must share their tailnet. */
  allowedOrigins?: readonly string[];
  now?: () => Date;
}

/** Mounted at /api/suite after the Host/Origin/Sec-Fetch-Site guard; read-only views. */
export function createSuiteRouter(options: SuiteRouterOptions): Router {
  // Built and checked once: a bad link stops startup instead of reaching a browser.
  const manifest = Object.freeze(validateSuiteManifest(suiteManifest(options.links ?? {}), options.allowedOrigins ?? []));
  const exampleIds = new Set(options.examples.map(lesson => lesson.id));
  const router = Router();
  router.get("/manifest", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(manifest);
  });
  router.get("/today", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const { learning } = options;
    if (!learning) throw new AppError(503, "學習紀錄尚未啟用。");
    let feed: SuiteTodayFeed;
    try {
      const now = options.now?.() ?? new Date();
      // A sibling's read changes nothing: peekSummary() counts the cards sync would leave,
      // never summary() (it creates and deletes cards) or due() (it introduces new ones).
      // Strict, as for the review router: a skipped unreadable note would drop its cards.
      const lessons = options.store.listRaw({ strict: true });
      feed = validateSuiteFeed(buildTodayFeed({ lessons, summary: learning.peekSummary(lessons, now), now, exampleIds }));
    } catch (error) {
      logEvent("suite.today.failed", { errorClass: error instanceof Error ? error.name : typeof error, ...(error instanceof SuiteContractError ? { rule: error.message } : {}) });
      if (error instanceof AppError) throw error;
      throw new AppError(500, "今日複習摘要暫時無法產生，請稍後再試。");
    }
    res.json(feed);
  });
  // Minimized topic directory for BELL Web Reader: titles, tags and object refs only (no answers, hints or bodies).
  router.get("/topics", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const lessons = options.store.listRaw();
    const topics = lessons
      .filter(lesson => !lesson.isDemo && !exampleIds.has(lesson.id) && suiteRouteId(lesson.id))
      .map(lesson => ({
        id: lesson.id,
        title: cleanSuiteTitle(lesson.title),
        ...(lesson.category ? { category: cleanSuiteTitle(lesson.category, 40) } : {}),
        tags: (lesson.tags ?? []).slice(0, 8).map(tag => cleanSuiteTitle(tag, 40)),
        href: `#/note/${lesson.id}`,
      }));
    res.json({ schemaVersion: 1, appId: "explain", topics });
  });
  return router;
}
