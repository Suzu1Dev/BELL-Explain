import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register, registerHooks } from "node:module";
import { act, createElement } from "react";
import { Window } from "happy-dom";

const katexResolution = `if (url.includes("/lib/katex.ts") && context.parentURL?.includes("MathText.tsx?missing")) return { url: url + (url.includes("?") ? "&" : "?") + "missing", shortCircuit: true };`;
const katexFailure = `if (url.includes("/lib/katex.ts") && /[?&]missing/.test(url)) return { format: "module", source: "throw new Error('KaTeX unavailable')", shortCircuit: true };`;
if (Number(process.versions.node.split(".")[0]) >= 24) {
  registerHooks({
    resolve(url, context, next) {
      if (url.includes("/lib/katex.ts") && context.parentURL?.includes("MathText.tsx?missing")) return { url: `${url}${url.includes("?") ? "&" : "?"}missing`, shortCircuit: true };
      return next(url, context);
    },
    load(url, context, next) {
      if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
      if (url.includes("/lib/katex.ts") && /[?&]missing/.test(url)) return { format: "module", source: "throw new Error('KaTeX unavailable')", shortCircuit: true };
      return next(url, context);
    },
  });
} else {
  register(`data:text/javascript,${encodeURIComponent(`export async function resolve(url, context, next) {
    ${katexResolution}
    return next(url, context);
  }
  export async function load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    ${katexFailure}
    return next(url, context);
  }`)}`);
}

const { api, ApiError, checkAnswer, generate, resumeJob } = await import("../lib/api.js");
const mathText = (query: string) => import(`./MathText.tsx${query}`);
const { Formula } = await mathText("?invalid");
const { Formula: MissingFormulaZh } = await mathText("?missing-zh");
const { Formula: MissingFormulaEn } = await mathText("?missing-en");
const MissingFormula = { "zh-TW": MissingFormulaZh, en: MissingFormulaEn };

const canonicalA06dd4ea = {
  "zh-TW": {
    explainApiErrors: {
      serviceUnavailable: "服務暫時無法回應，請稍後再試。",
      sourceCheckFailed: "無法確認原始檔案，請稍後重試。",
      unusedUploadRemoveFailed: "無法移除尚未使用的檔案。",
      sourceMissingOnServer: "這台伺服器沒有原始檔案，仍可閱讀筆記中的擷取內容。",
      deleteNoteFailed: "無法刪除筆記，請稍後再試。",
      jobStatusUnavailable: "暫時無法確認工作狀態。",
      cancelJobFailed: "無法取消這次工作，請稍後再試。",
      selfCheckInterrupted: "批改連線中斷，尚未確認結果。請再試一次。",
      selfCheckStartFailed: "無法開始批改，請稍後再試。",
      jobOutcomeUnknown: "無法確認這次工作的結果（伺服器可能已重新啟動）。請到知識庫查看是否已儲存，或重新開始。",
      explainStartFailed: "無法開始解說，請稍後再試。",
      connectionInterruptedRetry: "連線暫時中斷。",
      connectionLostShort: "連線中斷。",
      explainStartUncertain: "連線中斷，無法確認這次解說是否已開始。請重新整理頁面查看。",
      jobStatusLostReload: "連線中斷，暫時無法確認這次工作的狀態。請重新整理頁面查看。",
      streamBodyUnsupported: "瀏覽器無法讀取生成進度。",
      generationInterrupted: "生成連線中斷，尚未完成筆記。請重新嘗試。",
    },
    explainMathFallback: {
      katexRetryingTitle: "公式排版元件沒有載入，稍後會自動重試，也可以重新整理頁面",
      katexReloadTitle: "公式排版元件沒有載入，請重新整理頁面",
      invalidLatexTitle: "這段 LaTeX 無法排版，顯示原文",
    },
  },
  en: {
    explainApiErrors: {
      serviceUnavailable: "The service isn't responding right now. Please try again in a moment.",
      sourceCheckFailed: "Couldn't check the original file. Please try again in a moment.",
      unusedUploadRemoveFailed: "Couldn't remove the unused file.",
      sourceMissingOnServer: "The original file isn't on this server. You can still read the extracted text in this note.",
      deleteNoteFailed: "Couldn't delete this note. Please try again in a moment.",
      jobStatusUnavailable: "Couldn't check the status right now.",
      cancelJobFailed: "Couldn't cancel this right now. Please try again in a moment.",
      selfCheckInterrupted: "Connection lost while checking your answer, before the result was confirmed. Please try again.",
      selfCheckStartFailed: "Couldn't start checking your answer. Please try again in a moment.",
      jobOutcomeUnknown: "Couldn't confirm the result (the server may have restarted). Check Library to see if it saved, or start over.",
      explainStartFailed: "Couldn't start the explanation. Please try again in a moment.",
      connectionInterruptedRetry: "Connection temporarily interrupted.",
      connectionLostShort: "Connection lost.",
      explainStartUncertain: "Connection lost before we could confirm the explanation started. Please reload the page to check.",
      jobStatusLostReload: "Connection lost, so we can't check the status right now. Please reload the page to check.",
      streamBodyUnsupported: "This browser can't read live progress updates.",
      generationInterrupted: "Connection lost before the note was finished. Please try again.",
    },
    explainMathFallback: {
      katexRetryingTitle: "Formula formatting didn't load. It will retry shortly, or you can reload the page.",
      katexReloadTitle: "Formula formatting didn't load. Please reload the page.",
      invalidLatexTitle: "Couldn't format this LaTeX. Showing the original text.",
    },
  },
};
const strings = JSON.parse(readFileSync(new URL("../copy/explain-client-errors-strings.json", import.meta.url), "utf8")) as typeof canonicalA06dd4ea;
const nativeSetTimeout = globalThis.setTimeout;

