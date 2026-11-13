import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement, Fragment, Profiler, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { exampleLessons } from "../shared/examples.js";
import { lessonMarkdown } from "../shared/lesson-markdown.js";
import { findBold, findInline, findMath, mathLines, proseBlocks, typesetAsQuoted } from "../shared/math.js";
import type { CodeExample, Lesson, LessonAnnotation } from "../shared/types.js";

// Components import their stylesheets; outside the bundler those load as empty modules.
// While the `offline` file exists, the KaTeX chunk fails to download as on a dropped connection,
// and each URL asked for is written to it. Node keeps a failed load of a URL for good, so each
// one fails under a URL of its own: a later test still gets KaTeX under the URL it asks for.
const offline = join(tmpdir(), `bell-math-offline-${process.pid}`);
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor >= 24 || (nodeMajor === 22 && nodeMinor >= 23)) {
  // Node 22.23+ can leave a retried import pending behind asynchronous hooks and mocked timers.
  // Synchronous in-process hooks also let tsx transform the imported TypeScript on these versions.
  let drops = 0;
  const failedUrls = new Map<string, string>();
  registerHooks({
    resolve(specifier, context, next) {
      const resolved = next(specifier, context);
      if (!/\/src\/lib\/katex\.ts(\?|$)/.test(resolved.url) || !existsSync(offline)) return resolved;
      let url = failedUrls.get(resolved.url);
      if (!url) {
        url = resolved.url + (resolved.url.includes("?") ? "&" : "?") + "offline=" + ++drops;
        failedUrls.set(resolved.url, url);
        appendFileSync(offline, resolved.url.replace(/^.*\//, "") + "\n");
      }
      return { ...resolved, url };
    },
    load(url, context, next) {
      if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
      if (/[?&]offline=\d+$/.test(url)) throw new Error("offline");
      return next(url, context);
    },
  });
} else {
  register(`data:text/javascript,${encodeURIComponent(`import { appendFileSync, existsSync } from "node:fs";
  let drops = 0;
  const failedUrls = new Map();
  export async function resolve(specifier, context, next) {
    const resolved = await next(specifier, context);
    if (!/\\/src\\/lib\\/katex\\.ts(\\?|$)/.test(resolved.url) || !existsSync(${JSON.stringify(offline)})) return resolved;
    let url = failedUrls.get(resolved.url);
    if (!url) {
      url = resolved.url + (resolved.url.includes("?") ? "&" : "?") + "offline=" + ++drops;
      failedUrls.set(resolved.url, url);
      appendFileSync(${JSON.stringify(offline)}, resolved.url.replace(/^.*\\//, "") + "\\n");
    }
    return { ...resolved, url };
  }
  export async function load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    if (/[?&]offline=\\d+$/.test(url)) throw new Error("offline");
    return next(url, context);
  }`)}`);
}
/** The KaTeX URLs asked for while offline. */
const attempts = () => readFileSync(offline, "utf8").split("\n").filter(Boolean);
const { default: MathText, ProseBlocks, loadMath } = await import("../src/components/MathText.js");
const { default: V3Text } = await import("../src/components/learning/V3Text.js");
const { default: ReadingAnnotations, AnnotatedText, selectedSource, sourceText } = await import("../src/components/ReadingAnnotations.js");
const { default: PracticalExample } = await import("../src/components/PracticalExample.js");
const { default: RelatedNotes } = await import("../src/components/RelatedNotes.js");
const { default: ReviewSession } = await import("../src/components/ReviewSession.js");
const { lessonTitle } = await import("../src/components/SemanticSearch.js");
const { linkPages } = await import("../src/lib/page-references.js");
const { LearningStore } = await import("./learning.js");

/** Each formula as [source, display]. */
const formulas = (text: string) => findMath(text).map(span => [text.slice(span.start, span.end), span.display]);
const math = (text: string) => renderToStaticMarkup(createElement(MathText, { text }));
/** `text` rendered as plain text, escaped as React escapes it. */
const plain = (text: string) => renderToStaticMarkup(createElement("span", null, text)).slice(6, -7);

/** A happy-dom page where components mount as in the browser, so effects and event handlers run. */
async function onPage() {
  const window = new Window();
  // happy-dom leaves compatMode out, and KaTeX warns about quirks mode without it.
  Object.defineProperty(window.document, "compatMode", { value: "CSS1Compat" });
  const globals: Record<string, unknown> = {
    window, document: window.document, ResizeObserver: window.ResizeObserver, IS_REACT_ACT_ENVIRONMENT: true,
    Element: window.Element, HTMLElement: window.HTMLElement, Node: window.Node, navigator: window.navigator,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.body.appendChild(window.document.createElement("div")) as unknown as Element);
  return {
    document: window.document,
    /** Runs `work` and lets React apply what follows from it. */
    settle: (work: () => unknown = () => {}) => act(async () => { await work(); }),
    render: (element: ReactNode) => act(async () => { root.render(element); }),
    async close() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
      await window.happyDOM.close();
    },
  };
}

test("only \\( \\) and \\[ \\] delimit formulas; $ never does", () => {
  assert.deepEqual(formulas(String.raw`面積是 \(\pi r^2\)，總和為 \[\sum_{i=1}^{n} i\]。`), [[String.raw`\(\pi r^2\)`, false], [String.raw`\[\sum_{i=1}^{n} i\]`, true]]);
  assert.deepEqual(findMath(String.raw`a \(x^2\) b`)[0], { start: 2, end: 9, tex: "x^2", display: false });
  // Shell variables, prices and $…$ stay text.
  assert.deepEqual(formulas("echo $PATH，午餐 $120，$x^2$ 與 $$y$$"), []);
  // Display math may span lines; inline math ends at a line break, display math at a blank line.
  assert.deepEqual(formulas("\\[a\n= b\\]"), [["\\[a\n= b\\]", true]]);
  assert.deepEqual(formulas("\\(a\nb\\)"), []);
  assert.deepEqual(formulas("\\[a\n\nb\\]"), []);
  // \\ inside a formula is a line break, not an escaped closer.
  assert.deepEqual(formulas(String.raw`\[a \\ b\]`), [[String.raw`\[a \\ b\]`, true]]);
});

test("escaped, unbalanced, empty and code-span delimiters stay text", () => {
  // \\( is an escaped backslash followed by "(".
  assert.deepEqual(formulas(String.raw`路徑 C:\\(x\\) 不是公式`), []);
  assert.deepEqual(formulas(String.raw`\\\(y\)`), [[String.raw`\(y\)`, false]]);
  // An opener without a closer, or reopened before closing, is not a delimiter.
  assert.deepEqual(formulas(String.raw`只有開頭 \(x + 1`), []);
  assert.deepEqual(formulas(String.raw`\( 斷掉 \(b\)`), [[String.raw`\(b\)`, false]]);
  assert.deepEqual(formulas(String.raw`結尾 x\)`), []);
  assert.deepEqual(formulas(String.raw`空的 \(\) 與 \[  \]`), []);
  // Code in backticks keeps its backslashes, e.g. a shell find or a regular expression.
  assert.deepEqual(formulas("執行 `find . \\( -name a \\)` 再算 \\(n^2\\)"), [[String.raw`\(n^2\)`, false]]);
  assert.deepEqual(formulas("``a ` \\(x\\) `` 與 `未閉合 \\(y\\)"), [[String.raw`\(y\)`, false]]);
});

test("text without delimiters renders exactly as plain text", () => {
  for (const text of ["a < b && c > d，$HOME", "第 3 頁", "", String.raw`regex \d+ 與 \\(`]) {
    assert.equal(math(text), plain(text));
  }
});

test("closing CJK punctuation stays glued to its inline formula", () => {
  for (const punctuation of ["，", "。"]) {
    const markup = math(String.raw`前 \(x\)${punctuation}後`);
    assert.ok(markup.startsWith('前 <span class="math-glue" style="white-space:nowrap"><span class="math-source"'), markup);
    assert.ok(markup.includes(`>${punctuation}</span>後`), markup);
  }
  assert.doesNotMatch(math(String.raw`\[x\]`), /math-glue/);
  assert.doesNotMatch(math(String.raw`\(x\),`), /math-glue/);
});

test("regexes and shell commands quoted in prose stay text", () => {
  // Code that only looks like a formula: glued to a quote or a word, holding quotes or
  // regex wildcards, or with nothing but Chinese text inside.
  for (const code of [
    String.raw`用 grep '\[ERROR\]' app.log 找錯誤`, String.raw`sed 's/\(.*\)@\(.*\)/\2/'`, String.raw`find . \( -name '*.js' -o -name '*.ts' \)`,
    String.raw`用 \( 和 \) 把 find 的條件包起來`, String.raw`echo "\(1+2\)"`, String.raw`re.escape 的結果是 a\[b\]`, String.raw`比對 \([^)]*\)`,
  ]) {
    assert.deepEqual(formulas(code), [], code);
    assert.equal(math(code), plain(code));
  }
  // Formulas beside them are still found.
  const real = String.raw`導數 \(f'(x)\)、\(x''\)，比值 \(a/b\)，「\(\text{面積} = \pi r^2\)」，\(面積 = \pi r^2\)，\(0.5^n\)，空集合 \(\{\}\)，\[\sum_i x_i\]`;
  assert.equal(findMath(real).length, 8);
});

test("ellipses, operators between Chinese words and quotes in \\text{} are still math", () => {
  for (const formula of [
    String.raw`\((n-1)+(n-2)+...+1 = \frac{n(n-1)}{2}\)`, String.raw`\(1+2+...+n\)`, String.raw`\(總延遲 / 請求數\)`,
    String.raw`\(總數 - 已完成\)`, String.raw`\(|\text{"abc"}| = 3\)`, String.raw`\(總數!\)`, String.raw`\(單價 * 數量\)`,
  ]) assert.deepEqual(formulas(`式子 ${formula} 成立`), [[formula, false]], formula);
  const sum = "\\[\nS = 1+2+...+n\n\\]";
  assert.deepEqual(mathLines(`前言\n${sum}\n結論`), ["前言", sum, "結論"]);
  // Wildcards and quotes outside \text{} are still code.
  for (const code of [String.raw`\(.*\)`, String.raw`\(a.+b\)`, String.raw`\(x.?\)`, String.raw`\(\text{a} "b"\)`, String.raw`\("\)`]) assert.deepEqual(formulas(code), [], code);
});

test("a display formula over several lines has \\[ and \\] on lines of their own", () => {
  // Prose that mentions both brackets on different lines stays three paragraphs of text.
  const prose = "正規表示式裡，左方括號要跳脫寫成 \\[，例如比對 a 開頭的清單。\n第二步：寫出內容 0-9。\n最後右方括號同樣寫成 \\]，整個式子才完整。";
  assert.deepEqual(formulas(prose), []);
  assert.deepEqual(mathLines(prose), prose.split("\n"));
  assert.deepEqual(formulas("\\[ 是 a 的左括號\n\\] 是右括號"), []);
  assert.deepEqual(formulas("在 Markdown 裡，\\[ 會被當成普通的左括號。\n下一行有 x 與 y。\n同理 \\] 也是。"), []);
  // Spaces around the brackets are fine, and the first and last lines may hold part of the formula.
  assert.deepEqual(mathLines("  \\[\n a+b\n\\]  \n後記"), ["  \\[\n a+b\n\\]  ", "後記"]);
  assert.deepEqual(formulas("\\[ a +\n b \\]"), [["\\[ a +\n b \\]", true]]);
  // On one line a display formula may still sit in a sentence.
  assert.deepEqual(formulas(String.raw`總和為 \[\sum_i x_i\]。`), [[String.raw`\[\sum_i x_i\]`, true]]);
});

test("a stray backtick in one line of a body does not swallow a display formula below it", () => {
  const body = "反引號 ` 開頭的程式碼要成對。\n\\[\na + b\n\\]\n結尾 `x` 也是。";
  assert.deepEqual(mathLines(body), ["反引號 ` 開頭的程式碼要成對。", "\\[\na + b\n\\]", "結尾 `x` 也是。"]);
  assert.deepEqual(mathLines("執行 `find . \\(` 與\n\\[\nx\n\\]\n與 `\\)` 結束"), ["執行 `find . \\(` 與", "\\[\nx\n\\]", "與 `\\)` 結束"]);
  // Within one field a fenced block may still cross lines and keep its backslashes; a code span may not.
  assert.deepEqual(formulas("```\nfind . \\( -name a \\)\n```"), []);
  assert.deepEqual(formulas("`a\n\\(n\\) b`"), [["\\(n\\)", false]]);
});

test("before KaTeX loads, a formula shows its source", () => {
  const markup = math(String.raw`面積 \(r^2\)`);
  assert.match(markup, /面積 <span class="math-source" data-math-source="\\\(r\^2\\\)">\\\(r\^2\\\)<\/span>/);
  assert.doesNotMatch(markup, /katex/);
});

/** Waits for the actual render condition, with a wall-clock bound that also works under load. */
async function until(page: Awaited<ReturnType<typeof onPage>>, done: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for the expected render");
    await page.settle(() => new Promise(resolve => setImmediate(resolve)));
  }
}

test("a failed KaTeX download is retried a few times, each under a new URL, then asks for a reload", async t => {
  // A real copy keeps Node 24's loader from sticking on a child import after the parent itself had a query.
  const copy = new URL(`../src/components/MathText.offline-${process.pid}.tsx`, import.meta.url);
  writeFileSync(copy, readFileSync(new URL("../src/components/MathText.tsx", import.meta.url)));
  t.after(() => rmSync(copy, { force: true }));
  const { default: Offline } = await import(copy.href) as typeof import("../src/components/MathText.js");
  writeFileSync(offline, "");
  const page = await onPage();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // The formula renders again each time a download fails.
    let renders = 0;
    await page.render(createElement(Profiler, { id: "formula", onRender: () => { renders++; } },
      createElement("p", null, createElement(Offline, { text: String.raw`面積 \(r^2\)` }))));
    await until(page, () => renders === 2);
    const formula = () => page.document.querySelector("[data-math-source]")!;
    assert.equal(formula().getAttribute("title"), "公式排版元件沒有載入，稍後會自動重試，也可以重新整理頁面");
    assert.equal(formula().className, "math-source math-unloaded");
    for (const [index, pause] of [5_000, 15_000, 30_000, 60_000].entries()) {
      await page.settle(() => t.mock.timers.tick(pause - 1));
      await until(page, () => true);
      assert.equal(renders, index + 2, "no retry before the pause is over");
      await page.settle(() => t.mock.timers.tick(1));
      await until(page, () => renders === index + 3);
    }
    // A browser keeps a failed import() of a URL for good: each retry asks for a URL not tried before.
    assert.deepEqual(attempts(), ["katex.ts", "katex.ts?retry=1", "katex.ts?retry=2", "katex.ts?retry=3", "katex.ts?retry=4"]);
    assert.equal(formula().getAttribute("title"), "公式排版元件沒有載入，請重新整理頁面");
    // Then no timer is left to try again.
    await page.settle(() => t.mock.timers.tick(24 * 3_600_000));
    for (let turn = 0; turn < 50; turn++) await page.settle(() => new Promise(resolve => setImmediate(resolve)));
    assert.equal(attempts().length, 5);
    assert.equal(renders, 6);
  } finally {
    t.mock.timers.reset();
    await page.close();
    rmSync(offline, { force: true });
  }
});

