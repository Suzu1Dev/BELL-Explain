import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { act, createElement, type ReactNode } from "react";
import { Window } from "happy-dom";
import type { KnowledgeSearch } from "../../shared/knowledge.js";
import type { CodeExample } from "../../shared/types.js";

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
  formatAnnotationTitleSuffix,
  formatDocumentTitleSuffix,
  formatOpenInPdfTitle,
  formatPracticalCurrentFocus,
  formatPracticalLineLabel,
  formatPracticalStepButtonAria,
  formatSimilarityBadge,
  localizeSemanticWarning,
  parseLessonChunkTitle,
  resolvePracticalSearchLocale,
} = await import("../copy/practical-search.js");
const { default: PracticalExample, lineLabel } = await import("./PracticalExample.js");
const { default: SemanticSearch, lessonTitle } = await import("./SemanticSearch.js");
const { citedRanges, linkPages, markedPages } = await import("../lib/page-references.js");

const canonicalZhTw = {
  practicalExample: {
    lineSingle: "第 {line} 行",
    lineRange: "第 {startLine}–{endLine} 行",
    eyebrow: "用一個小案例理解",
    scenarioLabel: "實際情境",
    environmentLabel: "執行環境",
    codeCaption: "一個小而完整的 case",
    currentFocus: "{lines} · 目前重點",
    walkthroughHeading: "白話拆解",
    walkthroughHint: "點選任一步，對照上方標亮的程式碼。",
    walkthroughListAria: "逐段程式碼解說",
    stepButtonAria: "對照步驟 {step}：{lines}",
    lastStepPrompt: "這幾行在做什麼？先在心裡用一句話說說看。",
    revealStepAction: "看說明",
    expectedResultHeading: "預期結果",
    predictFirstNote: "先預測，再對照",
    derivedNotExecutedNote: "依程式邏輯推導 · 未實際執行",
    guessLabel: "執行後你預期會看到什麼？寫下來再對照（不會儲存）。",
    guessPlaceholder: "例如：印出 1、2、3，最後佇列是空的",
    revealResultAction: "揭曉預期結果",
    yourGuessLabel: "你的預測",
    expectedResultAria: "推導的預期結果",
    applicationHeading: "什麼時候用得上？",
  },
  semanticSearch: {
    searchUnavailableError: "搜尋暫時無法回應。",
    compactRegionAria: "相關知識段落",
    regionAria: "知識庫搜尋結果",
    compactHeading: "與這一段相關",
    heading: "跨筆記與程式碼搜尋",
    keywordModeTitle: "尚未啟用語意向量，依文字內容比對",
    modeHybrid: "語意＋關鍵字",
    modeKeyword: "關鍵字搜尋",
    semanticFallbackWarning: "語意模型暫時無法查詢，這次使用關鍵字搜尋。",
    keywordHelp: "在設定中啟用多語向量模型，就能搜尋用不同文字描述的相關概念。",
    loadingMessage: "正在比對相關段落…",
    emptyMessage: "目前沒有相符的段落，試試其他概念或先建立筆記與 Repo 索引。",
    lessonCitationLabel: "筆記段落",
    similarityBadge: "相似度 {score}",
    similarityTitle: "向量餘弦相似度，用來排序，並非正確率。",
    annotationTitleSuffix: " · 詞句解釋：{term}",
    documentTitleSuffix: " · 文件：{name}",
  },
  pageReferences: {
    openInPdfTitle: "在 PDF 原文開啟第 {page} 頁",
  },
};

type SpecBundle = {
  $meta: {
    placeholders: Record<string, string>;
    budgets: {
      modeBadgeEnMaxChars: number;
      inlineRevealButtonEnMaxChars: number;
      primaryRevealButtonEnMaxChars: number;
      citationLabelEnMaxChars: number;
      similarityBadgeTemplateEnMaxChars: number;
      searchHeadingEnMaxChars: number;
      pageRefTitleTemplateEnMaxChars: number;
      overallEnMaxChars: number;
    };
  };
  "zh-TW": typeof canonicalZhTw;
  en: {
    practicalExample: Record<keyof typeof canonicalZhTw.practicalExample, string>;
    semanticSearch: Record<keyof typeof canonicalZhTw.semanticSearch, string>;
    pageReferences: Record<keyof typeof canonicalZhTw.pageReferences, string>;
  };
};

