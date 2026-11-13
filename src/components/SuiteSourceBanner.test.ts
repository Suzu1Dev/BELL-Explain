import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SuiteSourceBanner from "./SuiteSourceBanner.js";
import { handoffFromLine, handoffKind } from "../lib/suite.js";

const links = { personal: "http://127.0.0.1:21103" };
const handoff = { text: "活動內容", title: "活動", from: "personal" as const, back: "#/events/ics:feed-1:abc", truncated: false };

test("the source chip stays in a loading state until the manifest resolves", () => {
  const html = renderToStaticMarkup(createElement(SuiteSourceBanner, { ready: false, handoff, links }));
  assert.match(html, /正在確認交接來源…/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /BELL Explain · 新的解說草稿/);
  assert.doesNotMatch(html, /來自 BELL Personal/);
  assert.doesNotMatch(html, /suite-back-link/);
});

test("a linked handoff renders its source kind, title and exact colon-id return route", () => {
  const html = renderToStaticMarkup(createElement(SuiteSourceBanner, { ready: true, handoff, links }));
  assert.match(html, /來自 BELL Personal · 行程「活動」/);
  assert.match(html, /<bdi>回到 BELL Personal<\/bdi>/);
  assert.match(html, /href="http:\/\/127\.0\.0\.1:21103\/#\/events\/ics:feed-1:abc"/);
  assert.match(html, /aria-busy="false"/);
});

test("an unlinked source never renders as a linked draft or a return link", () => {
  const html = renderToStaticMarkup(createElement(SuiteSourceBanner, {
    ready: true,
    handoff: { ...handoff, from: "pr" },
    links,
  }));
  assert.match(html, /BELL Explain/);
  assert.doesNotMatch(html, /來自 BELL/);
  assert.doesNotMatch(html, /suite-back-link/);
});

test("handoff errors render in the first-screen source banner without an AI setup action", () => {
  const html = renderToStaticMarkup(createElement(SuiteSourceBanner, {
    ready: true,
    links,
    error: "交接網址有重複欄位，請重新發起。",
    onDismissError: () => {},
  }));
  assert.match(html, /suite-source-error" role="alert">交接網址有重複欄位，請重新發起。<button/);
  assert.match(html, /aria-label="關閉交接錯誤提示"/);
  assert.doesNotMatch(html, /設定 AI 服務/);
  assert.doesNotMatch(html, /generation-error/);
});

test("the source kind comes only from the validated back route", () => {
  assert.equal(handoffKind("#/tasks/t-1"), "待辦");
  assert.equal(handoffKind("#/ideas/i-1"), "靈感");
  assert.equal(handoffKind("#/inbox/m-1"), "郵件");
  assert.equal(handoffKind("#/events/e-1"), "行程");
  assert.equal(handoffKind("#/note/n-1"), "筆記");
  assert.equal(handoffKind("#/today"), undefined);
  assert.equal(handoffKind(undefined), undefined);
  assert.equal(handoffFromLine({ from: "personal", back: "#/ideas/i-1", title: "分享閉包" }), "來自 BELL Personal · 靈感「分享閉包」");
  assert.equal(handoffFromLine({ from: "explain", back: "#/note/n-1", title: "" }), "來自 BELL Explain · 筆記");
  assert.equal(handoffFromLine({ from: "personal", title: "分享閉包" }), "來自 BELL Personal「分享閉包」");
  assert.equal(handoffFromLine({ from: "personal", title: "" }), "來自 BELL Personal");
});

test("truncation uses the exact concise string", () => {
  const html = renderToStaticMarkup(createElement(SuiteSourceBanner, { ready: true, handoff: { ...handoff, truncated: true }, links }));
  assert.match(html, /內容過長，已截斷為前 2,000 字/);
  assert.doesNotMatch(html, /標題最多 120 字/);
});