test("a formula on the page typesets once a retry gets KaTeX", async t => {
  writeFileSync(offline, "");
  try {
    assert.equal(await loadMath(), false);
    assert.equal(math(String.raw`\(r^2\)`), String.raw`<span class="math-source math-unloaded" data-math-source="\(r^2\)" title="公式排版元件沒有載入，稍後會自動重試，也可以重新整理頁面">\(r^2\)</span>`);
    // A formula shown after the failure retries on its own once the pause is over.
    const page = await onPage();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    try {
      await page.render(createElement("p", null, createElement(MathText, { text: String.raw`面積 \(r^2\)` })));
      const paragraph = () => page.document.querySelector("p")!.innerHTML;
      assert.match(paragraph(), /^面積 <span class="math-source math-unloaded" data-math-source="[^"]+" title="公式排版元件沒有載入/);
      rmSync(offline);
      await page.settle(() => t.mock.timers.tick(5_000));
      await until(page, () => paragraph().includes("katex"));
      assert.match(paragraph(), /^面積 <span class="math" data-math-source="\\\(r\^2\\\)"><span class="katex">/);
    } finally {
      t.mock.timers.reset();
      await page.close();
    }
  } finally {
    rmSync(offline, { force: true });
  }
  assert.equal(await loadMath(), true);
});

