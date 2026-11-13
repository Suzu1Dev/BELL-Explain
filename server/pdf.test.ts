import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { restoreCjkRadicals } from "./cjk-radicals.js";
import { buildLines, isMonospaceRun, pageText, readingOrder, removeRunningLines, type LayoutItem, type LayoutPage } from "./pdf-layout.js";
import { inspectPdfPages, parseDocument, renderPdfPages, type ParsedDocument, type RenderedPage } from "./document-parser.js";
import { createDocumentRouter, DocumentService } from "./documents.js";
import { requestSchema } from "./schema.js";
import { AppError } from "./errors.js";
import { citedRanges, markedPages } from "../src/lib/page-references.js";

const lecture = new URL("./fixtures/lecture-zh.pdf", import.meta.url).pathname;
const locked = new URL("./fixtures/locked-aes256.pdf", import.meta.url).pathname;
const run = (str: string, x: number, y: number, size = 12, width = [...str].length * size, mono = false): LayoutItem => ({ str, x, y, width, size, mono });

test("radicals extracted from shared CJK glyphs become ordinary ideographs; punctuation is untouched", () => {
  assert.equal(restoreCjkRadicals("⾏程排程：時間⽚⽤完，⻑度⾼（標點）"), "行程排程：時間片用完，長度高（標點）");
  assert.equal(restoreCjkRadicals("ASCII, ﬁ, ！"), "ASCII, ﬁ, ！");
});

test("lines join CJK runs without spaces, keep real word gaps, and rebuild code indentation", () => {
  // pdf.js reports real spaces as blank runs; split CJK runs touch each other.
  const prose = buildLines([run("行", 50, 700), run("程排程", 62, 700), run("Linux", 98, 700, 12, 30), run(" ", 128, 700, 12, 4), run("排程器", 132, 700)]);
  assert.equal(prose.length, 1);
  assert.equal(prose[0].text, "行程排程Linux 排程器");
  assert.equal(buildLines([run("CPU", 50, 700, 12, 22), run("scheduler", 76, 700, 12, 50)])[0].text, "CPU scheduler");
  assert.equal(isMonospaceRun("monospace", "struct", 36, 10), true);
  // CJK fonts are often flagged fixed-pitch, but their glyphs advance a full em.
  assert.equal(isMonospaceRun("monospace", "行程", 24, 12), false);
  const code = buildLines([
    run("for", 50, 600, 10, 18, true), run(" ", 68, 600, 10, 6, true), run("(;;)", 74, 600, 10, 24, true),
    run("next();", 74, 584, 10, 42, true),
    run("}", 50, 568, 10, 6, true),
  ]);
  assert.equal(pageText(code), "for (;;)\n    next();\n}");
});

test("paragraphs reflow across lines, rejoin hyphenated words and keep headings and list items apart", () => {
  const lines = buildLines([
    run("3.1 基本概念", 50, 760, 18),
    // One 216 pt column: the indented first line and full lines reach its right edge.
    run("行程排程決定哪一個行程可以取得中", 74, 730, 12, 192), run("央處理器，排程器需要取捨。", 50, 712),
    run("1. 先到先服務", 50, 690), run("2. 時間片輪轉", 50, 672),
    run("The scheduler maintains a ready queue and this imple-", 50, 640, 12, 216), run("mentation detail matters.", 50, 622, 12, 120),
  ]);
  assert.equal(pageText(lines), "3.1 基本概念\n\n行程排程決定哪一個行程可以取得中央處理器，排程器需要取捨。\n\n1. 先到先服務\n\n2. 時間片輪轉\n\nThe scheduler maintains a ready queue and this implementation detail matters.");
});

test("running headers, footers and page numbers repeated near page edges are removed", () => {
  const page = (number: number, body: string): LayoutPage => ({ top: 842, bottom: 0, lines: buildLines([
    run("作業系統講義 · 第三章", 50, 815, 9), run(body, 50, 600), run(`— ${number} —`, 280, 30, 9),
  ]) });
  const pages = [page(1, "第一頁內容"), page(2, "第二頁內容"), page(3, "第三頁內容")];
  pages[0].lines.push(...buildLines([run("只出現一次的頁首附註", 50, 790, 9)]));
  removeRunningLines(pages);
  assert.deepEqual(pages.map(item => item.lines.map(line => line.text)), [["第一頁內容", "只出現一次的頁首附註"], ["第二頁內容"], ["第三頁內容"]]);
  // Two pages are too few to call a repeated line a running header, but page numbers still go.
  const short = [page(1, "甲"), page(2, "乙")];
  removeRunningLines(short);
  assert.deepEqual(short.map(item => item.lines.map(line => line.text)), [["作業系統講義 · 第三章", "甲"], ["作業系統講義 · 第三章", "乙"]]);
});

// Two 240 pt columns at x 50 and 322 with a 32 pt gutter, 10 pt Latin text about half an em per character.
const columnRuns = (left: string[], right: string[], top: number, rightX = 322) => left.flatMap((text, i) =>
  [run(text, 50, top - i * 13, 10, text.length * 5), ...right[i] ? [run(right[i], rightX, top - i * 13, 10, right[i].length * 5)] : []]);
const leftColumn = ["A scheduler decides which runnable task to run", "next. Each policy trades throughput, latency", "and fairness, and the kernel keeps every task", "in a ready queue so the choice is cheap to imple-"];
const rightColumn = ["ment. Round robin gives each task a fixed slice", "of time and moves it to the back of the queue", "when the slice runs out, which keeps response", "times predictable for interactive programs."];
const secondLeft = ["Completely fair scheduling instead tracks the", "virtual runtime of every task and always picks", "the task that has so far received the least", "processor time, so no task waits for too long."];
const secondRight = ["Its red-black tree keeps the lookup cheap even", "with thousands of runnable tasks, and the same", "balanced tree idea appears in many kernels and", "databases that need fast ordered lookups too."];
const ordered = (items: LayoutItem[]) => buildLines(readingOrder(items)).map(line => line.text);

