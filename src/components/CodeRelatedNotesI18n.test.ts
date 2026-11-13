import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { act, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { exampleLessons } from "../../shared/examples.js";
import type { Lesson } from "../../shared/types.js";
import type { RelatedNote } from "../lib/related-notes.js";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor >= 24 || (nodeMajor === 22 && nodeMinor >= 23)) {
  registerHooks({
    load(url, context, next) {
      if (/\.css(\?|$)/.test(url)) return { format: "module", source: "", shortCircuit: true };
      return next(url, context);
    },
  });
} else {
  register(`data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, next) {
      if (/\\.css(\\?|$)/.test(url)) return { format: "module", source: "", shortCircuit: true };
      return next(url, context);
    }
  `)}`);
}

const {
  codeBlockCopy,
  formatCodeRegionAria,
  formatRelationLabel,
  formatRelationTooltip,
  formatShowRemaining,
  localizeRelationReason,
  localizeRelationSection,
  relatedNotesCopy,
  resolveCodeRelatedNotesLocale,
} = await import("../copy/code-related-notes.js");
const { default: CodeBlock } = await import("./CodeBlock.js");
const { default: RelatedNotes } = await import("./RelatedNotes.js");
const { RELATION_LABELS, relatedNotes } = await import("../lib/related-notes.js");

const canonicalZhTw = {
  codeBlock: {
    copyCode: "複製程式碼",
    defaultLanguage: "程式碼",
    regionAria: "{language} 程式碼",
    highlightRegionAria: "{language}，目前重點為第 {startLine} 至 {endLine} 行",
    copyFallback: "請選取程式碼手動複製。",
  },
  relatedNotes: {
    heading: "相關筆記",
    collapse: "收起",
    showRemaining: "顯示其餘 {count} 項關聯",
    showRemainingOne: "顯示其餘 {count} 項關聯",
    labels: {
      linksTo: "延伸閱讀",
      linkedFrom: "被引用",
      continues: "延伸自",
      continuedBy: "延伸出",
    },
    reasons: {
      continues: "這篇是讀完它之後的延伸問題。",
      continuedBy: "從這篇的追問延伸出來。",
    },
    sectionBacklink: "關聯到本篇「{section}」",
  },
};

type SpecBundle = {
  $meta: {
    placeholders: Record<string, string>;
    budgets: {
      collapseEnMaxChars: number;
      showRemainingTemplateEnMaxChars: number;
      relationLabelEnMaxChars: number;
      copyFallbackEnMaxChars: number;
    };
  };
  "zh-TW": typeof canonicalZhTw;
  en: typeof canonicalZhTw;
};

const strings = JSON.parse(
  readFileSync(new URL("../copy/code-related-notes-strings.json", import.meta.url), "utf8"),
) as SpecBundle;

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
}

function flattenStrings(value: unknown, prefix = ""): Array<[string, string]> {
  if (typeof value === "string") return [[prefix, value]];
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) =>
    flattenStrings(child, prefix ? `${prefix}.${key}` : key),
  );
}

function assertDecorativeSvgs(root: ParentNode) {
  const svgs = [...root.querySelectorAll("svg")];
  assert.ok(svgs.length > 0, "expected at least one decorative svg");
  for (const svg of svgs) {
    assert.equal(svg.getAttribute("aria-hidden"), "true");
  }
}

function assertZeroCjkOnSubtree(root: Element) {
  assert.doesNotMatch(root.textContent ?? "", CJK_RE);
  for (const element of [root, ...root.querySelectorAll("*")]) {
    for (const attr of ["aria-label", "title", "placeholder"]) {
      const value = element.getAttribute(attr);
      if (value) assert.doesNotMatch(value, CJK_RE, `${element.tagName}[${attr}]="${value}"`);
    }
  }
}

async function mountNode(
  t: TestContext,
  options: {
    url?: string;
    htmlLang?: string;
    clipboardWriteText?: ((text: string) => Promise<void>) | null;
    execCommandCopy?: boolean;
  },
  render: () => ReactNode,
) {
  const window = new Window({ url: options.url ?? "http://127.0.0.1/" });
  if (options.htmlLang !== undefined) window.document.documentElement.lang = options.htmlLang;
  if (options.clipboardWriteText !== undefined) {
    Object.defineProperty(window.navigator, "clipboard", {
      value: options.clipboardWriteText ? { writeText: options.clipboardWriteText } : undefined,
      configurable: true,
    });
  }
  if (options.execCommandCopy !== undefined) {
    Object.defineProperty(window.document, "execCommand", {
      value: () => options.execCommandCopy,
      configurable: true,
    });
  }
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    Element: window.Element,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    KeyboardEvent: window.KeyboardEvent,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const container = window.document.body.appendChild(window.document.createElement("div"));
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    await window.happyDOM.close();
  });
  await act(async () => {
    root.render(render());
  });
  return { window, document: window.document as unknown as Document };
}

function makeLesson(
  id: string,
  title: string,
  options: {
    parentLessonId?: string;
    sections?: Array<{ id: string; heading: string }>;
    connections?: Array<{ targetId: string; sectionId: string; reason: string }>;
  } = {},
): Lesson {
  const base = structuredClone(exampleLessons[0]);
  return {
    ...base,
    id,
    title,
    isDemo: false,
    parentLessonId: options.parentLessonId,
    sections: (options.sections ?? [{ id: "s1", heading: "1. Core concept" }]).map(section => ({
      ...base.sections[0],
      id: section.id,
      heading: section.heading,
    })),
    connections: options.connections ?? [],
  };
}

function sampleRelations() {
  const parent = makeLesson("parent", "Event Loop Basics");
  const target = makeLesson("target", "Microtask Queue", {
    sections: [{ id: "t1", heading: "2. Drain order" }],
  });
  const current = makeLesson("current", "Async Scheduling", {
    parentLessonId: "parent",
    sections: [{ id: "c1", heading: "1. Promise callbacks" }],
    connections: [{ targetId: "target", sectionId: "t1", reason: "Explains microtask priority." }],
  });
  const child = makeLesson("child", "Starvation Edge Cases", {
    parentLessonId: "current",
  });
  const inboundWithSection = makeLesson("inbound-sec", "Timers vs Promises", {
    connections: [{ targetId: "current", sectionId: "c1", reason: "Compares callback queues." }],
  });
  const extraItems: RelatedNote[] = Array.from({ length: 5 }, (_, index) => ({
    lessonId: `extra-${index + 1}`,
    title: `Extra Note ${index + 1}`,
    reason: "Related concept.",
    kind: "links-to",
  }));
  const computed = relatedNotes(current, [parent, target, current, child, inboundWithSection]);
  return { computed, nineItems: [...computed, ...extraItems] };
}

test("all 16 leaf keys and placeholders match 11f680bb with 0 English CJK and within budgets", () => {
  assert.deepEqual(strings["zh-TW"], canonicalZhTw);
  assert.deepEqual(strings["zh-TW"].relatedNotes.labels, {
    linksTo: RELATION_LABELS["links-to"],
    linkedFrom: RELATION_LABELS["linked-from"],
    continues: RELATION_LABELS.continues,
    continuedBy: RELATION_LABELS["continued-by"],
  });

  const zhEntries = flattenStrings(strings["zh-TW"]);
  const enEntries = flattenStrings(strings.en);
  assert.equal(zhEntries.length, 16);
  assert.deepEqual(
    enEntries.map(([key]) => key),
    zhEntries.map(([key]) => key),
  );

  const enMap = new Map(enEntries);
  const seenPlaceholders = new Set<string>();
  for (const [key, zhVal] of zhEntries) {
    const enVal = enMap.get(key);
    assert.ok(enVal !== undefined, `missing en key ${key}`);
    assert.deepEqual(placeholders(enVal), placeholders(zhVal), `placeholder mismatch at ${key}`);
    for (const token of placeholders(zhVal)) seenPlaceholders.add(token);
    assert.doesNotMatch(enVal, CJK_RE, `en.${key} contains CJK`);
    assert.doesNotMatch(zhVal, /點子/, `zh-TW.${key} contains banned term`);
  }
  assert.deepEqual([...seenPlaceholders].sort(), Object.keys(strings.$meta.placeholders).sort());

  const { budgets } = strings.$meta;
  assert.ok(strings.en.relatedNotes.collapse.length <= budgets.collapseEnMaxChars);
  assert.ok(strings.en.relatedNotes.showRemaining.length <= budgets.showRemainingTemplateEnMaxChars);
  assert.ok(strings.en.relatedNotes.showRemainingOne.length <= budgets.showRemainingTemplateEnMaxChars);
  assert.ok(strings.en.codeBlock.copyFallback.length <= budgets.copyFallbackEnMaxChars);
  for (const [labelKey, labelValue] of Object.entries(strings.en.relatedNotes.labels)) {
    assert.ok(labelValue.length <= budgets.relationLabelEnMaxChars, `en.relatedNotes.labels.${labelKey}`);
  }
});

test("CodeBlock.tsx, RelatedNotes.tsx, and code-related-notes.ts contain zero hardcoded CJK", () => {
  for (const relPath of ["./CodeBlock.tsx", "./RelatedNotes.tsx", "../copy/code-related-notes.ts"]) {
    const source = readFileSync(new URL(relPath, import.meta.url), "utf8");
    assert.doesNotMatch(source, CJK_RE, `${relPath} contains hardcoded CJK`);
  }
});

test("SSR fallback defaults to zh-TW when window is undefined", () => {
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(resolveCodeRelatedNotesLocale(), "zh-TW");

  const codeMarkup = renderToStaticMarkup(
    createElement(CodeBlock, { code: "const x = 1;", language: "javascript" }),
  );
  assert.match(codeMarkup, /aria-label="複製程式碼"/);
  assert.match(codeMarkup, /aria-label="javascript 程式碼"/);
  assert.match(codeMarkup, /type="button"/);

  const notesMarkup = renderToStaticMarkup(
    createElement(RelatedNotes, {
      open: () => {},
      items: [{ lessonId: "n1", title: "Closures", reason: "Follow-up", kind: "links-to" }],
    }),
  );
  assert.match(notesMarkup, /aria-label="相關筆記"/);
  assert.match(notesMarkup, /title="延伸閱讀 · Follow-up"/);
});

test("resolveCodeRelatedNotesLocale honors ?lang=en, ?lang=zh-TW, and html[lang]", async t => {
  const { window } = await mountNode(t, { url: "http://127.0.0.1/?lang=en" }, () => null);
  assert.equal(resolveCodeRelatedNotesLocale(), "en");

  window.happyDOM.setURL("http://127.0.0.1/?lang=zh-TW");
  window.document.documentElement.lang = "en";
  assert.equal(resolveCodeRelatedNotesLocale(), "zh-TW");

  window.happyDOM.setURL("http://127.0.0.1/");
  window.document.documentElement.lang = "en-US";
  assert.equal(resolveCodeRelatedNotesLocale(), "en");

  window.document.documentElement.lang = "";
  assert.equal(resolveCodeRelatedNotesLocale(), "zh-TW");
});

test("formatCodeRegionAria avoids 'Code code' in English while preserving exact shipped zh-TW strings", () => {
  assert.equal(formatCodeRegionAria("javascript", undefined, "zh-TW"), "javascript 程式碼");
  assert.equal(formatCodeRegionAria("", undefined, "zh-TW"), "程式碼 程式碼");
  assert.equal(
    formatCodeRegionAria("python", { startLine: 2, endLine: 5 }, "zh-TW"),
    "python，目前重點為第 2 至 5 行",
  );
  assert.equal(
    formatCodeRegionAria("", { startLine: 2, endLine: 5 }, "zh-TW"),
    "程式碼，目前重點為第 2 至 5 行",
  );

  assert.equal(formatCodeRegionAria("javascript", undefined, "en"), "javascript code");
  assert.equal(formatCodeRegionAria("", undefined, "en"), "Code");
  assert.equal(formatCodeRegionAria("   ", undefined, "en"), "Code");
  assert.equal(
    formatCodeRegionAria("python", { startLine: 2, endLine: 5 }, "en"),
    "python, highlighting lines 2 to 5",
  );
  assert.equal(
    formatCodeRegionAria("", { startLine: 2, endLine: 5 }, "en"),
    "Code, highlighting lines 2 to 5",
  );
});

for (const locale of ["zh-TW", "en"] as const) {
  test(`CodeBlock (${locale}) localizes copy button, landmarks, and empty highlighted language`, async t => {
    const copy = codeBlockCopy(locale);
    let copiedPayload = "";
    const { document } = await mountNode(
      t,
      {
        url: `http://127.0.0.1/?lang=${locale}`,
        clipboardWriteText: async text => {
          copiedPayload = text;
        },
      },
      () =>
        createElement(CodeBlock, {
          code: "const a = 1;\nconst b = 2;\nreturn a + b;",
          language: "",
          highlightRange: { startLine: 2, endLine: 3 },
        }),
    );

    const root = document.querySelector(".code-block")!;
    const button = root.querySelector(".code-header button") as HTMLButtonElement;
    assert.equal(button.getAttribute("type"), "button");
    assert.equal(button.getAttribute("aria-label"), copy.copyCode);
    assert.equal(button.getAttribute("title"), copy.copyCode);
    assert.equal(root.querySelector(".code-header i")?.getAttribute("aria-hidden"), "true");

    const region = root.querySelector('pre[role="region"]')!;
    assert.equal(
      region.getAttribute("aria-label"),
      locale === "en" ? "Code, highlighting lines 2 to 3" : "程式碼，目前重點為第 2 至 3 行",
    );
    assertDecorativeSvgs(root);

    await act(async () => {
      button.click();
    });
    assert.equal(copiedPayload, "const a = 1;\nconst b = 2;\nreturn a + b;");
    assert.equal(root.querySelector(".copy-error"), null);
    assertDecorativeSvgs(root);
    if (locale === "en") assertZeroCjkOnSubtree(root);
  });

  test(`CodeBlock (${locale}) renders role="status" fallback notice when clipboard fails and handles empty non-highlighted language`, async t => {
    const copy = codeBlockCopy(locale);
    const { document } = await mountNode(
      t,
      {
        url: `http://127.0.0.1/?lang=${locale}`,
        clipboardWriteText: null,
        execCommandCopy: false,
      },
      () => createElement(CodeBlock, { code: "x = 42", language: "" }),
    );

    const root = document.querySelector(".code-block")!;
    const region = root.querySelector('pre[role="region"]')!;
    assert.equal(region.getAttribute("aria-label"), locale === "en" ? "Code" : "程式碼 程式碼");

    const button = root.querySelector(".code-header button") as HTMLButtonElement;
    await act(async () => {
      button.click();
    });

    const fallback = root.querySelector('.copy-error[role="status"]');
    assert.ok(fallback);
    assert.equal(fallback.textContent, copy.copyFallback);
    if (locale === "en") assertZeroCjkOnSubtree(root);
  });
}

