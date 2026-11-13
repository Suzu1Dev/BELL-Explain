import test from "node:test";
import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import { act, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import strings from "../copy/suite-strings.json";
import { suiteCopy } from "../copy/suite";
import { handoffFromLine, handoffKind, parseExplainHandoff } from "../lib/suite";
import SuiteSourceBanner from "./SuiteSourceBanner";

if (Number(process.versions.node.split(".")[0]) >= 24) {
  registerHooks({
    load(url, context, next) {
      if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
      return next(url, context);
    },
  });
} else {
  register(`data:text/javascript,${encodeURIComponent(`export async function load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true };
    return next(url, context);
  }`)}`);
}

const bootstrap = new Window({ url: "http://127.0.0.1:21101" });
for (const [key, value] of Object.entries({ window: bootstrap, document: bootstrap.document })) {
  Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
test.after(async () => {
  delete (globalThis as Record<string, unknown>).window;
  delete (globalThis as Record<string, unknown>).document;
  await bootstrap.happyDOM.close();
});

const { default: LegacySwitcher } = await import("./SuiteSwitcher.js");
const { default: PreciseSwitcher } = await import("../ui/SuiteSwitcher.js");
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const links = { personal: "http://127.0.0.1:21103" };

function localizedPairs(value: unknown, path = ""): Array<[string, Record<"zh-TW" | "en", string>]> {
  if (!value || typeof value !== "object") return [];
  if ("zh-TW" in value || "en" in value) return [[path, value as Record<"zh-TW" | "en", string>]];
  return Object.entries(value).flatMap(([key, entry]) => localizedPairs(entry, path ? `${path}.${key}` : key));
}

async function mount(element: ReactNode) {
  const window = new Window({ url: "http://127.0.0.1:21101/?lang=en" });
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    navigator: window.navigator,
    self: window,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    KeyboardEvent: window.KeyboardEvent,
    MouseEvent: window.MouseEvent,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.body.appendChild(window.document.createElement("div")) as unknown as Element);
  await act(async () => {
    root.render(element);
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  return { window, root, async close() {
    await act(async () => root.unmount());
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    await window.happyDOM.close();
  } };
}

test("suite copy has 58 bilingual pairs with exact glossary compliance", () => {
  const pairs = localizedPairs(strings);
  assert.equal(pairs.length, 58);
  for (const [path, pair] of pairs) {
    assert.deepEqual(Object.keys(pair).sort(), ["en", "zh-TW"], path);
    assert.equal(typeof pair["zh-TW"], "string", path);
    assert.equal(typeof pair.en, "string", path);
    assert.doesNotMatch(pair.en, CJK, path);
    assert.doesNotMatch(pair["zh-TW"], /點子/, path);
  }
  assert.equal(strings.apps.personal.summary["zh-TW"], "今日與收件匣");
  assert.doesNotMatch(JSON.stringify(strings), /今天|點子/);
  assert.equal(strings.handoff.kinds.idea["zh-TW"], "靈感");
});

test("English handoff helpers, parser errors and banner contain no CJK", async () => {
  const window = new Window({ url: "http://127.0.0.1:21101/?lang=en" });
  const saved = ["window", "document"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, "window", { value: window, configurable: true, writable: true });
  Object.defineProperty(globalThis, "document", { value: window.document, configurable: true, writable: true });
  try {
    const copy = suiteCopy();
    for (const [route, kind] of [["#/tasks/1", "task"], ["#/ideas/1", "idea"], ["#/inbox/1", "email"], ["#/events/1", "event"], ["#/note/1", "note"], ["#/page/1", "page"]] as const) {
      assert.equal(handoffKind(route), copy.handoff.kinds[kind]);
    }
    const provenance = handoffFromLine({ from: "personal", back: "#/ideas/1", title: "Closures" });
    assert.equal(provenance, "From BELL Personal · idea “Closures”");
    assert.doesNotMatch(provenance, CJK);

    const errors = [
      parseExplainHandoff("#/explain?text=a&text=b&from=personal", links).error,
      parseExplainHandoff("#/explain?from=personal", links).error,
      parseExplainHandoff("#/explain?text=a&from=personal").error,
      parseExplainHandoff("#/explain?text=%00&from=personal", links).error,
    ];
    assert.deepEqual(errors, Object.values(copy.handoff.errors));
    for (const error of errors) assert.doesNotMatch(error!, CJK);

    const handoff = { text: "Draft", title: "Closures", from: "personal" as const, back: "#/ideas/1", truncated: true };
    const html = renderToStaticMarkup(createElement(SuiteSourceBanner, {
      ready: true,
      handoff,
      links,
      error: errors[0],
      onDismissError: () => {},
    }));
    assert.match(html, /<bdi>From BELL Personal · idea “Closures”<\/bdi>/);
    assert.match(html, /Long text was trimmed to the first 2,000 characters/);
    assert.match(html, /<bdi>Back to BELL Personal<\/bdi>/);
    assert.match(html, /aria-label="Draft source"/);
    assert.match(html, /aria-label="Dismiss draft notice"/);
    assert.doesNotMatch(html, /<svg(?![^>]*aria-hidden="true")/);
    assert.doesNotMatch(html, CJK);
    const loading = renderToStaticMarkup(createElement(SuiteSourceBanner, { ready: false, links }));
    assert.match(loading, /Checking draft source…/);
    assert.doesNotMatch(loading, CJK);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
    await window.happyDOM.close();
  }
});

test("both rendered switchers and the command empty state are fully English", async () => {
  const legacy = await mount(createElement(LegacySwitcher, { links }));
  try {
    const trigger = legacy.window.document.querySelector(".suite-switcher-trigger") as unknown as HTMLButtonElement;
    assert.ok(trigger);
    await act(async () => {
      trigger.click();
    });
    const html = legacy.window.document.body.innerHTML;
    for (const text of ["Switch BELL products", "BELL products", "Today and inbox", "Understanding and review", "Contributions and review", "Web reading and markup", "Event timeline and collaboration", "Current", "Not linked"]) {
      assert.ok(html.includes(text), text);
    }
    assert.doesNotMatch(html, CJK);
    assert.doesNotMatch(html, /<svg(?![^>]*aria-hidden="true")/);
  } finally {
    await legacy.close();
  }

  const precise = await mount(createElement(PreciseSwitcher, { open: true, links, onOpenChange: () => {} }));
  try {
    const html = precise.window.document.body.innerHTML;
    for (const text of ["Switch BELL products", "Switch to…", "Today and inbox", "Understanding and review", "Contributions and review", "Web reading and markup", "Event timeline and collaboration", "Current", "Not linked"]) {
      assert.ok(html.includes(text), text);
    }
    assert.doesNotMatch(html, CJK);
    assert.doesNotMatch(html, /<svg(?![^>]*aria-hidden="true")/);
    const current = precise.window.document.querySelector('[aria-current="page"]');
    assert.ok(current);
    assert.match(current.textContent || "", /BELL Explain/);
    const input = precise.window.document.querySelector("input");
    assert.ok(input);
    assert.equal(input.getAttribute("aria-label"), "Switch BELL products");
    await act(async () => {
      Object.getOwnPropertyDescriptor(precise.window.HTMLInputElement.prototype, "value")!.set!.call(input, "no matching product");
      input.dispatchEvent(new precise.window.Event("input", { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    const empty = precise.window.document.body.innerHTML;
    assert.match(empty, /No matching products\./);
    assert.doesNotMatch(empty, CJK);
  } finally {
    await precise.close();
  }
});

test("legacy switcher ArrowDown with zero linked apps focuses the menu and Escape restores the trigger", async () => {
  const legacy = await mount(createElement(LegacySwitcher, { links: {} }));
  try {
    const trigger = legacy.window.document.querySelector(".suite-switcher-trigger") as unknown as HTMLButtonElement;
    assert.ok(trigger);
    trigger.focus();
    const arrowDown = new legacy.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true });
    await act(async () => {
      trigger.dispatchEvent(arrowDown as unknown as Event);
      await new Promise(resolve => setTimeout(resolve, 50));
    });
    assert.equal(arrowDown.defaultPrevented, true);
    const menu = legacy.window.document.querySelector(".suite-switcher-menu");
    assert.ok(menu);
    assert.equal(legacy.window.document.activeElement, menu);
    await act(async () => {
      menu.dispatchEvent(new legacy.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    assert.equal(legacy.window.document.querySelector(".suite-switcher-menu"), null);
    assert.equal(legacy.window.document.activeElement, trigger);
  } finally {
    await legacy.close();
  }
});