test("two-column pages read band by band, left column before right, around full-width rows", () => {
  // Content order runs row by row across both columns, as many PDF writers emit it.
  const items = [
    run("Scheduling in Two Columns", 194, 760, 18, 223),
    // Two authors centred over the columns sit apart from the body and stay in front of it.
    run("Ada Lovelace", 140, 735, 10, 60), run("Alan Turing", 412, 735, 10, 55),
    ...columnRuns(leftColumn, rightColumn, 700),
    run("Figure 1: Ready queue length over time for the three policies compared here.", 50, 630, 10, 390),
    ...columnRuns(secondLeft, secondRight, 590),
  ];
  // An indented first line in the next column starts a new paragraph.
  items[items.findIndex(item => item.str.startsWith("Its red-black"))].x += 15;
  // Today's content order interleaves the columns.
  assert.match(pageText(buildLines(items)), /run ment\. Round robin/);
  assert.equal(pageText(buildLines(readingOrder(items))), [
    "Scheduling in Two Columns", "Ada Lovelace Alan Turing",
    // The paragraph runs on from the bottom of the left column into the right one, rejoining the hyphenated word.
    "A scheduler decides which runnable task to run next. Each policy trades throughput, latency and fairness, and the kernel keeps every task in a ready queue so the choice is cheap to implement. Round robin gives each task a fixed slice of time and moves it to the back of the queue when the slice runs out, which keeps response times predictable for interactive programs.",
    "Figure 1: Ready queue length over time for the three policies compared here.",
    "Completely fair scheduling instead tracks the virtual runtime of every task and always picks the task that has so far received the least processor time, so no task waits for too long.",
    "Its red-black tree keeps the lookup cheap even with thousands of runnable tasks, and the same balanced tree idea appears in many kernels and databases that need fast ordered lookups too.",
  ].join("\n\n"));
});

test("columns stored right column first, or as three columns, still read from the left", () => {
  const rightFirst = [...columnRuns(rightColumn, [], 700).map(item => ({ ...item, x: 322 })), ...columnRuns(leftColumn, [], 700)];
  assert.deepEqual(ordered(rightFirst), [...leftColumn, ...rightColumn]);
  // Three 160 pt columns: each holds an eight-line paragraph, emitted row by row.
  const third = (column: number) => Array.from({ length: 8 }, (_, i) => `column ${column} line ${i + 1} of the running text here`);
  const rows = Array.from({ length: 8 }, (_, i) => [0, 1, 2].map(column => run(third(column + 1)[i], 50 + column * 180, 700 - i * 13, 10, 150))).flat();
  assert.deepEqual(ordered(rows), [...third(1), ...third(2), ...third(3)]);
  // IEEE journals leave only 1.2 em between columns, and the page number sits centred in that gutter.
  assert.deepEqual(ordered([...columnRuns(leftColumn, rightColumn, 700, 307), run("3", 299, 40, 10, 5)]), [...leftColumn, ...rightColumn, "3"]);
});

test("tables, side-by-side code and term lists keep their row order", () => {
  const cells = [["Policy", "Time slice"], ["FCFS", "none"], ["Round robin", "10 ms"], ["CFS", "dynamic"], ["Real time", "fixed priority"], ["Idle", "runs last"]];
  const table = cells.flatMap(([a, b], i) => [run(a, 50, 700 - i * 14, 10, a.length * 5), run(b, 322, 700 - i * 14, 10, b.length * 5)]);
  assert.equal(readingOrder(table), table);
  assert.deepEqual(ordered(table).slice(0, 2), ["Policy Time slice", "FCFS none"]);
  // Short terms beside long definitions are a table too, even though one side is prose.
  const terms = ["Process", "Thread", "Quantum", "Context switch"].flatMap((term, i) => [
    run(term, 50, 700 - i * 28, 10, term.length * 5), run("is defined here with a sentence long enough to be prose", 322, 700 - i * 28, 10, 240),
    run("that wraps onto a second line of the definition cell", 322, 687 - i * 28, 10, 235)]);
  assert.equal(readingOrder(terms), terms);
  // Cells that wrap whole sentences still start side by side, row after row.
  const sentences = ["A process owns an address space and the resources", "the kernel gives it, such as open files, memory", "mappings and the credentials it runs with today."];
  const wrapped = [0, 1, 2].flatMap(row => sentences.flatMap((text, i) => [run(text, 50, 700 - row * 54 - i * 12, 10, 240), run(text, 322, 700 - row * 54 - i * 12, 10, 240)]));
  assert.equal(readingOrder(wrapped), wrapped);
  const code = Array.from({ length: 6 }, (_, i) => [run(`int before_${i} = slice * weight + base;`, 50, 700 - i * 12, 10, 228, true),
    run(`int after_${i} = vruntime + delta * load;`, 322, 700 - i * 12, 10, 228, true)]).flat();
  assert.equal(readingOrder(code), code);
});

test("slides with a bullet list beside a picture keep their order", () => {
  const bullets = [run("Process scheduling", 60, 500, 28, 260),
    ...["• The ready queue holds every runnable task", "• A timer interrupt ends the time slice", "• The scheduler picks the next task to run", "• Context switches save and restore state"]
      .map((text, i) => run(text, 60, 440 - i * 34, 16, text.length * 8))];
  assert.equal(readingOrder(bullets), bullets);
  // Labels inside the picture are not a second column.
  const labelled = [...bullets, run("CPU", 560, 420, 12, 24), run("ready queue", 540, 330, 12, 66), run("timer", 600, 260, 12, 30)];
  assert.equal(readingOrder(labelled), labelled);
});

