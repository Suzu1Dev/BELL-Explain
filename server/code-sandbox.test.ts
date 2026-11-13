import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement, type ReactNode } from "react";
import { Window } from "happy-dom";

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

const { createApp } = await import("./app.js");
const { LessonStore } = await import("./store.js");
const { validCodeExampleLines } = await import("./schema.js");
const { allDemoCodeExamples, getDemoCodeExample } = await import("../shared/demo-code-examples.js");
const { exampleLessons } = await import("../shared/examples.js");
const {
  instrumentConsoleLines,
  isSandboxRunnable,
  isStepExecutableAnnotatedCode,
  isStepExecutableExample,
  stripTypeScriptTypes,
} = await import("../src/lib/code-runner.js");
const { default: PracticalExample } = await import("../src/components/PracticalExample.js");
const { default: AnnotatedCode } = await import("../src/components/learning/AnnotatedCode.js");

async function mountDom(
  t: TestContext,
  url: string,
  render: () => ReactNode,
) {
  const window = new Window({ url });
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
  const saved = Object.keys(globals).map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
  );
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

test("GET /api/code-sandbox serves isolated null-origin worker runner with strict CSP", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "bell-sandbox-test-"));
  const store = new LessonStore(join(dataDir, "notes.sqlite"), []);
  const app = createApp({
    store,
    examples: exampleLessons,
    config: { apiKey: "", model: "fixture", baseUrl: "http://127.0.0.1:9/v1" },
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const res = await fetch(`http://127.0.0.1:${port}/api/code-sandbox`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");

  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /sandbox allow-scripts/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /worker-src blob:/);
  assert.match(csp, /frame-ancestors 'self'/);

  const html = await res.text();
  assert.match(html, /bell-sandbox-run/);
  assert.match(html, /worker\.terminate\(\)/);
});

test("isSandboxRunnable and stripTypeScriptTypes preserve line count, object literals, and ternaries", async () => {
  assert.equal(isSandboxRunnable("javascript"), true);
  assert.equal(isSandboxRunnable("TypeScript"), true);
  assert.equal(isSandboxRunnable("ts"), true);
  assert.equal(isSandboxRunnable("python"), false);
  assert.equal(isSandboxRunnable("c"), false);
  assert.equal(isSandboxRunnable(""), false);

  const tsSnippet = [
    "interface Item {",
    "  id: number;",
    "  label: string;",
    "}",
    "type Formatter = (item: Item) => string;",
    "function summarize<T extends Item>(items: T[], prefix?: string): string {",
    "  const count: number = items.length;",
    "  const tag = count > 1 ? 'many' : 'single';",
    "  const meta = { prefix: prefix ?? 'item', tag };",
    "  return `${meta.prefix}:${meta.tag}:${(items[0] as Item).label}`;",
    "}",
    "const fmt: Formatter = (item: Item): string => `${item.id}-${item.label}`;",
    "console.log(summarize([{ id: 1, label: 'A：開始' }]), fmt({ id: 2, label: 'B' }));",
  ].join("\n");

  const jsCode = stripTypeScriptTypes(tsSnippet);
  assert.equal(
    jsCode.split("\n").length,
    tsSnippet.split("\n").length,
    "line count must stay identical after stripping TypeScript annotations",
  );

  const logs: string[] = [];
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor as new (
    arg: string,
    body: string,
  ) => (c: { log: (...a: unknown[]) => void }) => Promise<void>;
  const fn = new AsyncFn("console", `"use strict";\n${jsCode}`);
  await fn({ log: (...args: unknown[]) => logs.push(args.map(String).join(" ")) });
  assert.deepEqual(logs, ["item:single:A：開始 2-B"]);
});