const strings = JSON.parse(
  readFileSync(new URL("../copy/practical-search-strings.json", import.meta.url), "utf8"),
) as SpecBundle;

const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const nativeSetTimeout = globalThis.setTimeout;

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{\w+\}/g)].map(match => match[0]).sort();
}

const sampleExample: CodeExample = {
  title: "FIFO queue drain",
  scenario: "Process queued tasks in arrival order.",
  environment: "Node.js 22",
  walkthrough: [
    { startLine: 1, endLine: 1, explanation: "Seed the queue with three items." },
    { startLine: 2, endLine: 4, explanation: "Shift and log each item until empty." },
  ],
  expectedOutput: "1\n2\n3",
  application: "Background job runners and BFS frontier queues.",
};

const sampleCode = [
  "const queue = [1, 2, 3];",
  "while (queue.length > 0) {",
  "  console.log(queue.shift());",
  "}",
].join("\n");

async function mountNode(
  t: TestContext,
  options: { url?: string; htmlLang?: string; fetchImpl?: typeof fetch },
  render: () => ReactNode,
) {
  const window = new Window({ url: options.url ?? "http://127.0.0.1/" });
  if (options.htmlLang !== undefined) window.document.documentElement.lang = options.htmlLang;
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    Element: window.Element,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    KeyboardEvent: window.KeyboardEvent,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  if (options.fetchImpl) globals.fetch = options.fetchImpl;
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

async function waitFor(check: () => void) {
  const deadline = Date.now() + 3_000;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await act(async () => {
        await new Promise(resolve => nativeSetTimeout(resolve, 15));
      });
    }
  }
}

function assertZeroCjkOnOwnedSubtree(root: Element, ignoreSelector?: string) {
  assert.doesNotMatch(root.textContent ?? "", CJK_RE);
  for (const element of [root, ...root.querySelectorAll("*")]) {
    if (ignoreSelector && element.closest(ignoreSelector)) continue;
    for (const attr of ["aria-label", "title", "placeholder"]) {
      const value = element.getAttribute(attr);
      if (value) assert.doesNotMatch(value, CJK_RE, `${element.tagName}[${attr}]="${value}"`);
    }
  }
}

test("all paired keys and {placeholder} tokens match 15f39222 with 0 English CJK and within character budgets", () => {
  const zh = strings["zh-TW"];
  const en = strings.en;

  assert.equal(Object.keys(zh.practicalExample).length, 22);
  assert.equal(Object.keys(zh.semanticSearch).length, 17);
  assert.equal(Object.keys(zh.pageReferences).length, 1);
  assert.deepEqual(Object.keys(en.practicalExample).sort(), Object.keys(zh.practicalExample).sort());
  assert.deepEqual(Object.keys(en.semanticSearch).sort(), Object.keys(zh.semanticSearch).sort());
  assert.deepEqual(Object.keys(en.pageReferences).sort(), Object.keys(zh.pageReferences).sort());

  // 38 direct UI/warning keys + 2 server chunk-suffix templates = 40 total leaf keys in 15f39222.
  const seenPlaceholders = new Set<string>();
  for (const section of ["practicalExample", "semanticSearch", "pageReferences"] as const) {
    const zhGroup = zh[section] as Record<string, string>;
    const enGroup = en[section] as Record<string, string>;
    for (const key of Object.keys(zhGroup)) {
      const zhTokens = placeholders(zhGroup[key]);
      const enTokens = placeholders(enGroup[key]);
      assert.deepEqual(enTokens, zhTokens, `${section}.${key} placeholder mismatch`);
      for (const token of enTokens) seenPlaceholders.add(token);
      assert.doesNotMatch(enGroup[key], CJK_RE, `${section}.${key} contains CJK`);
      assert.ok(
        enGroup[key].length <= strings.$meta.budgets.overallEnMaxChars,
        `${section}.${key} exceeds overallEnMaxChars`,
      );
    }
  }
  assert.deepEqual([...seenPlaceholders].sort(), Object.keys(strings.$meta.placeholders).sort());

  // Numeric en dash U+2013 in lineRange for both locales.
  assert.ok(zh.practicalExample.lineRange.includes("\u2013"));
  assert.ok(en.practicalExample.lineRange.includes("\u2013"));

  // $meta.budgets checks.
  const { budgets } = strings.$meta;
  assert.ok(en.semanticSearch.modeHybrid.length <= budgets.modeBadgeEnMaxChars);
  assert.ok(en.semanticSearch.modeKeyword.length <= budgets.modeBadgeEnMaxChars);
  assert.ok(en.practicalExample.revealStepAction.length <= budgets.inlineRevealButtonEnMaxChars);
  assert.ok(en.practicalExample.revealResultAction.length <= budgets.primaryRevealButtonEnMaxChars);
  assert.ok(en.semanticSearch.lessonCitationLabel.length <= budgets.citationLabelEnMaxChars);
  assert.ok(en.semanticSearch.similarityBadge.length <= budgets.similarityBadgeTemplateEnMaxChars);
  assert.ok(en.semanticSearch.heading.length <= budgets.searchHeadingEnMaxChars);
  assert.ok(en.semanticSearch.compactHeading.length <= budgets.searchHeadingEnMaxChars);
  assert.ok(en.pageReferences.openInPdfTitle.length <= budgets.pageRefTitleTemplateEnMaxChars);
});