// Splits row-by-row runs into the left column's runs, then the right column's, the way LaTeX writes a band.
const byColumn = (items: LayoutItem[]) => [...items.filter(item => item.x < 300), ...items.filter(item => item.x > 300)];
// Sorts runs row by row, left to right, the way many other PDF writers emit a page.
const byRow = (items: LayoutItem[]) => [...items].sort((a, b) => b.y - a.y || a.x - b.x);
// A two-column table of one sentence per cell, as a single-column handout sets it beside its prose.
const cells = [["Process", "Thread"], ["Each process owns a separate address space", "All threads share their process address space"],
  ["Creating a process copies its page tables", "Creating a thread only allocates a new stack"], ["Processes talk through pipes or sockets", "Threads talk through shared memory directly"],
  ["A crash in one process leaves the others up", "A crash in one thread brings down the process"], ["Switching processes flushes the TLB first", "Switching threads keeps the same address space"]];

test("a column line running over into the gutter stays in its column", () => {
  // An overfull URL in the left column runs across the gutter into the start of the right column's line.
  const url = "https://example.org/kernel/scheduling/fair-share.html";
  const left = [...leftColumn, url, ...secondLeft], right = [...rightColumn, "Lottery scheduling instead hands out tickets", ...secondRight];
  const items = columnRuns(left, right, 700);
  items.find(item => item.str === url)!.width = 300;
  assert.deepEqual(ordered(items), [...left, ...right]);
  assert.deepEqual(ordered(byColumn(items)), [...left, ...right]);
});

test("a display formula or picture across the page keeps the columns above and below it apart", () => {
  // The formula's pieces are short, and its fraction sits on rows of its own above and below the baseline.
  const formula = [run("E =", 268, 634, 10, 18), run("a+b", 293, 641, 10, 18), run("2m", 296, 627, 10, 12), run("+ c", 318, 634, 10, 14), run("(5)", 542, 634, 10, 15)];
  const above = columnRuns(leftColumn, rightColumn, 700), below = columnRuns(secondLeft, secondRight, 607);
  const expected = [...leftColumn, ...rightColumn, "E =", "a+b", "2m", "+ c (5)", ...secondLeft, ...secondRight];
  assert.deepEqual(ordered([...byColumn(above), ...formula, ...byColumn(below)]), expected);
  assert.deepEqual(ordered([...above, ...formula, ...below]), expected);
  // A picture across the page leaves only a blank strip between the bands, so the page keeps its content order.
  const picture = [...byColumn(above), ...byColumn(columnRuns(secondLeft, secondRight, 520))];
  assert.equal(readingOrder(picture), picture);
});

test("side-by-side tables keep their rows on a single-column page and when they fill a page", () => {
  const prose = (top: number, lines: string[]) => lines.map((text, i) => run(text, 50, top - i * 13, 10, 500));
  const handout = [
    ...prose(700, ["Processes and threads both let a program do several things at once, but they share very different", "amounts of state with each other. The table below compares the two models side by side so that the", "trade-offs are easy to see before we look at how the kernel schedules each of them in practice."]),
    ...cells.flatMap(([a, b], i) => [run(a, 50, 650 - i * 13, 10, a.length * 5), run(b, 322, 650 - i * 13, 10, b.length * 5)]),
    ...prose(560, ["Threads are cheaper to create and switch, while processes isolate failures; most servers mix both", "kinds, using a few processes for isolation and many threads inside each of them for concurrency."]),
  ];
  assert.equal(readingOrder(handout), handout);
  // Cells wrapping without row padding still start together: below the shorter cell its side leaves a gap.
  const rows = [
    [["A process owns an address space, open files and", "the credentials it runs with, all kept apart", "from every other process."], ["Threads of one process share its address space", "and open files."]],
    [["Creating a process copies its page tables, which", "is slow."], ["Creating a thread only allocates a stack and a", "small control block in the kernel, which makes", "it cheap."]],
    [["Processes talk through pipes, sockets or files", "that the kernel mediates."], ["Threads talk through shared memory directly and", "need locks."]],
    [["A crash ends only that process."], ["A crash in one thread brings down every thread", "of the process."]],
  ];
  let y = 700;
  const table = rows.flatMap(cell => {
    const items = cell.flatMap((lines, side) => lines.map((text, i) => run(text, side ? 322 : 50, y - i * 13, 10, text.length * 5)));
    y -= Math.max(...cell.map(lines => lines.length)) * 13;
    return items;
  });
  assert.equal(readingOrder(table), table);
});

test("rows set apart above or below the columns, such as author blocks, stay outside them", () => {
  // Two IEEE-style author blocks centred over the columns, with affiliation lines wider than 8 em.
  const author = (centre: number, lines: string[]) => lines.map((text, i) => run(text, centre - text.length * 2.5, 735 - i * 12, 10, text.length * 5));
  const first = ["Ada Lovelace", "Department of Computer Science", "National Taiwan University", "ada@csie.ntu.edu.tw"];
  const second = ["Alan Turing", "Institute of Networking", "National Tsing Hua University", "alan@cs.nthu.edu.tw"];
  const head = [run("Scheduling in Two Columns", 194, 770, 18, 223), ...author(170, first), ...author(440, second)];
  const body = columnRuns([...leftColumn, ...secondLeft], [...rightColumn, ...secondRight], 668);
  const expected = ["Scheduling in Two Columns", ...first, ...second, ...leftColumn, ...secondLeft, ...rightColumn, ...secondRight];
  assert.deepEqual(ordered([...head, ...body]), expected);
  assert.deepEqual(ordered([...head, ...byColumn(body)]), expected);
  // A running header set apart above headings that open both columns stays in front too, and a footer
  // set apart below short closing lines follows the columns.
  const opened = columnRuns(["1 Scheduling", ...leftColumn], ["2 Fairness", ...rightColumn], 700);
  assert.deepEqual(ordered([run("Preprint, under review", 450, 760, 10, 110), ...opened]), ["Preprint, under review", "1 Scheduling", ...leftColumn, "2 Fairness", ...rightColumn]);
  const left = [...leftColumn.slice(0, 3), "in a ready queue for the scheduler."], right = [...rightColumn.slice(0, 3), "times predictable for users."];
  assert.deepEqual(ordered([...columnRuns(left, right, 700), run("Draft of 8 October 2026", 50, 600, 10, 115)]), [...left, ...right, "Draft of 8 October 2026"]);
});

