import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, ArrowRight, ArrowUpRight, Box, Check, ChevronRight, Clock, Eye, FileText, GitPullRequest, Hash, History, Layers, Lightbulb, ListChecks, ListTodo, MoreHorizontal, Network, Star, Sun, TextQuote, Timer, Trash2 } from "lucide-react";
import { lessonMinutes, type LessonNoteV3, type StoredLesson, type Step } from "../../../shared/lesson-v3";
import { exportLesson } from "../../lib/api";
import { usePredictMode } from "../../lib/predict";
import { saveReadingProgress } from "../../lib/reading-progress";
import { markdownRelations, relatedNotes } from "../../lib/related-notes";
import CodeBlock from "../CodeBlock";
import { DocumentOriginal } from "../DocumentUpload";
import MathText, { ProseBlocks } from "../MathText";
import ReadingAnnotations from "../ReadingAnnotations";
import RelatedNotes from "../RelatedNotes";
import Figure from "./Figure";
import Recall from "./Recall";
import WrapUp from "./WrapUp";
import { useRecalls } from "./useRecalls";
import { fill, learningCopy } from "../../copy/learning";
import V3Text from "./V3Text";
import "./learning-v3.css";

const figureIcons = { "annotated-code": TextQuote, state: History, compare: Layers, sequence: ListChecks, timeline: Timer, keyfact: Hash, d2: Network, "rubik-2x2": Box } as const;
function FigureKind({ kind }: { kind: keyof typeof figureIcons }) {
  const Icon = figureIcons[kind];
  const kinds = learningCopy().figures.kinds;
  const label = kind === "annotated-code" ? kinds.annotatedCode : kind === "rubik-2x2" ? kinds.rubik : kinds[kind];
  return <span className="v3-outline-kind"><Icon size={14} aria-hidden="true" />{label}</span>;
}

