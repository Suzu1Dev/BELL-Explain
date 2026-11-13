import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  Code2,
  Clock,
  Command,
  CornerDownRight,
  Eye,
  FileText,
  FolderClosed,
  GitBranch,
  GitPullRequest,
  LayoutGrid,
  Lightbulb,
  Link,
  ListTodo,
  LoaderCircle,
  Menu,
  Moon,
  MoreHorizontal,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Repeat,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  AppConfig,
  Depth,
  GenerateEvent,
  JobView,
  Lesson,
  LessonSection,
  SourceKind,
} from "../shared/types";
import { DEPTHS } from "../shared/depth-rubric";
import { figureLines, isLessonV3, type StoredLesson } from "../shared/lesson-v3";
import { exampleLessons } from "../shared/examples";
import { getDemoCodeExample } from "../shared/demo-code-examples";
import LessonV3Reader from "./components/learning/LessonV3Reader";
import { fill, learningCopy } from "./copy/learning";
import { api, exportLesson, generate, enhanceExamples, readDocument, reformatLesson, resumeJob, JobFailure } from "./lib/api";
import CodeBlock from "./components/CodeBlock";
import ConceptAnimation from "./components/ConceptAnimation";
import RubikIllustration from "./components/RubikIllustration";
import KnowledgeGraph from "./components/KnowledgeGraph";
import ModelSettings from "./components/ModelSettings";
import SyncSettings from "./components/SyncSettings";
import EmbeddingSettings from "./components/EmbeddingSettings";
import RepositoryWorkspace from "./components/RepositoryWorkspace";
import SemanticSearch from "./components/SemanticSearch";
import PracticalExample from "./components/PracticalExample";
import ReadingAnnotations, { AnnotatedText } from "./components/ReadingAnnotations";
import MathText, { ProseBlocks } from "./components/MathText";
import { mergeRefreshedLessons } from "../shared/lesson-state";
import type { DocumentPreview } from "../shared/documents";
import DocumentUpload, { DocumentOriginal, type DocumentLessonChoice } from "./components/DocumentUpload";
import type { PdfTarget } from "./components/PdfViewer";
import { citedRanges, linkPages, markedPages } from "./lib/page-references";
import { usePredictMode } from "./lib/predict";
import RelatedNotes from "./components/RelatedNotes";
import { markdownRelations, relatedNotes } from "./lib/related-notes";
import { lastRead, saveReadingProgress } from "./lib/reading-progress";
import SelfCheck from "./components/SelfCheck";
import ReviewSession from "./components/ReviewSession";
import type { ReviewCardView } from "../shared/learning";
import SuiteSourceBanner from "./components/SuiteSourceBanner";
import {
  EXPLAIN_HANDOFF_KEY,
  explainNoteRoute,
  hasExplainHandoff,
  hashPath,
  normalizeExplainHandoff,
  parseExplainHandoff,
  personalDraftHref,
  prDraftHref,
  sanitizeSuiteLinks,
  type ExplainHandoff,
  type SuiteLinks,
} from "./lib/suite";
import { reviewFailure, reviewRefresh, reviewSuccess, type ReviewState } from "./lib/review-state";
import Select from "./ui/Select";

// pdf.js loads only when a PDF lesson is opened.
const PdfViewer = lazy(() => import("./components/PdfViewer"));
const PreciseSwitcher = lazy(() => import("./ui/SuiteSwitcher"));
const Sheet = lazy(() => import("./ui/Sheet"));

type Route =
  | { page: "home" | "explain" | "library" | "graph" | "favorites" | "repositories" | "review" }
  | { page: "note"; id: string; section?: string };
const modes: {
  id: SourceKind;
  label: string;
  icon: LucideIcon;
  placeholder: string;
}[] = [
  { id: "code", label: "程式碼", icon: Code2, placeholder: "貼上程式碼" },
  { id: "repo", label: "GitHub Repo", icon: GitBranch, placeholder: "https://github.com/owner/repository" },
  { id: "document", label: "檔案", icon: FileText, placeholder: "上傳文件" },
  { id: "article", label: "文章", icon: FileText, placeholder: "貼上文章內容" },
  { id: "concept", label: "概念", icon: Lightbulb, placeholder: "問一個問題" },
  { id: "url", label: "網址", icon: Link, placeholder: "https://..." },
];
const stageLabels = [
  { id: "read", label: "讀取來源", detail: "掌握內容與範圍", icon: FileText },
  {
    id: "analyze",
    label: "拆解概念",
    detail: "找到理解的關鍵",
    icon: Waypoints,
  },
  {
    id: "teach",
    label: "生成解說",
    detail: "文字、範例與動畫",
    icon: Sparkles,
  },
  {
    id: "organize",
    label: "連結知識",
    detail: "分類並儲存筆記",
    icon: BookOpen,
  },
];

function readRoute(): Route {
  const parts = hashPath(window.location.hash).split("/").filter(Boolean);
  if (parts[0] === "note" && parts[1]) {
    try {
      return {
        page: "note",
        id: decodeURIComponent(parts[1]),
        section: parts[2] ? decodeURIComponent(parts[2]) : undefined,
      };
    } catch {
      return { page: "library" };
    }
  }
  return {
    page: ["explain", "library", "graph", "favorites", "repositories", "review"].includes(parts[0])
      ? (parts[0] as "explain" | "library" | "graph" | "favorites" | "repositories" | "review")
      : "home",
  };
}
const cleanHeading = (heading: string) =>
  heading.replace(/^\d+\s*[\/．.、：:]\s*/, "");
const SIDEBAR_COLLAPSED_KEY = "bell.sidebar.collapsed";
const COMPOSER_KEY = "bell.composer";
/** The last source type and depth, so the composer starts where the learner left off. */
function savedComposer(): { kind?: SourceKind; depth?: Depth } {
  try {
    const value = JSON.parse(localStorage.getItem(COMPOSER_KEY) || "{}") as { kind?: unknown; depth?: unknown };
    return {
      kind: modes.some((mode) => mode.id === value.kind) ? (value.kind as SourceKind) : undefined,
      depth: typeof value.depth === "string" && value.depth in DEPTHS ? (value.depth as Depth) : undefined,
    };
  } catch {
    return {};
  }
}
/**
 * The address navigate() just set, until its hashchange is handled. Focus coming
 * back during that gap (a closing dialog) must not overwrite it.
 */
let pendingNavigation: string | undefined;
const JOB_KEY = "bell.job";
const formatCopy = () => learningCopy().lesson.moreMenu;
/**
 * The lesson job this tab started, so a reload can pick it up and report how it
 * ended. Per tab (sessionStorage): another tab or device only watches it.
 */
function rememberJob(id: string) {
  try { sessionStorage.setItem(JOB_KEY, id); } catch { /* Other tabs' jobs are still shown from the server. */ }
}
function forgetJob() {
  try { sessionStorage.removeItem(JOB_KEY); } catch { /* Nothing to forget. */ }
}
function savedJob(): string | undefined {
  try { return sessionStorage.getItem(JOB_KEY) || undefined; } catch { return undefined; }
}
/** Whether another open tab of this browser is following the job, asked over a broadcast channel. */
function followedElsewhere(id: string): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new BroadcastChannel("bell-jobs");
    const done = (answer: boolean) => { clearTimeout(timer); channel.close(); resolve(answer); };
    const timer = setTimeout(() => done(false), 250);
    channel.onmessage = (event: MessageEvent<{ type: string; id: string }>) => { if (event.data?.type === "mine" && event.data.id === id) done(true); };
    channel.postMessage({ type: "who", id });
  });
}
const dateLabel = (date: string) =>
  new Intl.DateTimeFormat("zh-TW", { month: "short", day: "numeric" }).format(
    new Date(date),
  );