test("a heading or box title at the top of the next column starts a new paragraph", () => {
  // Two text boxes on a slide, in box order, whose bullets are pictures rather than list glyphs.
  const box = (x: number, title: string, lines: string[], gap = 36) => [run(title, x, 410 + gap, 18, title.length * 10), ...lines.map((text, i) => run(text, x, 410 - i * 30, 16, text.length * 8))];
  const pros = ["Every process is served in turn, none starves", "It is simple to implement with a single queue", "Short jobs that arrive early finish quickly", "Each job runs eventually in order of arrival"];
  const cons = ["Long jobs at the head delay every short job", "Average waiting time can grow very large", "Interactive programs feel slow under heavy load", "It cannot react to priorities or deadlines"];
  const slide = [...box(40, "Advantages", pros), ...box(440, "Disadvantages", cons)];
  const boxes = ["Advantages", pros.join(" "), "Disadvantages", cons.join(" ")].join("\n\n");
  assert.notEqual(readingOrder(slide), slide);
  assert.equal(pageText(buildLines(readingOrder(slide))), boxes);
  // Titles set further apart still start at their boxes' left edges, so they stay with their boxes.
  assert.equal(pageText(buildLines(readingOrder([...box(40, "Advantages", pros, 40), ...box(440, "Disadvantages", cons, 40)]))), boxes);
  // An unnumbered heading at the top of the right column follows a full closing line on the left ...
  const left = [...leftColumn.slice(0, 3), "in a ready queue so that every choice is cheap."];
  const heading = columnRuns(left, ["4 EVALUATION", ...rightColumn], 700);
  assert.equal(pageText(buildLines(readingOrder(heading))).split("\n\n")[1], "4 EVALUATION");
  // ... while a paragraph's short closing line there still carries it on.
  const closing = columnRuns(leftColumn, ["mentation detail.", ...rightColumn], 700);
  closing.find(item => item.str === rightColumn[0])!.x += 15;
  assert.match(pageText(buildLines(readingOrder(closing))), /cheap to implementation detail\.\n\nment\. Round robin/);
});

test("the short last line of a caption across the page stays with the caption above the columns", () => {
  // The last line sits alone, flush with the left column, 4.8 em above the columns.
  const caption = ["Figure 1: Ready queue length over time for the three policies compared in this paper, measured", "on a quad-core machine."];
  const items = [run(caption[0], 50, 760, 10, 470), run(caption[1], 50, 748, 10, 115), ...columnRuns([...leftColumn, ...secondLeft], [...rightColumn, ...secondRight], 700)];
  for (const stored of [items, byColumn(items)]) {
    assert.deepEqual(ordered(stored).slice(2), [...leftColumn, ...secondLeft, ...rightColumn, ...secondRight]);
    assert.equal(pageText(buildLines(readingOrder(stored))).split("\n\n")[0], caption.join(" "));
  }
});

test("gaps that line up across the columns split them only when tall and between prose on every side", () => {
  // Both columns open a section at about the same height, each with 3 em of space above its heading.
  const rows = [700, 687, 674, 661, 631, 618, 605, 592, 579];
  const left = [...leftColumn, "2 Fairness", ...secondLeft], right = [...rightColumn, "3 Trees", ...secondRight];
  const headings = left.flatMap((text, i) => [run(text, 50, rows[i], 10, text.length * 5), run(right[i], 322, rows[i], 10, right[i].length * 5)]);
  assert.deepEqual(ordered(headings), [...left, ...right]);
  // Pictures standing side by side at the top of both columns, under captions set smaller than the prose.
  const captions = ["Fig. 2: Ready queue length on four cores, measured", "over ten runs of the same workload on one machine."];
  const pictures = [...[50, 322].flatMap(x => captions.map((text, i) => run(text, x, 760 - i * 9, 8, 240))), ...columnRuns([...leftColumn, ...secondLeft], [...rightColumn, ...secondRight], 690)];
  assert.deepEqual(ordered(pictures), [...captions, ...leftColumn, ...secondLeft, ...captions, ...rightColumn, ...secondRight]);
});