function setup(t: TestContext, locale: "zh-TW" | "en") {
  const window = new Window({ url: `http://127.0.0.1/${locale === "en" ? "?lang=en" : ""}` });
  window.document.documentElement.lang = locale;
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    Element: window.Element,
    Node: window.Node,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  t.after(async () => {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    await window.happyDOM.close();
  });
  return window;
}

async function expectMessage(promise: Promise<unknown>, message: string) {
  await assert.rejects(promise, error => {
    assert.equal((error as Error).message, message);
    return true;
  });
}

async function waitFor(check: () => void) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try { check(); return; }
    catch (error) {
      if (Date.now() >= deadline) throw error;
      await act(async () => { await new Promise(resolve => nativeSetTimeout(resolve, 10)); });
    }
  }
}

test("all 20 client error strings match a06dd4ea byte-for-byte and English has no CJK", () => {
  assert.deepEqual(strings, canonicalA06dd4ea);
  assert.equal(Object.keys(strings["zh-TW"].explainApiErrors).length, 17);
  assert.equal(Object.keys(strings["zh-TW"].explainMathFallback).length, 3);
  for (const group of Object.values(strings.en)) {
    for (const [key, value] of Object.entries(group)) assert.doesNotMatch(value, /[\u4e00-\u9fff]/, key);
  }
});

