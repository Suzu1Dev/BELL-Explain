import test from "node:test";
import assert from "node:assert/strict";
import { explainNoteRoute, hasExplainHandoff, hashPath, normalizeExplainHandoff, parseExplainHandoff, personalDraftHref, prDraftHref, readerDraftHref, safeBackRoute, safeSuiteOrigin, sanitizeSuiteLinks, suiteBackHref } from "./suite.js";

const links = { personal: "http://127.0.0.1:21103" };

test("existing note and section routes keep their path when a query is present", () => {
  assert.equal(hashPath("#/note/a%2Fb/section-1?from=personal"), "/note/a%2Fb/section-1");
  assert.equal(hashPath("#/review?from=personal"), "/review");
  assert.equal(hashPath(""), "/");
});

test("a handoff is editable data, truncates by Unicode characters and keeps a valid linked source", () => {
  const result = parseExplainHandoff(`#/explain?text=${encodeURIComponent("任務".repeat(1001))}&title=${encodeURIComponent("標題".repeat(61))}&from=personal&back=${encodeURIComponent("#/tasks")}`, links);
  assert.equal(result.present, true);
  assert.equal(Array.from(result.draft!.text).length, 2000);
  assert.equal(Array.from(result.draft!.title).length, 120);
  assert.equal(result.draft!.truncated, true);
  assert.equal(result.draft!.from, "personal");
  assert.equal(result.draft!.back, "#/tasks");
});

test("R7–R10 reject every repeated handoff field instead of choosing a value", () => {
  for (const [name, hash] of [
    ["R7", "#/explain?text=a&text=b&from=personal"],
    ["R7 same values and decoded key", "#/explain?text=a&te%78t=a&from=personal"],
    ["R8", "#/explain?text=a&title=x&title=y&from=personal"],
    ["R9", "#/explain?text=a&from=personal&from=pr"],
    ["R10", "#/explain?text=a&from=personal&back=%23%2Ftoday&back=%23%2Ftasks"],
    ["D9 draft alias", "#/explain?text=a&draft=x&draft=y&from=personal"],
  ]) {
    const result = parseExplainHandoff(hash, links);
    assert.equal(result.present, true, name);
    assert.equal(result.draft, undefined, name);
    assert.match(result.error || "", /重複欄位/, name);
  }
});

test("R11 accepts an otherwise valid handoff with unrelated duplicate keys", () => {
  const result = parseExplainHandoff("#/explain?text=a&from=personal&x=1&x=2", links);
  assert.equal(result.draft?.text, "a");
  assert.equal(result.draft?.from, "personal");
  assert.equal(result.error, undefined);
});

test("handoffs remove overrides and reject duplicate titles without text", () => {
  const titleOnly = parseExplainHandoff("#/explain?title=first&title=duplicate", links);
  assert.equal(titleOnly.present, true);
  assert.equal(titleOnly.draft, undefined);
  assert.match(titleOnly.error || "", /重複欄位/);
  const cleaned = parseExplainHandoff("#/explain?text=+%0D%0Ahello%00%09world%E2%80%AE+&title=%09main%E2%80%8Ftitle%0D%0A&from=personal", links);
  assert.equal(cleaned.draft?.text, "hello\tworld");
  assert.equal(cleaned.draft?.title, "main\u200ftitle");
});

test("D7 titles keep LRM and RLM while dropping overrides on receipt and restore", () => {
  const title = "\u200f\u202eא b\u200e";
  const result = parseExplainHandoff(`#/explain?text=a&title=${encodeURIComponent(title)}&from=personal`, links);
  assert.equal(result.draft?.title, "\u200fא b\u200e");
  const restored = normalizeExplainHandoff({ text: "a", title: result.draft?.title, from: "personal" }, links);
  assert.equal(restored?.title, "\u200fא b\u200e");
});

test("malformed, missing, empty and unlinked handoffs never reuse an old draft", () => {
  for (const hash of [
    "#/explain?text=one",
    "#/explain?text=one&from=personal",
    "#/explain?text=one&from=explain",
    "#/explain?text=one&from=unknown",
    "#/explain?text=&from=personal",
    "#/explain?text=%00&from=personal",
    "#/explain?title=ignored&from=personal",
    "#/explain?back=%23%2Ftasks&from=personal",
  ]) {
    const result = parseExplainHandoff(hash, hash.includes("from=personal&") || hash.endsWith("from=personal") ? {} : links);
    assert.equal(result.present, true, hash);
    assert.equal(result.draft, undefined, hash);
    assert.ok(result.error, hash);
  }
  const titleOnly = parseExplainHandoff("#/explain?title=ignored", links);
  assert.equal(titleOnly.present, true);
  assert.match(titleOnly.error || "", /沒有草稿文字/);
  assert.equal(parseExplainHandoff("#/explain?other=ignored", links).present, false);
});