test("formula pieces, small type or many short paragraphs in prose columns are no table", () => {
  // Each column holds two display formulas at the same heights, set apart above and below, whose pieces are short runs.
  const formula = (x: number, y: number, number: string) => [run("y", x + 80, y, 10, 5), run("=", x + 95, y, 10, 6), run("x + 1", x + 111, y, 10, 25), run(number, x + 220, y, 10, 15)];
  const column = (x: number, lines: string[], numbers: string[]) => [
    ...lines.slice(0, 3).map((text, i) => run(text, x, 700 - i * 13, 10, 240)), ...formula(x, 653, numbers[0]),
    ...lines.slice(3, 6).map((text, i) => run(text, x, 632 - i * 13, 10, 240)), ...formula(x, 585, numbers[1]),
    ...lines.slice(6).map((text, i) => run(text, x, 564 - i * 13, 10, 240))];
  const left = [...leftColumn, ...secondLeft], right = [...rightColumn, ...secondRight];
  const items = byRow([...column(50, left, ["(1)", "(2)"]), ...column(322, right, ["(3)", "(4)"])]);
  assert.deepEqual(ordered(items).filter(text => left.includes(text) || right.includes(text)), [...left, ...right]);
  // Pseudo-code set small above both columns has its own leading, so the prose lines below it are no starts.
  const prose = (x: number, lines: string[], top: number) => lines.map((text, i) => run(text, x, top - i * 13, 10, 240));
  const code = Array.from({ length: 10 }, (_, i) => `${i + 1}: t = next(queue)`);
  const small = [50, 322].flatMap(x => code.map((text, i) => run(text, x, 760 - i * 8, 6, 200)));
  assert.deepEqual(ordered(byRow([...small, ...prose(50, left, 668), ...prose(322, right, 668)])), [...code, ...left, ...code, ...right]);
  // A column of eight short paragraphs beside one of three, two of whose starts line up with its own.
  const many = Array.from({ length: 8 }, (_, p) => [`Paragraph ${p + 1} of the abstract opens with a line`, "that runs on to a second full line", "and a short end."]);
  const few = Array.from({ length: 18 }, (_, k) => [6, 11].includes(k) ? `short end ${k}.` : `line ${k + 1} of the introduction runs on full`);
  const abstract = many.flatMap((lines, p) => lines.map((text, j) => run(text, 50, 682 - p * 45 - j * 13, 10, j === 2 ? 100 : 240)));
  const intro = few.map((text, k) => run(text, 322, 682 - k * 13, 10, text.startsWith("short") ? 100 : 240));
  assert.deepEqual(ordered(byRow([run("Abstract", 50, 700, 10, 40), run("1 Introduction", 322, 700, 10, 70), ...abstract, ...intro])), ["Abstract", ...many.flat(), "1 Introduction", ...few]);
});

test("a sentence carried over to the top of the next column is no heading, in Chinese or after a closing quote", () => {
  const cjk = (text: string, x: number, y: number) => run(text, x, y, 10, [...text].length * 10);
  const left = ["作業系統以行程排程器決定下一個取得中央處理器", "的行程。排程策略必須在產出量、回應時間與公平", "性之間取捨，因此核心通常依工作類型調整時間片", "長度與優先順序，讓互動程式保持流暢，也讓背景", "工作能夠穩定完成。為了兼顧這些目標，Linux 的"];
  const right = (top: string) => [top, "第一種是先到先服務，依抵達順序執行每個工作，", "實作最簡單，但長工作會拖慢後面所有的短工作。", "第二種是時間片輪轉，每個行程輪流取得固定長度", "的時間片，用完就排回佇列尾端等待下一輪執行。"];
  const page = (lines: string[], top: string) => lines.flatMap((text, i) => [cjk(text, 50, 700 - i * 14), cjk(right(top)[i], 322, 700 - i * 14)]);
  const first = (lines: string[], top: string) => pageText(buildLines(readingOrder(page(lines, top)))).split("\n\n")[0];
  assert.equal(first(left, "排程器提供下列三種策略："), left.join("") + "排程器提供下列三種策略：");
  assert.equal(first(left, "排程器提供三種策略"), left.join("") + "排程器提供三種策略");
  // After a closed sentence, a short line of its own still starts a new paragraph.
  const closed = [...left.slice(0, 4), "工作能夠穩定完成，並維持穩定的回應時間與產出。"];
  assert.equal(first(closed, "排程策略的分類"), closed.join(""));
  for (const top of ["Linux kernel calls it “fair.”", "Linux kernel offers two of them:"]) {
    const english = columnRuns([...leftColumn.slice(0, 3), "in a ready queue so the choice stays cheap. The"], [top, ...rightColumn.slice(1)], 700);
    english.find(item => item.str === rightColumn[1])!.x += 15;
    assert.ok(pageText(buildLines(readingOrder(english))).includes(`cheap. The ${top}\n\nof time`));
  }
});

test("a first page reads its short band of columns below a long full-width abstract column by column", () => {
  const abstract = Array.from({ length: 9 }, (_, i) => `Abstract line ${i + 1}: we study how a scheduler trades throughput, latency and fairness on many cores at once.`);
  const items = [run("Fair Scheduling on Many Cores", 180, 760, 20, 280), ...abstract.map((text, i) => run(text, 50, 720 - i * 12, 9, 500)),
    ...columnRuns([...leftColumn, ...secondLeft], [...rightColumn, ...secondRight], 590)];
  assert.deepEqual(ordered(items), ["Fair Scheduling on Many Cores", ...abstract, ...leftColumn, ...secondLeft, ...rightColumn, ...secondRight]);
});

test("a short label in the gutter, such as a figure's tick, does not end a band", () => {
  // A small figure in each column at the same height, one of whose axis labels sits in the gutter.
  const rows = [700, 687, 674, 661, 600, 587, 574, 561];
  const left = [...leftColumn, ...secondLeft], right = [...rightColumn, ...secondRight];
  const items = [...left.flatMap((text, i) => [run(text, 50, rows[i], 10, text.length * 5), run(right[i], 322, rows[i], 10, right[i].length * 5)]),
    run("Fig. 1: Queue length.", 110, 615, 8, 80), run("Fig. 2: Wait time.", 380, 615, 8, 70), run("10", 304, 630, 7, 7)];
  for (const stored of [items, byColumn(items)]) assert.deepEqual(ordered(stored).filter(text => left.includes(text) || right.includes(text)), [...left, ...right]);
});