test("formulas are typeset with KaTeX; invalid LaTeX falls back to its source", async () => {
  await loadMath();
  const inline = math(String.raw`面積 \(\frac{a}{b}\) 平方公尺`);
  assert.match(inline, /^面積 <span class="math" data-math-source="\\\(\\frac\{a\}\{b\}\\\)"><span class="katex">/);
  assert.match(inline, /<annotation encoding="application\/x-tex">\\frac\{a\}\{b\}<\/annotation>/);
  assert.match(inline, / 平方公尺$/);
  assert.match(math(String.raw`\[\sum_i x_i\]`), /class="math math-display".*class="katex-display"/);
  for (const bad of [String.raw`\(\frac{1}{\)`, String.raw`\(\undefinedmacro x\)`, String.raw`\(\def\a{\a}\a\)`]) {
    const markup = math(`前 ${bad} 後`);
    assert.equal(markup, `前 <span class="math-source math-invalid" data-math-source="${bad}" title="這段 LaTeX 無法排版，顯示原文">${bad}</span> 後`);
  }
  // Untrusted commands never become links.
  assert.doesNotMatch(math(String.raw`\(\href{https://example.com}{x}\)`), /<a |href=/);
  // Code that KaTeX rejects, such as a regex, is plain text rather than broken LaTeX.
  for (const code of [String.raw`\(\d+\)`, String.raw`\( $HOME \)`, String.raw`\(^\w+$\)`, String.raw`\(\bword\b\)`]) {
    assert.equal(math(`比對 ${code} 的部分`), `比對 <span class="math-source" data-math-source="${code}">${code}</span> 的部分`);
  }
});