test("zh-TW copy is preserved 100% byte-for-byte", () => {
  assert.deepEqual(strings["zh-TW"], canonicalZhTw);
});

test("PracticalExample.tsx, SemanticSearch.tsx, page-references.tsx, and practical-search.ts contain 0 CJK literals", () => {
  for (const relPath of [
    "./PracticalExample.tsx",
    "./SemanticSearch.tsx",
    "../lib/page-references.tsx",
    "../copy/practical-search.ts",
  ]) {
    const source = readFileSync(new URL(relPath, import.meta.url), "utf8");
    assert.doesNotMatch(source, CJK_RE, `${relPath} still contains inline CJK`);
  }
});

test("SSR/Node fallback defaults safely to zh-TW when window is undefined and helpers handle $ replacement patterns", () => {
  assert.equal(typeof globalThis.window, "undefined");
  assert.equal(resolvePracticalSearchLocale(), "zh-TW");
  assert.equal(lineLabel(4, 4), "第 4 行");
  assert.equal(lineLabel(2, 5), "第 2\u20135 行");
  assert.equal(formatPracticalCurrentFocus(lineLabel(2, 5)), "第 2\u20135 行 · 目前重點");
  assert.equal(formatPracticalStepButtonAria(2, lineLabel(2, 5)), "對照步驟 2：第 2\u20135 行");
  assert.equal(formatSimilarityBadge(0.843), "相似度 0.84");
  assert.equal(formatOpenInPdfTitle(7), "在 PDF 原文開啟第 7 頁");

  // Suffix & warning helpers preserve zh-TW byte-for-byte and re-localize under en, including $ characters.
  assert.deepEqual(parseLessonChunkTitle("BFS · 詞句解釋：cost $& tax", "zh-TW"), {
    baseTitle: "BFS",
    suffix: " · 詞句解釋：cost $& tax",
  });
  assert.deepEqual(parseLessonChunkTitle("BFS · 詞句解釋：cost $& tax", "en"), {
    baseTitle: "BFS",
    suffix: " · Explanation: cost $& tax",
  });
  assert.deepEqual(parseLessonChunkTitle("BFS · 文件：lecture-$1.pdf", "zh-TW"), {
    baseTitle: "BFS",
    suffix: " · 文件：lecture-$1.pdf",
  });
  assert.deepEqual(parseLessonChunkTitle("BFS · 文件：lecture-$1.pdf", "en"), {
    baseTitle: "BFS",
    suffix: " · Document: lecture-$1.pdf",
  });
  assert.deepEqual(parseLessonChunkTitle("BFS · Complexity", "en"), {
    baseTitle: "BFS · Complexity",
    suffix: null,
  });
  assert.equal(
    localizeSemanticWarning("語意模型暫時無法查詢，這次使用關鍵字搜尋。", "zh-TW"),
    "語意模型暫時無法查詢，這次使用關鍵字搜尋。",
  );
  assert.equal(
    localizeSemanticWarning("語意模型暫時無法查詢，這次使用關鍵字搜尋。", "en"),
    "Semantic matching isn't responding right now, so these results use keyword search.",
  );
  assert.equal(localizeSemanticWarning("Custom server notice", "en"), "Custom server notice");
  assert.equal(localizeSemanticWarning(undefined, "en"), undefined);
});