test("every handoff key requests old-draft replacement, even without text", () => {
  for (const hash of [
    "#/explain?text=new&from=personal",
    "#/explain?title=only",
    "#/explain?draft=only",
    "#/explain?from=personal&back=%23%2Ftoday",
    "#/explain?back=%23%2Ftasks",
  ]) assert.equal(hasExplainHandoff(hash), true, hash);
  assert.equal(hasExplainHandoff("#/explain?other=ignored"), false);
  assert.equal(hasExplainHandoff("#/note/abc?text=ignored"), false);
});

test("back routes exactly match the source app's rev. b route table", () => {
  for (const value of [
    "https://evil.example", "//evil.example", "/\\evil", "#/a%0d%0aSet-Cookie", "#/%2F%2Fevil", "#//evil", "#/a\\b",
    "#/tasks?filter=today", "#/settings", "#/note/abc", "#/tasks/abc/extra", "#/tasks/%61bc", "#/tasks/.", "#/tasks/..",
    `#/${"a".repeat(513)}`, `#/tasks/${"a".repeat(129)}`,
  ]) {
    assert.equal(safeBackRoute(value, "personal"), undefined, value);
  }
  for (const value of ["#/today", "#/tasks", "#/tasks/abc", "#/tasks/m:1", "#/events", "#/events/a.b", "#/ideas/x_y", "#/inbox/m:1"]) {
    assert.equal(safeBackRoute(value, "personal"), value, value);
  }
  for (const value of ["#/", "#/home", "#/demo", "#/repos", "#/repos/bell-explain", "#/discover", "#/team", "#/group", "#/learning", "#/settings", "#/runs/1"]) {
    assert.equal(safeBackRoute(value, "pr"), value, value);
  }
  assert.equal(safeBackRoute("#/runs/..", "pr"), undefined);
  assert.equal(suiteBackHref(links, "personal", "https://evil.example"), undefined);
  assert.equal(suiteBackHref(links, "pr", "#/runs/1"), undefined);
  assert.equal(suiteBackHref({ ...links, pr: "http://127.0.0.1:4603" }, "pr", "#/runs/1"), "http://127.0.0.1:4603/#/runs/1");
  assert.equal(suiteBackHref(links, "personal", "#/tasks/abc"), "http://127.0.0.1:21103/#/tasks/abc");
});

test("browser origins are restricted to configured loopback or the current tailnet", () => {
  assert.equal(safeSuiteOrigin("http://127.0.0.1:21103"), "http://127.0.0.1:21103");
  assert.equal(safeSuiteOrigin("http://[::1]:21103"), "http://[::1]:21103");
  assert.equal(safeSuiteOrigin("http://localhost"), "http://localhost");
  assert.equal(safeSuiteOrigin("http://localhost:80"), "http://localhost");
  assert.equal(safeSuiteOrigin("http://127.0.0.1:80"), "http://127.0.0.1");
  assert.equal(safeSuiteOrigin("https://localhost:443"), "https://localhost");
  assert.equal(safeSuiteOrigin("https://personal.example.ts.net", "explain.example.ts.net"), "https://personal.example.ts.net");
  assert.equal(safeSuiteOrigin("https://explain.example.ts.net:21101", "explain.example.ts.net"), "https://explain.example.ts.net:21101");
  for (const value of [
    "https://personal.other.ts.net", "https://evil.example", "http://personal.example.ts.net", "https://user:pass@personal.example.ts.net",
    "https://personal.example.ts.net/path", "https://personal.example.ts.net/?x=1", "https://*.ts.net", "https://personal.example.ts.net:0",
  ]) {
    assert.equal(safeSuiteOrigin(value, "explain.example.ts.net"), undefined, value);
  }
  assert.equal(safeSuiteOrigin("https://personal.example.ts.net"), undefined);
  assert.deepEqual(sanitizeSuiteLinks({ personal: "http://127.0.0.1:21103", pr: "https://evil.example", explain: "http://127.0.0.1:1", other: "http://127.0.0.1:1" }), links);
});

