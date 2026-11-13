import type { CubeMove } from "./rubik.js";
import type { DocumentRange, DocumentSource } from "./documents.js";
import type { StoredLesson } from "./lesson-v3.js";

export type SourceKind = "code" | "repo" | "article" | "concept" | "url" | "document";
export type Depth = "beginner" | "intermediate" | "advanced";
export interface Source {
  kind: SourceKind;
  content: string;
  label: string;
  url?: string;
  scope?: string;
  truncated?: boolean;
  fetchedAt?: string;
  document?: DocumentSource;
}
export interface CodeExample {
  title: string;
  scenario: string;
  environment: string;
  walkthrough: {
    startLine: number;
    endLine: number;
    explanation: string;
    /** Optional watch snapshot at this breakpoint, e.g. "count = 1, timerId = 2". */
    state?: string;
    /** Optional stdout emitted when execution reaches this breakpoint. */
    output?: string;
  }[];
  expectedOutput: string;
  application: string;
}
export interface LessonSection {
  id: string;
  heading: string;
  body: string;
  analogy: string;
  code: string;
  language: string;
  codeExample?: CodeExample;
  concepts: string[];
  visualStep: number;
}
export interface VisualNode {
  id: string;
  label: string;
  detail: string;
}
export interface VisualStep {
  title: string;
  description: string;
  activeNodeIds: string[];
  output: string;
  activeEdgeIds?: string[];
  nodeStates?: { nodeId: string; value: string; items: string[] }[];
}
export interface VisualScene {
  layout: "flow" | "sequence" | "memory" | "layers" | "timeline";
  edges: {
    id: string;
    from: string;
    to: string;
    label: string;
    type: "data" | "reference" | "call" | "return" | "control";
  }[];
  groups: { id: string; label: string; nodeIds: string[] }[];
}
export interface RubikIllustrationSpec {
  kind: "rubik-2x2";
  title: string;
  caption: string;
  /** Apply these moves from the solved state; this is not a solution sequence. */
  setupMoves: CubeMove[];
  focus?: {
    sectionIndex: number;
    view: "space" | "moves" | "search";
  }[];
}
export interface Visual {
  kind: "flow" | "closure" | "event-loop" | "debounce";
  title: string;
  caption: string;
  nodes: VisualNode[];
  steps: VisualStep[];
  scene?: VisualScene;
  illustration?: RubikIllustrationSpec;
}
export interface Connection {
  targetId: string;
  sectionId: string;
  reason: string;
}
export interface LessonAnnotation {
  id: string;
  term: string;
  explanation: string;
  analogy: string;
  example?: string;
  sourceKey: string;
  quote: string;
  createdAt: string;
}
export interface AnnotationRequest {
  term: string;
  sourceKey: string;
  quote: string;
}
export interface Lesson {
  id: string;
  title: string;
  subtitle: string;
  summary: string;
  category: string;
  tags: string[];
  source: Source;
  sections: LessonSection[];
  visual: Visual;
  connections: Connection[];
  followUpQuestions: string[];
  createdAt: string;
  updatedAt: string;
  isDemo: boolean;
  favorite: boolean;
  annotations?: LessonAnnotation[];
  /** The note whose follow-up question this note answers. */
  parentLessonId?: string;
  /**
   * 3 when this note was meant to be lesson format 3 and was saved in this format instead,
   * because both attempts failed the writing guide or the source was too large for that
   * prompt. The reader shows 「整理失敗」 for it, and 整理成新格式 (L1.7) finds notes by it.
   */
  failedFormat?: 3;
}
export interface GenerateRequest {
  kind: SourceKind;
  content: string;
  depth: Depth;
  exampleId?: string;
  indexedRepoId?: string;
  documentId?: string;
  question?: string;
  documentRange?: DocumentRange;
  documentVisual?: boolean;
  documentPassword?: string;
  /** Continue from this saved note: the model builds on it instead of repeating it. */
  parentLessonId?: string;
}
/** Server events carry any saved note; readers branch on `format` (see shared/lesson-v3.ts). */
export type GenerateEvent<L = StoredLesson> =
  | {
      type: "stage";
      stage: "read" | "analyze" | "teach" | "organize";
      message: string;
    }
  | { type: "complete"; lesson: L }
  | { type: "error"; message: string; status?: number }
  /** First line of a job stream: the id to follow it again after a dropped connection. */
  | { type: "job"; id: string }
  /** Outcome of a deep reading: how many pages of the document were read. */
  | { type: "read"; documentId: string; pages: number };
/** reformat: 整理成新格式, an original-format note written again in format 3 (L1.7). */
export type JobKind = "generate" | "examples" | "reading" | "reformat";
/** Model work running on the server, independent of the request that started it. */
export interface JobView {
  id: string;
  kind: JobKind;
  /** What is being made, for progress shown on other pages and devices. */
  title: string;
  /** For examples and reformat: the note being changed; once done: the resulting note. */
  lessonId?: string;
  /** For deep reading: the document being read. */
  documentId?: string;
  /** For deep reading, once done: pages read in this run. */
  pagesRead?: number;
  status: "running" | "done" | "failed" | "cancelled";
  stage?: "read" | "analyze" | "teach" | "organize";
  message?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}
export interface AppConfig {
  configured: boolean;
  model: string;
  storage: string;
  provider?: "codex" | "claude" | "antigravity" | "api";
  effort?: string;
  speed?: "default" | "fast" | "ultrafast";
  message?: string;
  /** BELL_LESSON_V3 is on: new notes are written in format 3, and 整理成新格式 is available. */
  lessonV3?: boolean;
}
