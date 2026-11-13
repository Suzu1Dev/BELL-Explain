import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import yauzl, { type Entry } from "yauzl";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { restoreCjkRadicals } from "./cjk-radicals.js";
import { DOCUMENT_MAX_MB, DOCUMENT_MAX_SLIDES, DOCUMENT_MAX_VISUAL_PAGES, type DocumentFormat, type DocumentOutlineEntry } from "../shared/documents.js";
import { AppError } from "./errors.js";
import { DOCUMENT_MAX_BYTES, DOCUMENT_MAX_CHARS, DOCUMENT_MAX_PAGES, type PageMetrics, type ParsedDocument, type RenderedPage, type WorkerRequest } from "./document-parser.js";
import { buildLines, isMonospaceRun, pageText, readingOrder, removeRunningLines, type LayoutPage } from "./pdf-layout.js";

const MAX_XML_BYTES = 12 * 1024 * 1024;
const MAX_ZIP_BYTES = 40 * 1024 * 1024;
const MAX_ENTRIES = 10_000;
const MAX_SECTIONS = 10_000;
const MAX_PAGE_IMAGES = 100;
type XmlNode = Record<string, unknown>;
const charLimit = `${DOCUMENT_MAX_CHARS.toLocaleString("en-US")} 字元`;
const invalidOffice = () => new AppError(422, "Office 文件內容損毀或與副檔名不符。請使用原編輯器重新儲存成 DOCX 或 PPTX 後再上傳。");

/** `line` without trailing spaces and tabs, in linear time: a regex retries a long blank run from each of its characters. */
function trimLineEnd(line: string): string {
  let end = line.length;
  while (end && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return line.slice(0, end);
}
function normalized(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").split("\n").map(trimLineEnd).join("\n").trim();
}
function finish(units: ParsedDocument["units"], unitLabel: ParsedDocument["unitLabel"], totalUnits: number, parsedUnits: number, warnings: string[], pdf?: Pick<ParsedDocument, "outline" | "imageOnlyUnits" | "encrypted">): ParsedDocument {
  const kept = units.filter(unit => unit.text.trim());
  // Scanned PDF pages are kept as page numbers and read later as page images.
  if (!kept.length && !pdf?.imageOnlyUnits?.length) throw new AppError(422, "文件中沒有可擷取的文字。若內容是圖片或掃描講義，請先進行 OCR，或匯出成包含文字的文件。");
  return { units: kept, unitLabel, totalUnits, parsedUnits, extractedChars: kept.reduce((sum, unit) => sum + unit.text.length, 0), warnings: [...new Set(warnings)], ...pdf };
}
function capUnits(texts: string[], unitLabel: ParsedDocument["unitLabel"], warnings: string[], limit = MAX_SECTIONS): ParsedDocument {
  const units: ParsedDocument["units"] = [];
  let left = DOCUMENT_MAX_CHARS;
  let parsed = 0;
  for (const [i, source] of texts.entries()) {
    if (parsed >= limit || !left) break;
    const text = normalized(source);
    const clipped = text.slice(0, left);
    units.push({ number: i + 1, text: clipped });
    left -= clipped.length;
    parsed++;
    if (clipped.length < text.length) warnings.push(`文件文字超過 ${charLimit}，僅保留前段內容；解說不涵蓋未擷取的部分。`);
  }
  if (parsed < texts.length) warnings.push(left === 0
    ? `文件文字超過 ${charLimit}，僅保留前段內容；解說不涵蓋未擷取的部分。`
    : `文件超過 ${limit} 個${unitLabel === "slide" ? "投影片" : "段落"}，僅擷取前 ${limit} 個。`);
  return finish(units, unitLabel, texts.length, parsed, warnings);
}
function decodeText(bytes: Buffer, xml = false): string {
  let encoding = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = "utf-16be";
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new AppError(422, xml ? "文件的 XML 文字編碼無法讀取，請重新匯出文件。" : "文字檔不是有效的 UTF-8 或含 BOM 的 UTF-16 編碼，請另存為 UTF-8 後再上傳。"); }
}
function xmlNodes(bytes: Buffer): XmlNode[] {
  const xml = decodeText(bytes, true);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new AppError(422, "文件包含不支援的 XML 宣告，請重新匯出為標準 DOCX 或 PPTX。");
  if (XMLValidator.validate(xml) !== true) throw invalidOffice();
  return new XMLParser({ preserveOrder: true, ignoreAttributes: false, processEntities: false, trimValues: false, parseTagValue: false, parseAttributeValue: false }).parse(xml) as XmlNode[];
}
// Only predefined/numeric XML character references are decoded, once; no user-defined entities.
function xmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, token => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (token in named) return named[token];
    const code = token.startsWith("&#x") ? Number.parseInt(token.slice(3, -1), 16) : Number.parseInt(token.slice(2, -1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "";
  });
}
/** Pushes `children` so they pop in document order; a loop, as spreading a long list overflows the call stack. */
function pushChildren(stack: XmlNode[], children: XmlNode[]) {
  for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]);
}
// Word writes a text box twice: for current readers in mc:Choice, and as an older shape in mc:Fallback.
const FALLBACK = "mc:Fallback";
function elements(nodes: XmlNode[], name: string): XmlNode[] {
  const found: XmlNode[] = [];
  const stack: XmlNode[] = [];
  pushChildren(stack, nodes);
  while (stack.length) {
    const node = stack.pop()!;
    if (Object.hasOwn(node, name)) found.push(node);
    for (const [key, value] of Object.entries(node)) if (key !== ":@" && key !== FALLBACK && Array.isArray(value)) pushChildren(stack, value as XmlNode[]);
  }
  return found;
}
/** A paragraph's own text; paragraphs in its text boxes are found by elements() and read on their own. */
function paragraphText(nodes: XmlNode[], prefix: "w" | "a"): string {
  let text = "";
  const stack: XmlNode[] = [];
  pushChildren(stack, nodes);
  while (stack.length) {
    const node = stack.pop()!;
    for (const [key, value] of Object.entries(node)) {
      if (key === `${prefix}:t` && Array.isArray(value)) {
        for (const part of value as XmlNode[]) if (typeof part["#text"] === "string") text += xmlText(part["#text"]);
      } else if (key === `${prefix}:tab`) text += "\t";
      else if (key === `${prefix}:br` || key === `${prefix}:cr`) text += "\n";
      else if (key !== ":@" && key !== "w:del" && key !== "w:txbxContent" && key !== FALLBACK && Array.isArray(value)) pushChildren(stack, value as XmlNode[]);
    }
  }
  return text;
}
function attributes(node: XmlNode): Record<string, string> { return (node[":@"] || {}) as Record<string, string>; }