test("RelatedNotes formatters re-localize relatedNotes() tooltips in English and preserve zh-TW byte-for-byte", () => {
  const { computed } = sampleRelations();
  assert.deepEqual(
    computed.map(item => item.kind),
    ["continues", "links-to", "continued-by", "linked-from"],
  );

  for (const item of computed) {
    const legacyZhTooltip = [RELATION_LABELS[item.kind], item.section, item.reason]
      .filter(Boolean)
      .join(" · ");
    assert.equal(formatRelationTooltip(item, "zh-TW"), legacyZhTooltip);
  }

  assert.equal(
    formatRelationTooltip(computed[0], "en"),
    "Continues from · This note came from a follow-up question after reading that one.",
  );
  assert.equal(
    formatRelationTooltip(computed[1], "en"),
    "Further reading · Drain order · Explains microtask priority.",
  );
  assert.equal(
    formatRelationTooltip(computed[2], "en"),
    "Continued in · Started from a follow-up question on this note.",
  );
  assert.equal(
    formatRelationTooltip(computed[3], "en"),
    "Referenced by · Links to “Promise callbacks” in this note · Compares callback queues.",
  );

  assert.equal(
    localizeRelationSection({ kind: "linked-from", section: "關聯到本篇「Step 「A」」" }, "en"),
    "Links to “Step 「A」” in this note",
  );
  assert.equal(
    localizeRelationReason({ kind: "links-to", reason: canonicalZhTw.relatedNotes.reasons.continues }, "en"),
    canonicalZhTw.relatedNotes.reasons.continues,
  );
  assert.equal(formatRelationLabel("linked-from", "en"), "Referenced by");
  assert.equal(formatShowRemaining(1, "en"), "Show 1 more connection");
  assert.equal(formatShowRemaining(2, "en"), "Show 2 more connections");
  assert.equal(formatShowRemaining(1, "zh-TW"), "顯示其餘 1 項關聯");
  assert.equal(formatShowRemaining(2, "zh-TW"), "顯示其餘 2 項關聯");
});

