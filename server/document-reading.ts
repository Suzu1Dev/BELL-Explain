import { z } from "zod";
import { DOCUMENT_READING_BATCH, type PageReading } from "../shared/documents.js";
import type { GenerateEvent } from "../shared/types.js";
import type { ChatCall } from "./ai.js";
import type { DocumentService, ReadingPlan } from "./documents.js";
import { withGenerationProgress } from "./generation-progress.js";
import { logEvent } from "./log.js";
import { transcriptionMathRule } from "./prompts/math.js";
import { validatedWithRepair } from "./repair.js";

export const READING_TIMEOUT_MS = 2 * 60 * 60_000;
const readingSchema = z.object({
  pages: z.array(z.object({
    page: z.number().int().min(1),
    text: z.string().max(12_000),
    visuals: z.array(z.object({
      kind: z.enum(["chart", "diagram", "table", "formula", "photo", "other"]),
      description: z.string().trim().min(1).max(1_200),
    }).strict()).max(12),
  }).strict()).min(1).max(DOCUMENT_READING_BATCH),
}).strict();

const instruction = `逐頁閱讀附上的 PDF 頁面影像，為每一頁寫出可以取代 PDF 文字層的轉寫，供之後的解說、搜尋與自我檢查使用。
text：依人閱讀的順序完整轉寫頁面上的文字（多欄版面先左欄再右欄，由上而下），保留標題、條列與表格（表格用 Markdown 表格），不要摘要、不要改寫、不要補充頁面上沒有的內容。${transcriptionMathRule}程式碼照原樣保留縮排。看不清楚的字寫「［無法辨識］」，不要猜。
visuals：列出頁面上的圖表、示意圖、表格、公式或照片；description 用繁體中文說明它呈現什麼：圖表寫出座標軸、單位、數值與趨勢；示意圖寫出元件與箭頭代表的關係；公式寫出符號的意義與它在說什麼。只描述看得到的內容，純文字頁面回傳空陣列。
extractedText 是同一頁的 PDF 文字層，可能缺少符號、順序錯亂或是空的；可用它校對拼字，但以影像為準。
每一頁都要回傳，page 必須是 pages 中的頁碼。只回傳 JSON。JSON schema：${JSON.stringify(z.toJSONSchema(readingSchema))}`;

/**
 * Reads the visual pages of a PDF with the model, a few pages per call, and keeps
 * each batch as soon as it is read: a cancel, a timeout or a restart loses only
 * the batch in progress, and the next run continues with what is left.
 */
export async function runDeepReading(
  documents: DocumentService,
  id: string,
  plan: ReadingPlan,
  password: string | undefined,
  chat: ChatCall,
  signal: AbortSignal,
  emit: (event: GenerateEvent) => void,
  progressIntervalMs?: number,
): Promise<{ pages: number; more: number }> {
  let done = 0;
  for (let start = 0; start < plan.pages.length; start += DOCUMENT_READING_BATCH) {
    signal.throwIfAborted();
    const batch = plan.pages.slice(start, start + DOCUMENT_READING_BATCH);
    const label = batch.length > 1 ? `第 ${batch[0].page}–${batch.at(-1)!.page} 頁` : `第 ${batch[0].page} 頁`;
    const status = `正在深度解析${label}（已完成 ${done}/${plan.pages.length} 頁）`;
    emit({ type: "stage", stage: "teach", message: `${status}。` });
    // Waiting messages keep saying which pages are being read and how far along the run is.
    const reading = withGenerationProgress(chat, (event) => emit(event.type === "stage" ? { ...event, message: `${status}：${event.message.replace(/^文件深度解析代理/, "模型")}` } : event), progressIntervalMs);
    const images = await documents.renderPages(id, batch.map(item => item.page), signal, password);
    signal.throwIfAborted();
    const pages = batch.filter(item => images.some(image => image.page === item.page));
    if (!pages.length) continue;
    const parsed = await validatedWithRepair({
      schema: readingSchema,
      name: "文件深度解析代理",
      message: "深度解析的回覆格式不完整，這一批頁面沒有儲存。",
      chat: reading,
      signal,
      value: await reading(
        "文件深度解析代理",
        instruction,
        { document: plan.name, pages: pages.map(item => ({ page: item.page, extractedText: item.text.slice(0, 4_000) })) },
        signal,
        undefined,
        images.map(image => ({ mimeType: image.mimeType, data: image.data, label: `第 ${image.page} 頁影像` })),
      ),
    });
    signal.throwIfAborted();
    const wanted = new Set(pages.map(item => item.page));
    const at = new Date().toISOString();
    // Blank pages are kept too (with nothing on them), so the next run does not read them again.
    const readings: PageReading[] = parsed.pages
      .filter((page, index, all) => wanted.has(page.page) && all.findIndex(other => other.page === page.page) === index)
      .map(page => ({ page: page.page, text: page.text, visuals: page.visuals, at }));
    if (readings.length < pages.length) logEvent("document.reading_missing", { id, missing: pages.length - readings.length });
    await documents.saveReadings(id, readings);
    done += readings.length;
  }
  emit({ type: "stage", stage: "organize", message: `深度解析完成：${done} 頁。` });
  return { pages: done, more: plan.more };
}