test("a formula cannot draw over the text around it", async () => {
  await loadMath();
  // maxSize caps only positive sizes: KaTeX keeps a negative kern and \rlap as written…
  const markup = math(String.raw`前 \(\kern-30em\text{偽造}\rlap{蓋過後面}\) 後`);
  assert.match(markup, /margin-right:-30em/);
  // …so the stylesheet clips each KaTeX base of an inline formula, and everything KaTeX draws sits in one.
  const css = readFileSync(new URL("../src/components/math-text.css", import.meta.url), "utf8");
  assert.match(css, /^\.math:not\(\.math-display\) \.katex-base \{ clip-path: inset\(-?[.\d]+em\); \}$/m);
  // A display formula is a block that clips what overflows it, so wide limits under a sum
  // (\mathclap) are not cut off by the base's clip.
  assert.doesNotMatch(css, /^\.math \.katex-base/m);
  assert.match(css, /^\.math-display \{[^}]*\boverflow-x: auto; overflow-y: hidden;/m);
  const window = new Window();
  try {
    window.document.body.innerHTML = markup;
    const drawn = [...window.document.querySelector(".katex-html")!.children];
    assert.ok(drawn.length > 0);
    for (const child of drawn) assert.ok(child.classList.contains("katex-base"), child.className);
  } finally {
    await window.happyDOM.close();
  }
});

const paragraph = String.raw`圓的面積是 \(\pi r^2\)，詳見第 3 頁的推導。`;
const annotation = (id: string, term: string): LessonAnnotation => ({
  id, term, sourceKey: "s1:body", quote: paragraph, explanation: "說明", analogy: "比喻", createdAt: "2026-10-08T00:00:00.000Z",
});
function reading(children: ReactNode, annotations: LessonAnnotation[]) {
  const lesson: Lesson = { ...structuredClone(exampleLessons[0]), id: "math-note", isDemo: false, annotations };
  return renderToStaticMarkup(createElement(ReadingAnnotations, { lesson, onLessonChange: () => {}, children }));
}
const body = (renderPlain?: (text: string) => ReactNode) =>
  createElement("p", null, createElement(AnnotatedText, { text: paragraph, sourceKey: "s1:body", renderPlain, math: true }));

test("annotations and page links keep working on the text around a formula", async () => {
  await loadMath();
  // "r" appears only inside the LaTeX: a highlight never cuts a formula open.
  const markup = reading(body(text => linkPages(text, 10, () => {})), [annotation("a", "面積"), annotation("b", "r"), annotation("c", String.raw`\(\pi r^2\)`)]);
  assert.match(markup, /<span class="reading-annotation-mark" role="button" tabindex="0" aria-label="查看「面積」的解釋"[^>]*>面積<\/span>/);
  assert.doesNotMatch(markup, /查看「r」的解釋/);
  // A saved explanation of the whole formula highlights the typeset formula.
  assert.match(markup, /aria-label="查看「\\\(\\pi r\^2\\\)」的解釋"[^>]*><span class="math" data-math-source="\\\(\\pi r\^2\\\)"><span class="katex">/);
  assert.match(markup, /<span class="page-ref" role="link" tabindex="0" title="在 PDF 原文開啟第 3 頁">第 3 頁<\/span>/);

  // Read back as the selection handler does, the paragraph is its source again.
  const window = new Window();
  try {
    window.document.body.innerHTML = markup;
    const block = window.document.querySelector("[data-annotation-source]")!;
    assert.equal(sourceText(block as unknown as Node), paragraph);
    const glyphs = [...block.querySelectorAll(".katex-html *")].map(element => element.firstChild).filter(node => node?.nodeType === 3);
    const range = window.document.createRange();
    // From inside "面積" to inside the drawn formula: the formula is taken whole.
    range.setStart(block.querySelector(".reading-annotation-mark")!.firstChild!, 1);
    range.setEnd(glyphs[0]!, 0);
    const selected = selectedSource(block as unknown as Element, range as unknown as Range);
    assert.equal(selected.raw, String.raw`積是 \(\pi r^2\)`);
    assert.equal(selected.text.slice(selected.offset, selected.offset + selected.raw.length), selected.raw);
    // Wholly inside the formula: the term is the formula's LaTeX, not KaTeX's glyphs.
    range.setStart(glyphs[0]!, 0);
    range.setEnd(glyphs.at(-1)!, 1);
    assert.equal(selectedSource(block as unknown as Element, range as unknown as Range).raw, String.raw`\(\pi r^2\)`);
    // Plain text is measured as before.
    const link = block.querySelector(".page-ref")!.firstChild!;
    range.setStart(link, 2);
    range.setEnd(link, 3);
    const plain = selectedSource(block as unknown as Element, range as unknown as Range);
    assert.equal(plain.raw, "3");
    assert.equal(plain.offset, paragraph.indexOf("3 頁"));
  } finally {
    await window.happyDOM.close();
  }
});