test("all 9 curated demoCodeExamples match exampleLessons sections, pass line bounds, and execute to expectedOutput", async () => {
  const entries = allDemoCodeExamples();
  const demoLessonMap = new Map(exampleLessons.map((lesson) => [lesson.id, lesson]));

  let totalDemoSections = 0;
  for (const lesson of exampleLessons) {
    for (const section of lesson.sections) {
      totalDemoSections += 1;
      const found = getDemoCodeExample(lesson.id, section.id);
      assert.ok(found, `missing demo codeExample for ${lesson.id}:${section.id}`);
    }
  }
  assert.equal(Object.keys(entries).length, totalDemoSections);

  for (const [key, entry] of Object.entries(entries)) {
    const [lessonId, sectionId] = key.split(":");
    const lesson = demoLessonMap.get(lessonId);
    assert.ok(lesson, `unknown demo lesson ${lessonId}`);
    assert.ok(lesson.sections.some((s) => s.id === sectionId), `unknown section ${sectionId}`);
    assert.equal(
      validCodeExampleLines(entry.code, entry.example),
      true,
      `invalid walkthrough line bounds in ${key}`,
    );

    const logs: string[] = [];
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor as new (
      c: string,
      st: string,
      ct: string,
      body: string,
    ) => (
      consoleObj: { log: (...a: unknown[]) => void },
      setTimeoutFn: typeof setTimeout,
      clearTimeoutFn: typeof clearTimeout,
    ) => Promise<void>;

    const pending = new Set<ReturnType<typeof setTimeout>>();
    let notify = () => {};
    const trackedSetTimeout = ((cb: (...a: unknown[]) => void, ms?: number) => {
      const id = setTimeout(() => {
        pending.delete(id);
        cb();
        notify();
      }, Math.min(Number(ms) || 0, 200));
      pending.add(id);
      return id;
    }) as unknown as typeof setTimeout;
    const trackedClearTimeout = ((id: ReturnType<typeof setTimeout>) => {
      pending.delete(id);
      clearTimeout(id);
      notify();
    }) as typeof clearTimeout;

    const fn = new AsyncFn(
      "console",
      "setTimeout",
      "clearTimeout",
      `"use strict";\n${entry.code}`,
    );
    await fn(
      { log: (...args: unknown[]) => logs.push(args.map(String).join(" ")) },
      trackedSetTimeout,
      trackedClearTimeout,
    );
    await new Promise<void>((resolve) => {
      const check = () => {
        if (pending.size === 0) setTimeout(resolve, 0);
      };
      notify = check;
      check();
    });

    assert.equal(
      logs.join("\n"),
      entry.example.expectedOutput,
      `live execution output mismatch in ${key}`,
    );
  }
});

test("selective step-execution predicates and instrumentConsoleLines handle output vs static code accurately", () => {
  const staticShellFigure = {
    language: "shell",
    source: "gcc -fPIC -c y1.c\nreadelf -dW liby.so",
    output: undefined,
  };
  const staticJsDeclFigure = {
    language: "javascript",
    source: "function createCounter() {\n  let count = 0;\n  return () => ++count;\n}\nconst c = createCounter();",
    output: undefined,
  };
  const outputJsFigure = {
    language: "javascript",
    source: "let count = 0;\ncount += 1;\nconsole.log(count);",
    output: "1",
  };
  assert.equal(isStepExecutableAnnotatedCode(staticShellFigure), false);
  assert.equal(isStepExecutableAnnotatedCode(staticJsDeclFigure), false);
  assert.equal(isStepExecutableAnnotatedCode(outputJsFigure), true);

  const staticPolicyExample = {
    walkthrough: [
      { startLine: 1, endLine: 2, explanation: "Inspect current user SID." },
      { startLine: 3, endLine: 4, explanation: "Verify admin group." },
    ],
    expectedOutput: "UserSid : S-1-5-21",
  };
  assert.equal(
    isStepExecutableExample("powershell", "whoami /user\nwhoami /groups", staticPolicyExample),
    false,
  );
  assert.equal(
    isStepExecutableExample("python", "def dfs():\n  pass", staticPolicyExample),
    false,
  );

  const pythonStepOutputExample = {
    walkthrough: [
      { startLine: 1, endLine: 1, explanation: "Init frontier", state: "queue = ['S']" },
      { startLine: 2, endLine: 2, explanation: "Pop and print", state: "queue = []", output: "S -> G" },
    ],
    expectedOutput: "S -> G",
  };
  assert.equal(
    isStepExecutableExample("python", "q = ['S']\nprint('S -> G')", pythonStepOutputExample),
    true,
  );

  const sample = [
    "// console.log('ignored in comment')",
    "const literal = 'console.log(notACall)';",
    "/* multi",
    "   line */ console.log('line4');",
    "const msg = `hello ${\"}\"}`;",
    "custom.console.log('keep method');",
    "console.warn('line7');",
  ].join("\n");
  const instrumented = instrumentConsoleLines(sample);
  assert.equal(instrumented.split("\n").length, sample.split("\n").length);
  assert.match(instrumented, /__bellConsole\(4, "log", 'line4'\)/);
  assert.match(instrumented, /__bellConsole\(7, "warn", 'line7'\)/);
  assert.match(instrumented, /custom\.console\.log\('keep method'\)/);
  assert.match(instrumented, /'console\.log\(notACall\)'/);
});