function Brand({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand ${small ? "brand-small" : ""}`}>
      <span className="brand-icon"><AudioLines size={15} strokeWidth={2.1} /></span>
      {!small && <span className="brand-wordmark"><b>BELL Explain</b></span>}
    </span>
  );
}

function MiniDiagram({ kind, index = 0 }: { kind?: string; index?: number }) {
  return (
    <div className={`mini-diagram mini-tone-${index % 3}`} aria-hidden="true">
      <span className="mini-grid" />
      {kind === "closure" ? (
        <>
          <span className="mini-scope">
            <span>lexical scope</span>
            <i>count = 0</i>
          </span>
          <span className="mini-line" />
          <span className="mini-function">
            ƒ <b>increment()</b>
          </span>
        </>
      ) : kind === "event-loop" ? (
        <>
          <span className="mini-stack">
            <i />
            <i />
            <i />
          </span>
          <span className="mini-orbit">
            <ArrowRight size={18} />
          </span>
          <span className="mini-queue">
            <i />
            <i />
            <i />
          </span>
          <span className="mini-caption">
            call stack <span>event loop</span> task queue
          </span>
        </>
      ) : kind === "debounce" ? (
        <>
          <span className="mini-wave">
            {[20, 38, 27, 52, 35, 18, 18, 18, 18, 18].map((height, i) => (
              <i key={i} style={{ height }} />
            ))}
          </span>
          <span className="mini-trigger">
            <Check size={17} />
          </span>
          <span className="mini-caption">
            input events <span>wait · 300ms</span> execute
          </span>
        </>
      ) : (
        <>
          <span className="mini-flow-node">
            <FileText size={22} />
            <small>source</small>
          </span>
          <ArrowRight size={18} />
          <span className="mini-flow-node">
            <Lightbulb size={22} />
            <small>concept</small>
          </span>
          <ArrowRight size={18} />
          <span className="mini-flow-node">
            <BookOpen size={22} />
            <small>knowledge</small>
          </span>
        </>
      )}
    </div>
  );
}

function NoteCard({
  lesson,
  index,
  onOpen,
  onFavorite,
}: {
  lesson: StoredLesson;
  index: number;
  onOpen: () => void;
  onFavorite: () => void;
}) {
  const parts = isLessonV3(lesson) ? lesson.steps : lesson.sections;
  return (
    <article className="note-card">
      <button
        className="note-card-image"
        onClick={onOpen}
        tabIndex={-1}
        aria-label={`開啟 ${lesson.title}`}
      >
        <MiniDiagram
          kind={lesson.isDemo && !isLessonV3(lesson) ? lesson.visual.kind : "flow"}
          index={index}
        />
        <span className="card-type">
          <Code2 size={12} />
          {lesson.category}
        </span>
      </button>
      <div className="note-card-body">
        <div className="note-card-title-row">
          <button className="card-title" onClick={onOpen}>
            <span><MathText text={lesson.title} /></span>
          </button>
          <button
            className={`favorite-button ${lesson.favorite ? "is-favorite" : ""}`}
            onClick={onFavorite}
            aria-label={lesson.favorite ? `取消收藏 ${lesson.title}` : `收藏 ${lesson.title}`}
            title={lesson.favorite ? "取消收藏" : "收藏"}
          >
            <Star size={15} fill={lesson.favorite ? "currentColor" : "none"} />
          </button>
        </div>
        <div className="card-bottom">
          <span><i className="category-dot" />{lesson.category} · {parts.length} {isLessonV3(lesson) ? "步" : "段"}</span>
          {!isLessonV3(lesson) && lesson.failedFormat === 3 && <span className="format-failed-badge">{formatCopy().reformatFailedBadge}</span>}
          <time dateTime={lesson.createdAt}>{dateLabel(lesson.createdAt)}</time>
        </div>
      </div>
    </article>
  );
}

function Dialog({
  children,
  title,
  close,
  className = "",
  initialFocusRef,
  closeLabel,
}: {
  children: React.ReactNode;
  title: string;
  close: () => void;
  className?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  closeLabel?: string;
}) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    initialFocusRef?.current?.focus({ preventScroll: true });
    return () => { previous?.focus({ preventScroll: true }); };
  }, [initialFocusRef]);
  return <Suspense fallback={null}><Sheet open onOpenChange={open => { if (!open) close(); }} title={title} className={className} closeLabel={closeLabel}>{children}</Sheet></Suspense>;
}

export function clearNoModelReformatJobs(jobs: Record<string, { message?: string; error?: string; noModel?: boolean }>) {
  return Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, job.noModel ? {} : job]));
}

export default function App() {
  const copy = learningCopy();
  const [route, setRoute] = useState<Route>(readRoute);
  // Counts address changes, so opening the section already in the route still scrolls to it.
  const [jump, setJump] = useState(0);
  const [lessons, setLessons] = useState<StoredLesson[]>([]);
  const [lessonsReady, setLessonsReady] = useState(false);
  const [config, setConfig] = useState<AppConfig>({
    configured: false,
    model: "",
    storage: "SQLite",
  });
  const [configReady, setConfigReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [configLoadError, setConfigLoadError] = useState("");
  const [input, setInput] = useState("");
  const [handoff, setHandoff] = useState<ExplainHandoff>();
  const [suiteLinks, setSuiteLinks] = useState<SuiteLinks>({});
  const [suiteReady, setSuiteReady] = useState(false);
  const [handoffError, setHandoffError] = useState("");
  const [personalDraft, setPersonalDraft] = useState<{ text: string; back: string; source: string }>();
  const updateHandoff = useCallback((update: ExplainHandoff | undefined | ((current: ExplainHandoff | undefined) => ExplainHandoff | undefined)) => {
    setHandoffError("");
    setHandoff(current => {
      const next = typeof update === "function" ? update(current) : update;
      try {
        if (next) sessionStorage.setItem(EXPLAIN_HANDOFF_KEY, JSON.stringify(next));
        else sessionStorage.removeItem(EXPLAIN_HANDOFF_KEY);
      } catch { /* The in-memory draft still works. */ }
      return next;
    });
  }, []);
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      const saved = localStorage.getItem("bell.theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch { /* System preference still applies. */ }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [kind, setKind] = useState<SourceKind>(() => savedComposer().kind ?? "code");
  const [depth, setDepth] = useState<Depth>(() => savedComposer().depth ?? "intermediate");
  const [topicQuestion, setTopicQuestion] = useState("");
  // The note a follow-up question came from; the new note continues from it.
  const [parentLesson, setParentLesson] = useState<{ id: string; title: string }>();
  const [exampleId, setExampleId] = useState<string>();
  const [indexedRepoId, setIndexedRepoId] = useState<string>();
  const [selectedRepository, setSelectedRepository] = useState<string>();
  const [repoQuestion, setRepoQuestion] = useState("");
  const [documentDraft, setDocumentDraft] = useState<DocumentPreview>();
  const [documentQuestion, setDocumentQuestion] = useState("");
  const [documentUploading, setDocumentUploading] = useState(false);
  const [documentDraftKey, setDocumentDraftKey] = useState(0);
  const [documentChoice, setDocumentChoice] = useState<DocumentLessonChoice>({ visual: false });
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [stageMessage, setStageMessage] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error"; action?: { label: string; run: () => void } }>();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [searchOpen, setSearchOpen] = useState(false);
  const [suiteOpen, setSuiteOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<
    "model" | "embedding" | "sync"
  >("model");
  const [mobileNav, setMobileNav] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [deleteId, setDeleteId] = useState<string>();
  const controller = useRef<AbortController | null>(null);
  // The lesson job being followed, and whether the learner asked to cancel it.
  const job = useRef<{ id?: string; cancel?: boolean }>({});
  const [jobTitle, setJobTitle] = useState("");
  const [cancelling, setCancelling] = useState(false);
  // The document a running lesson reads; its file controls wait until the lesson ends.
  const [runningDocument, setRunningDocument] = useState<string>();
  // Jobs being followed here, so the resume check never follows one twice.
  const followed = useRef(new Set<string>());
  // Lessons started in another tab or on another device: shown, not controlled.
  // Lessons started elsewhere, and deep readings of documents (from any tab): shown, and stoppable.
  const [watched, setWatched] = useState<Array<{ id: string; title: string; message: string; kind: JobView["kind"]; documentId?: string }>>([]);
  const watchers = useRef(new Map<string, AbortController>());
  const exampleJobId = useRef<string | undefined>(undefined);
  const exampleCancel = useRef(false);
  /** Merges the server's library without touching the load state (no error banner, no resume pass). */
  const refreshLessons = useCallback(async () => {
    try {
      const notes = await api.lessons();
      setLessons((current) => mergeRefreshedLessons(current, notes));
      setLessonsReady(true);
    } catch {
      /* The 15-second refresh tries again. */
    }
  }, []);
  const [loaded, setLoaded] = useState(0);
  const routeRef = useRef(route);
  routeRef.current = route;
  const exampleController = useRef<AbortController | null>(null);
  const [exampleErrors, setExampleErrors] = useState<Record<string, string>>({});
  const [exampleJob, setExampleJob] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const reformatController = useRef(new Map<string, AbortController>());
  const [reformatJob, setReformatJob] = useState<Record<string, { message?: string; error?: string; noModel?: boolean }>>({});
  useEffect(() => {
    if (!config.configured) return;
    setReformatJob(clearNoModelReformatJobs);
  }, [config.configured]);
  const favoritePending = useRef(new Set<string>());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const note =
    route.page === "note"
      ? lessons.find((lesson) => lesson.id === route.id)
      : undefined;
  const categories = useMemo(
    () => [...new Set(lessons.map((lesson) => lesson.category))],
    [lessons],
  );
  const favorites = lessons.filter((lesson) => lesson.favorite);
  // Recomputed when returning home, after reading has moved on.
  const continueReading = useMemo(() => (route.page === "home" ? lastRead(lessons) : undefined), [lessons, route.page]);
  const [reviewState, setReviewState] = useState<ReviewState>({ status: "loading" });
  const reviewRequest = useRef(0);
  const review = reviewState.summary;
  const reviewWaiting = review ? review.due + review.newAvailable : undefined;
  const refreshReview = useCallback(async () => {
    const request = ++reviewRequest.current;
    setReviewState(reviewRefresh);
    try {
      const summary = await api.reviewSummary();
      if (request === reviewRequest.current) setReviewState(reviewSuccess(summary, Date.now()));
    } catch {
      if (request === reviewRequest.current) setReviewState(reviewFailure);
    }
  }, []);
  // Tabs tell each other which lessons they follow, so a duplicated tab does not adopt one twice.
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("bell-jobs");
    channel.onmessage = (event: MessageEvent<{ type: string; id: string }>) => {
      if (event.data?.type === "who" && job.current.id === event.data.id && controller.current) channel.postMessage({ type: "mine", id: event.data.id });
    };
    return () => channel.close();
  }, []);
  // Lessons and examples keep running on the server across reloads and devices. After
  // each successful load (so a failed first load is retried with 重新載入), pick up this
  // tab's lesson again, watch others, and report how this tab's last lesson ended.
  useEffect(() => {
    if (!loaded) return;
    let active = true;
    api.jobs().then(async (jobs) => {
      if (!active) return;
      const mine = savedJob();
      for (const item of jobs.filter((entry) => (entry.kind === "generate" || entry.kind === "reformat") && entry.status === "running")) {
        if (followed.current.has(item.id)) continue;
        // A duplicated tab inherits the same memory: adopt only if no open tab is following it.
        if (item.id === mine && !controller.current && !(await followedElsewhere(item.id))) {
          if (!active || followed.current.has(item.id)) continue;
          followed.current.add(item.id);
          if (item.kind === "reformat" && item.lessonId) void startReformat(item.lessonId, item.id);
          else if (item.kind === "generate") {
            setStage(item.stage || "read");
            setStageMessage(item.message || "正在繼續先前的解說…");
            void runGeneration((signal, onEvent) => resumeJob(item.id, signal, onEvent), item.title);
          } else watchJob(item);
        } else watchJob(item);
      }
      if (mine && !followed.current.has(mine) && !controller.current) {
        const ended = jobs.find((entry) => entry.id === mine) ?? await api.job(mine).catch(() => undefined);
        if (!active || ended === undefined) return; // Could not ask; the next load tries again.
        if (ended?.status === "done" && ended.lessonId) {
          const id = ended.lessonId;
          void load().then(() => notify(ended.kind === "reformat" ? formatCopy().reformatSuccessToast : "上次的解說已完成", { label: ended.kind === "reformat" ? formatCopy().reformatOpenAction : "打開筆記", run: () => navigate("note", id) }));
        } else if (ended?.status === "failed") {
          if (ended.kind === "reformat") notify(formatCopy().reformatFailureToast, undefined, "error");
          else notify(`上次的解說沒有完成：${ended.error || "請重新開始。"}`);
        } else if (ended === null) notify("上次的解說狀態無法確認（伺服器可能已重新啟動），請到知識庫查看或重新開始。");
        forgetJob();
      }
      for (const item of jobs.filter((entry) => entry.kind === "reading" && entry.status === "running" && !followed.current.has(entry.id))) watchJob(item);
      const examples = jobs.find((entry) => entry.kind === "examples" && entry.status === "running" && entry.lessonId && !followed.current.has(entry.id));
      if (examples?.lessonId && !exampleController.current) void prepareExamples({ id: examples.lessonId }, examples.id);
    }).catch(() => {});
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);
  // Notes added or removed change what is waiting; so does coming back from a session.
  useEffect(() => { if (!loading) void refreshReview(); }, [loading, lessons.length, route.page, refreshReview]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try { localStorage.setItem("bell.theme", theme); } catch { /* The selected theme still applies to this page. */ }
  }, [theme]);
  useEffect(() => {
    let active = true;
    api.suiteManifest().then(manifest => {
      if (active) setSuiteLinks(sanitizeSuiteLinks(manifest.links, window.location.hostname));
    }).catch(() => {
      if (active) setSuiteLinks({});
    }).finally(() => {
      if (active) setSuiteReady(true);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (route.page !== "explain" || !suiteReady) return;
    const hash = window.location.hash;
    const requested = hasExplainHandoff(hash);
    if (requested) {
      try { sessionStorage.removeItem(EXPLAIN_HANDOFF_KEY); } catch { /* The in-memory draft still works. */ }
    }
    const incoming = parseExplainHandoff(hash, suiteLinks);
    if (hash.includes("?")) window.history.replaceState(window.history.state, "", "#/explain");
    if (requested) {
      updateHandoff(incoming.draft);
      setHandoffError(incoming.error || "");
      setError("");
      setParentLesson(undefined);
      setExampleId(undefined);
      setTopicQuestion("");
      setKind("article");
      return;
    }
    if (handoff) return;
    try {
      const stored = normalizeExplainHandoff(JSON.parse(sessionStorage.getItem(EXPLAIN_HANDOFF_KEY) || "null"), suiteLinks);
      if (stored) updateHandoff(stored);
    } catch {
      try { sessionStorage.removeItem(EXPLAIN_HANDOFF_KEY); } catch { /* The visible handoff error stays available. */ }
    }
  }, [jump, suiteLinks, suiteReady, updateHandoff]);

  const notify = useCallback((message: string, action?: { label: string; run: () => void }, tone: "success" | "error" = "success") => setToast({ message, action, tone }), []);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(sidebarCollapsed));
    } catch {
      // The layout still works when browser storage is unavailable.
    }
  }, [sidebarCollapsed]);
  useEffect(() => {
    try {
      localStorage.setItem(COMPOSER_KEY, JSON.stringify({ kind, depth }));
    } catch {
      // Defaults are used when browser storage is unavailable.
    }
  }, [kind, depth]);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === SIDEBAR_COLLAPSED_KEY || event.key === null)
        setSidebarCollapsed(event.newValue === "true");
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, []);
  const configStatus = useRef({ ready: false, error: "" });
  const configRequest = useRef(0);
  const loadMessage = useCallback((cause: unknown, fallback: string) => {
    const text = cause instanceof Error ? cause.message : "";
    return !text || /failed to fetch|fetch failed|networkerror/i.test(text) ? fallback : text;
  }, []);
  const updateConfigStatus = useCallback((ready: boolean, error: string) => {
    configStatus.current = { ready, error };
    setConfigReady(ready);
    setConfigLoadError(error);
  }, []);
  const requestConfig = useCallback(async (active?: () => boolean) => {
    const request = ++configRequest.current;
    try {
      const settings = await api.config();
      if ((active && !active()) || request !== configRequest.current) return false;
      setConfig(settings);
      updateConfigStatus(true, "");
      return true;
    } catch (cause) {
      if ((active && !active()) || request !== configRequest.current) return false;
      updateConfigStatus(configStatus.current.ready, loadMessage(cause, "無法連線 Explain（設定）。"));
      return false;
    }
  }, [loadMessage, updateConfigStatus]);
  const load = useCallback(async () => {
    setLoadError("");
    updateConfigStatus(configStatus.current.ready, "");
    const [notes, settings] = await Promise.allSettled([
      api.lessons(),
      requestConfig(),
    ]);
    if (notes.status === "fulfilled") {
      setLessons(notes.value);
      setLessonsReady(true);
      setLoaded((count) => count + 1);
    } else {
      setLoadError(loadMessage(notes.reason, "無法連線 Explain（知識庫）。"));
    }
    setLoading(false);
    return notes.status === "fulfilled" && settings.status === "fulfilled" && settings.value;
  }, [loadMessage, requestConfig, updateConfigStatus]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      if (document.hidden || !active) return;
      const settings = !configStatus.current.ready || configStatus.current.error
        ? requestConfig(() => active)
        : undefined;
      try {
        const notes = await api.lessons();
        if (active) {
          setLessons((current) => mergeRefreshedLessons(current, notes));
          setLessonsReady(true);
          setLoadError("");
        }
      } catch {
        /* Keep the current library while the service reconnects. */
      }
      await settings;
    };
    const timer = setInterval(() => void refresh(), 15000);
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [requestConfig]);
  useEffect(() => {
    const change = () => {
      pendingNavigation = undefined;
      setRoute(readRoute());
      setJump((count) => count + 1);
      setMobileNav(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  // The open drawer takes focus and closes with Esc unless a dialog owns the key, returning focus to the menu button.
  useEffect(() => {
    if (!mobileNav) return;
    document.querySelector<HTMLElement>("#primary-sidebar .brand-link")?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector('[role="dialog"]')) return;
      setMobileNav(false);
      document.querySelector<HTMLElement>(".mobile-menu")?.focus();
    };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [mobileNav]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (["1", "2", "3", "4", "5"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "2") setSuiteOpen(true);
        else {
          const app = event.key === "1" ? "personal" : event.key === "3" ? "pr" : event.key === "4" ? "reader" : "campaign";
          const href = suiteLinks[app];
          if (href) window.location.href = href;
        }
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [suiteLinks]);
  useEffect(() => {
    if (!toast) return;
    // A toast with an action stays long enough to use it.
    const timeout = setTimeout(() => setToast(undefined), toast.action ? 10_000 : 3500);
    return () => clearTimeout(timeout);
  }, [toast]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => () => { for (const watcher of watchers.current.values()) watcher.abort(); }, []);
  useEffect(() => () => exampleController.current?.abort(), []);

  const navigate = (page: Route["page"], id?: string, section?: string) => {
    const hash =
      page === "note"
        ? `/note/${encodeURIComponent(id || "")}${section ? `/${encodeURIComponent(section)}` : ""}`
        : `/${page}`;
    // The same address fires no hashchange; jump there anyway.
    if (window.location.hash === `#${hash}`) {
      setRoute(readRoute());
      setJump((count) => count + 1);
    } else {
      pendingNavigation = `#${hash}`;
      window.location.hash = hash;
    }
    setMobileNav(false);
  };
  const selectTag = (tag: string) => {
    setCategory("全部");
    setQuery(tag);
    navigate("library");
  };
  const newLearning = () => {
    if (!busy) {
      if (documentDraft) void api.removeDocument(documentDraft.id).catch(() => {});
      setDocumentDraft(undefined);
      setDocumentQuestion("");
      setTopicQuestion("");
      setParentLesson(undefined);
      setDocumentChoice({ visual: false });
      setDocumentDraftKey((current) => current + 1);
      setDocumentUploading(false);
      updateHandoff(undefined);
      try { sessionStorage.removeItem(EXPLAIN_HANDOFF_KEY); } catch { /* Nothing else to clear. */ }
      setError("");
    }
    navigate("home");
    setTimeout(() => inputRef.current?.focus(), 30);
  };
  const discardHandoff = () => {
    if (busy) return;
    updateHandoff(undefined);
    setError("");
    try { sessionStorage.removeItem(EXPLAIN_HANDOFF_KEY); } catch { /* Nothing else to clear. */ }
    navigate("home");
  };
  const personalDraftLink = personalDraft ? personalDraftHref(suiteLinks.personal, personalDraft.text, personalDraft.back, window.location.hostname) : undefined;
  const useExample = (lesson: Lesson) => {
    setParentLesson(undefined);
    setRepoQuestion("");
    setIndexedRepoId(undefined);
    setKind(lesson.source.kind);
    setInput(lesson.source.content);
    setExampleId(lesson.id);
    setError("");
    inputRef.current?.focus();
  };
  const favorite = async (lesson: StoredLesson) => {
    if (favoritePending.current.has(lesson.id)) return;
    favoritePending.current.add(lesson.id);
    try {
      const updated = await api.favorite(lesson.id, !lesson.favorite);
      setLessons((current) =>
        current.map((n) => (n.id === lesson.id ? updated : n)),
      );
    } catch {
      notify(learningCopy().lesson.topbar.bookmarkErrorToast);
    } finally {
      favoritePending.current.delete(lesson.id);
    }
  };
  const remove = async () => {
    if (!deleteId) return;
    try {
      await api.remove(deleteId);
      setLessons((current) => current.filter((n) => n.id !== deleteId));
      setDeleteId(undefined);
      navigate("library");
      notify(learningCopy().lesson.deleteDialog.deletedToast);
    } catch {
      notify(learningCopy().lesson.deleteDialog.deleteErrorToast);
    }
  };
  /**
   * Follows a lesson job to its end. Leaving the page or losing the connection
   * only stops following; the server keeps going and the job can be picked up
   * again. Finishing opens the note only if the learner is still on the start
   * page; elsewhere a toast offers it, so reading is not interrupted.
   */
  /** Shows the new page counts after a deep reading, if the file is still in the composer. */
  const refreshDraft = async (documentId: string) => {
    const preview = await api.document(documentId).catch(() => null);
    if (preview) setDocumentDraft((current) => (current?.id === documentId ? preview : current));
  };
  const announceReading = (event: Extract<GenerateEvent, { type: "read" }>) => {
    notify(`深度解析完成：${event.pages} 頁`);
    void refreshDraft(event.documentId);
  };
  /** Shows a lesson started elsewhere (or any deep reading) and announces it when done. */
  const watchJob = (view: JobView) => {
    followed.current.add(view.id);
    const run = new AbortController();
    watchers.current.set(view.id, run);
    setWatched((list) => [...list.filter((item) => item.id !== view.id), { id: view.id, title: view.title, message: view.message || "進行中", kind: view.kind, documentId: view.documentId }]);
    void resumeJob(view.id, run.signal, (event) => {
      if (event.type === "stage") setWatched((list) => list.map((item) => (item.id === view.id ? { ...item, message: event.message } : item)));
      if (event.type === "complete") {
        setLessons((current) => [event.lesson, ...current.filter((n) => n.id !== event.lesson.id)]);
        notify(`《${event.lesson.title}》已完成`, { label: "打開筆記", run: () => navigate("note", event.lesson.id) });
      }
      if (event.type === "read") announceReading(event);
    }).catch((cause) => {
      // A reading followed from here reports how it ended, like one started here.
      if (view.kind !== "reading" || run.signal.aborted) return;
      const message = cause instanceof Error ? cause.message : "深度解析沒有完成。";
      notify(/已取消/.test(message) ? "已停止深度解析；已完成的頁面都已保存。" : message);
    }).finally(() => {
      followed.current.delete(view.id);
      watchers.current.delete(view.id);
      setWatched((list) => list.filter((item) => item.id !== view.id));
      if (view.documentId) void refreshDraft(view.documentId);
    });
  };
  /**
   * Starts (or joins) the deep reading of a document. It runs on the server like a
   * lesson: leaving the page does not stop it, and finished pages are kept even if
   * it is stopped.
   */
  const startReading = async (documentId: string, title: string, options: { range?: { start: number; end: number }; password?: string }) => {
    const run = new AbortController();
    const pending = `pending:${documentId}`;
    let id = pending;
    setWatched((list) => [...list.filter((item) => item.id !== pending), { id: pending, title, message: "正在開始深度解析…", kind: "reading", documentId }]);
    try {
      await readDocument(documentId, options, run.signal, (event) => {
        // A reconnect repeats the job line: only the first one renames the pending entry.
        if (event.type === "job" && event.id !== id) {
          const previous = id;
          id = event.id;
          followed.current.add(event.id);
          watchers.current.set(event.id, run);
          setWatched((list) => list.filter((item) => item.id !== event.id).map((item) => (item.id === previous ? { ...item, id: event.id } : item)));
        }
        if (event.type === "stage") setWatched((list) => list.map((item) => (item.id === id ? { ...item, message: event.message } : item)));
        if (event.type === "read") announceReading(event);
      });
    } catch (cause) {
      if (!run.signal.aborted) {
        const message = cause instanceof Error ? cause.message : "深度解析沒有完成。";
        notify(/已取消/.test(message) ? "已停止深度解析；已完成的頁面都已保存。" : message);
      }
    } finally {
      followed.current.delete(id);
      watchers.current.delete(id);
      setWatched((list) => list.filter((item) => item.id !== id && item.id !== pending));
      void refreshDraft(documentId);
    }
  };
  const composing = route.page === "home" || route.page === "explain";
  const composerInput = route.page === "explain" ? handoff?.text || "" : input;
  const composerKind: SourceKind = route.page === "explain" ? "article" : kind;
  const runGeneration = async (
    follow: (signal: AbortSignal, onEvent: (event: GenerateEvent<StoredLesson>) => void) => Promise<void>,
    title: string,
    onComplete?: (lesson: StoredLesson) => void,
  ) => {
    if (controller.current) return;
    const run = new AbortController();
    controller.current = run;
    job.current = {};
    let unknown = false;
    setBusy(true);
    setCancelling(false);
    setError("");
    setJobTitle(title);
    const cancelFailed = () => {
      job.current.cancel = false;
      setCancelling(false);
      notify("無法取消，請稍後再試。");
    };
    try {
      await follow(run.signal, (event: GenerateEvent) => {
        if (run.signal.aborted || controller.current !== run) return;
        if (event.type === "job") {
          job.current.id = event.id;
          followed.current.add(event.id);
          rememberJob(event.id);
          if (job.current.cancel) void api.cancelJob(event.id).catch(cancelFailed);
        }
        if (event.type === "stage") {
          setStage(event.stage);
          setStageMessage(event.message);
        }
        if (event.type === "complete") {
          setLessons((current) => [
            event.lesson,
            ...current.filter((n) => n.id !== event.lesson.id),
          ]);
          onComplete?.(event.lesson);
          const open = () => navigate("note", event.lesson.id);
          if (routeRef.current.page === "home" || routeRef.current.page === "explain") {
            open();
            notify("解說已儲存到你的知識庫");
          } else notify(`《${event.lesson.title}》已完成`, { label: "打開筆記", run: open });
        }
      });
    } catch (cause) {
      if (!run.signal.aborted) {
        const message = cause instanceof Error ? cause.message : "生成失敗，請稍後再試";
        // "Cancelled" only when the server says so; any other ending keeps its own message.
        if (job.current.cancel && /已取消/.test(message)) notify("已取消這次解說");
        else {
          setError(message);
          if (cause instanceof JobFailure && cause.unknown) {
            // The lesson may have been saved: refresh the library quietly, keep the job for a reload to ask about.
            unknown = true;
            void refreshLessons();
          }
          if (routeRef.current.page !== "home" && routeRef.current.page !== "explain") notify("這次解說沒有完成", { label: "查看原因", run: () => navigate("home") });
        }
      }
    } finally {
      if (job.current.id) followed.current.delete(job.current.id);
      if (controller.current === run) {
        setBusy(false);
        setCancelling(false);
        setRunningDocument(undefined);
        controller.current = null;
        if (!unknown) forgetJob();
      }
    }
  };
  const cancelGeneration = () => {
    job.current.cancel = true;
    setCancelling(true);
    setStageMessage("正在取消…");
    if (job.current.id) void api.cancelJob(job.current.id).catch(() => {
      job.current.cancel = false;
      setCancelling(false);
      notify("無法取消，請稍後再試。");
    });
  };
  const begin = async () => {
    if ((composerKind === "document" ? !documentDraft || documentUploading || !!documentChoice.error : !composerInput.trim() && !indexedRepoId) || controller.current || busy || loading || !configReady || !config.configured)
      return;
    const sentParent = exampleId ? undefined : parentLesson;
    const sentTopic = topicQuestion;
    const sentHandoff = handoff;
    const question = (composerKind === "repo" ? repoQuestion : composerKind === "document" ? documentQuestion : exampleId ? "" : topicQuestion).trim() || undefined;
    setStage("read");
    setStageMessage(
      exampleId ? "正在開啟人工編寫的互動示範…" : "正在準備你的學習內容…",
    );
    const title = (route.page === "explain" ? handoff?.title.trim() : "") || question || (composerKind === "document" ? documentDraft?.name : composerInput.trim().split("\n")[0])?.slice(0, 60) || "新的解說";
    setRunningDocument(composerKind === "document" ? documentDraft?.id : undefined);
    await runGeneration(
      (signal, onEvent) => generate(
        {
          kind: composerKind,
          content: composerKind === "document" ? "" : composerInput.trim(),
          depth,
          exampleId,
          indexedRepoId,
          documentId: composerKind === "document" ? documentDraft?.id : undefined,
          parentLessonId: exampleId ? undefined : parentLesson?.id,
          question,
          ...(composerKind === "document" ? {
            documentRange: documentChoice.range,
            documentVisual: documentChoice.visual || undefined,
            documentPassword: documentChoice.visual ? documentChoice.password : undefined,
          } : {}),
        },
        signal,
        onEvent,
      ),
      title,
      () => {
        setParentLesson((current) => (current === sentParent ? undefined : current));
        setTopicQuestion((current) => (current === sentTopic ? "" : current));
        updateHandoff(current => {
          if (current !== sentHandoff) return current;
          try { sessionStorage.removeItem(EXPLAIN_HANDOFF_KEY); } catch { /* The completed draft no longer needs clearing. */ }
          return undefined;
        });
      },
    );
  };
  const prepareExamples = useCallback(async (lesson: { id: string }, resumeId?: string) => {
    if (exampleController.current) return;
    const run = new AbortController();
    exampleController.current = run;
    setExampleErrors(({ [lesson.id]: _previous, ...rest }) => rest);
    setExampleJob({ id: lesson.id, message: "正在補上實作案例…" });
    try {
      const follow = resumeId
        ? (signal: AbortSignal, onEvent: (event: GenerateEvent) => void) => resumeJob(resumeId, signal, onEvent)
        : (signal: AbortSignal, onEvent: (event: GenerateEvent) => void) => enhanceExamples(lesson.id, signal, onEvent);
      await follow(run.signal, (event) => {
        if (run.signal.aborted) return;
        if (event.type === "job") {
          exampleJobId.current = event.id;
          followed.current.add(event.id);
          if (exampleCancel.current) void api.cancelJob(event.id).catch(() => notify("無法取消，請稍後再試。"));
        }
        if (event.type === "stage")
          setExampleJob({ id: lesson.id, message: event.message });
        if (event.type === "complete") {
          setLessons((current) =>
            current.map((item) =>
              item.id === event.lesson.id ? event.lesson : item,
            ),
          );
          notify("實作案例與逐段解說已儲存");
        }
      });
    } catch (cause) {
      if (!run.signal.aborted) {
        const message = cause instanceof Error ? cause.message : "無法自動補充案例。";
        if (/已取消/.test(message)) notify("已取消補上實作案例");
        else if (cause instanceof JobFailure && cause.unknown) {
          // The examples may have been saved meanwhile: refresh instead of claiming they were not.
          void refreshLessons();
          notify(message);
        } else {
          setExampleErrors((current) => ({
            ...current,
            [lesson.id]: "實作案例暫時無法補齊。你可以繼續閱讀原有解說，稍後再按一次重試。",
          }));
          notify(message);
        }
      }
    } finally {
      if (exampleJobId.current) followed.current.delete(exampleJobId.current);
      exampleJobId.current = undefined;
      exampleCancel.current = false;
      if (exampleController.current === run) {
        exampleController.current = null;
        setExampleJob(null);
      }
    }
  }, [notify]);
  const startReformat = useCallback(async (lessonId: string, resumeId?: string) => {
    if (reformatController.current.has(lessonId)) return;
    const run = new AbortController();
    let jobId = resumeId;
    reformatController.current.set(lessonId, run);
    setReformatJob(current => ({ ...current, [lessonId]: { message: formatCopy().reformatProgress } }));
    try {
      const onEvent = (event: GenerateEvent) => {
        if (run.signal.aborted) return;
        if (event.type === "job") {
          jobId = event.id;
          rememberJob(event.id);
          followed.current.add(event.id);
        }
        if (event.type === "complete") {
          setLessons(current => current.map(item => item.id === event.lesson.id ? event.lesson : item));
          setReformatJob(current => ({ ...current, [lessonId]: {} }));
          forgetJob();
          notify(formatCopy().reformatSuccessToast);
        }
      };
      if (resumeId) await resumeJob(resumeId, run.signal, onEvent);
      else await reformatLesson(lessonId, run.signal, onEvent);
    } catch (cause) {
      if (!run.signal.aborted) {
        console.error("Reformat failed", cause);
        if (cause instanceof JobFailure && cause.code === "no_model") {
          // Trying again cannot help until an AI is connected: say where to connect one.
          setReformatJob(current => ({ ...current, [lessonId]: { error: formatCopy().reformatNoModel, noModel: true } }));
          forgetJob();
          notify(formatCopy().reformatNoModelToast, { label: formatCopy().reformatOpenSettings, run: () => { setSettingsTab("model"); setSettingsOpen(true); } }, "error");
          return;
        }
        const during = cause instanceof JobFailure && cause.status === 409;
        let deleted = cause instanceof JobFailure && cause.status === 404;
        let changed = false;
        if (during) {
          const notes = await api.lessons().catch(() => undefined);
          if (notes) {
            deleted = !notes.some(item => item.id === lessonId);
            changed = !deleted;
            if (deleted) setLessons(notes);
          }
        }
        if (deleted) setLessons(current => current.filter(item => item.id !== lessonId));
        const errorKey = deleted ? during ? "reformatNoteDeletedDuring" : "reformatNoteDeleted" : changed ? "reformatNoteChangedDuring" : "reformatFailureBanner";
        const toastKey = deleted ? during ? "reformatNoteDeletedDuring" : "reformatNoteDeleted" : "reformatFailureToast";
        setReformatJob(current => ({ ...current, [lessonId]: { error: formatCopy()[errorKey] } }));
        forgetJob();
        if (!changed) notify(formatCopy()[toastKey], undefined, "error");
      }
    } finally {
      if (jobId) followed.current.delete(jobId);
      if (reformatController.current.get(lessonId) === run) reformatController.current.delete(lessonId);
    }
  }, [notify]);
  // I: a cancel pressed before the job id arrives is sent as soon as it does.
  const cancelExamples = () => {
    const id = exampleJobId.current;
    if (id) void api.cancelJob(id).catch(() => notify("無法取消，請稍後再試。"));
    else exampleCancel.current = true;
  };
  /** Prefills a follow-up that keeps the original source (PDF, repo index, code, article or URL). */
  const followUp = async (question: string, parent: StoredLesson) => {
    const source = parent.source;
    setRepoQuestion("");
    setTopicQuestion("");
    setIndexedRepoId(undefined);
    setExampleId(undefined);
    setError("");
    setParentLesson({ id: parent.id, title: parent.title });
    let prepared = false;
    if (source.kind === "document" && source.document) {
      const preview = await api.document(source.document.id).catch(() => null);
      if (preview) {
        // An unsent upload being replaced would otherwise stay on the server.
        if (documentDraft && documentDraft.id !== preview.id) void api.removeDocument(documentDraft.id).catch(() => {});
        setKind("document");
        setDocumentDraftKey((current) => current + 1);
        setDocumentDraft(preview);
        setDocumentQuestion(question);
        prepared = true;
      }
    } else if (source.kind === "repo") {
      // Reuse the index of the same commit when it still exists. A GitHub repo can be indexed
      // again from its URL; a local repository has no URL, so it needs its index.
      const commit = /commit ([0-9a-f]{7,40})/i.exec(source.scope || "")?.[1];
      const repositories = await fetch("/api/knowledge/repositories").then((response) => response.ok ? response.json() as Promise<Array<{ id: string; location?: string; commit?: string; state?: string }>> : []).catch(() => []);
      const sameCommit = (item: { commit?: string }) => !!commit && !!item.commit?.startsWith(commit);
      const match = repositories
        .filter((item) => item.state === "completed" && (source.url ? item.location === source.url : sameCommit(item)))
        .sort((a, b) => Number(sameCommit(b)) - Number(sameCommit(a)))[0];
      if (source.url || match) {
        setKind("repo");
        setInput(source.url || "");
        setRepoQuestion(question);
        if (match) setIndexedRepoId(match.id);
        prepared = true;
      }
    } else if ((source.kind === "code" || source.kind === "article") && source.content.trim()) {
      setKind(source.kind);
      setInput(source.content.slice(0, 30_000));
      setTopicQuestion(question);
      prepared = true;
    } else if (source.kind === "url" && source.url) {
      setKind("url");
      setInput(source.url);
      setTopicQuestion(question);
      prepared = true;
    }
    if (!prepared) {
      setKind("concept");
      setInput(`${parent.title}：${question}`);
    }
    navigate("home");
    setTimeout(() => inputRef.current?.focus(), 20);
  };
  const filtered = useMemo(() => lessons.filter(
    (lesson) =>
      (route.page !== "favorites" || lesson.favorite) &&
      (category === "全部" || lesson.category === category) &&
      `${lesson.title} ${isLessonV3(lesson) ? lesson.answer : lesson.summary} ${lesson.tags.join(" ")} ${isLessonV3(lesson)
        ? `${lesson.steps.map((step) => `${step.lead} ${step.body}`).join(" ")} ${lesson.steps.flatMap(step => step.figure ? figureLines(step.figure) : []).join(" ")}`
        : lesson.sections.map((s) => `${s.heading} ${s.body} ${s.code}`).join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  ), [lessons, route.page, category, query]);
  const openRepository = (id: string) => {
    setSelectedRepository(id);
    setSearchOpen(false);
    navigate("repositories");
  };
  // Work still running elsewhere is shown on every other page.
  const pills = !mobileNav && ((busy && !composing) || watched.length > 0 || (!!exampleJob && !(route.page === "note" && route.id === exampleJob.id)));
  const toastView = toast && (
    <div className={`toast${pills ? " toast-in-stack" : ""}`} data-tone={toast.tone} role={toast.tone === "error" ? "alert" : "status"}>
      {toast.tone === "error" ? <CircleAlert size={17} /> : <Check size={17} />}
      {toast.message}
      {toast.action && (
        <button type="button" className="toast-action" onClick={() => { toast.action!.run(); setToast(undefined); }}>
          {toast.action.label}
        </button>
      )}
    </div>
  );
  useEffect(() => {
    const english = new URLSearchParams(window.location.search).get("lang") === "en" || document.documentElement.lang.startsWith("en");
    document.documentElement.lang = english ? "en" : "zh-Hant";
    document.title = copy.shell.documentTitle;
  }, [copy.shell.documentTitle]);
  const title =
    route.page === "repositories"
      ? copy.nav.repositories
      : route.page === "library"
        ? copy.nav.library
        : route.page === "review"
          ? copy.nav.review
        : route.page === "graph"
          ? copy.nav.graph
          : route.page === "favorites"
            ? copy.nav.bookmarks
            : route.page === "note"
              ? copy.nav.library
              : copy.nav.learn;

  const modifierKey = /Mac|iPhone|iPad/.test(window.navigator.platform) ? "⌘" : "Ctrl";
  const lessonCount = lessonsReady ? lessons.length : "—";
  const reviewNavAria = reviewState.status === "error"
    ? copy.shell.reviewErrorAria
    : reviewState.status === "stale"
      ? fill(reviewWaiting === 1 ? copy.shell.reviewStaleAriaOne : copy.shell.reviewStaleAria, { count: reviewWaiting ?? 0 })
      : reviewWaiting === undefined
        ? copy.shell.reviewUnknownAria
        : reviewWaiting > 0
          ? fill(reviewWaiting === 1 ? copy.shell.reviewDueAriaOne : copy.shell.reviewDueAria, { count: reviewWaiting })
          : copy.shell.reviewEmptyAria;
  const reviewDuePart = review?.due ? fill(copy.home.reviewCard.duePart, { due: review.due }) : "";
  const reviewNewPart = review?.newAvailable ? fill(copy.home.reviewCard.newPart, { newCount: review.newAvailable }) : "";
  const reviewBreakdown = reviewDuePart && reviewNewPart
    ? fill(copy.home.reviewCard.breakdownJoin, { duePart: reviewDuePart, newPart: reviewNewPart })
    : reviewDuePart || reviewNewPart;

  return (
    <div className={`app-shell${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      {mobileNav && (
        <button
          className="nav-scrim"
          aria-label={copy.shell.closeNavigationAria}
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside id="primary-sidebar" className={`sidebar ${mobileNav ? "sidebar-open" : ""}`} aria-label={copy.shell.sidebarAria}>
        <div className="suite-sidebar-brand">
          <button type="button" className="suite-workspace-button brand-link" onClick={() => setSuiteOpen(true)} aria-label={copy.shell.switchProduct} title={copy.shell.switchProduct}>
            <Brand />
            <ChevronDown size={14} className="brand-chevron" aria-hidden="true" />
          </button>
        </div>
        <button type="button" className="global-search sidebar-search" onClick={() => setSearchOpen(true)} aria-label={copy.shell.searchLibraryAria}>
          <Search size={14} />
          <span>{copy.nav.search}</span>
          <kbd>{modifierKey} K</kbd>
        </button>
        <nav aria-label={copy.shell.primaryNavigationAria}>
          <button
            className={`nav-item ${composing ? "active" : ""}`}
            onClick={() => navigate("home")}
            aria-label={copy.nav.learn}
            title={copy.nav.learn}
          >
            <Sparkles size={17} />
            <span className="nav-label">{copy.nav.learn}</span>
          </button>
          <div className="sidebar-item-row">
            <a
              href="#/review"
              className={`nav-item ${route.page === "review" ? "active" : ""}`}
              onClick={event => { event.preventDefault(); navigate("review"); }}
              aria-label={reviewNavAria}
              title={reviewState.status === "error" ? copy.shell.reviewErrorTitle : reviewState.status === "stale" ? copy.shell.reviewStaleTitle : copy.nav.review}
            >
              <Repeat size={17} />
              <span className="nav-label">{copy.nav.review}</span>
              {(reviewWaiting === undefined || reviewWaiting > 0) && <span className={`nav-count ${reviewWaiting === undefined ? "nav-count-unknown" : ""}`}>{reviewWaiting ?? copy.shell.reviewUnknownBadge}</span>}
            </a>
            {(reviewState.status === "error" || reviewState.status === "stale") && (
              <button
                type="button"
                className="sidebar-retry"
                onClick={() => void refreshReview()}
                disabled={reviewState.retrying}
                aria-label={reviewState.retrying ? copy.shell.reviewRetryingAria : copy.shell.reviewRetryAria}
                aria-busy={reviewState.retrying || undefined}
                title={copy.shell.reviewRetryTitle}
              >
                <RefreshCw size={12} className={reviewState.retrying ? "spin" : undefined} aria-hidden="true" />
              </button>
            )}
          </div>
          <button
            className={`nav-item ${route.page === "library" || route.page === "note" ? "active" : ""}`}
            onClick={() => {
              setCategory("全部");
              setQuery("");
              navigate("library");
            }}
            aria-label={copy.nav.library}
            title={lessonsReady ? fill(lessons.length === 1 ? copy.shell.libraryTitleOne : copy.shell.libraryTitle, { count: lessons.length }) : copy.shell.libraryUnknownTitle}
          >
            <BookOpen size={17} />
            <span className="nav-label">{copy.nav.library}</span><span className="nav-count">{lessonCount}</span>
          </button>
          <button
            className={`nav-item ${route.page === "repositories" ? "active" : ""}`}
            onClick={() => navigate("repositories")}
            aria-label={copy.nav.repositories}
            title={copy.nav.repositories}
          >
            <GitBranch size={17} />
            <span className="nav-label">{copy.nav.repositories}</span>
          </button>
          <button
            className={`nav-item ${route.page === "graph" ? "active" : ""}`}
            onClick={() => navigate("graph")}
            aria-label={copy.nav.graph}
            title={copy.nav.graph}
          >
            <Network size={17} />
            <span className="nav-label">{copy.nav.graph}</span>
          </button>
          <button
            className={`nav-item ${route.page === "favorites" ? "active" : ""}`}
            onClick={() => {
              setCategory("全部");
              setQuery("");
              navigate("favorites");
            }}
            aria-label={copy.nav.bookmarks}
            title={fill(favorites.length === 1 ? copy.shell.bookmarksTitleOne : copy.shell.bookmarksTitle, { count: favorites.length })}
          >
            <Star size={17} />
            <span className="nav-label">{copy.nav.bookmarks}</span>
            {favorites.length > 0 && <span className="nav-count">{favorites.length}</span>}
          </button>
        </nav>
        <div className="nav-section-label category-label">{copy.nav.categories}</div>
        <div className="category-nav">
          {categories.map((item, i) => (
            <button
              key={item}
              onClick={() => {
                setCategory(item);
                setQuery("");
                navigate("library");
              }}
            >
              <i className={`category-dot category-dot-${i % 3}`} />
              {item}
              <span>{lessons.filter((n) => n.category === item).length}</span>
            </button>
          ))}
        </div>
        <div className="sidebar-bottom">
          <button className="profile-button" onClick={() => setSettingsOpen(true)} aria-label={copy.shell.openSettingsAria} title={copy.nav.settings}>
            <Settings2 size={16} />
            <span className="nav-label">{copy.nav.settings}</span>
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className={`topbar${route.page === "note" ? " reader-topbar" : ""}`}>
          <div className="topbar-title">
            <button type="button" className="suite-workspace-button suite-switcher-mobile" onClick={() => setSuiteOpen(true)} aria-label={copy.shell.switchProduct} title={copy.shell.switchProduct}>
              <Brand small />
              <ChevronDown size={13} className="brand-chevron" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button desktop-sidebar-toggle"
              onClick={() => setSidebarCollapsed(value => !value)}
              aria-label={sidebarCollapsed ? copy.shell.expandSidebar : copy.shell.collapseSidebar}
              title={sidebarCollapsed ? copy.shell.expandSidebar : copy.shell.collapseSidebar}
              aria-expanded={!sidebarCollapsed}
              aria-controls="primary-sidebar"
            >
              {sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}
            </button>
            <button
              className="icon-button mobile-menu"
              onClick={() => route.page === "note" ? navigate("library") : setMobileNav(true)}
              aria-label={route.page === "note" ? copy.lesson.topbar.backToLibraryAria : copy.shell.openNavigationAria}
              aria-expanded={route.page === "note" ? undefined : mobileNav}
              aria-controls={route.page === "note" ? undefined : "primary-sidebar"}
            >
              {route.page === "note" ? <ChevronLeft size={20} /> : <Menu size={20} />}
            </button>
            <nav className="topbar-breadcrumbs" aria-label={copy.shell.breadcrumbsAria}>
              <span className="topbar-breadcrumb">{route.page === "note" ? copy.lesson.topbar.breadcrumbLibrary : title}</span>
              {route.page === "note" && note && <><ChevronRight size={13} /><b>{note.category}</b></>}
            </nav>
          </div>
          <div className="topbar-actions">
            {route.page === "note" && note && <div id="reader-topbar-actions" className="reader-topbar-actions" />}
            {!loading && configReady && !config.configured && (
              <button className="connection-status" onClick={() => setSettingsOpen(true)}>
                <i />{copy.shell.codexDisconnectedSettings}
              </button>
            )}
            <button
              type="button"
              className="icon-button theme-toggle"
              onClick={() => setTheme(value => value === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? copy.shell.switchToLight : copy.shell.switchToDark}
              title={theme === "dark" ? copy.shell.switchToLight : copy.shell.switchToDark}
            >
              {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
            </button>
          </div>
        </header>
        <main className="workspace-content">
          {(loadError || configLoadError) && (
            <div className="page-error" role="alert">
              <span>{[loadError, configLoadError].filter(Boolean).join(" · ")}</span>
              <button onClick={() => void load()}>重新載入</button>
            </div>
          )}
          {composing && (
            <div className="home-page page-container">
              {route.page === "home" && (
                <section className="home-intro">
                  <div className="home-intro-copy">
                    <div className="eyebrow">
                      <span /> {copy.home.intro.eyebrow}
                    </div>
                    <h1>
                      {copy.home.intro.titleLine1}
                      <br />
                      {copy.home.intro.titlePrefix}
                      <span className="underlined-word">
                        {copy.home.intro.titleHighlight}
                        <svg viewBox="0 0 270 12" preserveAspectRatio="none" aria-hidden="true">
                          <path d="M2 8 Q125 -2 268 6" />
                        </svg>
                      </span>
                      {copy.home.intro.titleSuffix}
                    </h1>
                    <p>{copy.home.intro.subtitle}</p>
                  </div>
                  <div className="intro-art" aria-hidden="true">
                    <div className="art-orbit orbit-one" />
                    <div className="art-orbit orbit-two" />
                    <span className="art-node art-node-code">
                      <Code2 size={24} />
                    </span>
                    <span className="art-node art-node-note">
                      <BookOpen size={23} />
                    </span>
                    <span className="art-node art-node-spark">
                      <Sparkles size={22} />
                    </span>
                    <span className="art-center">
                      <Waypoints size={38} strokeWidth={1.35} />
                    </span>
                    <span className="art-dot art-dot-one" />
                    <span className="art-dot art-dot-two" />
                    <span className="art-asterisk">✳</span>
                  </div>
                </section>
              )}
              {route.page === "explain" && (
                <SuiteSourceBanner ready={suiteReady} handoff={handoff} links={suiteLinks} currentHostname={window.location.hostname} error={handoffError} onDismissError={() => {
                  setHandoffError("");
                  inputRef.current?.focus({ preventScroll: true });
                }} />
              )}
              <section
                className={`composer ${busy ? "composer-busy" : ""}`}
                aria-label="建立學習解說"
              >
                {parentLesson && !exampleId && (
                  <div className="composer-parent">
                    <CornerDownRight size={14} />
                    <span>延伸自《<MathText text={parentLesson.title} />》：會沿用原來源，並從那篇筆記接著講。</span>
                    <button className="icon-button" onClick={() => setParentLesson(undefined)} aria-label="取消延伸，改為獨立的新筆記" title="改為獨立的新筆記"><X size={14} /></button>
                  </div>
                )}
                {route.page === "explain" ? null : (
                  <div className="composer-tabs" role="tablist" aria-label="內容類型">
                    {modes.map((mode) => (
                      <button
                        key={mode.id}
                        role="tab"
                        aria-selected={kind === mode.id}
                        className={kind === mode.id ? "selected" : ""}
                        onClick={() => {
                          if (mode.id !== kind) setParentLesson(undefined);
                          setKind(mode.id);
                          setRepoQuestion("");
                          setIndexedRepoId(undefined);
                          setExampleId(undefined);
                          setError("");
                          inputRef.current?.focus();
                        }}
                      >
                        <mode.icon size={16} />
                        {mode.label}
                      </button>
                    ))}
                    <span className="composer-corner">INPUT / 01</span>
                  </div>
                )}
                {composerKind === "document" ? <DocumentUpload
                  key={documentDraftKey}
                  value={documentDraft}
                  onChange={(value) => { setDocumentDraft(value); setError(""); }}
                  onUploading={setDocumentUploading}
                  question={documentQuestion}
                  onQuestionChange={setDocumentQuestion}
                  onChoiceChange={setDocumentChoice}
                  disabled={busy && !!runningDocument && documentDraft?.id === runningDocument}
                  reading={watched.find((item) => item.kind === "reading" && item.documentId === documentDraft?.id)}
                  onDeepRead={config.configured && documentDraft ? (options) => void startReading(documentDraft.id, documentDraft.name, options) : undefined}
                  onStopReading={(id) => void api.cancelJob(id).catch(() => notify("無法停止，請稍後再試。"))}
                /> : <div className="input-area">
                  <textarea
                    ref={inputRef}
                    dir="auto"
                    value={composerInput}
                    onChange={(event) => {
                      if (route.page === "explain") updateHandoff(current => ({ text: event.target.value, title: current?.title || "", from: current?.from, back: current?.back, truncated: current?.truncated || false }));
                      else setInput(event.target.value);
                      setIndexedRepoId(undefined);
                      setExampleId(undefined);
                      setError("");
                    }}
                    placeholder={route.page === "explain" ? "問一個問題，或貼上文字、連結" : modes.find((mode) => mode.id === kind)?.placeholder}
                    aria-label={route.page === "explain" ? "編輯交接草稿" : `輸入${modes.find((mode) => mode.id === kind)?.label}`}
                    maxLength={route.page === "explain" ? 2000 : 30000}
                    spellCheck={false}
                    className={composerKind === "code" ? "code-input" : ""}
                    onInput={event => {
                      event.currentTarget.style.height = "auto";
                      event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 420)}px`;
                    }}
                    onKeyDown={(event) => {
                      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                        event.preventDefault();
                        void begin();
                      }
                    }}
                  />
                  {composerInput && (
                    <button
                      className="clear-input icon-button"
                      onClick={() => {
                        if (route.page === "explain") updateHandoff(current => ({ text: "", title: current?.title || "", from: current?.from, back: current?.back, truncated: false }));
                        else setInput("");
                        setIndexedRepoId(undefined);
                        setExampleId(undefined);
                      }}
                      aria-label="清除輸入"
                    >
                      <X size={15} />
                    </button>
                  )}
                  <div className="input-meta">
                    {exampleId && <span className="sample-label"><Sparkles size={12} />人工編寫的示範內容</span>}
                    <span>{Array.from(composerInput).length.toLocaleString()} / {route.page === "explain" ? "2,000" : "30,000"}</span>
                  </div>
                </div>}
                {composerKind !== "repo" && composerKind !== "document" && !exampleId && (
                  <input
                    className="topic-question"
                    aria-label="想弄懂的重點"
                    value={topicQuestion}
                    onChange={(event) => setTopicQuestion(event.target.value)}
                    maxLength={4000}
                    placeholder="想弄懂的重點（選填）"
                  />
                )}
                {composerKind === "repo" && (
                  <div className="repo-composer-options">
                    <div>
                      <span>
                        {indexedRepoId
                          ? "已選用固定版本的 Repo 索引"
                          : "先索引完整檔案樹，再為你的問題找出相關內容"}
                      </span>
                      <button
                        onClick={() => navigate("repositories")}
                      >
                        <GitBranch size={13} />
                        管理 Repo 索引
                        <ArrowUpRight size={13} />
                      </button>
                    </div>
                    <input
                      aria-label="想了解 Repo 的什麼"
                      value={repoQuestion}
                      onChange={(event) => setRepoQuestion(event.target.value)}
                      maxLength={4000}
                      placeholder="想了解什麼？例如：請追蹤使用者登入的資料流程"
                    />
                  </div>
                )}
                <div className="composer-footer">
                  <div className="composer-preferences">
                    <Select
                      label="解說深度"
                      value={depth}
                      options={(Object.keys(DEPTHS) as Depth[]).map(value => ({ value, label: DEPTHS[value].label }))}
                      onChange={value => setDepth(value as Depth)}
                      disabled={!!exampleId}
                    />
                  </div>
                  <div className="composer-actions">
                    {route.page === "explain" && <button type="button" className="secondary-button" onClick={discardHandoff} disabled={busy}>捨棄</button>}
                    <button
                      className="primary-button generate-button"
                      disabled={
                        (composerKind === "document" ? !documentDraft || documentUploading || !!documentChoice.error : !composerInput.trim() && !indexedRepoId) ||
                        busy || loading || !configReady || !config.configured
                      }
                      onClick={() => void begin()}
                    >
                      {busy ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={16} />}
                      {busy ? "正在整理理解" : route.page === "explain" ? "開始解釋" : exampleId ? "體驗這段解說" : "開始解釋"}
                      {!busy && <kbd>{modifierKey} ↵</kbd>}
                    </button>
                  </div>
                </div>
              </section>
              {error && (
                <div className="generation-error" role="alert">
                  <CircleHelp size={18} />
                  <span>{configReady && config.configured ? error : "Codex 未連接"}</span>
                  {(!configReady || !config.configured) && (
                    <button onClick={() => setSettingsOpen(true)}>
                      <Settings2 size={13} />設定
                    </button>
                  )}
                </div>
              )}
              {busy ? (
                <section className="generation-panel" aria-live="polite">
                  <div className="generation-title">
                    <span>
                      <LoaderCircle className="spin" size={17} />
                      {stageMessage}
                    </span>
                    <button onClick={cancelGeneration} disabled={cancelling}>
                      取消
                    </button>
                  </div>
                  <div className="generation-stages">
                    {stageLabels.map((item, i) => {
                      const current = stageLabels.findIndex(
                        (s) => s.id === stage,
                      );
                      return (
                        <div
                          key={item.id}
                          className={`${i === current ? "stage-active" : i < current ? "stage-done" : ""}`}
                        >
                          <span>
                            {i < current ? (
                              <Check size={17} />
                            ) : (
                              <item.icon size={17} />
                            )}
                          </span>
                          <div>
                            <b>{item.label}</b>
                            <small>{item.detail}</small>
                          </div>
                          {i < 3 && <ChevronRight size={14} />}
                        </div>
                      );
                    })}
                  </div>
                </section>
              ) : (
                lessons.some((lesson) => !lesson.isDemo) ? null : <div className="try-examples">
                  {exampleLessons.map((lesson, i) => (
                    <button key={lesson.id} onClick={() => useExample(lesson)}>
                      {i === 0 ? (
                        <Code2 size={13} />
                      ) : i === 1 ? (
                        <Waypoints size={13} />
                      ) : (
                        <Lightbulb size={13} />
                      )}
                      {i === 0
                        ? "為什麼函式會有記憶？"
                        : i === 1
                          ? "搞懂 Event Loop"
                          : "搜尋框背後的 Debounce"}
                      <ArrowUpRight size={12} />
                    </button>
                  ))}
                </div>
              )}
              <section className="recent-section">
                <div className="section-heading">
                  <h2>最近筆記 <span className="count-label">{lessonCount}</span></h2>
                  <button className="text-button" onClick={() => { setQuery(""); setCategory("全部"); navigate("library"); }}>
                    知識庫<ArrowRight size={15} />
                  </button>
                </div>
                {!loading && ((reviewWaiting ?? 0) > 0 || (reviewState.status !== "ready" && reviewState.status !== "stale")) && (
                  <button
                    className={`continue-card review-today-card review-state-${reviewState.status}`}
                    onClick={() => reviewState.status === "error" ? void refreshReview() : navigate("review")}
                    disabled={reviewState.status === "error" && reviewState.retrying}
                    aria-label={reviewState.status === "error" && !reviewState.retrying ? copy.home.reviewCard.errorAria : reviewState.status === "loading" ? copy.home.reviewCard.loadingAria : undefined}
                    aria-busy={reviewState.status === "error" && reviewState.retrying || undefined}
                    title={reviewState.status === "error" ? copy.home.reviewCard.errorTooltip : undefined}
                  >
                    <span className="continue-eyebrow"><Repeat size={14} />{copy.home.reviewCard.eyebrow}</span>
                    {reviewState.status === "error" ? (
                      <span className="review-today-summary">
                        <span className="nav-count nav-count-unknown">{copy.home.reviewCard.unknownBadge}</span>
                        <strong>{copy.home.reviewCard.errorTitle}</strong>
                      </span>
                    ) : <strong>{reviewState.status === "loading" ? copy.home.reviewCard.loading : fill(reviewWaiting === 1 ? copy.home.reviewCard.waitingCountOne : copy.home.reviewCard.waitingCount, { count: reviewWaiting ?? 0 })}</strong>}
                    <span className="continue-where">
                      {reviewState.status === "error" ? (reviewState.retrying ? copy.home.reviewCard.retrying : copy.home.reviewCard.retry) : reviewState.status === "stale" ? copy.home.reviewCard.staleHint : reviewState.status === "loading" ? "" : reviewBreakdown}
                    </span>
                  </button>
                )}
                {continueReading && !loading && (
                  <button className="continue-card" onClick={() => navigate("note", continueReading.lesson.id, continueReading.progress.sectionId)}>
                    <span className="continue-eyebrow"><BookOpen size={14} />繼續閱讀</span>
                    <strong><MathText text={continueReading.lesson.title} /></strong>
                    <span className="continue-where">{continueReading.progress.index + 1} / {continueReading.progress.total} · <MathText text={continueReading.heading} /></span>
                    <progress value={Math.min(continueReading.progress.furthest, continueReading.progress.total - 1) + 1} max={continueReading.progress.total} aria-label="這篇已讀到的段落" />
                  </button>
                )}
                {loading ? (
                  <div className="loading-state" role="status"><LoaderCircle size={22} className="spin" />載入中…</div>
                ) : lessons.length ? (
                  <div className="notes-grid">
                    {lessons.slice(0, 3).map((lesson, index) => (
                      <NoteCard key={lesson.id} lesson={lesson} index={index} onOpen={() => navigate("note", lesson.id)} onFavorite={() => void favorite(lesson)} />
                    ))}
                  </div>
                ) : lessonsReady ? (
                  <div className="empty-state">
                    <BookOpen size={26} />
                    <h3>還沒有筆記</h3>
                    <button className="secondary-button" onClick={newLearning}>開始解釋</button>
                  </div>
                ) : null}
              </section>
            </div>
          )}
          {(route.page === "library" || route.page === "favorites") && (
            <div className="library-page page-container">
              <div className="page-heading">
                <div><h1>{route.page === "favorites" ? "收藏" : "知識庫"}</h1></div>
                <button className="primary-button" onClick={newLearning}>
                  <Plus size={16} />
                  新的學習
                </button>
              </div>
              <div className="library-toolbar">
                <div className="filter-tabs">
                  <button
                    className={category === "全部" ? "active" : ""}
                    onClick={() => setCategory("全部")}
                  >
                    全部筆記{" "}
                    <span>
                      {route.page === "favorites"
                        ? favorites.length
                        : lessonCount}
                    </span>
                  </button>
                  {categories.map((cat) => (
                    <button
                      key={cat}
                      className={category === cat ? "active" : ""}
                      onClick={() => setCategory(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
                <div className="library-search">
                  <Search size={16} />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜尋標題、內容或主題"
                    aria-label="搜尋筆記"
                  />
                  {query && (
                    <button
                      className="icon-button"
                      onClick={() => setQuery("")}
                      aria-label="清除搜尋"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
              <div className="library-result-label">
                <span>
                  {filtered.length} 篇{query ? `與「${query}」相關的` : ""}筆記
                </span>
                <span>
                  <LayoutGrid size={14} />
                  依建立時間
                </span>
              </div>
              {filtered.length ? (
                <div className="notes-grid library-grid">
                  {filtered.map((lesson, index) => (
                    <NoteCard
                      key={lesson.id}
                      lesson={lesson}
                      index={index}
                      onOpen={() => navigate("note", lesson.id)}
                      onFavorite={() => void favorite(lesson)}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <Search size={34} />
                  <h3>
                    {route.page === "favorites" && !favorites.length
                      ? "收藏讓你想再看一次的理解"
                      : "還沒有找到相符的筆記"}
                  </h3>
                  <p>
                    {route.page === "favorites" && !favorites.length
                      ? "點選筆記上的星號，就可以收藏。"
                      : "換個關鍵字，或開始一段新的學習。"}
                  </p>
                </div>
              )}
            </div>
          )}
          {route.page === "repositories" && (
            <RepositoryWorkspace
              initialRepositoryId={selectedRepository}
              onExplain={(repoId, url, question) => {
                setParentLesson(undefined);
                setIndexedRepoId(repoId);
                setKind("repo");
                setInput(url);
                setRepoQuestion(question);
                setExampleId(undefined);
                setError("");
                navigate("home");
              }}
            />
          )}
          {route.page === "review" && (
            <ReviewSession
              openNote={(id, sectionId) => navigate("note", id, sectionId)}
              onReviewed={refreshReview}
              personalAvailable={Boolean(suiteLinks.personal)}
              sendToPersonal={(card: ReviewCardView) => setPersonalDraft({
                text: `複習《${card.lessonTitle}》\n\n${card.prompt}${card.context ? `\n\n${card.context}` : ""}`,
                back: explainNoteRoute(card.lessonId),
                source: `BELL Explain · 複習「${card.lessonTitle}」`,
              })}
            />
          )}
          {route.page === "graph" && (
            <div className="graph-page page-container">
              <KnowledgeGraph lessons={lessons} open={(id, sectionId) => navigate("note", id, sectionId)} selectTag={selectTag} />
            </div>
          )}
          {route.page === "note" &&
            (note ? (
              <NoteReader
                key={note.id}
                lesson={note}
                section={route.section}
                jump={jump}
                open={(id, sectionId) => navigate("note", id, sectionId)}
                favorite={() => void favorite(note)}
                remove={() => setDeleteId(note.id)}
                followUp={followUp}
                configured={config.configured}
                onReviewChange={refreshReview}
                notify={notify}
                personalAvailable={Boolean(suiteLinks.personal)}
                prHref={prDraftHref(suiteLinks.pr, `${note.title}\n\n${isLessonV3(note) ? note.answer : note.summary}`, note.title, explainNoteRoute(note.id), window.location.hostname)}
                sendToPersonal={(quote) => setPersonalDraft({
                  text: quote ?? `跟進學習筆記《${note.title}》\n\n${isLessonV3(note) ? note.answer : note.summary}`,
                  back: explainNoteRoute(note.id),
                  source: `BELL Explain · 筆記《${note.title}》${quote ? " · 選取文字" : ""}`,
                })}
                onLessonChange={updated => setLessons(current => current.map(item =>
                  item.id === updated.id && item.updatedAt <= updated.updatedAt ? updated : item
                ))}
                exampleProgress={
                  exampleJob?.id === note.id ? exampleJob.message : undefined
                }
                exampleError={exampleErrors[note.id]}
                lessons={lessons}
                onAddExamples={config.configured && !busy && !exampleJob && !isLessonV3(note) ? () => void prepareExamples(note) : undefined}
                onCancelExamples={exampleJob?.id === note.id ? cancelExamples : undefined}
                reformat={config.lessonV3 && !isLessonV3(note) && !note.isDemo ? { ...reformatJob[note.id], onStart: () => void startReformat(note.id), onOpenSettings: () => { setSettingsTab("model"); setSettingsOpen(true); } } : undefined}
                toggleTheme={() => setTheme(value => value === "dark" ? "light" : "dark")}
              />
            ) : loading ? (
              <div className="loading-state">
                <LoaderCircle className="spin" />
                正在載入筆記
              </div>
            ) : (
              <div className="empty-state">
                <BookOpen size={32} />
                <h2>{learningCopy().states.lesson.notFoundTitle}</h2>
                <p>{learningCopy().states.lesson.notFoundBody}</p>
                <button
                  className="primary-button"
                  onClick={() => navigate("library")}
                >
                  {learningCopy().states.lesson.libraryAction}
                </button>
              </div>
            ))}
        </main>
      </div>
      {/* With progress pills on screen, the toast joins their stack so neither covers the other. */}
      {toast && !pills && toastView}
      {pills ? (
        <div className="job-pills" aria-live="polite">
          {toast && toastView}
          {busy && !composing && (
            <button type="button" className="job-pill" onClick={() => navigate("home")} title="查看生成進度">
              <LoaderCircle size={15} className="spin" />
              <span><b>正在解說：{jobTitle}</b><small>{stageMessage}</small></span>
            </button>
          )}
          {watched.map((item) => (
            <div key={item.id} className="job-pill job-pill-watched" title={item.kind === "reading" ? "深度解析在伺服器上進行，離開頁面不會停止" : "在其他分頁或裝置開始的解說"}>
              <LoaderCircle size={15} className="spin" />
              <span><b>{item.kind === "reading" ? "正在深度解析" : "其他頁面正在解說"}：{item.title}</b><small>{item.message}</small></span>
              {/* Its own tab may be gone; stopping it here is the only way to free the slot. */}
              {!item.id.startsWith("pending:") && (
                <button type="button" className="job-pill-stop" onClick={() => void api.cancelJob(item.id).catch(() => notify("無法停止，請稍後再試。"))}>停止</button>
              )}
            </div>
          ))}
          {exampleJob && !(route.page === "note" && route.id === exampleJob.id) && (
            <button type="button" className="job-pill" onClick={() => navigate("note", exampleJob.id)} title="回到這篇筆記">
              <LoaderCircle size={15} className="spin" />
              <span><b>正在補上實作案例：{lessons.find((lesson) => lesson.id === exampleJob.id)?.title || "筆記"}</b><small>{exampleJob.message}</small></span>
            </button>
          )}
        </div>
      ) : null}
      <Suspense fallback={null}><PreciseSwitcher links={suiteLinks} open={suiteOpen} onOpenChange={setSuiteOpen} /></Suspense>
      {searchOpen && (
        <Dialog title="搜尋" close={() => setSearchOpen(false)} className="search-dialog" initialFocusRef={searchInputRef}>
          <div className="search-dialog-input">
            <Search size={20} />
            <input ref={searchInputRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜尋" aria-label="搜尋所有筆記" />
            <kbd>esc</kbd>
          </div>
          <div className="search-dialog-results search-knowledge-results">
            {search.trim() ? (
              <SemanticSearch query={search} onOpen={(id, sectionId) => { setSearchOpen(false); navigate("note", id, sectionId); }} onRepository={openRepository} />
            ) : (
              <div className="search-suggestions">
                {["函式為什麼能記得外面的變數", "連續輸入後只送出最後一次請求", "非同步工作按照什麼順序執行"].map((value) => (
                  <button key={value} onClick={() => setSearch(value)}><Search size={14} />{value}<ArrowUpRight size={14} /></button>
                ))}
              </div>
            )}
          </div>
        </Dialog>
      )}
      {settingsOpen && (
        <Dialog
          title="設定"
          close={() => setSettingsOpen(false)}
          className="workspace-settings-dialog"
        >
          <div
            className="workspace-settings-tabs"
            role="tablist"
            aria-label="設定分類"
          >
            {(
              [
                { id: "model", label: "模型與推理", icon: Sparkles },
                { id: "embedding", label: "語意檢索", icon: Search },
                { id: "sync", label: "雲端同步", icon: GitBranch },
              ] as const
            ).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                role="tab"
                aria-selected={settingsTab === id}
                aria-controls={`settings-${id}`}
                id={`settings-tab-${id}`}
                onClick={() => setSettingsTab(id)}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`settings-${settingsTab}`}
            aria-labelledby={`settings-tab-${settingsTab}`}
          >
            {settingsTab === "model" && (
              <ModelSettings
                onSaved={() => {
                  void load();
                  notify("模型設定已儲存");
                }}
              />
            )}
            {settingsTab === "embedding" && <EmbeddingSettings />}
            {settingsTab === "sync" && (
              <SyncSettings
                onRemoteChange={() => {
                  void load();
                }}
              />
            )}
          </div>
        </Dialog>
      )}
      {personalDraft && (
        <Dialog title="送到 Personal" close={() => setPersonalDraft(undefined)} className="suite-draft-dialog">
          <div className="suite-source-copy"><span className="suite-source-chip"><bdi>{personalDraft.source}</bdi></span></div>
          <pre className="suite-draft-preview">{personalDraft.text}</pre>
          <div className="suite-draft-actions">
            <button type="button" className="secondary-button" onClick={() => setPersonalDraft(undefined)}>捨棄</button>
            {personalDraftLink ? <a className="primary-button" href={personalDraftLink}><ListTodo size={16} />開啟待辦草稿<ArrowUpRight size={15} /></a> : <span className="suite-handoff-note">尚未連結</span>}
          </div>
        </Dialog>
      )}
      {deleteId && (
        <Dialog title={copy.lesson.deleteDialog.title} close={() => setDeleteId(undefined)} closeLabel={copy.lesson.deleteDialog.keep}>
          <div className="delete-content">
            <p>{fill(copy.lesson.deleteDialog.body, { title: lessons.find(lesson => lesson.id === deleteId)?.title ?? deleteId })}</p>
            <div>
              <button
                className="secondary-button"
                onClick={() => setDeleteId(undefined)}
              >
                {copy.lesson.deleteDialog.keep}
              </button>
              <button className="danger-button" onClick={() => void remove()}>
                {copy.lesson.deleteDialog.confirm}
              </button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}

type NoteReaderProps = {
  lesson: StoredLesson;
  /** Every saved note, to resolve links in both directions. */
  lessons: StoredLesson[];
  section?: string;
  /** Changes on every address change, including one to the section already shown. */
  jump: number;
  open: (id: string, section?: string) => void;
  favorite: () => void;
  remove: () => void;
  followUp: (question: string, parent: StoredLesson) => void;
  /** Whether a model is connected, so self-check answers can be graded. */
  configured: boolean;
  /** A recorded self-check may have queued a review card. */
  onReviewChange: () => void;
  notify: (message: string) => void;
  personalAvailable: boolean;
  prHref?: string;
  sendToPersonal: (quote?: string) => void;
  exampleProgress?: string;
  exampleError?: string;
  /** Starts a model call that adds practical examples; absent while unavailable. */
  onAddExamples?: () => void;
  /** Stops the example job running for this note. */
  onCancelExamples?: () => void;
  onLessonChange: (lesson: StoredLesson) => void;
  reformat?: { message?: string; error?: string; noModel?: boolean; onStart: () => void; onOpenSettings: () => void };
  toggleTheme: () => void;
};

function NoteReader(props: NoteReaderProps) {
  return isLessonV3(props.lesson)
    ? <LessonV3Reader {...props} lesson={props.lesson} />
    : <LegacyNoteReader {...props} lesson={props.lesson} />;
}

function LegacyNoteReader({
  lesson,
  section,
  jump,
  open,
  favorite,
  remove,
  followUp,
  configured,
  onReviewChange,
  notify,
  personalAvailable,
  prHref,
  sendToPersonal,
  exampleProgress,
  exampleError,
  onAddExamples,
  onCancelExamples,
  onLessonChange,
  lessons,
  reformat,
  toggleTheme,
}: Omit<NoteReaderProps, "lesson"> & { lesson: Lesson }) {
  const copy = learningCopy();
  const initial =
    lesson.sections.find((s) => s.id === section) || lesson.sections[0];
  const [activeId, setActiveId] = useState(initial?.id || "");
  const [step, setStep] = useState(initial?.visualStep || 0);
  const [tab, setTab] = useState<"explanation" | "source">("explanation");

  const [predict, setPredict] = usePredictMode();
  const [actionsHost, setActionsHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setActionsHost(document.getElementById("reader-topbar-actions"));
    return () => setActionsHost(null);
  }, []);
  const related = useMemo(() => relatedNotes(lesson, lessons), [lesson, lessons]);
  const activeSection =
    lesson.sections.find((s) => s.id === activeId) || initial;
  const activeIndex = Math.max(0, lesson.sections.findIndex((part) => part.id === activeId));
  const answerEnd = lesson.summary.search(/[。！？!?]/);
  const answer = (answerEnd < 0 ? lesson.summary : lesson.summary.slice(0, answerEnd + 1)).trim();
  const readingMinutes = Math.max(1, Math.ceil((lesson.summary.length + lesson.sections.reduce((total, part) => total + part.body.length, 0)) / 300));
  // PDF lessons read side by side: the original on one pane, the explanation on the other.
  const pdfDocument = lesson.source.kind === "document" && lesson.source.document?.format === "pdf" ? lesson.source.document : undefined;
  const totalPages = pdfDocument?.totalUnits ?? 0;
  const [pdfTarget, setPdfTarget] = useState<PdfTarget>();
  const [pdfPane, setPdfPane] = useState<"pdf" | "visual">("pdf");
  const [narrowPane, setNarrowPane] = useState<"explanation" | "pdf" | "visual">("explanation");
  const [followPdf, setFollowPdf] = useState(true);
  const sectionPages = useMemo(() => new Map(lesson.sections.map((part) => [part.id, totalPages
    ? citedRanges([part.heading, part.body, part.analogy, part.codeExample?.scenario, part.codeExample?.application].filter(Boolean).join("\n"), totalPages)
    : []])), [lesson.sections, totalPages]);
  const activePages = markedPages(sectionPages.get(activeSection?.id || "") || []);
  const showPane = (pane: "explanation" | "pdf" | "visual") => {
    setNarrowPane(pane);
    if (pane !== "explanation") setPdfPane(pane);
  };
  const goToPage = (page: number) => {
    setPdfTarget({ page, key: Date.now() });
    setPdfPane("pdf");
    if (window.matchMedia("(max-width: 960px)").matches) showPane("pdf");
  };
  const pageLinks = pdfDocument ? (text: string) => linkPages(text, totalPages, goToPage) : undefined;
  // A page chosen with a section's page chip, which also turns to that section.
  const pickedPage = useRef<string | undefined>(undefined);
  // Turning to a section turns the PDF to the first page it cites, unless one of its pages was chosen.
  useEffect(() => {
    const picked = pickedPage.current;
    pickedPage.current = undefined;
    if (!pdfDocument || !followPdf || picked === activeId) return;
    const first = sectionPages.get(activeId)?.[0]?.start;
    if (first) setPdfTarget({ page: first, key: Date.now() });
  }, [activeId, followPdf, pdfDocument?.id]);
  // Remember the section being read, in the address and this browser, without changing what is focused.
  useEffect(() => {
    if (tab !== "explanation") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.find((entry) => entry.isIntersecting);
      const part = visible && lesson.sections.find((item) => `section-${item.id}` === visible.target.id);
      if (part) remember(part);
    // The band includes the centre, where a restored or clicked section is scrolled to.
    }, { rootMargin: "-45% 0px -50% 0px" });
    for (const part of lesson.sections) {
      const element = document.getElementById(`section-${part.id}`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [lesson.id, lesson.sections, tab]);
  // While following, the section crossing the middle of the screen becomes active.
  useEffect(() => {
    if (!pdfDocument || !followPdf || tab !== "explanation") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.find((entry) => entry.isIntersecting);
      const part = visible && lesson.sections.find((item) => `section-${item.id}` === visible.target.id);
      if (part) { setActiveId(part.id); setStep(part.visualStep); }
    }, { rootMargin: "-40% 0px -55% 0px" });
    for (const part of lesson.sections) {
      const element = document.getElementById(`section-${part.id}`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [pdfDocument?.id, followPdf, tab, lesson.sections]);
  const remember = (part: LessonSection) => {
    // Focus can come back to this note just after navigating, even within it (search
    // results, dialogs): a navigation still on its way wins.
    const route = readRoute();
    if (route.page !== "note" || route.id !== lesson.id) return;
    if (pendingNavigation && window.location.hash === pendingNavigation) return;
    // replaceState keeps the address shareable without a hashchange that would scroll to the top.
    const hash = `#/note/${encodeURIComponent(lesson.id)}/${encodeURIComponent(part.id)}`;
    if (window.location.hash !== hash) window.history.replaceState(window.history.state, "", hash);
    saveReadingProgress(lesson.id, part.id, lesson.sections.indexOf(part), lesson.sections.length);
  };
  const focus = (part: LessonSection, scroll = false) => {
    setActiveId(part.id);
    setStep(part.visualStep);
    remember(part);
    if (scroll)
      document.getElementById(`section-${part.id}`)?.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
        block: "center",
      });
  };
  useEffect(() => {
    if (section) {
      const part = lesson.sections.find((s) => s.id === section);
      if (part) {
        setActiveId(part.id);
        setStep(part.visualStep);
        setTimeout(
          () =>
            document
              .getElementById(`section-${part.id}`)
              ?.scrollIntoView({ block: "center" }),
          80,
        );
      }
    }
  }, [section, jump]);
  const asideContent = (
    <>
      <nav className="reader-toc" aria-label={copy.lesson.rail.ariaLabel}>
        <ol>
          {lesson.sections.map((part, index) => (
            <li key={part.id} className={index < activeIndex ? "done" : index === activeIndex ? "current" : "upcoming"}>
              <button onClick={() => { setTab("explanation"); focus(part, true); }} aria-current={index === activeIndex ? "step" : undefined}>
                <span className="reader-toc-status">{index < activeIndex && <Check size={12} />}</span>
                <span><MathText text={cleanHeading(part.heading)} /></span>
              </button>
            </li>
          ))}
          {lesson.followUpQuestions.length > 0 && <li className="upcoming">
            <button onClick={() => document.getElementById("reader-end")?.scrollIntoView({ block: "start" })}>
              <span className="reader-toc-status" /><span>{copy.lesson.rail.followUpsItem}</span>
            </button>
          </li>}
        </ol>
      </nav>
      <button className="reader-original-button" onClick={() => setTab(tab === "explanation" ? "source" : "explanation")}>
        <FileText size={14} />{tab === "explanation" ? copy.lesson.rail.originalSource : copy.lesson.rail.backToExplanation}
      </button>
      {lesson.visual.illustration?.kind === "rubik-2x2" ? (
        <>
          <RubikIllustration
            data={lesson.visual.illustration}
            sectionIndex={activeIndex}
          />
          <details className="rb-flow-details">
            <summary>對照程式資料流 · {lesson.visual.steps.length} 個步驟 <ChevronDown size={14} /></summary>
            <ConceptAnimation curated={lesson.isDemo} visual={lesson.visual} step={step} onStepChange={setStep} predict={predict} />
          </details>
        </>
      ) : (
        <ConceptAnimation curated={lesson.isDemo} visual={lesson.visual} step={step} onStepChange={setStep} predict={predict} />
      )}
    </>
  );
  const readerActions = (
    <div className="reader-actions">
      <button
        className={`predict-toggle${predict ? " is-on" : ""}`}
        aria-label={copy.lesson.topbar.predictToggle}
        aria-pressed={predict}
        onClick={() => setPredict(!predict)}
        title={copy.lesson.topbar.predictTooltipLegacy}
      >
        <Eye size={14} /><span>{copy.lesson.topbar.predictToggle}</span>
      </button>
      <button
        type="button"
        className="text-button send-personal-button"
        aria-label={personalAvailable ? copy.lesson.topbar.sendToPersonalAria : copy.lesson.topbar.sendToPersonalDisabledAria}
        onClick={() => sendToPersonal()}
        disabled={!personalAvailable}
        title={personalAvailable ? copy.lesson.topbar.sendToPersonalTooltip : copy.lesson.topbar.sendToPersonalUnavailable}
      >
        <ListTodo size={15} /><span>{copy.lesson.topbar.sendToPersonal}</span>
      </button>
      <button
        className={`icon-button ${lesson.favorite ? "is-favorite" : ""}`}
        onClick={favorite}
        aria-label={lesson.favorite ? copy.lesson.topbar.unbookmarkAria : copy.lesson.topbar.bookmarkAria}
        title={lesson.favorite ? copy.lesson.topbar.unbookmarkTooltip : copy.lesson.topbar.bookmarkTooltip}
      >
        <Star size={17} fill={lesson.favorite ? "currentColor" : "none"} />
      </button>
      <details className="reader-more">
        <summary className="icon-button" aria-label={copy.lesson.topbar.moreActionsAria} title={copy.lesson.topbar.moreActionsTooltip}><MoreHorizontal size={17} /></summary>
        <div className="reader-more-menu" onClick={(event) => {
          if ((event.target as Element).closest("button, a")) event.currentTarget.parentElement?.removeAttribute("open");
        }}>
          <button className="reader-more-secondary" aria-pressed={predict} onClick={() => setPredict(!predict)}><Eye size={15} />{copy.lesson.moreMenu.predictToggle}</button>
          <button className="reader-more-secondary reader-more-personal" aria-label={personalAvailable ? undefined : copy.lesson.topbar.sendToPersonalDisabledAria} onClick={() => sendToPersonal()} disabled={!personalAvailable}><ListTodo size={15} /><span>{copy.lesson.moreMenu.sendToPersonal}</span>{!personalAvailable && <span className="reader-more-hint">{copy.lesson.moreMenu.sendToPersonalUnavailableHint}</span>}</button>
          {prHref && <a href={prHref}><GitPullRequest size={15} /><span>{copy.lesson.moreMenu.sendToPr}</span></a>}
          <button className="reader-more-secondary" onClick={toggleTheme}><Sun size={15} />{copy.lesson.moreMenu.toggleTheme}</button>
          {reformat && <button onClick={reformat.onStart} disabled={!!reformat.message}><Sparkles size={15} />{formatCopy().reformatV3}</button>}
          <button onClick={() => setTab(tab === "explanation" ? "source" : "explanation")}><FileText size={15} />{tab === "explanation" ? copy.lesson.moreMenu.originalSource : copy.lesson.moreMenu.backToExplanation}</button>
          <button onClick={() => {
            exportLesson(lesson, markdownRelations(related, copy.lesson.exportRelations));
            notify(copy.lesson.moreMenu.exportedToast);
          }}><ArrowDownToLine size={15} />{copy.lesson.moreMenu.exportMarkdown}</button>
          <button onClick={remove}><Trash2 size={15} />{copy.lesson.moreMenu.deleteLesson}</button>
        </div>
      </details>
    </div>
  );
  return (
    <ReadingAnnotations
      lesson={lesson}
      onLessonChange={onLessonChange}
      personalAvailable={personalAvailable}
      sendToPersonal={sendToPersonal}
    >
    <div className="reader-page">
      {actionsHost ? createPortal(readerActions, actionsHost) : <div className="reader-toolbar">{readerActions}</div>}
      <div className="reader-progress-strip" aria-label={`閱讀進度：第 ${activeIndex + 1} 段，共 ${lesson.sections.length} 段`}>
        <span><b>{activeIndex + 1}</b> / {lesson.sections.length}</span>
        <span className="reader-progress-segments" aria-hidden="true">
          {lesson.sections.map((part, index) => <i key={part.id} className={index < activeIndex ? "done" : index === activeIndex ? "current" : ""} />)}
        </span>
      </div>
      <div className={`reader-layout${pdfDocument ? " reader-layout-pdf" : ""}`} data-pane={pdfDocument ? narrowPane : undefined}>
        {pdfDocument && (
          <>
            <div className="reader-pane-switch" role="group" aria-label="閱讀窗格">
              <button className={narrowPane === "explanation" ? "active" : ""} aria-pressed={narrowPane === "explanation"} onClick={() => showPane("explanation")}><Sparkles size={14} />解說</button>
              <button className={narrowPane === "pdf" ? "active" : ""} aria-pressed={narrowPane === "pdf"} onClick={() => showPane("pdf")}><FileText size={14} />原文 PDF</button>
              <button className={narrowPane === "visual" ? "active" : ""} aria-pressed={narrowPane === "visual"} onClick={() => showPane("visual")}><Waypoints size={14} />圖解</button>
            </div>
            <aside className="reader-pdf-pane" aria-label="PDF 原文與互動圖解">
              <div className="reader-pdf-tabs">
                <button className={pdfPane === "pdf" ? "active" : ""} onClick={() => showPane("pdf")}><FileText size={14} />原文 PDF</button>
                <button className={pdfPane === "visual" ? "active" : ""} onClick={() => showPane("visual")}><Waypoints size={14} />圖解與段落</button>
                <label className="reader-follow" title="點選或捲動到段落時，PDF 自動翻到該段引用的頁面">
                  <input type="checkbox" checked={followPdf} onChange={(event) => setFollowPdf(event.target.checked)} />
                  跟著解說翻頁
                </label>
              </div>
              <div className="reader-pdf-body" hidden={pdfPane !== "pdf"}>
                <Suspense fallback={<div className="pdf-viewer"><div className="pdf-state" role="status"><LoaderCircle className="spin" size={22} /><span>正在載入 PDF 檢視器…</span></div></div>}>
                  <PdfViewer documentId={pdfDocument.id} fileName={pdfDocument.name} target={pdfTarget} highlightPages={activePages} />
                </Suspense>
              </div>
              <div className="reader-pdf-visual" hidden={pdfPane !== "visual"} role="region" aria-label="段落、進度與互動圖解" tabIndex={0}>
                {asideContent}
              </div>
            </aside>
          </>
        )}
        <div className="reader-document">
          {/* Hidden, not unmounted, on the source tab: answers being written or graded survive a look at the source. */}
          <div className="reader-explanation" hidden={tab !== "explanation"}>
              {reformat?.message && <div className="reformat-progress" role="status"><LoaderCircle className="spin" size={16} />{reformat.message}</div>}
              {reformat?.error && <div className="page-error" role="alert"><span>{reformat.error}</span>{reformat.noModel && <button onClick={reformat.onOpenSettings}>{formatCopy().reformatOpenSettings}</button>}</div>}
              <header className="reader-heading">
                <h1><MathText text={lesson.title} /></h1>
                <p className="reader-question"><MathText text={lesson.subtitle} /></p>
                <div className="reader-meta">
                  <span><i className="category-dot" />{lesson.category}</span>
                  <span><ListTodo size={13} />{lesson.sections.length} 段</span>
                  <span><Clock size={13} />約 {readingMinutes} 分鐘</span>
                  {lesson.failedFormat === 3 && <span className="format-failed-badge" title={formatCopy().reformatFailedTooltipRebuild}>{formatCopy().reformatFailedBadge}</span>}
                </div>
                {lesson.failedFormat === 3 && <p className="reader-reformat-note">{formatCopy().reformatFailedTooltipRebuild}</p>}
                <p className="reader-answer"><AnnotatedText text={answer} sourceKey="summary" renderPlain={pageLinks} math /></p>
                <ol className="reading-outline" aria-label="段落地圖">
                  {lesson.sections.map((part, index) => (
                    <li key={part.id} className={index < activeIndex ? "done" : index === activeIndex ? "current" : "upcoming"}>
                      <button onClick={() => focus(part, true)} aria-current={index === activeIndex ? "step" : undefined}>
                        <span className="reading-outline-number">{index < activeIndex ? <Check size={12} /> : index + 1}</span>
                        <span><MathText text={cleanHeading(part.heading)} /></span>
                      </button>
                    </li>
                  ))}
                </ol>
              </header>
              {!lesson.isDemo && !lesson.sections.some((part) => part.codeExample) && (
                <div className="example-status" role="status">
                  {exampleProgress ? <LoaderCircle className="spin" size={15} /> : <Code2 size={15} />}
                  <p>{exampleProgress || exampleError || "還沒有實作案例"}</p>
                  {!exampleProgress ? (
                    <button className="text-button" onClick={onAddExamples} disabled={!onAddExamples} title="會呼叫目前選取的模型">{exampleError ? "重試" : "補上實作案例"}</button>
                  ) : onCancelExamples && <button className="text-button" onClick={onCancelExamples}>取消</button>}
                </div>
              )}
              {lesson.sections.map((part, index) => (
                <section
                  id={`section-${part.id}`}
                  key={part.id}
                  className={`explanation-section ${activeId === part.id ? "section-focused" : ""}`}
                  onClick={() => focus(part)}
                  onFocus={() => focus(part)}
                >
                  <div className="explanation-step">{index + 1} / {lesson.sections.length}</div>
                  <div className="explanation-heading">
                    <h2><AnnotatedText text={cleanHeading(part.heading)} sourceKey={`${part.id}:heading`} math /></h2>
                    <button
                      className="icon-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        focus(part);
                      }}
                      title="連動旁邊的動畫與相關筆記"
                      aria-label={`聚焦段落：${cleanHeading(part.heading)}`}
                    >
                      <Waypoints size={17} />
                    </button>
                  </div>
                  {!!sectionPages.get(part.id)?.length && (
                    <div className="section-pages" aria-label="這段引用的頁面">
                      {sectionPages.get(part.id)!.slice(0, 8).map((range) => (
                        <button key={`${range.start}-${range.end}`} onClick={(event) => { event.stopPropagation(); pickedPage.current = part.id; focus(part); goToPage(range.start); }} title={`在 PDF 原文開啟第 ${range.start} 頁`}>
                          <FileText size={12} />第 {range.start}{range.end > range.start ? `–${range.end}` : ""} 頁
                        </button>
                      ))}
                    </div>
                  )}
                  {/* Paragraphs, lists, subheadings and quotes, keeping multi-line display formulas whole. */}
                  <ProseBlocks
                    text={part.body}
                    paragraphClass="explanation-text"
                    listClass="explanation-list"
                    headingClass="explanation-subheading"
                    quoteClass="explanation-quote"
                    renderLine={(line) => <AnnotatedText text={line} sourceKey={`${part.id}:body`} renderPlain={pageLinks} math />}
                  />
                  {(() => {
                    const demoExample = !part.codeExample ? getDemoCodeExample(lesson.id, part.id) : undefined;
                    if (part.code && part.codeExample) {
                      return (
                        <PracticalExample
                          key={`${part.id}:${predict}`}
                          code={part.code}
                          language={part.language}
                          example={part.codeExample}
                          annotationSectionId={part.id}
                          predict={predict}
                        />
                      );
                    }
                    if (demoExample) {
                      return (
                        <PracticalExample
                          key={`${part.id}:${predict}:demo`}
                          code={demoExample.code}
                          language={demoExample.language}
                          example={demoExample.example}
                          predict={predict}
                        />
                      );
                    }
                    return part.code ? (
                      <CodeBlock code={part.code} language={part.language} annotationSource={`${part.id}:code`} />
                    ) : null;
                  })()}
                  {part.analogy && (
                    <p className="analogy">
                      <Lightbulb size={16} />
                      <AnnotatedText text={part.analogy} sourceKey={`${part.id}:analogy`} renderPlain={pageLinks} math />
                    </p>
                  )}
                  {activeId === part.id && (
                    <div className={`paragraph-concepts${pdfDocument ? "" : " reader-aside-status"}`}>
                      <small>
                        <i />
                        {pdfDocument ? (followPdf && sectionPages.get(part.id)?.length ? "正與 PDF 原文連動" : "正與圖解連動") : "正與右側圖解連動"}
                      </small>
                    </div>
                  )}
                </section>
              ))}
              <section className="reader-end" id="reader-end" aria-label={copy.lesson.rail.endRegionLegacyAria}>
                <SelfCheck
                  lesson={lesson}
                  configured={configured}
                  openSection={(id) => {
                    const part = lesson.sections.find((item) => item.id === id);
                    if (part) focus(part, true);
                  }}
                  followUp={(question) => void followUp(question, lesson)}
                  onRecorded={onReviewChange}
                />
                <RelatedNotes items={related} open={open} title="接著讀" />
                <div className="reader-bottom-source">
                  <FileText size={14} />
                  <span>來源：{lesson.source.label}{lesson.source.scope ? ` · ${lesson.source.scope}` : ""}</span>
                  <button onClick={() => setTab("source")}>原始內容</button>
                </div>
              </section>
          </div>
          {tab === "source" && (
            <div className="source-content">
              {lesson.source.kind === "document" ? <DocumentOriginal source={lesson.source} /> : <>
              <div className="source-info">
                <h3>{lesson.source.label}</h3>
                <p>{lesson.source.scope || "使用者提供的原始內容"}</p>
                {lesson.source.truncated && (
                  <p className="source-warning">
                    內容已截斷；解說僅依保留部分產生。
                  </p>
                )}
                {lesson.source.url &&
                  /^https:\/\//i.test(lesson.source.url) && (
                    <a
                      href={lesson.source.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      開啟原始來源 <ArrowUpRight size={14} />
                    </a>
                  )}
              </div>
              <CodeBlock
                code={lesson.source.content}
                language={lesson.source.kind === "code" ? "code" : "text"}
              />
              </>}
            </div>
          )}
        </div>
        {!pdfDocument && (
          <aside className="reader-aside">
            <div
              className={`reader-aside-sticky${lesson.visual.illustration ? " reader-aside-illustrated" : ""}`}
              role="region"
              aria-label="段落、進度與互動圖解"
              tabIndex={0}
            >
              {asideContent}
            </div>
          </aside>
        )}
      </div>
    </div>
    </ReadingAnnotations>
  );
}