test("RelatedNotes (en) renders localized default heading, tooltips, singular showRemainingOne, and collapse", async t => {
  const { nineItems } = sampleRelations();
  assert.equal(nineItems.length, 9);
  const opened: Array<[string, string | undefined]> = [];

  const { document } = await mountNode(t, { url: "http://127.0.0.1/?lang=en" }, () =>
    createElement(RelatedNotes, {
      items: nineItems,
      open: (id, section) => opened.push([id, section]),
    }),
  );

  const section = document.querySelector("section.related-notes")!;
  const enCopy = relatedNotesCopy("en");
  assert.equal(section.getAttribute("aria-label"), enCopy.heading);
  assert.equal(section.querySelector("h3")?.textContent, `${enCopy.heading}9`);
  assertDecorativeSvgs(section);
  for (const btn of section.querySelectorAll("button")) {
    assert.equal(btn.getAttribute("type"), "button");
  }

  const toggle = section.querySelector("button.related-more") as HTMLButtonElement;
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(toggle.textContent, "Show 1 more connection");
  assertZeroCjkOnSubtree(section);

  await act(async () => {
    toggle.click();
  });
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.textContent, "Show less");
  assert.equal(section.querySelectorAll("li").length, 9);
  assertZeroCjkOnSubtree(section);

  await act(async () => {
    (section.querySelectorAll("li button")[1] as HTMLButtonElement).click();
  });
  assert.deepEqual(opened, [["target", "t1"]]);
});