test("a caption across the page set in small type on a tight leading keeps the bands apart", () => {
  const caption = ["Figure 1: Ready queue length over time for the three policies compared here, measured on four cores",
    "with the default time slice; each curve averages ten runs of the same workload on an idle machine."];
  // Set 7 pt on an 8 or 9 pt leading under 10 pt prose, each caption line lies within 0.9 em of the next.
  for (const leading of [8, 9]) {
    const items = [...columnRuns(leftColumn, rightColumn, 700), ...caption.map((text, i) => run(text, 50, 640 - i * leading, 7, 500)), ...columnRuns(secondLeft, secondRight, 610)];
    assert.deepEqual(ordered(items), [...leftColumn, ...rightColumn, ...caption, ...secondLeft, ...secondRight]);
  }
});

test("CJK two-column pages read column by column without spaces and with radicals restored", () => {
  const source = "作業系統以⾏程排程器決定下一個取得中央處理器的行程。排程策略必須在產出量、回應時間與公平性之間取捨，因此核心通常依工作類型調整時間片長度與優先順序，讓互動程式保持流暢，也讓背景工作能夠穩定完成。多核心系統還要考慮快取親和性與負載平衡，避免行程在處理器之間頻繁搬移。若系統負載升高，排程器也會調整各行程的權重，讓重要服務維持穩定的回應時間，並減少延遲。";
  const chunks = source.match(/.{1,24}/gu)!;
  // Each line is two touching runs, the way CJK text is often split.
  const line = (text: string, x: number, y: number) => [run(text.slice(0, 9), x, y, 10), run(text.slice(9), x + 90, y, 10)];
  const half = Math.ceil(chunks.length / 2);
  const items = chunks.slice(0, half).flatMap((text, i) => [...line(text, 50, 700 - i * 14), ...chunks[half + i] ? line(chunks[half + i], 322, 700 - i * 14) : []]);
  assert.equal(pageText(buildLines(readingOrder(items))), source.replace("⾏", "行"));
});