test("a display formula written over several lines stays one paragraph of a body", async () => {
  await loadMath();
  // Without such a formula a body splits into its lines exactly as before.
  for (const text of ["第一段\n\n第二段\n第三段", "公式 \\(x\\)\n下一行", "\\[a\n\n b\\]", ""]) assert.deepEqual(mathLines(text), text.split("\n").filter(Boolean));
  const sum = "\\[\nS_n = \\frac{n(n+1)}{2}\n\\]";
  const aligned = "\\[\n\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}\n\\]";
  const body = `前言\n${sum}\n對齊的寫法：\n${aligned}\n結論`;
  const paragraphs = mathLines(body);
  assert.deepEqual(paragraphs, ["前言", sum, "對齊的寫法：", aligned, "結論"]);
  // Rendered as NoteReader renders a body, both formulas are typeset whole.
  const markup = reading(createElement(Fragment, null, ...paragraphs.map((text, index) =>
    createElement("p", { key: index }, createElement(AnnotatedText, { text, sourceKey: "s1:body", math: true })))), []);
  assert.equal(markup.match(/class="math math-display"/g)?.length, 2);
  assert.doesNotMatch(markup, /class="math-source/);
  // A selection in such a paragraph reads back as a slice of the whole body, which is what the server checks a quote against.
  const window = new Window();
  try {
    window.document.body.innerHTML = markup;
    const blocks = [...window.document.querySelectorAll("[data-annotation-source]")].map(block => sourceText(block as unknown as Node));
    assert.deepEqual(blocks, paragraphs);
    for (const text of blocks) assert.ok(body.includes(text));
  } finally {
    await window.happyDOM.close();
  }
});

const output = String.raw`a\[b\]` + "\n" + String.raw`f\(x\) 與 \(1+2\)`;
const example: CodeExample = {
  title: "跳脫特殊字元", scenario: String.raw`把長度 \(n\) 的字串跳脫`, environment: "Python 3",
  walkthrough: [{ startLine: 1, endLine: 1, explanation: "呼叫 re.escape。" }], expectedOutput: output, application: "組正規表示式。",
};
const expected = (markup: string) => markup.match(/<pre tabindex="0" aria-label="推導的預期結果">(.*?)<\/pre>/s)?.[1] ?? "";

test("a practical example's expected output is program output, never LaTeX", async () => {
  await loadMath();
  const code = String.raw`print(re.escape("a[b]"))`;
  // Without reading annotations, and inside them as in the reader.
  const alone = renderToStaticMarkup(createElement(PracticalExample, { code, language: "python", example }));
  assert.equal(expected(alone), plain(output));
  assert.match(alone, /data-math-source="\\\(n\\\)"/, "the scenario still typesets its formula");
  const annotated = reading(createElement(PracticalExample, { code, language: "python", example, annotationSectionId: "s1" }),
    [{ ...annotation("o", String.raw`\(1+2\)`), sourceKey: "s1:example-output", quote: output }]);
  assert.doesNotMatch(expected(annotated), /katex|data-math-source/);
  assert.match(expected(annotated), /aria-label="查看「\\\(1\+2\\\)」的解釋"[^>]*>\\\(1\+2\\\)<\/span>/);

  // The explanation of a term picked from the output shows that term as written too.
  const page = await onPage();
  try {
    const lesson: Lesson = { ...structuredClone(exampleLessons[0]), id: "math-note", isDemo: false,
      annotations: [{ ...annotation("o", String.raw`\(1+2\)`), sourceKey: "s1:example-output", quote: output }, annotation("p", String.raw`\(\pi r^2\)`)] };
    await page.render(createElement(ReadingAnnotations, { lesson, onLessonChange: () => {}, children: createElement(Fragment, null,
      createElement("pre", null, createElement(AnnotatedText, { text: output, sourceKey: "s1:example-output" })),
      createElement("p", null, createElement(AnnotatedText, { text: paragraph, sourceKey: "s1:body", math: true }))) }));
    const title = async (term: string) => {
      const mark = [...page.document.querySelectorAll(".reading-annotation-mark")].find(item => item.getAttribute("aria-label") === `查看「${term}」的解釋`);
      await page.settle(() => (mark as unknown as HTMLElement).focus());
      return page.document.querySelector(".reading-explanation-card h3")!.innerHTML;
    };
    assert.equal(await title(String.raw`\(1+2\)`), String.raw`\(1+2\)`);
    // A term from prose still shows its formula typeset.
    await page.settle(loadMath);
    assert.match(await title(String.raw`\(\pi r^2\)`), /^<span class="math" data-math-source/);
  } finally {
    await page.close();
  }
});

test("a term its paragraph shows as written is not typeset in its explanation or on its review card", async () => {
  await loadMath();
  const text = String.raw`用 grep '\[ERROR\]' app.log 找出錯誤行，共 \(n\) 行。`;
  const regex = String.raw`\[ERROR\]`;
  assert.equal(typesetAsQuoted(regex, text), false);
  assert.equal(typesetAsQuoted(String.raw`\(n\)`, text), true);
  assert.equal(typesetAsQuoted("錯誤行", text), true);
  // Where it is picked decides: the same LaTeX may be code in one place and a formula in another.
  assert.equal(typesetAsQuoted(String.raw`\(x\)`, String.raw`echo "\(x\)" 印出 \(x\)`), true);
  assert.equal(typesetAsQuoted(String.raw`\(x\)`, String.raw`echo "\(x\)"`), false);
  // One section and no questions, so both term cards are among the day's new cards.
  const lesson: Lesson = { ...structuredClone(exampleLessons[0]), id: "math-note", isDemo: false, followUpQuestions: [], title: "找出 \\(n\\) 行的 `grep`" };
  lesson.sections = lesson.sections.slice(0, 1);
  const sourceKey = `${lesson.sections[0].id}:body`;
  lesson.annotations = [{ ...annotation("regex", regex), sourceKey, quote: text }, { ...annotation("n", String.raw`\(n\)`), sourceKey, quote: text }];
  const page = await onPage();
  const fetch = globalThis.fetch;
  try {
    await page.render(createElement(ReadingAnnotations, { lesson, onLessonChange: () => {}, children:
      createElement("p", null, createElement(AnnotatedText, { text, sourceKey, math: true })) }));
    assert.equal(page.document.querySelectorAll("p .katex").length, 1, "the paragraph typesets only \\(n\\)");
    const heading = async (term: string) => {
      const mark = [...page.document.querySelectorAll(".reading-annotation-mark")].find(item => item.getAttribute("aria-label") === `查看「${term}」的解釋`);
      await page.settle(() => (mark as unknown as HTMLElement).focus());
      return page.document.querySelector(".reading-explanation-card h3")!.innerHTML;
    };
    assert.equal(await heading(regex), regex);
    assert.match(await heading(String.raw`\(n\)`), /^<span class="math" data-math-source/);

    // The review card asks about the term as the paragraph shows it; its context is typeset as there.
    const store = new LearningStore(":memory:");
    const cards = store.due([lesson], new Date("2026-10-08T01:00:00Z")).filter(card => card.kind === "term");
    store.close();
    assert.equal(cards.length, 2);
    const shown: Record<string, [string, string]> = {};
    for (const card of cards) {
      globalThis.fetch = async () => new Response(JSON.stringify([card]));
      await page.render(createElement(ReviewSession, { key: card.id, openNote: () => {}, onReviewed: () => {} }));
      await until(page, () => Boolean(page.document.querySelector(".review-prompt")));
      shown[card.prompt] = [page.document.querySelector(".review-prompt")!.innerHTML, page.document.querySelector(".review-context")!.innerHTML];
      assert.match(page.document.querySelector(".review-source")!.innerHTML, /找出 <span class="math" data-math-source="\\\(n\\\)">.*的 <code class="inline-code" data-math-source="`grep`">grep<\/code>$/, "the note's title is typeset too");
    }
    const [prompt, context] = shown[`「${regex}」在這段裡是什麼意思？`];
    assert.equal(prompt, `「${regex}」在這段裡是什麼意思？`);
    assert.match(context, /^用 grep '＿＿＿' app\.log 找出錯誤行，共 <span class="math" data-math-source="\\\(n\\\)"><span class="katex">/);
    const [formulaPrompt, formulaContext] = shown[String.raw`「\(n\)」在這段裡是什麼意思？`];
    assert.match(formulaPrompt, /^「<span class="math-glue" style="white-space: nowrap;"><span class="math" data-math-source="\\\(n\\\)">/);
    assert.equal(formulaContext, text.replace(String.raw`\(n\)`, "＿＿＿"));
  } finally {
    globalThis.fetch = fetch;
    await page.close();
  }
});

test("section headings typeset their formulas wherever they are listed", async () => {
  await loadMath();
  const markup = renderToStaticMarkup(createElement(RelatedNotes, { open: () => {}, items: [
    { lessonId: "b", sectionId: "s1", title: "`sort` 與 \\(O(n)\\)", section: String.raw`為何是 \(O(n \log n)\)`, reason: "延伸", kind: "links-to" },
  ] }));
  assert.match(markup, /<strong><code class="inline-code" data-math-source="`sort`">sort<\/code> 與 <span class="math" data-math-source="\\\(O\(n\)\\\)"><span class="katex">/);
  assert.ok(markup.includes('title="延伸閱讀 · 為何是 \\(O(n \\log n)\\) · 延伸"'), markup);
  assert.doesNotMatch(markup, /<em>/);
});

test("code blocks and fields without math keep LaTeX as written", async () => {
  await loadMath();
  const { default: CodeBlock } = await import("../src/components/CodeBlock.js");
  const code = renderToStaticMarkup(createElement(CodeBlock, { code: String.raw`re.sub(r"\(\d+\)", "", s)  # \(x\)`, language: "python", annotationSource: "s1:code" }));
  assert.doesNotMatch(code, /katex|data-math-source/);
  assert.match(reading(createElement(AnnotatedText, { text: String.raw`\(x\)`, sourceKey: "s1:body" }), []), /<span data-annotation-source="s1:body"><span>\\\(x\\\)<\/span><\/span>/);
});

test("`code spans` in prose render as code and keep their backticks as the source", () => {
  const text = "執行 `grep -n` 算 \\(n^2\\)，`` a`b `` 與 ` x `，空的 ` ` 和單個 ` 照原樣";
  assert.deepEqual(findInline(text).map(span => [span.kind, text.slice(span.start, span.end), span.kind === "code" ? span.code : span.tex]), [
    ["code", "`grep -n`", "grep -n"], ["math", "\\(n^2\\)", "n^2"], ["code", "`` a`b ``", "a`b"], ["code", "` x `", "x"],
  ]);
  const markup = math(text);
  assert.match(markup, /^執行 <code class="inline-code" data-math-source="`grep -n`">grep -n<\/code> 算 <span class="math-glue" style="white-space:nowrap"><span class="math"/);
  assert.match(markup, /<code class="inline-code" data-math-source="`` a`b ``">a`b<\/code> 與 <code class="inline-code" data-math-source="` x `">x<\/code>，空的 ` ` 和單個 ` 照原樣$/);
  // Code fields keep their backticks as written.
  assert.match(reading(createElement(AnnotatedText, { text: "`x`", sourceKey: "s1:code" }), []), /<span>`x`<\/span>/);
});

test("part of a code span can be picked and highlighted; all of it takes its backticks", async () => {
  const text = "執行 `docker compose up -d` 啟動，再用 `grep` 找，然後 `ls -l` 列出。";
  const at = (id: string, term: string): LessonAnnotation => ({ ...annotation(id, term), quote: text });
  const markup = reading(createElement("p", null, createElement(AnnotatedText, { text, sourceKey: "s1:body", math: true })),
    [at("flag", "-d"), at("compose", "compose"), at("grep", "`grep`"), at("old", "ls -l` 列")]);
  // Two flags of one command are each highlighted, inside the code.
  assert.match(markup, /<code class="inline-code" data-math-source="`docker compose up -d`">docker <span class="reading-annotation-mark"[^>]* aria-label="查看「compose」的解釋"[^>]*>compose<\/span> up <span class="reading-annotation-mark"[^>]* aria-label="查看「-d」的解釋"[^>]*>-d<\/span><\/code>/);
  assert.match(markup, /aria-label="查看「`grep`」的解釋"[^>]*><code class="inline-code" data-math-source="`grep`">grep<\/code><\/span><span> 找，然後 /);
  // A term saved across a code span's edge, when backticks still showed as text, is drawn in pieces.
  assert.match(markup, /<code class="inline-code" data-math-source="`ls -l`"><span [^>]*aria-label="查看「ls -l` 列」的解釋"[^>]*>ls -l<\/span><\/code><\/span><span [^>]*aria-label="查看「ls -l` 列」的解釋"[^>]*> 列<\/span><span>出。<\/span>/);
  // Its explanation's heading and review card show a whole code span as code too.
  assert.equal(typesetAsQuoted("`grep`", text), true);

  const window = new Window();
  try {
    window.document.body.innerHTML = markup;
    const block = window.document.querySelector("[data-annotation-source]")! as unknown as Element;
    assert.equal(sourceText(block as unknown as Node), text);
    const code = window.document.querySelector("code")!.firstChild!;
    const flag = window.document.querySelector('[aria-label="查看「-d」的解釋"]')!.firstChild!;
    const compose = window.document.querySelector('[aria-label="查看「compose」的解釋"]')!.firstChild!;
    const range = window.document.createRange();
    const pick = (start: [unknown, number], end: [unknown, number]) => {
      range.setStart(start[0] as never, start[1]);
      range.setEnd(end[0] as never, end[1]);
      const selected = selectedSource(block, range as unknown as Range);
      assert.equal(selected.text.slice(selected.offset, selected.offset + selected.raw.length), selected.raw);
      return selected.raw;
    };
    // Inside the span, highlighted parts included: what was selected.
    assert.equal(pick([flag, 0], [flag, 2]), "-d");
    assert.equal(pick([code, 0], [code, 6]), "docker");
    assert.equal(pick([compose, 0], [compose.parentNode!.nextSibling, 3]), "compose up");
    // All of it, or running out of it: the span with its backticks.
    assert.equal(pick([code, 0], [flag, 2]), "`docker compose up -d`");
    const before = window.document.querySelector("[data-annotation-source] > span")!.firstChild!;
    assert.equal(pick([before, 1], [code, 6]), "行 `docker compose up -d`");
  } finally {
    await window.happyDOM.close();
  }
});

test("a lone backtick never pairs with one on another line, even where the lines show as one text", () => {
  // A section's whole text is the answer on its review card; in the note each line is a paragraph.
  const body = "在 shell 裡反引號 ` 是舊式的命令替換符號。\n接著用 `ls -l` 列出檔案，共 \\(n\\) 個。";
  assert.deepEqual(findInline(body).map(span => body.slice(span.start, span.end)), ["`ls -l`", "\\(n\\)"]);
  assert.match(math(body), /^在 shell 裡反引號 ` 是舊式的命令替換符號。\n接著用 <code class="inline-code" data-math-source="`ls -l`">ls -l<\/code> 列出檔案/);
});

test("a term saved across a code span's edge leaves the other highlights in that code", () => {
  const text = "執行 `docker compose up -d` 啟動。";
  const at = (id: string, term: string): LessonAnnotation => ({ ...annotation(id, term), quote: text });
  const markup = reading(createElement("p", null, createElement(AnnotatedText, { text, sourceKey: "s1:body", math: true })),
    [at("tail", "-d` 啟"), at("compose", "compose"), at("head", "`docker")]);
  const mark = (term: string, shown: string) => `<span class="reading-annotation-mark" role="button" tabindex="0" aria-label="查看「${term}」的解釋" aria-expanded="false">${shown}</span>`;
  assert.ok(markup.includes(`<span>執行 <code class="inline-code" data-math-source="\`docker compose up -d\`">${mark("`docker", "docker")} ${mark("compose", "compose")} up ${mark("-d` 啟", "-d")}</code></span>${mark("-d` 啟", " 啟")}<span>動。</span>`), markup);
});

test("a code block runs over lines only from the start of a line to the start of another", () => {
  // ``` mentioned within two lines of a body is text, and the display formula between them stays whole.
  const body = "程式碼區塊用 ``` 開頭。\n\\[\na^2 + b^2 = c^2\n\\]\n結尾也是 ``` 單獨一行。";
  assert.deepEqual(mathLines(body), ["程式碼區塊用 ``` 開頭。", "\\[\na^2 + b^2 = c^2\n\\]", "結尾也是 ``` 單獨一行。"]);
  assert.deepEqual(findInline(body).map(span => span.kind), ["math"]);
  const block = "說明：\n```bash\nfind . \\( -name a \\)\n```\n之後 \\(n\\) 行";
  assert.deepEqual(findInline(block).map(span => [span.kind, block.slice(span.start, span.end)]), [["code", "```bash\nfind . \\( -name a \\)\n```"], ["math", "\\(n\\)"]]);
});

test("review cards blank whole backticks and show a section's text as the note does", async () => {
  await loadMath();
  const lesson: Lesson = { ...structuredClone(exampleLessons[0]), id: "code-note", isDemo: false, followUpQuestions: [] };
  lesson.sections = lesson.sections.slice(0, 1);
  const section = lesson.sections[0];
  section.body = "程式碼區塊用 ``` 開頭。\n\\[\na^2 + b^2 = c^2\n\\]\n然後 `ls -l` 列出，`pwd` 顯示目錄。";
  const quote = "然後 `ls -l` 列出，`pwd` 顯示目錄，`docker compose up -d` 啟動。";
  lesson.annotations = [
    { ...annotation("legacy", "ls -l` 列"), sourceKey: `${section.id}:body`, quote },
    { ...annotation("flag", "-d"), sourceKey: `${section.id}:body`, quote },
  ];
  const store = new LearningStore(":memory:");
  const cards = store.due([lesson], new Date("2026-10-08T01:00:00Z"));
  store.close();
  const context = (id: string) => cards.find(card => card.kind === "term" && card.prompt.includes(id))?.context;
  assert.equal(context("ls -l` 列"), "然後 ＿＿＿出，`pwd` 顯示目錄，`docker compose up -d` 啟動。");
  assert.equal(context("-d"), "然後 `ls -l` 列出，`pwd` 顯示目錄，`docker compose up ＿＿＿` 啟動。");
  const page = await onPage();
  const fetch = globalThis.fetch;
  try {
    const card = cards.find(item => item.kind === "section")!;
    globalThis.fetch = async () => new Response(JSON.stringify([card]));
    await page.render(createElement(ReviewSession, { openNote: () => {}, onReviewed: () => {} }));
    await until(page, () => Boolean(page.document.querySelector(".review-reveal")));
    await page.settle(() => (page.document.querySelector(".review-reveal") as unknown as HTMLElement).click());
    // The reveal button is gone: focus moves to the answer, not back to the page's start.
    assert.equal(page.document.activeElement, page.document.querySelector(".review-answer"));
    const paragraphs = [...page.document.querySelectorAll(".review-answer > p:not(.review-analogy)")];
    assert.equal(paragraphs.length, 3);
    assert.equal(paragraphs[0].innerHTML, "程式碼區塊用 ``` 開頭。");
    assert.ok(paragraphs[1].querySelector(".katex-display"), "the formula between the two lines is typeset");
    assert.match(paragraphs[2].innerHTML, /^然後 <code class="inline-code" data-math-source="`ls -l`">ls -l<\/code> 列出/);
  } finally {
    globalThis.fetch = fetch;
    await page.close();
  }
});

test("search results typeset a note's title, not an explained term or a file name after it", () => {
  const html = (title: string) => renderToStaticMarkup(createElement(Fragment, null, lessonTitle(title))).replaceAll("<!-- -->", "");
  assert.match(html("排序 \\(O(n)\\) · 為何是 `sort`"), /^排序 <span class="math".*為何是 <code class="inline-code" data-math-source="`sort`">sort<\/code>$/);
  // \[ERROR\] picked from grep '\[ERROR\]', and a term from a code block, as the note shows them.
  assert.match(html("找錯誤 \\(n\\) · 詞句解釋：\\[ERROR\\]"), /^找錯誤 <span class="math".*<\/span> · 詞句解釋：\\\[ERROR\\\]$/);
  assert.equal(html("講義 · 文件：`a` \\(x\\).pdf"), "講義 · 文件：`a` \\(x\\).pdf");
});

test("Markdown export keeps the LaTeX source", () => {
  const lesson = structuredClone(exampleLessons[0]);
  lesson.summary = String.raw`總和 \[\sum_{i=1}^{n} i = \frac{n(n+1)}{2}\]，面積 \(\pi r^2\)。`;
  assert.ok(lessonMarkdown(lesson).includes(lesson.summary));
});

test("selection HUD copies and hands the selected quote to Personal without a model call", async () => {
  const page = await onPage();
  const lesson = structuredClone(exampleLessons[0]);
  lesson.annotations = [];
  const copied: string[] = [];
  const sent: string[] = [];
  try {
    const view = page.document.defaultView!;
    Object.defineProperty(view.navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied.push(text); } } });
    await page.render(createElement(ReadingAnnotations, {
      lesson,
      onLessonChange: () => {},
      personalAvailable: true,
      sendToPersonal: (quote: string) => sent.push(quote),
      children: createElement(AnnotatedText, { text: "increment 寫在 createCounter 裡面", sourceKey: "body" }),
    }));
    const block = page.document.querySelector("[data-annotation-source]")!;
    const walker = page.document.createTreeWalker(block, view.NodeFilter.SHOW_TEXT);
    const text = walker.nextNode()!;
    const range = page.document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 12);
    const selection = view.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    await page.settle(async () => {
      page.document.dispatchEvent(new view.Event("selectionchange"));
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    const toolbar = page.document.querySelector(".reading-selection-toolbar")!;
    assert.match(toolbar.textContent || "", /解釋.*送到 Personal.*複製/);
    assert.equal(toolbar.querySelector(".reading-explain-action")?.getAttribute("aria-keyshortcuts"), "E Alt+Enter");
    await page.settle(() => { (toolbar.querySelector(".reading-copy-action") as unknown as HTMLButtonElement).click(); });
    assert.deepEqual(copied, ["increment 寫在"]);
    await page.settle(() => { (toolbar.querySelector(".reading-personal-action") as unknown as HTMLButtonElement).click(); });
    assert.deepEqual(sent, ["increment 寫在"]);
  } finally {
    await page.close();
  }
});