for (const locale of ["zh-TW", "en"] as const) {
  test(`${locale} REST fallbacks use approved copy and propagate structured error codes`, async t => {
    setup(t, locale);
    let response: Response;
    t.mock.method(globalThis, "fetch", async () => response);
    const copy = strings[locale].explainApiErrors;
    const cases = [
      ["serviceUnavailable", 500, () => api.config()],
      ["sourceCheckFailed", 500, () => api.document("doc")],
      ["unusedUploadRemoveFailed", 500, () => api.removeDocument("doc")],
      ["sourceMissingOnServer", 404, () => api.downloadDocument("doc", "doc.pdf")],
      ["deleteNoteFailed", 500, () => api.remove("note")],
      ["jobStatusUnavailable", 500, () => api.job("job")],
      ["cancelJobFailed", 500, () => api.cancelJob("job")],
    ] as const;
    for (const [key, status, run] of cases) {
      response = new Response("{}", { status });
      await expectMessage(run(), copy[key]);
    }
    response = new Response(JSON.stringify({ code: "no_model" }), { status: 503 });
    await assert.rejects(api.config(), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, copy.serviceUnavailable);
      assert.equal(error.status, 503);
      assert.equal(error.code, "no_model");
      return true;
    });
  });

  test(`${locale} stream and job fallbacks use approved copy`, async t => {
    setup(t, locale);
    let fetchImpl: typeof fetch = async () => new Response("{}", { status: 400 });
    t.mock.method(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) => fetchImpl(input, init));
    const copy = strings[locale].explainApiErrors;
    const signal = new AbortController().signal;
    await assert.rejects(checkAnswer("note", 0, "answer", signal, () => {}), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, copy.selfCheckStartFailed);
      return true;
    });
    fetchImpl = async () => new Response(JSON.stringify({ code: "no_model" }), { status: 400 });
    await assert.rejects(checkAnswer("note", 0, "answer", signal, () => {}), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.message, copy.selfCheckStartFailed);
      assert.equal(error.code, "no_model");
      return true;
    });
    fetchImpl = async () => new Response("", { status: 200 });
    await expectMessage(checkAnswer("note", 0, "answer", signal, () => {}), copy.selfCheckInterrupted);
    fetchImpl = async () => new Response(null, { status: 200 });
    await expectMessage(checkAnswer("note", 0, "answer", signal, () => {}), copy.streamBodyUnsupported);
    fetchImpl = async () => new Response("{}", { status: 400 });
    await expectMessage(generate({ kind: "concept", content: "test", depth: "beginner" }, signal, () => {}), copy.explainStartFailed);
    fetchImpl = async () => { throw new TypeError("offline"); };
    await expectMessage(generate({ kind: "concept", content: "test", depth: "beginner" }, signal, () => {}), copy.explainStartUncertain);
    fetchImpl = async () => new Response("{}", { status: 404 });
    await expectMessage(resumeJob("job", signal, () => {}), copy.jobOutcomeUnknown);
    const timers: Array<() => void> = [];
    t.mock.method(globalThis, "setTimeout", ((callback: () => void) => {
      timers.push(callback);
      return timers.length;
    }) as unknown as typeof setTimeout);
    fetchImpl = async () => new Response("", { status: 200 });
    const following = resumeJob("job", signal, () => {});
    const assertion = expectMessage(following, copy.jobStatusLostReload);
    for (let retry = 0; retry < 30; retry++) {
      await waitFor(() => assert.ok(timers.length));
      await act(async () => { timers.shift()!(); });
    }
    await assertion;
  });

  test(`${locale} renders invalid LaTeX fallback title`, async t => {
    const window = setup(t, locale);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(window.document.body.appendChild(window.document.createElement("div")) as unknown as Element);
    try {
      await act(async () => {
        root.render(createElement(Formula, { source: "$\\frac{1}{$", tex: "\\frac{1}{", display: false }));
      });
      await waitFor(() => assert.equal(window.document.querySelector(".math-invalid")?.getAttribute("title"), strings[locale].explainMathFallback.invalidLatexTitle));
      assert.equal(window.document.querySelector(".math-invalid")?.textContent, "$\\frac{1}{$");
    } finally {
      await act(async () => root.unmount());
    }
  });

  test(`${locale} renders missing KaTeX retrying and reload titles`, async t => {
    const window = setup(t, locale);
    const timers: Array<() => void> = [];
    t.mock.method(globalThis, "setTimeout", ((callback: () => void) => {
      timers.push(callback);
      return timers.length;
    }) as unknown as typeof setTimeout);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(window.document.body.appendChild(window.document.createElement("div")) as unknown as Element);
    try {
      await act(async () => {
        root.render(createElement(MissingFormula[locale], { source: "$x^2$", tex: "x^2", display: false }));
      });
      await waitFor(() => assert.equal(window.document.querySelector(".math-unloaded")?.getAttribute("title"), strings[locale].explainMathFallback.katexRetryingTitle));
      for (let retry = 0; retry < 4; retry++) {
        await waitFor(() => assert.ok(timers.length));
        await act(async () => { timers.shift()!(); });
      }
      await waitFor(() => assert.equal(window.document.querySelector(".math-unloaded")?.getAttribute("title"), strings[locale].explainMathFallback.katexReloadTitle));
    } finally {
      await act(async () => root.unmount());
    }
  });
}