/** A one-page US Letter PDF whose content stream draws text objects with the standard Helvetica font. */
function helveticaPdf(stream: string): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}
/** Runs a generated one-page PDF through the isolated decoder. */
async function parseGenerated(t: TestContext, stream: string): Promise<ParsedDocument> {
  const directory = await mkdtemp(join(tmpdir(), "bell-columns-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "columns.pdf");
  await writeFile(path, helveticaPdf(stream));
  return parseDocument(path, "pdf", t.signal);
}
const text = (str: string, x: number, y: number, size = 10) => `BT /F1 ${size} Tf ${x} ${y} Td (${str}) Tj ET`;

test("a generated two-column PDF stored row by row is read column by column through the decoder", async t => {
  // Each row draws the left column line, then the right one on the same baseline.
  const rows = (left: string[], right: string[], top: number, indent = 0) => left.flatMap((line, i) => [text(line, 50, top - i * 13), text(right[i], 322 + (i ? 0 : indent), top - i * 13)]);
  const stream = [
    text("Scheduling in Two Columns", 194, 760, 18),
    ...rows(leftColumn, rightColumn, 720),
    text("Figure 1: Ready queue length over time for the three policies compared here.", 50, 640),
    ...rows(secondLeft, secondRight, 600, 15),
    // A vertical margin stamp beside the second band neither counts as a full-width row nor joins a column.
    "BT /F1 20 Tf 0 -1 1 0 30 581 Tm (arXiv:2610.01234v1 [cs.OS] 8 Oct 2026) Tj ET",
    text("7", 303, 40),
  ].join("\n");
  const parsed = await parseGenerated(t, stream);
  assert.equal(parsed.units[0].text, [
    "Scheduling in Two Columns",
    "A scheduler decides which runnable task to run next. Each policy trades throughput, latency and fairness, and the kernel keeps every task in a ready queue so the choice is cheap to implement. Round robin gives each task a fixed slice of time and moves it to the back of the queue when the slice runs out, which keeps response times predictable for interactive programs.",
    "Figure 1: Ready queue length over time for the three policies compared here.",
    "Completely fair scheduling instead tracks the virtual runtime of every task and always picks the task that has so far received the least processor time, so no task waits for too long.",
    "Its red-black tree keeps the lookup cheap even with thousands of runnable tasks, and the same balanced tree idea appears in many kernels and databases that need fast ordered lookups too.",
    "arXiv:2610.01234v1 [cs.OS] 8 Oct 2026",
  ].join("\n\n"));
  assert.ok(parsed.warnings.some(warning => warning.startsWith("1 頁偵測到多欄版面")));
});

test("a generated single-column handout keeps its side-by-side table in row order through the decoder", async t => {
  const prose = (top: number, lines: string[]) => lines.map((line, i) => text(line, 50, top - i * 13));
  const parsed = await parseGenerated(t, [
    ...prose(720, ["Processes and threads both let a program do several things at once, but they share very different amounts", "of state with each other. The table below compares the two models side by side, so that the trade-offs are", "easy to see before we look at how the kernel schedules each of them and what a context switch costs."]),
    ...cells.flatMap(([a, b], i) => [text(a, 50, 670 - i * 13), text(b, 322, 670 - i * 13)]),
    ...prose(580, ["Threads are cheaper to create and to switch, while processes isolate failures from each other; most servers", "mix both kinds, using a few processes for isolation and many threads inside each of them for concurrency."]),
  ].join("\n"));
  assert.match(parsed.units[0].text, /Each process owns a separate address space All threads share their process address space Creating a process/);
  assert.ok(!parsed.warnings.some(warning => warning.includes("多欄版面")));
});

test("a running header split into pieces by column detection still matches the unsplit header", () => {
  const header = (number: number, block?: number) => [{ ...run("Journal of Operating Systems", 50, 815, 9), block }, { ...run(`Vol. 7, No. ${number}`, 480, 815, 9), block: block && block + 1 }];
  const page = (number: number, split = false): LayoutPage => ({ top: 842, bottom: 0, lines: buildLines([...header(number, split ? 1 : undefined), run(`第 ${number} 頁內容`, 50, 600)]) });
  const pages = [page(1), page(2, true), page(3), page(4)];
  assert.deepEqual(pages[1].lines.map(line => line.text), ["Journal of Operating Systems", "Vol. 7, No. 2", "第 2 頁內容"]);
  removeRunningLines(pages);
  assert.deepEqual(pages.map(item => item.lines.map(line => line.text)), [["第 1 頁內容"], ["第 2 頁內容"], ["第 3 頁內容"], ["第 4 頁內容"]]);
});

test("a real CJK lecture PDF yields clean text, bookmarks with page spans and scan-only pages", async t => {
  const parsed = await parseDocument(lecture, "pdf", t.signal);
  const text = parsed.units.map(unit => unit.text).join("\n");
  assert.doesNotMatch(text, /[⺀-⿟]/u, "no radical code points remain");
  assert.doesNotMatch(text, /作業系統講義/, "running header removed");
  assert.doesNotMatch(text, /— \d —/, "page numbers removed");
  assert.match(text, /行程排程決定在多個可執行的行程之間，哪一個行程可以取得中央處理器。/);
  assert.match(text, /this implementation detail/);
  assert.match(text, /def schedule\(ready_queue\):\n {4}while ready_queue:\n {8}task = ready_queue\.pop\(0\)/);
  assert.deepEqual(parsed.imageOnlyUnits, [4]);
  assert.deepEqual(parsed.units.map(unit => unit.number), [1, 2, 3, 5]);
  assert.deepEqual(parsed.outline?.map(entry => [entry.title, entry.depth, entry.start, entry.end]), [
    ["第三章 行程排程", 0, 1, 5], ["3.1 基本概念", 1, 1, 1], ["3.2 排程迴圈", 1, 2, 2], ["3.3 完全公平排程器", 1, 3, 4], ["3.4 本章小結", 1, 5, 5],
  ]);
});

test("page rendering picks required scan pages and skips text-only candidates", async t => {
  const images = await renderPdfPages(lecture, { required: [4], candidates: [1, 2, 3, 5], limit: 8 }, t.signal);
  assert.deepEqual(images.map(image => image.page), [4]);
  assert.equal(images[0].mimeType, "image/png");
  assert.ok(Math.max(images[0].width, images[0].height) <= 1400);
  assert.equal(Buffer.from(images[0].data, "base64").subarray(1, 4).toString(), "PNG");
});

test("password-protected PDFs need the right password, which only travels over IPC", async t => {
  await assert.rejects(parseDocument(locked, "pdf", t.signal), (error: unknown) => error instanceof AppError && error.status === 423 && /輸入密碼/.test(error.message));
  await assert.rejects(parseDocument(locked, "pdf", t.signal, { password: "wrong" }), (error: unknown) => error instanceof AppError && error.status === 423 && /不正確/.test(error.message));
  const parsed = await parseDocument(locked, "pdf", t.signal, { password: "bell-test" });
  assert.equal(parsed.encrypted, true);
  assert.match(parsed.units[0].text, /secret chapter explains semaphores/);
  assert.equal((await renderPdfPages(locked, { required: [1], candidates: [], limit: 1 }, t.signal, { password: "bell-test" })).length, 1);
});

const scanned: ParsedDocument = {
  units: [1, 2, 3, 5, 6].map(number => ({ number, text: `第 ${number} 頁講義內容：排程與同步。` })),
  unitLabel: "page", totalUnits: 6, parsedUnits: 6, extractedChars: 80, warnings: [],
  outline: [{ title: "第一章", depth: 0, start: 1, end: 3 }], imageOnlyUnits: [4],
};
async function service(t: TestContext, parsed: ParsedDocument = scanned) {
  const directory = await mkdtemp(join(tmpdir(), "bell-pdf-test-"));
  const rendered: Array<{ required: number[]; candidates: number[]; password?: string }> = [];
  const passwords: Array<string | undefined> = [];
  const documents = new DocumentService({ directory,
    parser: async (_path, _format, _signal, options) => { passwords.push(options?.password); return parsed; },
    renderer: async (_path, pages, _signal, options) => {
      rendered.push({ required: pages.required, candidates: pages.candidates, password: options?.password });
      return pages.required.map((page): RenderedPage => ({ page, mimeType: "image/png", data: "iVBORw0KGgo=", width: 10, height: 14 }));
    } });
  t.after(async () => { await documents.close(); await rm(directory, { recursive: true, force: true }); });
  const preview = await documents.upload("講義.pdf", Buffer.from("%PDF-1.7 fixture"), t.signal);
  return { documents, preview, rendered, passwords };
}

test("preview exposes bookmarks and scan pages; a page range limits the lesson source", async t => {
  const { documents, preview } = await service(t);
  assert.deepEqual(preview.outline, scanned.outline);
  assert.deepEqual(preview.imageOnlyUnits, [4]);
  assert.equal(preview.encrypted, false);
  const { source, images } = await documents.lessonInput(preview.id, { question: "", range: { start: 2, end: 3 } }, t.signal);
  assert.deepEqual(source.document?.selectedUnits, [2, 3]);
  assert.match(source.content, /^\[第 2 頁\][\s\S]*\[第 3 頁\]/);
  assert.doesNotMatch(source.content, /第 1 頁|第 5 頁/);
  assert.match(source.scope ?? "", /只解說第 2–3 頁/);
  assert.equal(images.length, 0);
  for (const range of [{ start: 0, end: 2 }, { start: 3, end: 2 }, { start: 1, end: 7 }])
    await assert.rejects(documents.lessonInput(preview.id, { question: "", range }, t.signal), /解說範圍/);
});

test("page images cover scans in range, add a placeholder for them and are described in the scope", async t => {
  const { documents, preview, rendered } = await service(t);
  const { source, images } = await documents.lessonInput(preview.id, { question: "同步", range: { start: 3, end: 5 }, visual: true }, t.signal);
  assert.deepEqual(rendered, [{ required: [4], candidates: [3, 5], password: undefined }]);
  assert.deepEqual(images.map(image => image.page), [4]);
  assert.deepEqual(source.document?.selectedUnits, [3, 4, 5]);
  assert.match(source.content, /\[第 4 頁\]\n（此頁沒有可擷取的文字層/);
  assert.match(source.scope ?? "", /另附 1 頁頁面影像（第 4 頁）/);
  // Without page images a scan-only range has nothing to read.
  await assert.rejects(documents.lessonInput(preview.id, { question: "", range: { start: 4, end: 4 } }, t.signal), /附上頁面影像/);
  const text = await documents.lessonInput(preview.id, { question: "", range: { start: 3, end: 5 } }, t.signal);
  assert.match(text.source.scope ?? "", /1 頁沒有文字層，這次未附頁面影像/);
});

test("encrypted PDFs render only with the request's password and never store it", async t => {
  const { documents, preview, rendered, passwords } = await service(t, { ...scanned, encrypted: true });
  assert.equal(preview.encrypted, true);
  const missing = await documents.lessonInput(preview.id, { question: "", visual: true }, t.signal);
  assert.equal(rendered.length, 0);
  assert.match(missing.source.scope ?? "", /沒有附上頁面影像/);
  await documents.lessonInput(preview.id, { question: "", visual: true, password: "bell-test" }, t.signal);
  assert.equal(rendered[0].password, "bell-test");
  assert.deepEqual(passwords, [undefined]);
  assert.doesNotMatch(JSON.stringify(await documents.get(preview.id)), /bell-test/);
});

test("upload route forwards the password header to the decoder and rejects invalid values", async t => {
  const directory = await mkdtemp(join(tmpdir(), "bell-pdf-route-test-"));
  const seen: Array<string | undefined> = [];
  const documents = new DocumentService({ directory, parser: async (_path, _format, _signal, options) => {
    seen.push(options?.password);
    if (options?.password !== "bell-test") throw new AppError(423, "這份 PDF 有密碼保護，請輸入密碼後開啟。");
    return { ...scanned, encrypted: true };
  } });
  const app = express();
  app.use("/api", createDocumentRouter(documents, () => false));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => { res.status(error instanceof AppError ? error.status : 500).json({ error: error instanceof Error ? error.message : "failed" }); });
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await documents.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/documents`;
  const upload = (password?: string) => fetch(url, { method: "POST", body: "%PDF-1.7 locked", headers: { "Content-Type": "application/octet-stream", "X-Document-Name": encodeURIComponent("加密.pdf"),
    ...(password === undefined ? {} : { "X-Document-Password": encodeURIComponent(password) }) } });
  assert.equal((await upload()).status, 423);
  const opened = await upload("bell-test");
  assert.equal(opened.status, 201);
  assert.equal((await opened.json()).encrypted, true);
  assert.equal((await upload("x".repeat(257))).status, 400);
  assert.deepEqual(seen, [undefined, "bell-test"]);
});

test("document range, page images and password are accepted only for document lessons", () => {
  const base = { kind: "document", content: "", depth: "beginner", documentId: "7f8d1c2e-4b5a-4c3d-9e8f-1a2b3c4d5e6f" };
  assert.equal(requestSchema.safeParse({ ...base, documentRange: { start: 2, end: 9 }, documentVisual: true, documentPassword: "pw" }).success, true);
  assert.equal(requestSchema.safeParse({ ...base, documentRange: { start: 9, end: 2 } }).success, false);
  assert.equal(requestSchema.safeParse({ kind: "code", content: "const a = 1", depth: "beginner", documentVisual: true }).success, false);
});

test("page citations keep their written ranges and only small spans become page markers", () => {
  const ranges = citedRanges("見第 1–34 頁與第 46-50 頁，重點在第 4 頁；第 4 頁另有圖。附錄 p. 120 與第 999 頁不存在。", 135);
  assert.deepEqual(ranges, [{ start: 1, end: 34 }, { start: 4, end: 4 }, { start: 46, end: 50 }, { start: 120, end: 120 }]);
  assert.deepEqual(markedPages(ranges), []);
  assert.deepEqual(markedPages(citedRanges("第 3 頁和第 5 至第 6 頁", 10)), [3, 5, 6]);
  assert.deepEqual(citedRanges("第 8–200 頁", 10), [{ start: 8, end: 10 }]);
});

test("inspecting a real PDF counts drawings per page in the isolated decoder", async () => {
  const metrics = await inspectPdfPages(lecture, new AbortController().signal);
  const parsed = await parseDocument(lecture, "pdf", new AbortController().signal);
  assert.equal(metrics.length, parsed.totalUnits);
  assert.ok(metrics.every((page, index) => page.page === index + 1 && page.images >= 0 && page.paths >= 0 && page.gaps >= 0));
  await assert.rejects(inspectPdfPages(locked, new AbortController().signal), /密碼/);
  assert.equal((await inspectPdfPages(locked, new AbortController().signal, { password: "bell-test" })).length > 0, true);
});
