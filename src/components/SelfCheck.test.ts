import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { exampleLessons } from "../../shared/examples.js";

register(`data:text/javascript,${encodeURIComponent('export async function load(url, context, next) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : next(url, context); }')}`);
const { default: SelfCheck } = await import("./SelfCheck.js");

const render = (configured: boolean) => renderToStaticMarkup(createElement(SelfCheck, {
  lesson: exampleLessons[0],
  configured,
  openSection: () => {},
  followUp: () => {},
}));

test("follow-up questions stay collapsed and the missing-model note appears once", () => {
  const markup = render(false);
  assert.match(markup, /延伸問題/);
  assert.equal((markup.match(/class="self-check-details"/g) || []).length, 3);
  assert.equal((markup.match(/還沒連接模型/g) || []).length, 1);
  assert.doesNotMatch(markup, /自我檢查：先寫，再對照/);
  assert.doesNotMatch(render(true), /還沒連接模型/);
});
