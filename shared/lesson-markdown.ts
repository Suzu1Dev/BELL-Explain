import type { Lesson, LessonAnnotation, LessonSection, RubikIllustrationSpec, Source } from "./types.js";
import { figureLines, isLessonV3, type Figure, type LessonNoteV3, type StoredLesson, type Step } from "./lesson-v3.js";

// A longer fence preserves examples that themselves contain Markdown fences.
function fenced(content: string, language = "text"): string {
  let longest = 0;
  for (const [run] of content.matchAll(/`+/g)) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  const hint = language.replace(/[^a-zA-Z0-9_+#.-]/g, "").slice(0, 40);
  return `${fence}${hint}\n${content}\n${fence}`;
}

function sectionMarkdown(section: LessonSection): string[] {
  const example = section.codeExample;
  return [
    `## ${section.heading}`,
    section.body,
    ...(example
      ? [
          `### 小完整案例：${example.title}`,
          `**使用情境**：${example.scenario}`,
          `**執行環境**：${example.environment}`,
        ]
      : []),
    section.code ? fenced(section.code, section.language) : "",
    ...(example
      ? [
          "**逐段白話解說**",
          ...example.walkthrough.map((step, index) => {
            const lines = step.startLine === step.endLine
              ? `第 ${step.startLine} 行`
              : `第 ${step.startLine}–${step.endLine} 行`;
            return `${index + 1}. **${lines}**：${step.explanation}`;
          }),
          "**預期輸出（依程式推導，未執行）**",
          fenced(example.expectedOutput),
          `**實際應用**：${example.application}`,
        ]
      : []),
    section.analogy ? `> 換個方式想：${section.analogy}` : "",
  ];
}

function illustrationMarkdown(illustration: RubikIllustrationSpec, sections: LessonSection[]): string[] {
  const views = { space: "位置與角塊", moves: "轉面操作", search: "狀態鄰居與搜尋" };
  return [
    `## 互動立體圖解：${illustration.title}`,
    illustration.caption,
    "圖解類型：2×2×2 魔術方塊；BELL 依固定數學規則繪製的互動示意，未執行來源程式或完整 BFS。",
    "範例建立方式：從已解狀態依序套用下列操作（不是求解答案）。",
    fenced(illustration.setupMoves.length ? illustration.setupMoves.join(" ") : "已解狀態；不套用操作"),
    "位置慣例：+x 為右、+y 為上、+z 為前。前層左上順時針為 0、1、2、3；背層從前方穿透看為左上 7、右上 4、右下 5、左下 6；角塊 0 是固定參照。R／B／D 的順時針以該面外側視角為準。",
    ...(illustration.focus?.length ? [
      "段落對應模式：",
      ...illustration.focus.map(item => `- 第 ${item.sectionIndex + 1} 段「${sections[item.sectionIndex]?.heading || "未提供標題"}」：${views[item.view]}`),
    ] : []),
  ];
}

function annotationMarkdown(annotation: LessonAnnotation, index: number): string[] {
  // All user/model text stays literal, including Markdown, HTML and nested fences.
  return [
    `### 詞彙解說 ${index + 1}`,
    "**詞彙**",
    fenced(annotation.term),
    "**來源位置**",
    fenced(annotation.sourceKey),
    "**來源引文**",
    fenced(annotation.quote),
    "**白話解說**",
    fenced(annotation.explanation),
    "**生活比喻**",
    fenced(annotation.analogy),
    ...(annotation.example ? ["**範例**", fenced(annotation.example)] : []),
    "**建立時間**",
    fenced(annotation.createdAt),
  ];
}

/** Notes related to this one, resolved by the caller because titles live in other notes. */
export interface MarkdownRelation { title: string; label: string; reason: string; }

/** Source, annotations and related notes: the same closing for both formats. */
function closingMarkdown(source: Source, annotations: LessonAnnotation[] | undefined, related: MarkdownRelation[]): string[] {
  return [
    "## 來源",
    source.label,
    source.url || "",
    source.scope || "",
    ...(source.document ? [
      "### 檔案資訊",
      fenced(`檔名：${source.document.name}\n格式：${source.document.format.toUpperCase()}\n大小：${source.document.size} bytes\nSHA-256：${source.document.sha256}\n實際擷取：${source.document.parsedUnits} / ${source.document.totalUnits} ${({ page: "頁", slide: "張投影片", section: "段" })[source.document.unitLabel]}\n解說選用位置：${source.document.selectedUnits.join("、")}\n${source.document.warnings.join("\n")}`),
      "此匯出包含解說使用的文字與檔案資訊；原始附件保留在上傳它的 BELL 伺服器。",
    ] : []),
    fenced(source.content),
    ...(annotations?.length ? [
      "## 詞彙解說筆記",
      ...annotations.flatMap(annotationMarkdown),
    ] : []),
    ...(related.length ? [
      "## 相關筆記",
      related.map((item) => `- ${item.label}《${item.title}》：${item.reason}`).join("\n"),
    ] : []),
  ];
}

// Table cells keep their text; only what would end the cell or the row is escaped.
const cell = (value: string | undefined) => (value ?? "").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const row = (values: Array<string | undefined>) => `| ${values.map(cell).join(" | ")} |`;
const table = (head: string[], rows: Array<Array<string | undefined>>) => [row(head), row(head.map(() => "---")), ...rows.map(row)].join("\n");
const change = (value: { from?: string; to: string } | undefined) => !value ? "" : value.from === undefined ? value.to : `${value.from} → ${value.to}`;

function figureMarkdown(figure: Figure): string[] {
  switch (figure.kind) {
    case "annotated-code":
      return [
        figure.file ? `**${figure.file}**` : "",
        fenced(figure.source, figure.language),
        figure.notes.map(note => `- 第 ${note.line} 行：${note.text}`).join("\n"),
        ...(figure.output !== undefined ? ["**輸出**", fenced(figure.output)] : []),
      ];
    case "state": {
      const code = figure.rows.some(item => item.code);
      const output = figure.rows.some(item => item.output !== undefined);
      return [
        figure.caption || "",
        table(
          ["時刻", ...(code ? ["程式"] : []), ...figure.vars, ...(output ? ["輸出"] : [])],
          figure.rows.map(item => [item.moment, ...(code ? [item.code] : []), ...figure.vars.map(name => change(item.values[name])), ...(output ? [item.output] : [])]),
        ),
      ];
    }
    case "compare":
      return [
        table(
          ["", ...figure.items.map(item => `${item.title}${item.tone === "wrong" ? "（誤解）" : item.tone === "right" ? "（正解）" : ""}`)],
          figure.rows.map(item => [item.label, ...item.values]),
        ),
        figure.verdict || "",
      ];
    case "sequence":
    case "timeline":
    case "keyfact": {
      // One line per event or row, as in search; the caption, when there is one, comes first.
      const lines = figureLines(figure);
      const caption = figure.kind !== "keyfact" && figure.caption ? lines.shift() : undefined;
      return [caption || "", lines.map(line => figure.kind === "sequence" ? line : `- ${line}`).join("\n")];
    }
    case "d2":
      return [
        figure.title ? `**${figure.title}**` : "",
        fenced(figure.source, "d2"),
        figure.caption || "",
      ];
    case "rubik-2x2":
      return [
        `**互動立體圖解：${figure.title}**`,
        figure.caption,
        fenced(figure.setupMoves.length ? figure.setupMoves.join(" ") : "已解狀態；不套用操作"),
      ];
  }
}

function stepMarkdown(step: Step): string[] {
  return [
    `## ${step.lead}`,
    step.body,
    ...(step.figure ? figureMarkdown(step.figure) : []),
    step.analogy ? `> ${step.analogy.title}：${step.analogy.text}` : "",
    ...(step.deeper ? [`**深入：${step.deeper.summary}**`, step.deeper.body] : []),
    `**回想**：${step.recall.question}`,
    `答案：${step.recall.answer}`,
  ];
}

function lessonV3Markdown(lesson: LessonNoteV3, related: MarkdownRelation[]): string {
  return [
    `# ${lesson.title}`,
    lesson.isDemo ? "> 人工編寫的示範筆記" : "> AI 生成筆記，請搭配來源核對",
    `分類：${lesson.category} · ${lesson.tags.join(" / ")}`,
    `**${lesson.question}**`,
    lesson.answer,
    ...lesson.steps.flatMap(stepMarkdown),
    ...(lesson.followUps.length ? ["## 延伸問題", lesson.followUps.map(question => `- ${question}`).join("\n")] : []),
    ...closingMarkdown(lesson.source, lesson.annotations, related),
  ].filter(Boolean).join("\n\n");
}

/** A note as Markdown. Original-format notes export exactly as before; v3 notes export step by step. */
export function lessonMarkdown(lesson: StoredLesson, related: MarkdownRelation[] = []): string {
  if (isLessonV3(lesson)) return lessonV3Markdown(lesson, related);
  return [
    `# ${lesson.title}`,
    lesson.subtitle,
    lesson.isDemo ? "> 人工編寫的示範筆記" : "> AI 生成筆記，請搭配來源核對",
    `分類：${lesson.category} · ${lesson.tags.join(" / ")}`,
    lesson.summary,
    ...lesson.sections.flatMap(sectionMarkdown),
    `## 動畫圖解：${lesson.visual.title}`,
    ...lesson.visual.steps.map(
      (step, index) =>
        `${index + 1}. **${step.title}**：${step.description}${step.output ? `\n   輸出：${step.output}` : ""}`,
    ),
    ...(lesson.visual.illustration ? illustrationMarkdown(lesson.visual.illustration, lesson.sections) : []),
    ...closingMarkdown(lesson.source, lesson.annotations, related),
  ].filter(Boolean).join("\n\n");
}