test("PracticalExample progressively builds output step-by-step, preserves predict-first reveal, and omits debugger bar on static code", async (t) => {
  const demo = getDemoCodeExample("demo-event-loop", "event-loop-stack")!;
  const { document, window } = await mountDom(
    t,
    "http://127.0.0.1/?lang=en",
    () =>
      createElement(PracticalExample, {
        code: demo.code,
        language: demo.language,
        example: demo.example,
        predict: false,
      }),
  );

  // Step 1: Line 1 active, State visible, ONLY "A：開始" in progressive output console!
  const activeHead1 = document.querySelector(".code-line.practical-code-active-head");
  assert.ok(activeHead1?.textContent?.includes("1console.log"));
  assert.equal(document.querySelector(".practical-stepper-pos")?.textContent, "Step 1 / 6");
  assert.ok(document.querySelector(".practical-step-watch")?.textContent?.includes("State"));
  const consolePre = () => document.querySelector(".practical-example-result pre")?.textContent ?? "";
  assert.ok(consolePre().includes("A：開始"));
  assert.ok(!consolePre().includes("B：結束"), "future output B must not appear at Step 1");
  assert.ok(!consolePre().includes("D：計時器"), "future output D must not appear at Step 1");

  // Step 2 (setTimeout registration): internal state updated, still only A printed + idle note.
  const nextBtn = document.querySelector('button[aria-label="Next step"]') as HTMLButtonElement;
  await act(async () => nextBtn.click());
  assert.equal(document.querySelector(".practical-stepper-pos")?.textContent, "Step 2 / 6");
  assert.ok(consolePre().includes("A：開始"));
  assert.ok(consolePre().includes("Internal state updated on this step"));
  assert.ok(!consolePre().includes("B：結束"));

  // Click line 8 directly -> jumps to Step 5 (microtask C): A, B, and C shown, D still not shown!
  const codeLines = [...document.querySelectorAll(".practical-example .code-line")] as HTMLElement[];
  await act(async () => codeLines[7].click());
  assert.equal(document.querySelector(".practical-stepper-pos")?.textContent, "Step 5 / 6");
  assert.ok(consolePre().includes("A：開始"));
  assert.ok(consolePre().includes("B：結束"));
  assert.ok(consolePre().includes("C：微任務"));
  assert.ok(!consolePre().includes("D：計時器"), "timer D must wait until Step 6");

  // Step 6 -> complete output A, B, C, D!
  await act(async () => nextBtn.click());
  assert.equal(document.querySelector(".practical-stepper-pos")?.textContent, "Step 6 / 6");
  assert.ok(consolePre().includes("D：計時器"));

  // Toggle Edit & test mode, modify code, then Reset.
  const editBtn = [...document.querySelectorAll(".practical-tool-btn")].find((btn) =>
    btn.textContent?.includes("Edit & test"),
  ) as HTMLButtonElement;
  assert.ok(editBtn);
  await act(async () => editBtn.click());

  const editor = document.querySelector(".practical-code-editor") as HTMLTextAreaElement;
  assert.ok(editor);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(editor, "console.log('custom');");
    editor.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
  });

  const resetBtn = [...document.querySelectorAll(".practical-tool-btn")].find((btn) =>
    btn.textContent?.includes("Reset"),
  ) as HTMLButtonElement;
  assert.ok(resetBtn);
  await act(async () => resetBtn.click());
  assert.equal((document.querySelector(".practical-code-editor") as HTMLTextAreaElement).value, demo.code);
});