/** The `wanted` entries of an Office file, decompressed within the size limits. */
async function readOffice(path: string, wanted: (name: string) => boolean): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) { reject(invalidOffice()); return; }
      const files = new Map<string, Buffer>();
      const names = new Set<string>();
      let totalBytes = 0;
      let entries = 0;
      let done = false;
      const fail = (reason: unknown) => { if (!done) { done = true; zip.close(); reject(reason instanceof AppError ? reason : invalidOffice()); } };
      zip.on("error", fail);
      zip.on("end", () => { if (!done) { done = true; zip.close(); resolve(files); } });
      zip.on("entry", (entry: Entry) => {
        if (done) return;
        if (++entries > MAX_ENTRIES || names.has(entry.fileName)) { fail(new AppError(422, "文件包含過多或重複的封裝項目，請分段或重新匯出文件。")); return; }
        names.add(entry.fileName);
        if (entry.generalPurposeBitFlag & 1) { fail(new AppError(422, "不支援加密或密碼保護的 Office 文件，請先解除密碼後再上傳。")); return; }
        if (!wanted(entry.fileName)) { zip.readEntry(); return; }
        if (entry.uncompressedSize > MAX_XML_BYTES || totalBytes + entry.uncompressedSize > MAX_ZIP_BYTES) {
          fail(new AppError(422, "文件解壓後的文字結構過大，請拆成較小的文件再上傳。")); return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) { fail(streamError); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("error", fail);
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            totalBytes += chunk.length;
            if (size > MAX_XML_BYTES || totalBytes > MAX_ZIP_BYTES) { stream.destroy(); fail(new AppError(422, "文件解壓後的文字結構過大，請拆成較小的文件再上傳。")); }
            else chunks.push(chunk);
          });
          stream.on("end", () => { if (!done) { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); } });
        });
      });
      zip.readEntry();
    });
  });
}
async function parseOffice(path: string, format: "docx" | "pptx"): Promise<ParsedDocument> {
  // Slides are read once the presentation says which ones come first: a deck past the
  // slide limit must not fail on the size of slides it never keeps.
  const files = await readOffice(path, name => name === "[Content_Types].xml" || (format === "docx" ? name === "word/document.xml" :
    name === "ppt/presentation.xml" || name === "ppt/_rels/presentation.xml.rels"));
  const contentTypes = files.get("[Content_Types].xml");
  if (!contentTypes) throw invalidOffice();
  const declarations = elements(xmlNodes(contentTypes), "Override").map(attributes);
  const requiredType = format === "docx" ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" : "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
  const mainPath = format === "docx" ? "word/document.xml" : "ppt/presentation.xml";
  if (!declarations.some(item => xmlText(item["@_PartName"] || "") === `/${mainPath}` && item["@_ContentType"] === requiredType)) throw invalidOffice();
  const main = files.get(mainPath);
  if (!main) throw invalidOffice();
  const nodes = xmlNodes(main);
  const warnings = ["目前擷取文件文字；圖片、圖表、公式的視覺內容與原始版面不會自動辨識。"];
  if (format === "docx") {
    if (!elements(nodes, "w:document").length) throw invalidOffice();
    warnings.push("DOCX 以正文段落標示來源，不代表原始頁碼；頁首頁尾、註腳與註解不包含在本次擷取中。");
    return capUnits(elements(nodes, "w:p").map(node => paragraphText(node["w:p"] as XmlNode[], "w")), "section", warnings);
  }
  const relBytes = files.get("ppt/_rels/presentation.xml.rels");
  if (!relBytes) throw invalidOffice();
  const rels = new Map<string, string>();
  for (const rel of elements(xmlNodes(relBytes), "Relationship").map(attributes)) {
    if (rel["@_TargetMode"] === "External" || !rel["@_Type"]?.endsWith("/slide")) continue;
    const target = xmlText(rel["@_Target"] || "");
    const resolved = target.startsWith("/") ? target.slice(1) : posix.normalize(`ppt/${target}`);
    if (!/^ppt\/slides\/[^/]+\.xml$/.test(resolved) || /[:\\?#]/.test(target)) throw invalidOffice();
    if (rels.has(rel["@_Id"])) throw invalidOffice();
    rels.set(rel["@_Id"], resolved);
  }
  const ids = elements(nodes, "p:sldId").map(node => attributes(node)["@_r:id"]);
  if (!elements(nodes, "p:presentation").length || !ids.length || new Set(ids).size !== ids.length) throw invalidOffice();
  const kept = new Set(ids.slice(0, DOCUMENT_MAX_SLIDES).map(id => rels.get(id) || ""));
  const slides = await readOffice(path, name => kept.has(name));
  const texts: string[] = [];
  for (const id of ids.slice(0, DOCUMENT_MAX_SLIDES)) {
    const slide = slides.get(rels.get(id) || "");
    if (!slide) throw invalidOffice();
    texts.push(elements(xmlNodes(slide), "a:p").map(node => paragraphText(node["a:p"] as XmlNode[], "a")).join("\n"));
  }
  warnings.push("投影片依簡報中的實際順序擷取；講者備註與嵌入附件不包含在本次擷取中。");
  const result = capUnits(texts, "slide", warnings, DOCUMENT_MAX_SLIDES);
  if (ids.length > DOCUMENT_MAX_SLIDES) result.warnings.push(`簡報共有 ${ids.length} 張投影片，僅擷取前 ${DOCUMENT_MAX_SLIDES} 張。`);
  result.totalUnits = ids.length;
  const empty = texts.filter(text => !text.trim()).length;
  if (empty) result.warnings.push(`${empty} 張投影片沒有可擷取文字，圖像內容尚未辨識。`);
  return result;
}
type PdfDocument = Awaited<ReturnType<typeof import("pdfjs-dist/legacy/build/pdf.mjs")["getDocument"]>["promise"]>;
async function openPdf(bytes: Buffer, password?: string) {
  if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) throw new AppError(422, "檔案內容不是有效的 PDF，請檢查檔案或重新匯出。");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const packageRoot = new URL("../node_modules/pdfjs-dist/", import.meta.url);
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), password, useSystemFonts: false,
    disableFontFace: true, useWorkerFetch: false, enableXfa: false, stopAtErrors: true, verbosity: 0,
    cMapUrl: fileURLToPath(new URL("cmaps/", packageRoot)), cMapPacked: true,
    standardFontDataUrl: fileURLToPath(new URL("standard_fonts/", packageRoot)),
    wasmUrl: fileURLToPath(new URL("wasm/", packageRoot)),
  });
  try { return { pdfjs, task, document: await task.promise }; }
  catch (error) {
    await task.destroy();
    if (error instanceof Error && error.name === "PasswordException")
      throw new AppError(423, (error as Error & { code?: number }).code === 2 ? "PDF 密碼不正確，請重新輸入。" : "這份 PDF 有密碼保護，請輸入密碼後開啟。密碼只用於這次讀取，不會儲存。");
    throw new AppError(422, "PDF 無法完整解析，可能已損毀或使用不支援的編碼。請重新匯出成可選取文字的 PDF 後重試。");
  }
}
/** Bookmarks within the first `pages` pages, the ones parsed; a range past them could not be explained. */
async function readOutline(document: PdfDocument, pages: number): Promise<DocumentOutlineEntry[]> {
  const outline = await document.getOutline().catch(() => null);
  const flat: Array<Omit<DocumentOutlineEntry, "end">> = [];
  const visit = async (items: NonNullable<typeof outline>, depth: number) => {
    for (const item of items) {
      if (flat.length >= 500) return;
      let page: number | undefined;
      try {
        const dest = typeof item.dest === "string" ? await document.getDestination(item.dest) : item.dest;
        const ref = Array.isArray(dest) ? dest[0] : undefined;
        if (ref && typeof ref === "object") page = await document.getPageIndex(ref as Parameters<PdfDocument["getPageIndex"]>[0]) + 1;
        else if (Number.isInteger(ref)) page = (ref as number) + 1;
      } catch { /* A bookmark pointing outside the file is skipped. */ }
      const title = restoreCjkRadicals(normalized(item.title || "").replace(/\s+/g, " ")).slice(0, 200);
      if (page && page >= 1 && page <= pages && title) flat.push({ title, depth, start: page });
      if (depth < 3 && item.items?.length) await visit(item.items, depth + 1);
    }
  };
  if (outline?.length) await visit(outline, 0);
  return flat.map((entry, index) => {
    const next = flat.slice(index + 1).find(other => other.depth <= entry.depth);
    return { ...entry, end: Math.max(entry.start, next ? next.start - 1 : pages) };
  });
}
async function parsePdf(bytes: Buffer, password?: string): Promise<ParsedDocument> {
  const { task, document } = await openPdf(bytes, password);
  const warnings = ["PDF 依文字位置重組段落並移除重複的頁首頁尾；掃描頁、圖表與公式可在解說時以頁面影像交給模型閱讀。"];
  try {
    const limit = Math.min(document.numPages, DOCUMENT_MAX_PAGES);
    if (limit < document.numPages) warnings.push(`PDF 共有 ${document.numPages} 頁，僅擷取前 ${DOCUMENT_MAX_PAGES} 頁。`);
    const pages: LayoutPage[] = [];
    let lineChars = 0, columnPages = 0;
    for (let number = 1; number <= limit; number++) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        const items = content.items.flatMap(item => {
          if (!("str" in item)) return [];
          const [a, b, c, d, x, y] = item.transform;
          const size = Math.hypot(c, d) || item.height;
          // Rotated text, such as a vertical margin stamp, only covers its horizontal projection.
          const width = item.width * Math.abs(a) / (Math.hypot(a, b) || 1);
          return [{ str: item.str, x, y, width, size,
            mono: isMonospaceRun(content.styles[item.fontName]?.fontFamily, item.str, item.width, size) }];
        });
        const [, y0, , y1] = page.view;
        const ordered = readingOrder(items);
        if (ordered !== items) columnPages++;
        const lines = buildLines(ordered);
        pages.push({ top: Math.max(y0, y1), bottom: Math.min(y0, y1), lines });
        lineChars += lines.reduce((sum, line) => sum + line.text.length, 0);
      } finally { page.cleanup(); }
      // Layout only shortens text, so this bound keeps every page that can fit.
      if (lineChars > DOCUMENT_MAX_CHARS * 1.2) break;
    }
    if (columnPages) warnings.push(`${columnPages} 頁偵測到多欄版面，已改為逐欄由上而下閱讀；圖文交錯或排版特殊的頁面仍可能需要對照原檔。`);
    removeRunningLines(pages);
    const units: ParsedDocument["units"] = [];
    const imageOnlyUnits: number[] = [];
    let left = DOCUMENT_MAX_CHARS;
    for (const [index, page] of pages.entries()) {
      if (!left) break;
      const text = normalized(pageText(page.lines));
      if (!text) imageOnlyUnits.push(index + 1);
      units.push({ number: index + 1, text: text.slice(0, left) });
      if (text.length > left) warnings.push(`文件文字超過 ${charLimit}，僅保留前段內容；解說不涵蓋未擷取的部分。`);
      left -= Math.min(left, text.length);
    }
    if (imageOnlyUnits.length) warnings.push(imageOnlyUnits.length === units.length
      ? "這份 PDF 沒有文字層（可能是掃描檔）。解說時會把頁面影像交給 Codex、Claude Code 或 Antigravity 閱讀；相容 API 模式無法閱讀。"
      : `${imageOnlyUnits.length} 頁沒有文字層（可能是掃描頁或整頁圖片），解說時可把這些頁面影像交給模型閱讀。`);
    const outline = await readOutline(document, units.length);
    return finish(units, "page", document.numPages, units.length, warnings, { outline, imageOnlyUnits, encrypted: Boolean(password) });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, "PDF 無法完整解析，可能已損毀或使用不支援的編碼。請重新匯出成可選取文字的 PDF 後重試。");
  } finally { await task.destroy(); }
}
/** Renders the most visual pages: required pages first, then candidates with images or drawings. */
async function renderPdf(path: string, request: Extract<WorkerRequest, { command: "render" }>): Promise<RenderedPage[]> {
  const { pdfjs, task, document } = await openPdf(await readFile(path), request.password);
  try {
    const valid = (page: number) => Number.isInteger(page) && page >= 1 && page <= document.numPages;
    const limit = Math.min(request.limit, DOCUMENT_MAX_VISUAL_PAGES);
    const chosen = [...new Set(request.required.filter(valid))].slice(0, limit);
    if (request.ranked) for (const number of request.candidates.filter(valid)) if (chosen.length < limit && !chosen.includes(number)) chosen.push(number);
    const scored: Array<{ page: number; score: number; order: number }> = [];
    for (const [order, number] of [...new Set(request.ranked ? [] : request.candidates.filter(valid))].entries()) {
      if (chosen.includes(number) || scored.length >= 40) continue;
      const page = await document.getPage(number);
      try {
        const { fnArray } = await page.getOperatorList();
        let images = 0, paths = 0;
        for (const fn of fnArray) {
          if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject) images++;
          else if (fn === pdfjs.OPS.constructPath) paths++;
        }
        // Underlines and table rules draw a few paths; diagrams draw many.
        const score = images * 10 + (paths >= 15 ? paths : 0);
        if (score > 0) scored.push({ page: number, score, order });
      } finally { page.cleanup(); }
    }
    scored.sort((a, b) => b.score - a.score || a.order - b.order);
    for (const item of scored) if (chosen.length < limit) chosen.push(item.page);
    const images: RenderedPage[] = [];
    for (const number of chosen.sort((a, b) => a - b)) {
      const page = await document.getPage(number);
      try {
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(3, request.maxEdge / Math.max(base.width, base.height)) });
        const width = Math.ceil(viewport.width), height = Math.ceil(viewport.height);
        // In Node, pdf.js draws through its bundled @napi-rs/canvas factory.
        const factory = (document as unknown as { canvasFactory: { create(width: number, height: number): { canvas: { toBuffer(type: string, quality?: number): Buffer }; context: unknown } } }).canvasFactory;
        const { canvas, context } = factory.create(width, height);
        await page.render({ canvasContext: context as never, canvas: canvas as never, viewport }).promise;
        let data = canvas.toBuffer("image/png"), mimeType = "image/png";
        // Photos and scans compress poorly as PNG.
        if (data.length > 900_000) { data = canvas.toBuffer("image/jpeg", 85); mimeType = "image/jpeg"; }
        images.push({ page: number, mimeType, data: data.toString("base64"), width, height });
      } finally { page.cleanup(); }
    }
    return images;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, "無法產生 PDF 頁面影像，請改用文字解說或重新匯出 PDF。");
  } finally { await task.destroy(); }
}
/**
 * Per page: images, drawn paths and wide gaps inside text lines. Slide templates
 * draw the same few shapes on every page, so callers compare against the
 * document's typical page; formulas drawn as graphics leave gaps in the text.
 */