test("RelatedNotes (en) renders custom title prop and plural showRemaining", async t => {
  const { nineItems } = sampleRelations();
  const tenItems = [
    ...nineItems,
    { lessonId: "extra-6", title: "Extra Note 6", reason: "Another.", kind: "links-to" as const },
  ];
  const { document } = await mountNode(t, { url: "http://127.0.0.1/?lang=en" }, () =>
    createElement(RelatedNotes, { items: tenItems, open: () => {}, title: "Read next" }),
  );
  const section = document.querySelector("section.related-notes")!;
  assert.equal(section.getAttribute("aria-label"), "Read next");
  assert.equal(section.querySelector("button.related-more")?.textContent, "Show 2 more connections");
  assertZeroCjkOnSubtree(section);
});

test("RelatedNotes (zh-TW) preserves exact shipped strings for heading, toggle, and collapse", async t => {
  const { nineItems } = sampleRelations();
  const { document } = await mountNode(t, { url: "http://127.0.0.1/" }, () =>
    createElement(RelatedNotes, { items: nineItems, open: () => {} }),
  );
  const section = document.querySelector("section.related-notes")!;
  assert.equal(section.getAttribute("aria-label"), "相關筆記");
  const toggle = section.querySelector("button.related-more") as HTMLButtonElement;
  assert.equal(toggle.textContent, "顯示其餘 1 項關聯");
  await act(async () => {
    toggle.click();
  });
  assert.equal(toggle.textContent, "收起");
});