test("proseBlocks groups Markdown lists, subheadings and quotes while keeping annotation quotes exact", async () => {
  await loadMath();
  const body = [
    "### 安全議題",
    "常見風險如下：",
    "- 第 40 頁的 **Routing Table Poisoning** 會誤導轉送",
    "- 控制層與資料層都可能受影響",
    "\\[\nH(m) = y\n\\]",
    "1. 先算雜湊 `H(m)`",
    "2. 再用私鑰簽章 \\(\\sigma\\)",
    "> 原文並未展開 MPLS 細節",
  ].join("\n");
  assert.deepEqual(proseBlocks(body), [
    { kind: "heading", text: "安全議題" },
    { kind: "p", text: "常見風險如下：" },
    { kind: "ul", items: ["第 40 頁的 **Routing Table Poisoning** 會誤導轉送", "控制層與資料層都可能受影響"] },
    { kind: "p", text: "\\[\nH(m) = y\n\\]" },
    { kind: "ol", start: 1, items: ["先算雜湊 `H(m)`", "再用私鑰簽章 \\(\\sigma\\)"] },
    { kind: "quote", lines: ["原文並未展開 MPLS 細節"] },
  ]);
  const markup = reading(createElement(ProseBlocks, {
    text: body,
    paragraphClass: "explanation-text",
    listClass: "explanation-list",
    headingClass: "explanation-subheading",
    quoteClass: "explanation-quote",
    renderLine: line => createElement(AnnotatedText, { text: line, sourceKey: "s8:body", renderPlain: value => linkPages(value, 50, () => {}), math: true }),
  }), [{ ...annotation("p", "Poisoning"), sourceKey: "s8:body", quote: body }]);
  assert.match(markup, /<h3 class="explanation-subheading">.*安全議題.*<\/h3>/);
  assert.match(markup, /<ul class="explanation-list"><li>.*page-ref.*<strong>.*reading-annotation-mark.*Poisoning/);
  assert.match(markup, /<ol class="explanation-list"><li>.*?<code class="inline-code" data-math-source="`H\(m\)`">H\(m\)<\/code>.*?<\/li><li>.*?katex/s);
  assert.match(markup, /<blockquote class="explanation-quote"><p>.*原文並未展開 MPLS 細節/);
  const window = new Window();
  try {
    window.document.body.innerHTML = markup;
    assert.doesNotMatch(window.document.body.textContent ?? "", /\*\*|###|^-\s/m);
    for (const block of window.document.querySelectorAll("[data-annotation-source]")) {
      const recovered = sourceText(block as unknown as Node);
      assert.ok(body.includes(recovered), recovered);
    }
  } finally {
    await window.happyDOM.close();
  }
});

test("inline **bold** supports nested `code` and formulas without matching A*, globs, exponents or C pointers", async () => {
  await loadMath();
  for (const literal of ["A* 與 IDA*", "2 ** 10", "x**2 + y**2", "src/**/*.ts", "char **argv, **envp;"]) {
    assert.deepEqual(findBold(literal), [], literal);
    assert.equal(math(literal), plain(literal), literal);
  }
  assert.deepEqual(findBold("char **argv; **重點**").map(b => "char **argv; **重點**".slice(b.start, b.end)), ["**重點**"]);

  const verdict = "**`-L` 只設定建置時搜尋路徑。**";
  const markup = reading(createElement("p", null, createElement(V3Text, { text: verdict, sourceKey: "s7:recall-verdict" })), []);
  assert.match(markup, /<strong><span data-math-source="\*\*"><\/span><code class="inline-code" data-math-source="`-L`">-L<\/code> 只設定建置時搜尋路徑。<span data-math-source="\*\*"><\/span><\/strong>/);

  const window = new Window();
  try {
    window.document.body.innerHTML = markup;
    const block = window.document.querySelector("[data-annotation-source]")! as unknown as Element;
    assert.equal(block.textContent, "-L 只設定建置時搜尋路徑。");
    assert.equal(sourceText(block as unknown as Node), verdict);
    const textNode = window.document.querySelector("strong")!.childNodes[2]!;
    const range = window.document.createRange();
    range.setStart(textNode as never, 1);
    range.setEnd(textNode as never, 5);
    const picked = selectedSource(block, range as unknown as Range);
    assert.equal(picked.raw, "只設定建");
    assert.equal(picked.text.slice(picked.offset, picked.offset + picked.raw.length), picked.raw);
  } finally {
    await window.happyDOM.close();
  }
});