async function inspectPdf(path: string, password?: string, limit = DOCUMENT_MAX_PAGES): Promise<PageMetrics[]> {
  const { pdfjs, task, document } = await openPdf(await readFile(path), password);
  try {
    const metrics: PageMetrics[] = [];
    // Pages past the parsed ones are not part of the document as far as lessons go.
    for (let number = 1; number <= Math.min(document.numPages, DOCUMENT_MAX_PAGES, limit); number++) {
      const page = await document.getPage(number);
      try {
        const { fnArray, argsArray } = await page.getOperatorList();
        let images = 0, paths = 0;
        const sizes: string[] = [];
        const shared: string[] = [];
        for (const [index, fn] of fnArray.entries()) {
          if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject || fn === pdfjs.OPS.paintImageMaskXObject) {
            images++;
            // XObjects carry [id, width, height]; inline and mask images carry an object with width and height.
            const args = argsArray[index] as unknown[] | undefined;
            const image = args?.[0] as { width?: number; height?: number } | string | undefined;
            const width = typeof image === "object" && image ? image.width : Number(args?.[1]);
            const height = typeof image === "object" && image ? image.height : Number(args?.[2]);
            // A page can draw one icon thousands of times: past a page's worth of figures,
            // more sizes only grow document.json beyond what it can be read back at.
            if (Number.isFinite(width) && Number.isFinite(height) && sizes.length < MAX_PAGE_IMAGES) {
              sizes.push(`${width}x${height}`);
              // pdf.js gives an image used on several pages one document-wide id ("<doc>_img_…");
              // ids of images drawn on one page only start with "img_".
              if (typeof image === "string" && !image.startsWith("img_") && image.includes("_img_") && !shared.includes(`${image}=${width}x${height}`)) shared.push(`${image}=${width}x${height}`);
            }
          } else if (fn === pdfjs.OPS.constructPath) paths++;
        }
        const content = await page.getTextContent();
        let gaps = 0;
        let previous: { x: number; y: number; end: number; size: number } | undefined;
        for (const item of content.items) {
          if (!("str" in item) || !item.str.trim()) continue;
          const size = Math.hypot(item.transform[2], item.transform[3]) || item.height || 10;
          const x = item.transform[4], y = item.transform[5];
          // Text resuming on the same line after a wide blank: something was drawn there.
          if (previous && Math.abs(y - previous.y) < Math.max(size, previous.size) * 0.45 && x - previous.end > Math.max(size, previous.size) * 2.5) gaps++;
          previous = { x, y, end: x + item.width, size };
        }
        metrics.push({ page: number, images, paths, gaps, sizes, shared });
      } finally { page.cleanup(); }
    }
    return metrics;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, "無法檢查 PDF 的圖表頁面。");
  } finally { await task.destroy(); }
}
async function parse(path: string, format: DocumentFormat, password?: string): Promise<ParsedDocument> {
  const bytes = await readFile(path);
  if (bytes.length > DOCUMENT_MAX_BYTES) throw new AppError(413, `檔案大小超過 ${DOCUMENT_MAX_MB} MB，請拆成較小的文件再上傳。`);
  if (format === "pdf") return parsePdf(bytes, password);
  if (format === "docx" || format === "pptx") {
    if (bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
      throw new AppError(422, "這是密碼保護或舊格式的 Office 文件。請先解除密碼，並另存為 DOCX 或 PPTX 後再上傳。");
    }
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw invalidOffice();
    return parseOffice(path, format);
  }
  const text = decodeText(bytes);
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new AppError(422, "檔案包含二進位內容，不是可讀取的文字檔。請選擇正確的文件格式。");
  const paragraphs = text.replace(/\r\n?/g, "\n").split(/\n[\t ]*\n+/).filter(part => part.trim());
  return capUnits(paragraphs, "section", []);
}

// This module is only executed by the isolated decoder process, never imported by the API.
// The request (including any PDF password) arrives over IPC, never in argv or env.
process.once("message", (message: unknown) => {
  const request = message as WorkerRequest;
  const work = request.command === "render" ? renderPdf(request.path, request)
    : request.command === "inspect" ? inspectPdf(request.path, request.password, request.limit)
    : parse(request.path, request.format, request.password);
  void work.then(
    result => process.send?.({ result }, () => process.exit(0)),
    error => process.send?.({ error: { status: error instanceof AppError ? error.status : 422,
      message: error instanceof AppError ? error.message : "文件無法解析，請確認內容有效或重新匯出後再上傳。" } }, () => process.exit(1)),
  );
});