test("Progressive Python example with predict=true reveals pending-state console immediately on Next step", async (t) => {
  const pyExample = {
    title: "Iterative accumulation",
    scenario: "Accumulate sum before printing final value.",
    environment: "Python 3.12",
    walkthrough: [
      { startLine: 1, endLine: 1, explanation: "Set total = 0", state: "total = 0" },
      { startLine: 2, endLine: 2, explanation: "Add 5", state: "total = 5" },
      { startLine: 3, endLine: 3, explanation: "Print total", state: "total = 5", output: "total=5" },
    ],
    expectedOutput: "total=5",
    application: "Loop accumulators.",
  };
  const { document } = await mountDom(
    t,
    "http://127.0.0.1/?lang=en",
    () =>
      createElement(PracticalExample, {
        code: "total = 0\ntotal += 5\nprint(f'total={total}')",
        language: "python",
        example: pyExample,
        predict: true,
      }),
  );

  assert.ok(document.querySelector(".practical-guess"));
  const pyStepBtn = [...document.querySelectorAll(".practical-tool-btn")].find((btn) =>
    btn.textContent?.includes("Next step"),
  ) as HTMLButtonElement;
  await act(async () => pyStepBtn.click());
  assert.equal(document.querySelector(".practical-guess"), null);
  const pyPre = () => document.querySelector(".practical-example-result pre")?.textContent ?? "";
  assert.ok(pyPre().includes("nothing printed yet"));
  await act(async () => pyStepBtn.click());
  assert.ok(pyPre().includes("nothing printed yet"));
  await act(async () => pyStepBtn.click());
  assert.equal(pyPre(), "total=5");
});

test("Static PowerShell PracticalExample renders zero debugger controls", async (t) => {
  const { document } = await mountDom(
    t,
    "http://127.0.0.1/?lang=en",
    () =>
      createElement(PracticalExample, {
        code: "whoami /user",
        language: "powershell",
        example: {
          title: "Check user token",
          scenario: "Inspect Windows token.",
          environment: "PowerShell",
          walkthrough: [{ startLine: 1, endLine: 1, explanation: "Read SID." }],
          expectedOutput: "PC01\\alice",
          application: "Auditing.",
        },
      }),
  );
  assert.equal(document.querySelector(".practical-debugger-bar"), null);
});

test("AnnotatedCode shows execution controls for output-producing runnable code", async (t) => {
  const runnableFigure = {
    kind: "annotated-code" as const,
    file: "counter.js",
    language: "javascript",
    source: "let count = 0;\ncount += 1;\nconsole.log(count);",
    focus: [1, 2, 3],
    notes: [
      { line: 1, text: "Initialize count to 0." },
      { line: 2, text: "Increment count by 1." },
      { line: 3, text: "Print updated count." },
    ],
    output: "1",
  };

  const { document } = await mountDom(t, "http://127.0.0.1/?lang=en", () =>
    createElement(AnnotatedCode, { figure: runnableFigure }),
  );

  assert.ok(document.querySelector(".v3-code-run-btn")?.textContent?.includes("Step-by-step"));
  assert.equal(document.querySelectorAll(".v3-code-line.is-focused").length, 3);

  const noteRows = [...document.querySelectorAll(".v3-note-row")] as HTMLElement[];
  await act(async () => noteRows[1].click());
  assert.equal(document.querySelectorAll(".v3-code-line.is-focused").length, 1);
  assert.ok(noteRows[1].classList.contains("is-selected"));
  await act(async () => noteRows[1].click());
  assert.equal(document.querySelectorAll(".v3-code-line.is-focused").length, 3);
});

test("Static shell AnnotatedCode renders zero execution buttons", async (t) => {
  const { document } = await mountDom(t, "http://127.0.0.1/?lang=en", () =>
    createElement(AnnotatedCode, {
      figure: {
        kind: "annotated-code",
        language: "shell",
        source: "gcc -fPIC -c y1.c\nreadelf -dW liby.so",
        focus: [1, 2],
        notes: [
          { line: 1, text: "Compile position-independent object." },
          { line: 2, text: "Inspect dynamic section." },
        ],
      },
    }),
  );
  assert.equal(document.querySelector(".v3-code-run-btn"), null);
  assert.equal(document.querySelector(".v3-code-tool-btn"), null);
});
