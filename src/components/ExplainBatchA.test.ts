import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { exampleLessons } from "../../shared/examples.js";
import type { LessonNoteV3, LessonV3, StoredLesson } from "../../shared/lesson-v3.js";
import { markdownRelations, type RelatedNote } from "../lib/related-notes.js";
import { fill, learningCopy } from "../copy/learning.js";

if (Number(process.versions.node.split(".")[0]) >= 24) {
  registerHooks({ load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); } });
} else {
  register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  }`)}`);
}

const bootstrap = new Window({ url: "http://127.0.0.1:21115" });
for (const [key, value] of Object.entries({ window: bootstrap, document: bootstrap.document })) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
test.after(async () => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
  await bootstrap.happyDOM.close();
});

const { api } = await import("../lib/api.js");
const { default: App } = await import("../App.js");
const { default: Sheet } = await import("../ui/Sheet.js");
const { MotionGlobalConfig } = await import("motion/react");
MotionGlobalConfig.skipAnimations = true;
const { default: LessonV3Reader } = await import("./learning/LessonV3Reader.js");
const localized = JSON.parse(readFileSync(new URL("../../server/fixtures/closure-lesson.json", import.meta.url), "utf8")) as Record<"zh-TW" | "en", LessonV3>;
const generated = localized["zh-TW"];
const v3: LessonNoteV3 = {
  ...generated, id: "synced-v3", category: "JavaScript", tags: ["閉包"],
  source: { kind: "code", label: generated.source.label, content: "const count = 0;" },
  connections: [], createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z", isDemo: false, favorite: false,
};
const mixed: StoredLesson[] = [exampleLessons[0], v3];

function v3Page(t: TestContext, locale: "zh-TW" | "en") {
  const page = new Window({ url: `http://127.0.0.1/${locale === "en" ? "?lang=en" : ""}` });
  const globals: Record<string, unknown> = { window: page, document: page.document, localStorage: page.localStorage };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const html = renderToStaticMarkup(createElement(LessonV3Reader, {
    lesson: v3, lessons: [v3], jump: 0, open() {}, favorite() {}, remove() {}, followUp() {}, notify() {},
    personalAvailable: false, sendToPersonal() {}, onLessonChange() {}, toggleTheme() {},
  }));
  for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as Record<string, unknown>)[key];
  page.document.write(html);
  t.after(async () => page.happyDOM.close());
  return page;
}

async function waitFor(check: () => void) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { check(); return; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    }
  }
}

async function mount(t: TestContext, hash: string, lessons: StoredLesson[] = mixed) {
  const window = new Window({ url: `http://127.0.0.1:21115/${hash}` });
  const globals: Record<string, unknown> = {
    window, document: window.document, localStorage: window.localStorage, sessionStorage: window.sessionStorage,
    navigator: window.navigator, self: window, Element: window.Element, HTMLElement: window.HTMLElement,
    Node: window.Node, NodeFilter: window.NodeFilter, Event: window.Event, CustomEvent: window.CustomEvent,
    KeyboardEvent: window.KeyboardEvent, MouseEvent: window.MouseEvent, MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver, IntersectionObserver: window.IntersectionObserver, IS_REACT_ACT_ENVIRONMENT: true,
    getComputedStyle: window.getComputedStyle.bind(window), matchMedia: window.matchMedia.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.mock.method(globalThis, "setInterval", ((callback: () => void) => 1) as typeof setInterval);
  t.mock.method(api, "lessons", async () => lessons);
  t.mock.method(api, "suiteManifest", async () => ({ schemaVersion: 1, appId: "explain", displayName: "BELL Explain", summary: "學習", links: {} }));
  t.mock.method(api, "config", async () => ({ configured: false, model: "", storage: "SQLite" }));
  t.mock.method(api, "jobs", async () => []);
  t.mock.method(api, "job", async () => null);
  t.mock.method(api, "reviewSummary", async () => ({ due: 0, newAvailable: 0, reviewedToday: 0, total: 0 }));
  t.mock.method(api, "reviewDue", async () => []);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.body.appendChild(window.document.createElement("div")) as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) descriptor ? Object.defineProperty(globalThis, key, descriptor) : delete (globalThis as Record<string, unknown>)[key];
    await window.happyDOM.close();
  });
  await act(async () => { root.render(createElement(App)); });
  return window;
}