export default function LessonV3Reader({ lesson, lessons, section, jump, open, favorite, remove, followUp, notify, personalAvailable, prHref, sendToPersonal, onLessonChange, toggleTheme }: {
  lesson: LessonNoteV3;
  lessons: StoredLesson[];
  section?: string;
  jump: number;
  open: (id: string, section?: string) => void;
  favorite: () => void;
  remove: () => void;
  followUp: (question: string, parent: StoredLesson) => void;
  notify: (message: string) => void;
  personalAvailable: boolean;
  prHref?: string;
  sendToPersonal: (quote?: string) => void;
  onLessonChange: (lesson: StoredLesson) => void;
  toggleTheme: () => void;
}) {
  const initial = lesson.steps.find(step => step.id === section) || lesson.steps[0];
  const [activeId, setActiveId] = useState(initial.id);
  const [tab, setTab] = useState<"explanation" | "source">("explanation");
  const [predict, setPredict] = usePredictMode();
  const copy = learningCopy();
  const { states: recalls, loading: recallsLoading, onRated } = useRecalls(lesson.id);
  const [actionsHost, setActionsHost] = useState<HTMLElement | null>(null);
  const activeIndex = Math.max(0, lesson.steps.findIndex(step => step.id === activeId));
  const related = useMemo(() => relatedNotes(lesson, lessons), [lesson, lessons]);
  useEffect(() => {
    setActionsHost(document.getElementById("reader-topbar-actions"));
    return () => setActionsHost(null);
  }, []);
  const remember = (step: Step) => {
    const hash = `#/note/${encodeURIComponent(lesson.id)}/${encodeURIComponent(step.id)}`;
    if (window.location.hash !== hash) window.history.replaceState(window.history.state, "", hash);
    saveReadingProgress(lesson.id, step.id, lesson.steps.indexOf(step), lesson.steps.length);
  };
  const focus = (step: Step, scroll = false) => {
    setActiveId(step.id);
    remember(step);
    if (scroll) document.getElementById(`section-${step.id}`)?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      block: "center",
    });
  };
  useEffect(() => {
    if (tab !== "explanation") return;
    const observer = new IntersectionObserver(entries => {
      const visible = entries.find(entry => entry.isIntersecting);
      const step = visible && lesson.steps.find(item => `section-${item.id}` === visible.target.id);
      if (step) remember(step);
    }, { rootMargin: "-45% 0px -50% 0px" });
    for (const step of lesson.steps) {
      const element = document.getElementById(`section-${step.id}`);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [lesson.id, lesson.steps, tab]);
  useEffect(() => {
    if (!section) return;
    const step = lesson.steps.find(item => item.id === section);
    if (step) {
      setActiveId(step.id);
      setTimeout(() => document.getElementById(`section-${step.id}`)?.scrollIntoView({ block: "center" }), 80);
    }
  }, [section, jump]);
  const aside = <div className="reader-aside-sticky">
    <nav className="reader-toc" aria-label={copy.lesson.rail.ariaLabel}><ol>
      {lesson.steps.map((step, index) => <li key={step.id} className={index < activeIndex ? "done" : index === activeIndex ? "current" : "upcoming"}>
        <button onClick={() => { setTab("explanation"); focus(step, true); }} aria-current={index === activeIndex ? "step" : undefined}>
          <span className="reader-toc-status">{index < activeIndex && <Check size={12} />}</span>
          <span><V3Text text={step.lead} sourceKey={`${step.id}:toc`} /></span>
        </button>
      </li>)}
      <li className="upcoming"><button onClick={() => document.getElementById("reader-end")?.scrollIntoView({ block: "start" })}><span className="reader-toc-status" /><span>{copy.lesson.rail.wrapUpItem}</span></button></li>
    </ol></nav>
    <div className="reader-rail-recall"><span>{copy.lesson.rail.recallLabel}</span><span>{fill(copy.lesson.rail.recallCount, { done: Object.keys(recalls).length, total: lesson.steps.length })}</span></div>
    <button className="reader-original-button" onClick={() => setTab(tab === "explanation" ? "source" : "explanation")}><FileText size={14} />{tab === "explanation" ? copy.lesson.rail.originalSource : copy.lesson.rail.backToExplanation}</button>
  </div>;
  const actions = <div className="reader-actions">
    <button className={`predict-toggle${predict ? " is-on" : ""}`} aria-label={copy.lesson.topbar.predictToggle} aria-pressed={predict} onClick={() => setPredict(!predict)} title={copy.lesson.topbar.predictTooltip}><Eye size={14} /><span>{copy.lesson.topbar.predictToggle}</span></button>
    <button type="button" className="text-button send-personal-button" aria-label={personalAvailable ? copy.lesson.topbar.sendToPersonalAria : copy.lesson.topbar.sendToPersonalDisabledAria} onClick={() => sendToPersonal()} disabled={!personalAvailable} title={personalAvailable ? copy.lesson.topbar.sendToPersonalTooltip : copy.lesson.topbar.sendToPersonalUnavailable}><ListTodo size={15} /><span>{copy.lesson.topbar.sendToPersonal}</span></button>
    <button className={`icon-button ${lesson.favorite ? "is-favorite" : ""}`} onClick={favorite} aria-label={lesson.favorite ? copy.lesson.topbar.unbookmarkAria : copy.lesson.topbar.bookmarkAria} title={lesson.favorite ? copy.lesson.topbar.unbookmarkTooltip : copy.lesson.topbar.bookmarkTooltip}><Star size={17} fill={lesson.favorite ? "currentColor" : "none"} /></button>
    <details className="reader-more">
      <summary className="icon-button" aria-label={copy.lesson.topbar.moreActionsAria} title={copy.lesson.topbar.moreActionsTooltip}><MoreHorizontal size={17} /></summary>
      <div className="reader-more-menu" onClick={event => { if ((event.target as Element).closest("button, a")) event.currentTarget.parentElement?.removeAttribute("open"); }}>
        <button className="reader-more-secondary" aria-pressed={predict} onClick={() => setPredict(!predict)}><Eye size={15} />{copy.lesson.moreMenu.predictToggle}</button>
        <button className="reader-more-secondary reader-more-personal" aria-label={personalAvailable ? undefined : copy.lesson.topbar.sendToPersonalDisabledAria} onClick={() => sendToPersonal()} disabled={!personalAvailable}><ListTodo size={15} /><span>{copy.lesson.moreMenu.sendToPersonal}</span>{!personalAvailable && <span className="reader-more-hint">{copy.lesson.moreMenu.sendToPersonalUnavailableHint}</span>}</button>
        {prHref && <a href={prHref}><GitPullRequest size={15} /><span>{copy.lesson.moreMenu.sendToPr}</span></a>}
        <button className="reader-more-secondary" onClick={toggleTheme}><Sun size={15} />{copy.lesson.moreMenu.toggleTheme}</button>
        <button onClick={() => setTab(tab === "explanation" ? "source" : "explanation")}><FileText size={15} />{tab === "explanation" ? copy.lesson.moreMenu.originalSource : copy.lesson.moreMenu.backToExplanation}</button>
        <button onClick={() => { exportLesson(lesson, markdownRelations(related, copy.lesson.exportRelations)); notify(copy.lesson.moreMenu.exportedToast); }}><ArrowDownToLine size={15} />{copy.lesson.moreMenu.exportMarkdown}</button>
        <button onClick={remove}><Trash2 size={15} />{copy.lesson.moreMenu.deleteLesson}</button>
      </div>
    </details>
  </div>;
  return <ReadingAnnotations lesson={lesson} onLessonChange={onLessonChange} personalAvailable={personalAvailable} sendToPersonal={sendToPersonal}>
    <div className="reader-page v3-reader-page">
      {actionsHost ? createPortal(actions, actionsHost) : <div className="reader-toolbar">{actions}</div>}
      <div className="reader-progress-strip" aria-label={`閱讀進度：第 ${activeIndex + 1} 步，共 ${lesson.steps.length} 步`}>
        <span><b>{activeIndex + 1}</b> / {lesson.steps.length}</span>
        <span className="reader-progress-segments" aria-hidden="true">{lesson.steps.map((step, index) => <i key={step.id} className={index < activeIndex ? "done" : index === activeIndex ? "current" : ""} />)}</span>
        <span>{fill(copy.lesson.progress.recallFraction, { done: Object.keys(recalls).length, total: lesson.steps.length })}</span>
      </div>
      <div className="v3-lesson-layout">
        <div className="v3-lesson-document">
          <div hidden={tab !== "explanation"}>
            <header className="reader-heading v3-opener">
              <h1><V3Text text={lesson.title} sourceKey="title" /></h1>
              <p className="reader-question"><V3Text text={lesson.question} sourceKey="question" /></p>
              <div className="reader-meta"><span><i className="category-dot" />{lesson.category}</span><span><ListTodo size={13} />{lesson.steps.length} 步</span><span><Clock size={13} />約 {lessonMinutes(lesson)} 分鐘</span></div>
              <p className="reader-answer"><V3Text text={lesson.answer} sourceKey="answer" /></p>
              <ol className="reading-outline" aria-label="段落地圖">{lesson.steps.map((step, index) => <li key={step.id} className={index < activeIndex ? "done" : index === activeIndex ? "current" : "upcoming"}>
                <button onClick={() => focus(step, true)} aria-current={index === activeIndex ? "step" : undefined}>
                  <span className="reading-outline-number">{index < activeIndex ? <Check size={12} /> : index + 1}</span>
                  <span><V3Text text={step.lead} sourceKey={`${step.id}:outline`} /></span>
                  {step.figure && <FigureKind kind={step.figure.kind} />}
                </button>
              </li>)}</ol>
            </header>
            {lesson.steps.map((step, index) => <section className="v3-step" id={`section-${step.id}`} aria-labelledby={`${step.id}-lead`} key={step.id} onFocus={() => setActiveId(step.id)}>
              <div className="v3-step-number">{index + 1} / {lesson.steps.length}</div>
              <h2 className="v3-step-lead" id={`${step.id}-lead`}><V3Text text={step.lead} sourceKey={`${step.id}:lead`} /></h2>
              <ProseBlocks
                text={step.body}
                paragraphClass="v3-step-body"
                listClass="explanation-list"
                headingClass="explanation-subheading"
                quoteClass="explanation-quote"
                renderLine={line => <V3Text text={line} sourceKey={`${step.id}:body`} />}
              />
              {step.figure && <Figure figure={step.figure} predict={predict} blank={step.recall.blank} />}
              {step.analogy && <p className="v3-step-analogy"><Lightbulb size={16} /><span><strong>{step.analogy.title}</strong><V3Text text={step.analogy.text} sourceKey={`${step.id}:analogy`} /></span></p>}
              {step.deeper && <details className="v3-deeper"><summary><ChevronRight size={14} />細節：<MathText text={step.deeper.summary} /></summary><ProseBlocks text={step.deeper.body} listClass="explanation-list" renderLine={line => <V3Text text={line} sourceKey={`${step.id}:deeper`} />} /></details>}
              <Recall lessonId={lesson.id} step={step} state={recalls[step.id]} loading={recallsLoading} onRated={onRated} />
            </section>)}
            <section className="v3-wrap-up" id="reader-end" aria-label={copy.lesson.rail.endRegionAria}>
              <WrapUp lesson={lesson} recalls={recalls} onFocusRecall={(stepId) => {
                const step = lesson.steps.find(item => item.id === stepId);
                if (!step) return;
                focus(step, true);
                window.setTimeout(() => document.getElementById(`${stepId}-recall-q`)?.focus(), 80);
              }} />
              <h3 className="block-title">{copy.wrapUp.followUpsHeading}</h3>
              {lesson.followUps.length > 0 && <ul className="v3-followups">{lesson.followUps.map((question, index) => <li key={index}><button onClick={() => followUp(question, lesson)}><V3Text text={question} sourceKey={`follow-up:${index}`} /><ArrowRight size={14} /></button></li>)}</ul>}
              <RelatedNotes items={related} open={open} title={copy.wrapUp.nextReadsHeading} />
              <div className="v3-source"><FileText size={14} /><span>來源：{lesson.source.label}</span><button onClick={() => setTab("source")}>原始內容</button>{lesson.source.url && /^https:\/\//i.test(lesson.source.url) && <a href={lesson.source.url} target="_blank" rel="noreferrer">開啟原始網頁 <ArrowUpRight size={13} /></a>}</div>
            </section>
          </div>
          {tab === "source" && <div className="source-content">{lesson.source.kind === "document" ? <DocumentOriginal source={lesson.source} /> : <>
            <div className="source-info"><h3>{lesson.source.label}</h3><p>{lesson.source.scope || "使用者提供的原始內容"}</p>{lesson.source.truncated && <p className="source-warning">內容已截斷；解說僅依保留部分產生。</p>}</div>
            <CodeBlock code={lesson.source.content} language={lesson.source.kind === "code" ? "code" : "text"} />
          </>}</div>}
        </div>
        <aside className="reader-aside">{aside}</aside>
      </div>
    </div>
  </ReadingAnnotations>;
}