test("document-upload.css uses C Precise semantic tokens, >=13px CJK floor, and closes EX21-P2-05", async t => {
  const css = readFileSync(new URL("./document-upload.css", import.meta.url), "utf8");

  for (const token of [
    "--chrome",
    "--raised",
    "--raised-2",
    "--panel",
    "--line",
    "--line-2",
    "--text",
    "--text-2",
    "--text-3",
    "--explain",
    "--explain-text",
    "--explain-tint",
    "--personal-text",
    "--pr-text",
    "--pr-tint",
    "--danger",
    "--focus",
    "--text-ui",
    "--lh-ui",
    "--text-body",
    "--lh-body",
    "--row-touch",
  ]) {
    assert.match(css, new RegExp(`var\\(${token}(?:,|\\))`), `expected token ${token}`);
  }

  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
  assert.doesNotMatch(css, /\bbackground:\s*white\b/i);
  assert.doesNotMatch(css, /--text-meta\b/);
  assert.doesNotMatch(css, /font-size:\s*(?:9|10|11|12)px\b/);

  assert.doesNotMatch(css, /(?:^|\n)\.document-choose:hover/);
  assert.match(css, /:not\(\.pdf-password\)\s*>\s*\.document-choose:hover:not\(:disabled\)/);
  assert.match(css, /@media\s*\(pointer:\s*coarse\)/);

  const { document } = await mountNode(t, {}, () =>
    createElement(
      "div",
      null,
      createElement(
        "form",
        { className: "pdf-state pdf-password" },
        createElement("button", { type: "submit", className: "document-choose" }, "Open"),
      ),
      createElement(
        "div",
        { className: "document-dropzone" },
        createElement("button", { type: "button", className: "document-choose" }, "Choose file"),
      ),
      createElement(
        "div",
        { className: "document-locked-actions" },
        createElement("button", { type: "submit", className: "document-choose" }, "Open PDF"),
      ),
      createElement(
        "div",
        { className: "document-original-actions" },
        createElement("button", { type: "button", className: "document-choose" }, "Download"),
      ),
    ),
  );

  const selector = ":not(.pdf-password) > .document-choose:not(:disabled)";
  assert.equal(document.querySelector(".pdf-password > .document-choose")!.matches(selector), false);
  assert.equal(document.querySelector(".document-dropzone > .document-choose")!.matches(selector), true);
  assert.equal(document.querySelector(".document-locked-actions > .document-choose")!.matches(selector), true);
  assert.equal(document.querySelector(".document-original-actions > .document-choose")!.matches(selector), true);
});