test("Batch A copy matches Muse and English strings contain no CJK", () => {
  const raw = readFileSync(new URL("../copy/ui-strings.json", import.meta.url), "utf8");
  const copy = JSON.parse(raw);
  assert.equal(copy.lesson.rail.wrapUpItem.en, "Wrap-up");
  assert.equal(copy.lesson.rail.followUpsItem.en, "Go further");
  assert.equal(copy.lesson.rail.endRegionAria.en, "Wrap-up and follow-ups");
  assert.equal(copy.lesson.rail.endRegionLegacyAria.en, "Follow-ups and source");
  assert.equal(copy.lesson.moreMenu.sendToPersonalUnavailableHint.en, "Not linked");
  assert.equal(copy.lesson.topbar.sendToPersonalDisabledAria.en, "Send to Personal, not linked");
  assert.equal(copy.wrapUp.selfCheck.heading.en, "Go further");
  assert.doesNotMatch(raw, /點子/);
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (key === "en" && typeof entry === "string") assert.doesNotMatch(entry, /[\u3400-\u9fff]/);
        else visit(entry);
      }
    }
  };
  visit(copy);
});

test("XL-05 aligns the v3 TOC, heading, and end-region label in both locales", t => {
  for (const [locale, wrapUp, region] of [["zh-TW", "整理", "整理與延伸"], ["en", "Wrap-up", "Wrap-up and follow-ups"]] as const) {
    const page = v3Page(t, locale);
    const tocItems = page.document.querySelectorAll(".reader-toc button");
    assert.equal(tocItems[tocItems.length - 1]?.textContent, wrapUp);
    assert.equal(page.document.querySelector(".v3-wrap-up h2")?.textContent, wrapUp);
    assert.equal(page.document.querySelector("#reader-end")?.getAttribute("aria-label"), region);
  }
});

test("XL-05 and XL-07 align legacy labels and explain the disabled Personal action", async t => {
  const window = await mount(t, "?lang=en#/note/demo-closure");
  await waitFor(() => assert.equal(window.document.querySelector("#self-check-title")?.textContent, "Go further"));
  const tocItems = window.document.querySelectorAll(".reader-toc button");
  assert.equal(tocItems[tocItems.length - 1]?.textContent, "Go further");
  assert.equal(window.document.querySelector("#reader-end")?.getAttribute("aria-label"), "Follow-ups and source");
  const action = window.document.querySelector(".reader-more-personal");
  assert.equal(action?.getAttribute("aria-label"), "Send to Personal, not linked");
  assert.equal(action?.querySelector(".reader-more-hint")?.textContent, "Not linked");
  assert.equal(action?.hasAttribute("disabled"), true);
  assert.equal(window.document.querySelector(".send-personal-button")?.getAttribute("title"), "BELL Personal isn't connected yet");
});

test("XL-05 omits the legacy follow-up TOC row when there are no questions", async t => {
  const window = await mount(t, "#/note/demo-closure", [{ ...exampleLessons[0], followUpQuestions: [] }]);
  await waitFor(() => assert.ok(window.document.querySelector(".reader-toc")));
  assert.doesNotMatch(window.document.querySelector(".reader-toc")?.textContent || "", /延伸問題|整理/);
  assert.equal(window.document.querySelector("#self-check-title"), null);
});

test("XL-07 shows the finalized disabled hint and accessible name in the v3 menu", t => {
  for (const [locale, label, hint, tooltip] of [
    ["zh-TW", "送到 Personal，尚未連結", "尚未連結", "尚未連結 BELL Personal"],
    ["en", "Send to Personal, not linked", "Not linked", "BELL Personal isn't connected yet"],
  ] as const) {
    const page = v3Page(t, locale);
    const action = page.document.querySelector(".reader-more-personal");
    assert.equal(action?.getAttribute("aria-label"), label);
    assert.equal(action?.querySelector(".reader-more-hint")?.textContent, hint);
    assert.equal(action?.hasAttribute("disabled"), true);
    assert.equal(page.document.querySelector(".send-personal-button")?.getAttribute("title"), tooltip);
  }
});