test("Personal handoff opens a draft with a raw allowed note id, never a created-todo endpoint", () => {
  const href = personalDraftHref(links.personal, "複習閉包", "#/note/closure:part.1");
  assert.ok(href?.startsWith("http://127.0.0.1:21103/#/tasks?"));
  const query = href!.split("?")[1];
  const params = new URLSearchParams(query);
  assert.equal(params.get("draft"), "複習閉包");
  assert.equal(params.get("from"), "explain");
  assert.equal(params.get("back"), "#/note/closure:part.1");
  assert.equal(personalDraftHref("https://evil.example", "text", "#/note/1"), undefined);
  assert.equal(explainNoteRoute("note:part.1"), "#/note/note:part.1");
  assert.equal(explainNoteRoute("slash/id"), "#/library");
  assert.equal(explainNoteRoute(".."), "#/library");
});

test("an id outside the object-id rule: Explain sends its list page instead, and refuses one from Personal", () => {
  const outside = [".", "..", "a/b", "50%", "a b", "筆記", "x".repeat(129)];
  for (const id of outside) {
    assert.equal(explainNoteRoute(id), "#/library", id);
    const href = personalDraftHref(links.personal, "複習", explainNoteRoute(id));
    assert.equal(new URLSearchParams(href!.split("?")[1]).get("back"), "#/library", id);
    for (const kind of ["tasks", "events", "ideas", "inbox"]) {
      assert.equal(safeBackRoute(`#/${kind}/${id}`, "personal"), undefined, `${kind} ${id}`);
      assert.equal(safeBackRoute(`#/${kind}/${encodeURIComponent(id)}`, "personal"), undefined, `${kind} encoded ${id}`);
    }
  }
  assert.equal(explainNoteRoute("y".repeat(128)), `#/note/${"y".repeat(128)}`);
});

test("stored handoffs are normalized instead of trusted", () => {
  assert.equal(normalizeExplainHandoff({ text: "old", title: 42 }, links), undefined);
  const stored = normalizeExplainHandoff({ text: "新任務", title: "標題", from: "personal", back: "https://evil.example" }, links);
  assert.equal(stored?.text, "新任務");
  assert.equal(stored?.from, "personal");
  assert.equal(stored?.back, undefined);
  const unlinked = normalizeExplainHandoff({ text: "保留文字", title: "", from: "personal", back: "#/tasks" }, {});
  assert.equal(unlinked?.text, "保留文字");
  assert.equal(unlinked?.from, undefined);
  assert.equal(unlinked?.back, undefined);
});

test("Web Reader handoffs round-trip between Explain and Reader with allowed page routes", () => {
  const withReader = { personal: "http://127.0.0.1:21103", reader: "http://127.0.0.1:21104" };
  const incoming = parseExplainHandoff("#/explain?text=%E6%89%8B%E5%AF%AB%E6%89%B9%E8%A8%BB&title=Reader+%E7%AD%86%E8%A8%98&from=reader&back=%23%2Fpage%2F42", withReader);
  assert.equal(incoming.draft?.from, "reader");
  assert.equal(incoming.draft?.back, "#/page/42");
  assert.equal(suiteBackHref(withReader, "reader", "#/page/42"), "http://127.0.0.1:21104/#/page/42");
  assert.equal(safeBackRoute("#/settings", "reader"), undefined);

  const outgoing = readerDraftHref(withReader.reader, "深入閱讀段落", "閉包原理", "#/note/closure-1");
  assert.ok(outgoing?.startsWith("http://127.0.0.1:21104/#/read?"));
  const params = new URLSearchParams(outgoing!.split("?")[1]);
  assert.equal(params.get("text"), "深入閱讀段落");
  assert.equal(params.get("title"), "閉包原理");
  assert.equal(params.get("from"), "explain");
  assert.equal(params.get("back"), "#/note/closure-1");

  const withPr = { pr: "http://127.0.0.1:4603" };
  const fromPr = parseExplainHandoff("#/explain?text=Fix+race+condition&title=PR+%2312&from=pr&back=%23%2Fruns%2Frun-42", withPr);
  assert.equal(fromPr.draft?.from, "pr");
  assert.equal(fromPr.draft?.back, "#/runs/run-42");
  const toPr = prDraftHref(withPr.pr, "Contribute fix from note", "Closure Note", "#/note/closure-1");
  assert.ok(toPr?.startsWith("http://127.0.0.1:4603/#/discover?"));
  const prParams = new URLSearchParams(toPr!.split("?")[1]);
  assert.equal(prParams.get("draft"), "Contribute fix from note");
  assert.equal(prParams.get("title"), "Closure Note");
  assert.equal(prParams.get("from"), "explain");
  assert.equal(prParams.get("back"), "#/note/closure-1");
});
