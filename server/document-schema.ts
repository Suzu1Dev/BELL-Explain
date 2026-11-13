import { z } from "zod";
import { DOCUMENT_MAX_BYTES, DOCUMENT_MAX_CHARS } from "../shared/documents.js";

export const documentSourceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(255),
  format: z.enum(["pdf", "docx", "pptx", "txt", "md"]),
  mimeType: z.string().min(1).max(150),
  size: z.number().int().min(1).max(DOCUMENT_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  unitLabel: z.enum(["page", "slide", "section"]),
  totalUnits: z.number().int().min(1).max(1_000_000),
  parsedUnits: z.number().int().min(1).max(10_000),
  // A scan-only PDF has no text layer: its pages are read as images.
  extractedChars: z.number().int().min(0).max(DOCUMENT_MAX_CHARS),
  warnings: z.array(z.string().max(2000)).max(30),
  createdAt: z.string().datetime(),
  selectedUnits: z.array(z.number().int().min(1).max(1_000_000)).min(1).max(10_000),
}).strict().superRefine((value, ctx) => {
  if (value.parsedUnits > value.totalUnits || value.selectedUnits.length > value.parsedUnits ||
    value.selectedUnits.some(unit => unit > value.totalUnits) || new Set(value.selectedUnits).size !== value.selectedUnits.length)
    ctx.addIssue({ code: "custom", message: "文件來源範圍不一致。" });
});