for (const locale of ["zh-TW", "en"] as const) {
  test(`${locale} PracticalExample renders walkthrough, line ranges, and predict-first flow`, async t => {
    const copy = strings[locale].practicalExample;
    const { window, document } = await mountNode(
      t,
      { url: `http://127.0.0.1/?lang=${locale}`, htmlLang: locale },
      () => createElement(PracticalExample, { code: sampleCode, language: "javascript", example: sampleExample, predict: true }),
    );

    const section = document.querySelector("section.practical-example")!;
    assert.ok(section);
    assert.equal(document.querySelector(".practical-example-eyebrow")?.textContent, copy.eyebrow);
    assert.equal(document.querySelector(".practical-example-scenario strong")?.textContent, copy.scenarioLabel);
    assert.equal(document.querySelector(".practical-example-environment strong")?.textContent, copy.environmentLabel);
    assert.equal(document.querySelector(".practical-code-caption > span:first-child")?.textContent, copy.codeCaption);

    const expectedLine1 = formatPracticalLineLabel(1, 1, locale);
    const expectedLine2 = formatPracticalLineLabel(2, 4, locale);
    assert.equal(
      document.querySelector(".practical-code-caption > span:last-child")?.textContent,
      copy.currentFocus.replace("{lines}", expectedLine1),
    );
    assert.equal(document.querySelector(".practical-example-walkthrough h5")?.textContent, copy.walkthroughHeading);
    assert.equal(document.querySelector(".practical-example-hint")?.textContent, copy.walkthroughHint);
    assert.equal(document.querySelector(".practical-example-walkthrough ol")?.getAttribute("aria-label"), copy.walkthroughListAria);

    const stepButtons = [...document.querySelectorAll(".practical-step-number")] as HTMLButtonElement[];
    assert.equal(stepButtons.length, 2);
    assert.equal(stepButtons[0].getAttribute("aria-label"), copy.stepButtonAria.replace("{step}", "1").replace("{lines}", expectedLine1));
    assert.equal(stepButtons[1].getAttribute("aria-label"), copy.stepButtonAria.replace("{step}", "2").replace("{lines}", expectedLine2));

    // Predict-first hidden last step & hidden expected result.
    const hiddenStep = document.querySelector(".practical-step-hidden")!;
    assert.ok(hiddenStep.textContent?.includes(copy.lastStepPrompt));
    const revealStepBtn = document.querySelector(".practical-reveal-inline") as HTMLButtonElement;
    assert.equal(revealStepBtn.textContent, copy.revealStepAction);

    assert.equal(document.querySelector(".practical-result-heading h5")?.textContent, copy.expectedResultHeading);
    assert.equal(document.querySelector(".practical-result-heading > span")?.textContent, copy.predictFirstNote);
    assert.equal(document.querySelector(".practical-guess label")?.textContent, copy.guessLabel);
    const textarea = document.querySelector(".practical-guess textarea") as HTMLTextAreaElement;
    assert.equal(textarea.getAttribute("placeholder"), copy.guessPlaceholder);
    const revealResultBtn = document.querySelector(".practical-reveal") as HTMLButtonElement;
    assert.equal(revealResultBtn.textContent, copy.revealResultAction);
    assert.equal(document.querySelector(".practical-example-application h5")?.textContent, copy.applicationHeading);

    if (locale === "en") assertZeroCjkOnOwnedSubtree(section, ".code-block");

    // Reveal inline last step -> selects step 2 (line range) and reveals explanation.
    await act(async () => revealStepBtn.click());
    assert.equal(Boolean(document.querySelector(".practical-step-hidden")), false);
    assert.equal(
      document.querySelector(".practical-code-caption > span:last-child")?.textContent,
      copy.currentFocus.replace("{lines}", expectedLine2),
    );

    // Enter prediction and reveal expected result.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(textarea, "Prints 1 then 2 then 3");
      textarea.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(async () => revealResultBtn.click());

    assert.equal(document.querySelector(".practical-result-heading > span")?.textContent, copy.derivedNotExecutedNote);
    assert.equal(document.querySelector(".practical-your-guess span")?.textContent, copy.yourGuessLabel);
    assert.equal(document.querySelector(".practical-your-guess p")?.textContent, "Prints 1 then 2 then 3");
    assert.equal(document.querySelector(".practical-example-result pre")?.getAttribute("aria-label"), copy.expectedResultAria);

    for (const icon of section.querySelectorAll("svg")) {
      if (!icon.closest(".code-block")) assert.equal(icon.getAttribute("aria-hidden"), "true");
    }
    if (locale === "en") assertZeroCjkOnOwnedSubtree(section, ".code-block");
  });

  test(`${locale} SemanticSearch renders hybrid results and localizes indexed annotation/document suffixes`, async t => {
    const copy = strings[locale].semanticSearch;
    const hybridPayload: KnowledgeSearch = {
      mode: "hybrid",
      model: "Xenova/multilingual-e5-small",
      results: [
        {
          id: "lesson:1:annotation:a1:0",
          kind: "lesson",
          ownerId: "lesson-1",
          sectionId: "s1",
          title: "Graph Traversal · 詞句解釋：BFS",
          text: "Breadth-first search explores vertices layer by layer.",
          citation: "Graph Traversal",
          score: 0.91,
          lexicalScore: 0.5,
          semanticScore: 0.842,
        },
        {
          id: "lesson:1:document:0",
          kind: "lesson",
          ownerId: "lesson-1",
          title: "Graph Traversal · 文件：slides-01.pdf",
          text: "Lecture handout covering shortest unweighted paths.",
          citation: "slides-01.pdf",
          score: 0.77,
          lexicalScore: 0.4,
        },
        {
          id: "repo:r1:0",
          kind: "repo",
          ownerId: "repo-1",
          title: "src/bfs.ts",
          text: "export function bfs(graph: Map<string, string[]>, start: string) {}",
          citation: "src/bfs.ts:1-12",
          path: "src/bfs.ts",
          startLine: 1,
          endLine: 12,
          score: 0.72,
          lexicalScore: 0.4,
        },
      ],
    };

    const opened: Array<{ id: string; sectionId?: string }> = [];
    let releaseFetch!: () => void;
    const gate = new Promise<void>(resolve => { releaseFetch = resolve; });

    // Use document.documentElement.lang without ?lang= on en to verify HTML lang resolution as well.
    const mountOpts = locale === "en"
      ? { url: "http://127.0.0.1/", htmlLang: "en-US" }
      : { url: "http://127.0.0.1/?lang=zh-TW", htmlLang: "zh-TW" };

    const { document } = await mountNode(
      t,
      {
        ...mountOpts,
        fetchImpl: (async () => {
          await gate;
          return new Response(JSON.stringify(hybridPayload), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
      },
      () =>
        createElement(SemanticSearch, {
          query: "BFS",
          onOpen: (id, sectionId) => opened.push({ id, sectionId }),
        }),
    );

    const section = document.querySelector("section.semantic-search")!;
    assert.equal(section.getAttribute("aria-label"), copy.regionAria);
    assert.equal(section.querySelector(".semantic-heading strong")?.textContent, copy.heading);
    assert.equal(section.querySelector('[role="status"]')?.textContent, copy.loadingMessage);
    if (locale === "en") assertZeroCjkOnOwnedSubtree(section);

    await act(async () => releaseFetch());
    await waitFor(() => assert.equal(section.querySelectorAll(".semantic-result").length, 3));

    assert.equal(section.querySelector(".semantic-mode")?.textContent, copy.modeHybrid);
    assert.equal(section.querySelector(".semantic-mode")?.getAttribute("title"), "Xenova/multilingual-e5-small");

    const titles = [...section.querySelectorAll(".semantic-result-title strong")].map(node => node.textContent);
    assert.deepEqual(titles, [
      `Graph Traversal${formatAnnotationTitleSuffix("BFS", locale)}`,
      `Graph Traversal${formatDocumentTitleSuffix("slides-01.pdf", locale)}`,
      "src/bfs.ts",
    ]);

    const citations = [...section.querySelectorAll(".semantic-citation")];
    assert.equal(citations[0].children[0]?.textContent, copy.lessonCitationLabel);
    assert.equal(citations[0].children[1]?.textContent, copy.similarityBadge.replace("{score}", "0.84"));
    assert.equal(citations[0].children[1]?.getAttribute("title"), copy.similarityTitle);
    assert.equal(citations[2].children[0]?.textContent, "src/bfs.ts:1-12");

    await act(async () => (section.querySelector(".semantic-result-title button") as HTMLButtonElement).click());
    assert.deepEqual(opened, [{ id: "lesson-1", sectionId: "s1" }]);

    for (const icon of section.querySelectorAll("svg")) assert.equal(icon.getAttribute("aria-hidden"), "true");
    if (locale === "en") assertZeroCjkOnOwnedSubtree(section);
  });

  test(`${locale} SemanticSearch localizes keyword mode, fallback warning, and empty state`, async t => {
    const copy = strings[locale].semanticSearch;
    const keywordFallbackPayload: KnowledgeSearch = {
      mode: "keyword",
      warning: "語意模型暫時無法查詢，這次使用關鍵字搜尋。",
      results: [],
    };
    const { document } = await mountNode(
      t,
      {
        url: `http://127.0.0.1/?lang=${locale}`,
        htmlLang: locale,
        fetchImpl: (async () =>
          new Response(JSON.stringify(keywordFallbackPayload), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
      },
      () => createElement(SemanticSearch, { query: "DFS", onOpen: () => {} }),
    );

    const section = document.querySelector("section.semantic-search")!;
    await waitFor(() => assert.equal(section.querySelector(".semantic-mode")?.textContent, copy.modeKeyword));
    assert.equal(section.querySelector(".semantic-mode")?.getAttribute("title"), copy.keywordModeTitle);
    assert.equal(section.querySelector(".semantic-help")?.textContent, copy.keywordHelp);
    const messages = [...section.querySelectorAll(".semantic-message")].map(node => node.textContent);
    assert.deepEqual(messages, [copy.semanticFallbackWarning, copy.emptyMessage]);
    if (locale === "en") assertZeroCjkOnOwnedSubtree(section);
  });

  test(`${locale} SemanticSearch compact mode localizes landmark, heading, and unavailable error fallback`, async t => {
    const copy = strings[locale].semanticSearch;
    const { document } = await mountNode(
      t,
      {
        url: `http://127.0.0.1/?lang=${locale}`,
        htmlLang: locale,
        fetchImpl: (async () =>
          new Response(JSON.stringify({}), { status: 503, headers: { "content-type": "application/json" } })) as typeof fetch,
      },
      () => createElement(SemanticSearch, { query: "Heap", compact: true, onOpen: () => {} }),
    );

    const section = document.querySelector("section.semantic-search")!;
    assert.equal(section.getAttribute("aria-label"), copy.compactRegionAria);
    assert.equal(section.querySelector(".semantic-heading strong")?.textContent, copy.compactHeading);
    await waitFor(() => assert.equal(section.querySelector('[role="alert"]')?.textContent, copy.searchUnavailableError));
    if (locale === "en") assertZeroCjkOnOwnedSubtree(section);
  });

  test(`${locale} page-references linkPages localizes openInPdfTitle and preserves citedRanges/markedPages`, async t => {
    const copy = strings[locale].pageReferences;
    const jumped: number[] = [];
    const sampleText = locale === "en" ? "See pp. 3–4 and page 9 for details." : "見第 3–4 頁與第 9 頁說明。";

    assert.deepEqual(citedRanges(sampleText, 12), [
      { start: 3, end: 4 },
      { start: 9, end: 9 },
    ]);
    assert.deepEqual(markedPages(citedRanges(sampleText, 12)), [3, 4, 9]);

    const { window, document } = await mountNode(
      t,
      { url: `http://127.0.0.1/?lang=${locale}`, htmlLang: locale },
      () => createElement("p", null, linkPages(sampleText, 12, page => jumped.push(page))),
    );

    const paragraph = document.querySelector("p")!;
    assert.equal(paragraph.textContent, sampleText);
    const refs = [...paragraph.querySelectorAll(".page-ref")] as HTMLElement[];
    assert.equal(refs.length, 2);
    assert.equal(refs[0].getAttribute("title"), copy.openInPdfTitle.replace("{page}", "3"));
    assert.equal(refs[1].getAttribute("title"), copy.openInPdfTitle.replace("{page}", "9"));

    await act(async () => refs[0].click());
    await act(async () => {
      refs[1].dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as Event);
    });
    assert.deepEqual(jumped, [3, 9]);

    if (locale === "en") assertZeroCjkOnOwnedSubtree(paragraph);
  });
}

test("lessonTitle renders math in note prefix while keeping raw suffix outside MathText", async t => {
  const { document } = await mountNode(
    t,
    { url: "http://127.0.0.1/?lang=en", htmlLang: "en" },
    () => createElement("div", { id: "probe" }, lessonTitle("Complexity $O(V + E)$ · 詞句解釋：queue_$1")),
  );
  const probe = document.getElementById("probe")!;
  assert.ok(probe.textContent?.endsWith(" · Explanation: queue_$1"));
  assert.doesNotMatch(probe.textContent ?? "", CJK_RE);
});
