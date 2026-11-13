import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { parseDocument, DOCUMENT_MAX_BYTES, DOCUMENT_MAX_CHARS } from "./document-parser.js";
import { AppError } from "./errors.js";
import type { DocumentFormat } from "../shared/documents.js";

async function fixture(t: TestContext, bytes: Buffer | string, format: DocumentFormat) {
  const dir = await mkdtemp(join(tmpdir(), "bell-document-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, `document.${format}`);
  await writeFile(path, bytes);
  return { path, parse: () => parseDocument(path, format, t.signal) };
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
// Small real ZIP fixtures, independent of the production ZIP reader.
function zip(entries: Array<[string, string | Buffer]>, compress = false): Buffer {
  const files: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const filename = Buffer.from(name);
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const content = compress ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(compress ? 8 : 0, 8);
    header.writeUInt32LE(crc32(bytes), 14); header.writeUInt32LE(content.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    files.push(header, filename, content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(compress ? 8 : 0, 10);
    directory.writeUInt32LE(crc32(bytes), 16); directory.writeUInt32LE(content.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + content.length;
  }
  const centralBuffer = Buffer.concat(central);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(entries.length, 8); footer.writeUInt16LE(entries.length, 10); footer.writeUInt32LE(centralBuffer.length, 12); footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, centralBuffer, footer]);
}
function docx(xml: string, extra: Array<[string, string]> = []): Buffer {
  return zip([
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'],
    ["word/document.xml", xml], ...extra,
  ], true);
}
const word = (body: string) => `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
function pptx(slides: Array<{ id: string; filename: string; text: string }>, order = slides.map(slide => slide.id)): Buffer {
  return zip([
    ["[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>'],
    ["ppt/presentation.xml", `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst>${order.map((id, i) => `<p:sldId id="${256 + i}" r:id="${id}"/>`).join("")}</p:sldIdLst></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map(slide => `<Relationship Id="${slide.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/${slide.filename}"/>`).join("")}</Relationships>`],
    ...slides.map(slide => [`ppt/slides/${slide.filename}`, `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><a:p><a:r><a:t>${slide.text}</a:t></a:r></a:p></p:spTree></p:cSld></p:sld>`] as [string, string]),
  ], true);
}
function pdf(pages: string[]): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  for (const text of pages) {
    // Body text sits mid-page; the top and bottom edges are reserved for running headers.
    const stream = text ? `BT /F1 12 Tf 50 400 Td (${text}) Tj ET` : "";
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  let output = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

test("UTF-8 Markdown and UTF-16 text preserve real paragraph references", async t => {
  const markdown = await fixture(t, "# 技術規格\n這裡說明 API。\n\n回傳格式：JSON。", "md");
  const parsed = await markdown.parse();
  assert.equal(parsed.unitLabel, "section");
  assert.deepEqual(parsed.units, [{ number: 1, text: "# 技術規格\n這裡說明 API。" }, { number: 2, text: "回傳格式：JSON。" }]);
  assert.equal(parsed.extractedChars, parsed.units.reduce((sum, unit) => sum + unit.text.length, 0));
  const utf16 = await fixture(t, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("繁體中文講義", "utf16le")]), "txt");
  assert.equal((await utf16.parse()).units[0].text, "繁體中文講義");
});

test("PDF text extracts page numbers, marks pages without a text layer, and rejects invalid documents", async t => {
  const document = await fixture(t, pdf(["Technical specification", "", "Second chapter"]), "pdf");
  const parsed = await document.parse();
  assert.equal(parsed.unitLabel, "page");
  assert.equal(parsed.totalUnits, 3);
  assert.equal(parsed.parsedUnits, 3);
  assert.deepEqual(parsed.units, [{ number: 1, text: "Technical specification" }, { number: 3, text: "Second chapter" }]);
  assert.ok(parsed.warnings.some(warning => warning.includes("1 頁沒有")));
  assert.deepEqual(parsed.imageOnlyUnits, [2]);
  // A scan-only PDF is accepted; its pages can be read later as page images.
  const blank = await fixture(t, pdf([""]), "pdf");
  const scanned = await blank.parse();
  assert.deepEqual(scanned.units, []);
  assert.deepEqual(scanned.imageOnlyUnits, [1]);
  assert.ok(scanned.warnings.some(warning => warning.includes("沒有文字層")));
  const invalid = await fixture(t, "This is not a PDF", "pdf");
  await assert.rejects(invalid.parse(), /不是有效的 PDF/);
});

test("PDF stops after 1,000 pages with explicit partial-content warning", async t => {
  const document = await fixture(t, pdf(Array.from({ length: 1001 }, (_, i) => `Chapter ${i + 1}`)), "pdf");
  const parsed = await document.parse();
  assert.equal(parsed.totalUnits, 1001);
  assert.equal(parsed.parsedUnits, 1000);
  assert.equal(parsed.units.at(-1)?.number, 1000);
  assert.ok(parsed.warnings.some(warning => warning.includes("前 1000 頁")));
});

test("DOCX extracts ordered runs, Unicode XML references, tables, and logical sections", async t => {
  const document = await fixture(t, docx(word('<w:p><w:r><w:t>規格 &amp; &#x4E2D;&#25991;</w:t><w:tab/><w:t>API</w:t></w:r><w:r><w:br/><w:t>second line</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格內容</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')), "docx");
  const parsed = await document.parse();
  assert.equal(parsed.unitLabel, "section");
  assert.deepEqual(parsed.units, [{ number: 1, text: "規格 & 中文\tAPI\nsecond line" }, { number: 2, text: "表格內容" }]);
  assert.ok(parsed.warnings.some(warning => warning.includes("不代表原始頁碼")));
});

test("DOCX reads a text box once, as a section of its own", async t => {
  // Word writes a text box for current readers in mc:Choice and again as an older shape in mc:Fallback.
  const box = (wrapper: string) => `<${wrapper}><w:txbxContent><w:p><w:r><w:t>方框文字</w:t></w:r></w:p></w:txbxContent></${wrapper}>`;
  const document = await fixture(t, docx(word(`<w:p><w:r><w:t>正文。</w:t></w:r><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="wps">${box("wps:txbx")}</mc:Choice><mc:Fallback>${box("v:textbox")}</mc:Fallback></mc:AlternateContent></w:r></w:p><w:p><w:r><w:t>下一段</w:t></w:r></w:p>`)), "docx");
  assert.deepEqual((await document.parse()).units, [{ number: 1, text: "正文。" }, { number: 2, text: "方框文字" }, { number: 3, text: "下一段" }]);
});

test("a Word file with very many paragraphs keeps the first 10,000, and long blank runs parse quickly", async t => {
  const document = await fixture(t, docx(word("<w:p><w:r><w:t>a</w:t></w:r></w:p>".repeat(130_000))), "docx");
  const parsed = await document.parse();
  assert.equal(parsed.parsedUnits, 10_000);
  assert.ok(parsed.warnings.some(warning => warning.includes("前 10000 個")));
  // Trailing blanks are trimmed per line in linear time; a run not ending a line stays.
  const started = performance.now();
  const text = await fixture(t, `前${" ".repeat(300_000)}x \n下一行\t\t`, "txt");
  assert.deepEqual((await text.parse()).units, [{ number: 1, text: `前${" ".repeat(300_000)}x\n下一行` }]);
  assert.ok(performance.now() - started < 5_000);
});

test("PPTX follows relationship order, not ZIP order or slide filenames", async t => {
  const document = await fixture(t, pptx([{ id: "rA", filename: "slide1.xml", text: "Second" }, { id: "rB", filename: "slide10.xml", text: "First" }], ["rB", "rA"]), "pptx");
  const parsed = await document.parse();
  assert.equal(parsed.unitLabel, "slide");
  assert.deepEqual(parsed.units, [{ number: 1, text: "First" }, { number: 2, text: "Second" }]);
});

test("PPTX limits extraction to 200 slides and labels the omitted slides", async t => {
  const document = await fixture(t, pptx(Array.from({ length: 201 }, (_, i) => ({ id: `r${i}`, filename: `slide${i}.xml`, text: `Slide ${i + 1}` }))), "pptx");
  const parsed = await document.parse();
  assert.equal(parsed.totalUnits, 201);
  assert.equal(parsed.parsedUnits, 200);
  assert.equal(parsed.units.at(-1)?.text, "Slide 200");
  assert.ok(parsed.warnings.some(warning => warning.includes("前 200 張")));
});

test("PPTX past 200 slides decompresses only the slides it keeps", async t => {
  // 300 slides of 150 KB exceed the 40 MB decompression budget; the first 200 fit in it.
  const padding = `<!--${"x".repeat(150_000)}-->`;
  const document = await fixture(t, pptx(Array.from({ length: 300 }, (_, i) => ({ id: `r${i}`, filename: `slide${i}.xml`, text: `Slide ${i + 1}${padding}` }))), "pptx");
  const parsed = await document.parse();
  assert.equal(parsed.totalUnits, 300);
  assert.equal(parsed.parsedUnits, 200);
  assert.equal(parsed.units.at(-1)?.text, "Slide 200");
});

test("Office validates container metadata and XML before extracting text", async t => {
  for (const [bytes, message] of [
    [zip([["word/document.xml", word("<w:p/>")]]), /損毀|副檔名/],
    [docx(word("<w:p><w:r><w:t>invalid</w:p>")), /損毀|副檔名/],
    [docx('<!DOCTYPE document><w:document/>'), /XML 宣告/],
    [docx(word("<w:p/>")), /沒有可擷取/],
    [docx(word("<w:p/>"), [["word/document.xml", "duplicate"]]), /重複/],
    [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), /密碼保護或舊格式/],
  ] as Array<[Buffer, RegExp]>) {
    const document = await fixture(t, bytes, "docx");
    await assert.rejects(document.parse(), message);
  }
});

test("bounded decompression rejects oversized Office XML before parsing", async t => {
  const document = await fixture(t, docx(word(`<w:p><w:r><w:t>${"a".repeat(12 * 1024 * 1024)}</w:t></w:r></w:p>`)), "docx");
  await assert.rejects(document.parse(), /解壓後.*過大/);
});

test("text extraction caps stored characters with an explicit partial-content warning", async t => {
  const document = await fixture(t, "a".repeat(DOCUMENT_MAX_CHARS + 20), "txt");
  const parsed = await document.parse();
  assert.equal(parsed.extractedChars, DOCUMENT_MAX_CHARS);
  assert.equal(parsed.units[0].text.length, DOCUMENT_MAX_CHARS);
  assert.ok(parsed.warnings.some(warning => warning.includes(DOCUMENT_MAX_CHARS.toLocaleString("en-US"))));
});

test("empty, oversized and binary text files fail with useful typed errors", async t => {
  const empty = await fixture(t, "", "txt");
  await assert.rejects(empty.parse(), (error: unknown) => error instanceof AppError && error.status === 422 && /空的/.test(error.message));
  const large = await fixture(t, Buffer.alloc(DOCUMENT_MAX_BYTES + 1, 65), "txt");
  await assert.rejects(large.parse(), (error: unknown) => error instanceof AppError && error.status === 413);
  const binary = await fixture(t, Buffer.from([0, 1, 2, 3]), "txt");
  await assert.rejects(binary.parse(), /二進位/);
  const encoding = await fixture(t, Buffer.from([0xff, 0xfe, 0xff]), "txt");
  await assert.rejects(encoding.parse(), /編碼/);
});

test("pre-cancelled and in-flight decoders abort; a deadline terminates decoding", async t => {
  const document = await fixture(t, pdf(Array.from({ length: 200 }, () => "Document")), "pdf");
  const already = new AbortController(); already.abort();
  await assert.rejects(parseDocument(document.path, "pdf", already.signal), { name: "AbortError" });
  const controller = new AbortController();
  const pending = parseDocument(document.path, "pdf", controller.signal);
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(parseDocument(document.path, "pdf", t.signal, { timeoutMs: 1 }), /解析超過/);
  assert.equal((await document.parse()).units.length, 200);
});