test("XL-21 applies the material blur to the shared sheet and popover surface", () => {
  const css = readFileSync(new URL("../precise-legacy.css", import.meta.url), "utf8");
  assert.match(css, /\.reader-more-menu\s*\{[^}]*backdrop-filter: blur\(20px\) saturate\(1\.2\); -webkit-backdrop-filter: blur\(20px\) saturate\(1\.2\);/);
  assert.match(css, /\.reader-more-menu \.reader-more-hint\s*\{[^}]*font-size: var\(--text-ui\);/);
});

test("Muse reader toolbar, overflow menu, and delete dialog contain no CJK in English", async t => {
  const page = v3Page(t, "en");
  assert.doesNotMatch(page.document.querySelector(".reader-actions")?.outerHTML || "", /[\u3400-\u9fff]/);
  assert.doesNotMatch(page.document.querySelector(".reader-more-menu")?.outerHTML || "", /[\u3400-\u9fff]/);
  assert.equal(page.document.querySelector(".predict-toggle")?.getAttribute("title"), "Hide the next step and answers so you can guess before checking");
  assert.equal(page.document.querySelector(".reader-original-button")?.textContent, "Original source");

  const window = await mount(t, "?lang=en#/note/demo-closure");
  await waitFor(() => assert.ok(window.document.querySelector(".reader-actions")));
  assert.doesNotMatch(window.document.querySelector(".reader-actions")?.outerHTML || "", /[\u3400-\u9fff]/);
  assert.equal(window.document.querySelector(".predict-toggle")?.getAttribute("title"), "Hide example results and animation steps so you can predict before checking");
  const deleteButton = Array.from(window.document.querySelectorAll(".reader-more-menu button")).find(button => button.textContent === "Delete lesson");
  assert.ok(deleteButton);
  const copy = learningCopy().lesson.deleteDialog;
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.body.appendChild(window.document.createElement("div")) as unknown as Element);
  await act(async () => {
    root.render(createElement(Sheet, {
      open: true, onOpenChange() {}, title: copy.title, closeLabel: copy.keep,
      children: createElement("div", { className: "delete-content" },
        createElement("p", null, fill(copy.body, { title: "Closure" })),
        createElement("div", null,
          createElement("button", null, copy.keep),
          createElement("button", null, copy.confirm))),
    }));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  await waitFor(() => assert.ok(window.document.querySelector(".delete-content"), window.document.body.textContent));
  const dialog = window.document.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.doesNotMatch(dialog.outerHTML, /[\u3400-\u9fff]/);
  assert.match(dialog.textContent || "", /Delete this lesson\?/);
  assert.equal(dialog.querySelector(".p-sheet-heading button")?.getAttribute("aria-label"), "Keep");
  await act(async () => root.unmount());
});

test("Markdown export uses Muse relation labels and punctuation in English", () => {
  const copy = JSON.parse(readFileSync(new URL("../copy/ui-strings.json", import.meta.url), "utf8"));
  const items: RelatedNote[] = [
    { lessonId: "a", title: "A", reason: "Reason A", kind: "links-to" },
    { lessonId: "b", title: "B", reason: "Reason B", kind: "linked-from" },
    { lessonId: "c", title: "C", reason: "Reason C", kind: "continues" },
    { lessonId: "d", title: "D", section: "Next step", reason: "Reason D", kind: "continued-by" },
  ];
  const relationCopy = {
    linksTo: copy.lesson.exportRelations.linksTo.en,
    linkedFrom: copy.lesson.exportRelations.linkedFrom.en,
    continues: copy.lesson.exportRelations.continues.en,
    continuedBy: copy.lesson.exportRelations.continuedBy.en,
    sectionReasonJoin: copy.lesson.exportRelations.sectionReasonJoin.en,
  };
  const exported = markdownRelations(items, relationCopy);
  assert.deepEqual(exported.map(item => item.label), ["Links to", "Linked from", "Builds on", "Extended by"]);
  assert.equal(exported[3].reason, "Next step; Reason D");
  assert.doesNotMatch(JSON.stringify(exported), /[\u3400-\u9fff]/);
});
