import test from "node:test";
import assert from "node:assert/strict";
import { register, registerHooks } from "node:module";
import { act, createElement, useState } from "react";
import { Window } from "happy-dom";

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

const { default: SuiteSwitcher } = await import("./SuiteSwitcher.js");
const { default: Sheet } = await import("./Sheet.js");
const { default: Select } = await import("./Select.js");
const { MotionGlobalConfig } = await import("motion/react");
MotionGlobalConfig.skipAnimations = true;

async function mount(element: React.ReactNode) {
  const window = new Window({ url: "http://127.0.0.1:21101" });
  const globals: Record<string, unknown> = {
    window,
    document: window.document,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
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

test("cmdk keeps current and unconfigured apps disabled and closes with Escape", async t => {
  const calls: boolean[] = [];
  const page = await mount(createElement(SuiteSwitcher, { open: true, links: { personal: "http://127.0.0.1:21103" }, onOpenChange: (open: boolean) => { calls.push(open); } }));
  t.after(() => page.close());
  const items = [...page.window.document.querySelectorAll(".p-command-item")];
  assert.equal(items.length, 5, page.window.document.body.innerHTML);
  assert.equal(items[0].getAttribute("data-disabled"), "false");
  assert.equal(items[1].getAttribute("data-disabled"), "true");
  assert.equal(items[2].getAttribute("data-disabled"), "true");
  assert.equal(items[3].getAttribute("data-disabled"), "true");
  assert.equal(items[4].getAttribute("data-disabled"), "true");
  assert.equal(page.window.document.querySelector(".p-app-personal")?.textContent, "");
  await act(async () => { page.window.document.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  assert.deepEqual(calls, [false]);
});

test("sheet closes with Escape and restores focus to the previous control", async t => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return createElement("div", null,
      createElement("button", { id: "anchor", onClick: () => setOpen(true) }, "Anchor"),
      createElement(Sheet, { open, onOpenChange: setOpen, title: "確認", children: createElement("p", null, "內容") }),
    );
  }
  const page = await mount(createElement(Harness));
  t.after(() => page.close());
  const anchor = page.window.document.querySelector("#anchor") as unknown as HTMLButtonElement;
  anchor.focus();
  await act(async () => {
    anchor.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  assert.equal(page.window.document.querySelector('[role="dialog"]')?.textContent?.includes("確認"), true);
  await act(async () => {
    page.window.document.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 350));
  });
  assert.equal(page.window.document.querySelector('[role="dialog"]') === null, true, "Escape must remove the sheet");
  assert.equal(page.window.document.activeElement?.id, "anchor");
});

test("sheet reveals focused content and status messages using live sticky boundaries", async t => {
  const page = await mount(createElement(Sheet, {
    open: true,
    onOpenChange: () => {},
    title: "設定",
    children: createElement("div", null,
      createElement("button", { id: "last" }, "最後一項"),
      createElement("div", { className: "ms-actions" }, createElement("button", { id: "footer" }, "儲存")),
    ),
  }));
  t.after(() => page.close());
  const nativeFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { callback(0); return 0; };
  t.after(() => { globalThis.requestAnimationFrame = nativeFrame; });
  const sheet = page.window.document.querySelector(".p-sheet-content") as unknown as HTMLDivElement;
  const heading = sheet.querySelector(".p-sheet-heading") as unknown as HTMLDivElement;
  const footer = sheet.querySelector(".ms-actions") as unknown as HTMLDivElement;
  const last = sheet.querySelector("#last") as unknown as HTMLButtonElement;
  const rect = (top: number, bottom: number) => ({ x: 0, y: top, top, bottom, left: 0, right: 100, width: 100, height: bottom - top, toJSON() { return this; } }) as unknown as DOMRect;
  Object.defineProperties(sheet, {
    scrollHeight: { value: 800, configurable: true },
    clientHeight: { value: 300, configurable: true },
    clientTop: { value: 1, configurable: true },
    clientBottom: { value: 1, configurable: true },
  });
  sheet.getBoundingClientRect = () => rect(100, 400);
  heading.getBoundingClientRect = () => rect(100, 160);
  footer.getBoundingClientRect = () => rect(330, 400);
  last.getBoundingClientRect = () => rect(350, 370);
  sheet.scrollTop = 0;
  await act(async () => {
    last.focus();
    await new Promise(resolve => setTimeout(resolve, 60));
  });
  assert.equal(sheet.scrollTop, 40, "only the Sheet scrolls the covered focus above the live footer");
  assert.equal(page.window.document.activeElement?.id, "last", "visibility handling never steals focus");
  await act(async () => {
    (sheet.querySelector("#footer") as unknown as HTMLButtonElement).focus();
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  assert.equal(sheet.scrollTop, 40, "footer controls do not cause scrolling");
  const message = page.window.document.createElement("div");
  message.className = "ms-message ms-success";
  message.textContent = "已儲存";
  Object.defineProperty(message, "getBoundingClientRect", { value: () => rect(350, 380) });
  await act(async () => {
    last.parentElement!.appendChild(message as unknown as Node);
    await new Promise(resolve => setTimeout(resolve, 60));
  });
  assert.equal(sheet.scrollTop, 90, "a newly added status message is fully revealed without changing focus");
  assert.equal(page.window.document.activeElement?.id, "footer");
  assert.equal(page.window.scrollY, 0, "the page itself never scrolls");
});

test("select supports arrow-key navigation and preserves the chosen value", async t => {
  const calls: string[] = [];
  const page = await mount(createElement(Select, {
    label: "解說深度",
    value: "basic",
    options: [{ value: "basic", label: "基礎" }, { value: "deep", label: "深入" }],
    onChange: (value: string) => calls.push(value),
  }));
  t.after(() => page.close());
  const trigger = page.window.document.querySelector(".p-select-trigger") as unknown as HTMLButtonElement;
  await act(async () => {
    trigger.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  const list = page.window.document.querySelector('[role="listbox"]');
  assert.ok(list);
  await act(async () => {
    page.window.document.activeElement!.dispatchEvent(new page.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  const selected = page.window.document.activeElement as unknown as HTMLButtonElement;
  assert.equal(selected.textContent, "深入");
  await act(async () => {
    selected.click();
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  assert.deepEqual(calls, ["deep"]);
  assert.equal(page.window.document.querySelector('[role="listbox"]') === null, true, "selection must close the listbox");
});
