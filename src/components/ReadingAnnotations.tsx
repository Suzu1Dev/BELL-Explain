import {
  createContext, useCallback, useContext, useEffect, useId, useLayoutEffect,
  useMemo, useRef, useState, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { BookOpen, Check, Copy, Lightbulb, ListTodo, LoaderCircle, RotateCcw, Trash2, X } from "lucide-react";
import { termIsMath } from "../../shared/annotations";
import { codeText, findBold, findInline, type CodeSpan } from "../../shared/math";
import type { AnnotationRequest, LessonAnnotation } from "../../shared/types";
import type { StoredLesson } from "../../shared/lesson-v3";
import { api, explainSelection } from "../lib/api";
import { fill } from "../copy/learning";
import { selectionToolbarCopy } from "../copy/selection-toolbar";
import { annotationCardCopy, fillAnnotationCard } from "../copy/annotation-card";
import MathText, { mathRange } from "./MathText";
import "./reading-annotations.css";

type Anchor = { element?: HTMLElement; range?: Range; rect: DOMRect };
type SelectionTarget = AnnotationRequest & { anchor: Anchor };
type Popup =
  | { kind: "saved"; annotation: LessonAnnotation; anchor: Anchor; pinned: boolean; revision: string }
  | { kind: "loading" | "error"; target: SelectionTarget; anchor: Anchor; message: string };
type AnnotationContext = {
  annotations: LessonAnnotation[];
  activeId?: string;
  popupId: string;
  open: (annotation: LessonAnnotation, element: HTMLElement, pinned: boolean, focus?: boolean) => void;
  leave: () => void;
};
const Context = createContext<AnnotationContext | null>(null);

/** A source field may appear in several paragraphs; selection stays inside one span. */
export function AnnotatedText({ text, sourceKey, renderPlain = value => value, math = false }: {
  text: string;
  sourceKey: string;
  renderPlain?: (text: string) => ReactNode;
  /** Typeset \( \) and \[ \] formulas and set `code spans` as code. Prose only: code keeps its backslashes and backticks as written. */
  math?: boolean;
}) {
  const context = useContext(Context);
  const spans = math ? findInline(text) : [];
  const bolds = math ? findBold(text, spans) : [];
  if (!context) return <>{mathRange(text, spans, 0, text.length, renderPlain, undefined, bolds)}</>;
  const within = (at: number, span: { start: number; end: number }) => at > span.start && at < span.end;
  const cutsBold = (at: number) => bolds.some(bold => at === bold.start + 1 || at === bold.end - 1);
  const codes = spans.filter(span => span.kind === "code");
  type Piece = { start: number; end: number };
  // Where a saved term is highlighted: never through a formula. Within a code span's text
  // (a flag of a command) it is drawn inside the code. Across a code span's edge (saved when
  // backticks still showed as text) it is drawn in pieces, its part of the code inside and
  // the rest outside, so other terms in that code keep their own highlights.
  const place = (start: number, end: number) => {
    if (cutsBold(start) || cutsBold(end) || spans.some(span => span.kind !== "code" && (within(start, span) || within(end, span)))) return undefined;
    let from = start, to = end;
    const inside: Piece[] = [];
    for (const span of codes) {
      if (!within(start, span) && !within(end, span)) continue;
      const [first, last] = codeText(span);
      const piece = { start: Math.max(start, first), end: Math.min(end, last) };
      if (piece.end > piece.start) inside.push(piece);
      if (within(start, span)) from = span.end;
      if (within(end, span)) to = span.start;
    }
    const outside = to > from ? { start: from, end: to } : undefined;
    return outside || inside.length ? { start, end, outside, inside } : undefined;
  };
  const matches = context.annotations.filter(item => item.sourceKey === sourceKey && item.term)
    .sort((a, b) => b.term.length - a.term.length);
  // Each term at its first place from the cursor; the earliest wins, the longer on a tie.
  const marks: Array<NonNullable<ReturnType<typeof place>> & { annotation: LessonAnnotation }> = [];
  for (let cursor = 0; ;) {
    let next: (typeof marks)[number] | undefined;
    for (const annotation of matches) {
      for (let found = text.indexOf(annotation.term, cursor); found >= 0; found = text.indexOf(annotation.term, found + 1)) {
        const at = place(found, found + annotation.term.length);
        if (!at) continue;
        if (!next || at.start < next.start) next = { ...at, annotation };
        break;
      }
    }
    if (!next) break;
    marks.push(next);
    cursor = next.end;
  }
  const mark = ({ annotation }: (typeof marks)[number], { start }: Piece, children: ReactNode) => <span
    key={`${annotation.id}-${start}`}
    className="reading-annotation-mark"
    role="button" tabIndex={0}
    aria-label={fill(selectionToolbarCopy().termTriggerAria, { term: annotation.term })}
    aria-expanded={context.activeId === annotation.id}
    aria-controls={context.activeId === annotation.id ? context.popupId : undefined}
    onMouseEnter={event => context.open(annotation, event.currentTarget, false)}
    onMouseLeave={context.leave}
    onFocus={event => context.open(annotation, event.currentTarget, true)}
    onBlur={context.leave}
    onClick={event => {
      if (!window.getSelection()?.isCollapsed) return;
      context.open(annotation, event.currentTarget, true, true);
    }}
    onKeyDown={event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      context.open(annotation, event.currentTarget, true, true);
    }}
  >{children}</span>;
  /** A code span's text, with the highlights within it. */
  const code = (span: CodeSpan) => {
    const [from, to] = codeText(span);
    const parts: ReactNode[] = [];
    let at = from;
    for (const item of marks) {
      for (const piece of item.inside) {
        if (piece.start < from || piece.end > to) continue;
        if (piece.start > at) parts.push(text.slice(at, piece.start));
        parts.push(mark(item, piece, text.slice(piece.start, piece.end)));
        at = piece.end;
      }
    }
    if (!parts.length) return span.code;
    if (at < to) parts.push(text.slice(at, to));
    return parts;
  };
  const show = (from: number, to: number, plain: (value: string) => ReactNode) => mathRange(text, spans, from, to, plain, code, bolds);
  const fragments: ReactNode[] = [];
  let cursor = 0;
  for (const item of marks) {
    if (!item.outside) continue;
    const { start, end } = item.outside;
    if (start > cursor) fragments.push(<span key={`plain-${cursor}`}>{show(cursor, start, renderPlain)}</span>);
    fragments.push(mark(item, item.outside, show(start, end, value => value)));
    cursor = end;
  }
  if (cursor < text.length) fragments.push(<span key={`plain-${cursor}`}>{show(cursor, text.length, renderPlain)}</span>);
  return <span data-annotation-source={sourceKey}>{fragments}</span>;
}

/** The note's own text under `node`: a rendered formula reads as its LaTeX source, not as KaTeX's glyphs. */
export function sourceText(node: Node): string {
  if (node.nodeType === 3) return (node as Text).data;
  if (node.nodeType === 1 && (node as Element).hasAttribute("data-math-source")) return (node as Element).getAttribute("data-math-source")!;
  let text = "";
  node.childNodes.forEach(child => { text += sourceText(child); });
  return text;
}

/**
 * Maps a selection inside `block` onto the note's text. A selection that starts or
 * ends inside a formula takes the whole formula, so a quote never holds half of its
 * LaTeX or the glyphs KaTeX drew. Part of one code span stays as selected (a flag of a
 * command); all of it, or a selection running out of it, takes the span with its backticks.
 * `offset` is where the selection starts in `text`.
 */
export function selectedSource(block: Element, range: Range): { range: Range; raw: string; offset: number; text: string } {
  const formulaAt = (node: Node) => (node.nodeType === 1 ? node as Element : node.parentElement)?.closest("[data-math-source]");
  const whole = range.cloneRange();
  const first = formulaAt(range.startContainer);
  const last = formulaAt(range.endContainer);
  if (first && first === last && first.localName === "code" && block.contains(first)) {
    const shown = first.textContent ?? "";
    const before = range.cloneRange();
    before.selectNodeContents(first);
    before.setEnd(range.startContainer, range.startOffset);
    const raw = range.toString();
    if (raw.length < shown.length) {
      const prefix = range.cloneRange();
      prefix.selectNodeContents(block);
      prefix.setEndBefore(first);
      // The backticks (and the space Markdown drops inside them) are on both sides alike.
      const fence = (first.getAttribute("data-math-source")!.length - shown.length) / 2;
      return { range: whole, raw, offset: sourceText(prefix.cloneContents()).length + fence + before.toString().length, text: sourceText(block) };
    }
  }
  if (first && block.contains(first)) whole.setStartBefore(first);
  if (last && block.contains(last)) whole.setEndAfter(last);
  const prefix = whole.cloneRange();
  prefix.selectNodeContents(block);
  prefix.setEnd(whole.startContainer, whole.startOffset);
  return { range: whole, raw: sourceText(whole.cloneContents()), offset: sourceText(prefix.cloneContents()).length, text: sourceText(block) };
}

function liveRect(anchor: Anchor) {
  try {
    const rect = anchor.element?.isConnected ? anchor.element.getBoundingClientRect()
      : anchor.range?.startContainer.isConnected ? anchor.range.getBoundingClientRect() : null;
    if (rect && (rect.width || rect.height)) return rect;
  } catch { /* A refreshed paragraph can invalidate a saved DOM range. */ }
  return anchor.rect;
}

function Floating({ anchor, className, children, ...events }: {
  anchor: Anchor; className: string; children: ReactNode;
  onMouseEnter?: () => void; onMouseLeave?: () => void;
  onFocusCapture?: () => void; onBlurCapture?: () => void;
  role?: string; "aria-label"?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const position = () => {
      const node = ref.current;
      if (!node) return;
      const viewport = window.visualViewport;
      const x = viewport?.offsetLeft || 0;
      const y = viewport?.offsetTop || 0;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      node.style.maxWidth = `${Math.max(0, width - 24)}px`;
      node.style.maxHeight = `${Math.max(0, height - 24)}px`;
      const rect = liveRect(anchor);
      const box = node.getBoundingClientRect();
      const left = Math.max(x + 12, Math.min(rect.left, x + width - box.width - 12));
      const source = anchor.element ?? (anchor.range?.startContainer instanceof Element
        ? anchor.range.startContainer : anchor.range?.startContainer.parentElement);
      let container = source?.parentElement;
      let boundaryTop = y + 12;
      while (container) {
        if (/(auto|scroll|overlay)/.test(window.getComputedStyle(container).overflowY)) {
          boundaryTop = Math.max(boundaryTop, container.getBoundingClientRect().top);
          break;
        }
        container = container.parentElement;
      }
      const above = rect.top - box.height - 8;
      const preferred = above >= boundaryTop ? above : rect.bottom + 8;
      const top = Math.max(y + 12, Math.min(preferred, y + height - box.height - 12));
      node.style.left = `${left}px`;
      node.style.top = `${top}px`;
      node.style.visibility = "visible";
    };
    position();
    const observer = new ResizeObserver(position);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [anchor]);
  return createPortal(<div ref={ref} className={className} data-reading-float="true"
    style={{ visibility: "hidden" }} {...events}>{children}</div>, document.body);
}

export default function ReadingAnnotations({ lesson, onLessonChange, children, personalAvailable = false, sendToPersonal }: {
  lesson: StoredLesson;
  onLessonChange: (lesson: StoredLesson) => void;
  children: ReactNode;
  personalAvailable?: boolean;
  sendToPersonal?: (quote: string) => void;
}) {
  const copy = selectionToolbarCopy();
  const cardCopy = annotationCardCopy();
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef({ lesson, onLessonChange });
  latest.current = { lesson, onLessonChange };
  const [candidate, setCandidate] = useState<SelectionTarget | null>(null);
  const candidateRef = useRef(candidate);
  candidateRef.current = candidate;
  const explainRef = useRef<(target: SelectionTarget) => void>(() => {});
  const personalRef = useRef(sendToPersonal);
  personalRef.current = sendToPersonal;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [popup, setPopup] = useState<Popup | null>(null);
  const popupRef = useRef(popup);
  popupRef.current = popup;
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const operation = useRef(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const popupId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const focusRequested = useRef(false);
  useEffect(() => {
    if (popup && focusRequested.current && dialog.current) {
      focusRequested.current = false;
      dialog.current.focus({ preventScroll: true });
    }
  }, [popup]);
  const keepOpen = useCallback(() => { clearTimeout(closeTimer.current); }, []);
  const close = useCallback((restoreFocus = false) => {
    keepOpen();
    controller.current?.abort();
    controller.current = null;
    operation.current++;
    const trigger = popupRef.current?.anchor.element;
    setPopup(null);
    setCandidate(null);
    setRemoving(false);
    setRemoveError("");
    focusRequested.current = false;
    if (restoreFocus && trigger?.isConnected) {
      // Focus can open an annotation; clear the popup after returning focus.
      trigger.focus({ preventScroll: true });
      setPopup(null);
    }
  }, [keepOpen]);
  const leave = useCallback(() => {
    keepOpen();
    closeTimer.current = setTimeout(() => {
      const current = popupRef.current;
      if (current?.kind === "saved" && !current.pinned) setPopup(null);
    }, 200);
  }, [keepOpen]);
  useEffect(() => {
    if (popup?.kind !== "saved" || lesson.updatedAt < popup.revision) return;
    const current = lesson.annotations?.find(annotation => annotation.id === popup.annotation.id);
    if (!current) close();
    else if (current !== popup.annotation) setPopup({ ...popup, annotation: current, revision: lesson.updatedAt });
  }, [lesson.annotations, lesson.updatedAt, popup, close]);
  const open = useCallback((annotation: LessonAnnotation, element: HTMLElement, pinned: boolean, focus = false) => {
    keepOpen();
    if (controller.current || !window.getSelection()?.isCollapsed) return;
    const current = popupRef.current;
    if (current && (current.kind !== "saved" || current.pinned) && !pinned) return;
    setRemoveError("");
    focusRequested.current = focus;
    setCandidate(null);
    setPopup({ kind: "saved", annotation, anchor: { element, rect: element.getBoundingClientRect() }, pinned,
      revision: latest.current.lesson.updatedAt });
  }, [keepOpen]);

  useEffect(() => {
    setCandidate(null);
    setPopup(null);
    setRemoving(false);
    setRemoveError("");
    let frame = 0;
    const readSelection = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (controller.current) return;
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
          setCandidate(null); return;
        }
        const range = selection.getRangeAt(0);
        const sourceOf = (node: Node) => (node instanceof Element ? node : node.parentElement)
          ?.closest<HTMLElement>("[data-annotation-source]");
        const block = sourceOf(range.startContainer);
        if (!block || block !== sourceOf(range.endContainer) || !root.current?.contains(block)) {
          setCandidate(null); return;
        }
        const { range: whole, raw, offset, text } = selectedSource(block, range);
        const term = raw.trim();
        if (!term || term.length > 160 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(term)) {
          setCandidate(null); return;
        }
        const start = offset + raw.indexOf(term);
        if (text.slice(start, start + term.length) !== term) { setCandidate(null); return; }
        const quoteStart = Math.max(0, start - 1700);
        const quote = text.slice(quoteStart, quoteStart + 4000).trim();
        keepOpen();
        setPopup(null);
        setCandidate({ term, quote, sourceKey: block.dataset.annotationSource!,
          anchor: { range: whole, rect: whole.getBoundingClientRect() } });
      });
    };
    const escape = (event: KeyboardEvent) => {
      const target = candidateRef.current;
      if (event.key === "Escape") { close(true); window.getSelection()?.removeAllRanges(); }
      if (target && ((event.altKey && event.key === "Enter") || (!event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "e"))) {
        event.preventDefault();
        explainRef.current(target);
      }
      if (target && event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "s" && personalAvailable) {
        event.preventDefault();
        personalRef.current?.(target.term);
        close();
      }
    };
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || event.target.closest("[data-reading-float], .reading-annotation-mark")) return;
      if (popupRef.current?.kind !== "loading") close();
    };
    document.addEventListener("selectionchange", readSelection);
    document.addEventListener("pointerup", readSelection);
    document.addEventListener("keyup", readSelection);
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    return () => {
      cancelAnimationFrame(frame);
      controller.current?.abort();
      controller.current = null;
      operation.current++;
      keepOpen();
      document.removeEventListener("selectionchange", readSelection);
      document.removeEventListener("pointerup", readSelection);
      document.removeEventListener("keyup", readSelection);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
    };
  }, [lesson.id, close, keepOpen, personalAvailable]);

  useEffect(() => { setCopyState("idle"); }, [candidate]);

  const explain = async (target: SelectionTarget) => {
    keepOpen();
    controller.current?.abort();
    controller.current = null;
    setCandidate(null);
    window.getSelection()?.removeAllRanges();
    setRemoveError("");
    focusRequested.current = true;
    const cached = latest.current.lesson.annotations?.find(item => item.term === target.term && item.sourceKey === target.sourceKey);
    if (cached) {
      setPopup({ kind: "saved", annotation: cached, anchor: target.anchor, pinned: true,
        revision: latest.current.lesson.updatedAt });
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    const id = latest.current.lesson.id;
    setPopup({ kind: "loading", target, anchor: target.anchor, message: cardCopy.loadingMessage });
    try {
      await explainSelection(id, { term: target.term, sourceKey: target.sourceKey, quote: target.quote }, abort.signal, event => {
        if (controller.current !== abort || abort.signal.aborted || latest.current.lesson.id !== id) return;
        if (event.type === "stage") {
          setPopup({ kind: "loading", target, anchor: target.anchor, message: event.message });
        } else if (event.type === "complete") {
          const annotation = event.lesson.annotations?.find(item => item.term === target.term && item.sourceKey === target.sourceKey);
          if (!annotation) throw new Error(cardCopy.incompleteError);
          latest.current.onLessonChange(event.lesson);
          setPopup({ kind: "saved", annotation, anchor: target.anchor, pinned: true, revision: event.lesson.updatedAt });
        }
      }, cardCopy.streamInterruptedError);
    } catch (error) {
      if (controller.current === abort && !abort.signal.aborted) {
        setPopup({ kind: "error", target, anchor: target.anchor,
          message: error instanceof Error ? error.message : cardCopy.explainFailedError });
      }
    } finally {
      if (controller.current === abort) controller.current = null;
    }
  };
  explainRef.current = target => { void explain(target); };

  const remove = async (annotation: LessonAnnotation) => {
    if (removing) return;
    const currentOperation = ++operation.current;
    const id = latest.current.lesson.id;
    setRemoving(true);
    setRemoveError("");
    try {
      const updated = await api.removeAnnotation(id, annotation.id);
      if (latest.current.lesson.id !== id) return;
      latest.current.onLessonChange(updated);
      if (operation.current === currentOperation) close();
    } catch (error) {
      if (operation.current === currentOperation) setRemoveError(error instanceof Error ? error.message : cardCopy.removeFailedError);
    } finally {
      if (operation.current === currentOperation) setRemoving(false);
    }
  };
  const context = useMemo<AnnotationContext>(() => ({
    annotations: lesson.annotations || [],
    activeId: popup?.kind === "saved" ? popup.annotation.id : undefined,
    popupId, open, leave,
  }), [lesson.annotations, popup, popupId, open, leave]);
  const active = popup?.kind === "saved" ? popup.annotation : null;
  const selected = active || (popup && popup.kind !== "saved" ? popup.target : null);
  // The term looks as where it was picked: from code, or from prose that shows it as written, it keeps its backslashes.
  const term = selected && (termIsMath(selected) ? <MathText text={selected.term} /> : selected.term);
  return <Context.Provider value={context}>
    <div ref={root} className="reading-annotations">{children}</div>
    {candidate && !popup && <Floating anchor={candidate.anchor} className="reading-selection-toolbar" role="toolbar" aria-label={copy.toolbarLabel}>
      <button className="reading-explain-action" aria-keyshortcuts="E Alt+Enter" title={copy.explainTitle} onPointerDown={event => event.preventDefault()} onClick={() => void explain(candidate)}>
        <Lightbulb size={15} />{copy.explain} <kbd>E</kbd>
      </button>
      <button className="reading-personal-action" aria-keyshortcuts="Shift+S" disabled={!personalAvailable} title={personalAvailable ? copy.sendToPersonalTitle : copy.sendToPersonalUnlinkedTitle} onPointerDown={event => event.preventDefault()} onClick={() => { personalRef.current?.(candidate.term); close(); window.getSelection()?.removeAllRanges(); }}>
        <ListTodo size={15} />{copy.sendToPersonal} <kbd>⇧S</kbd>
      </button>
      <button className="reading-copy-action" onPointerDown={event => event.preventDefault()} onClick={async () => {
        try {
          await navigator.clipboard.writeText(candidate.term);
          setCopyState("copied");
        } catch {
          setCopyState("error");
        }
      }}>
        {copyState === "copied" ? <Check size={15} /> : <Copy size={15} />}{copyState === "copied" ? copy.copied : copyState === "error" ? copy.copyFailed : copy.copy}
      </button>
      <button className="reading-annotation-icon" aria-label={copy.closeToolbarAria} onPointerDown={event => event.preventDefault()}
        onClick={() => { close(); window.getSelection()?.removeAllRanges(); }}><X size={15} /></button>
    </Floating>}
    {popup && <Floating anchor={popup.anchor} className="reading-explanation-card"
      onMouseEnter={keepOpen} onMouseLeave={leave}
      onFocusCapture={() => { keepOpen(); setPopup(current => current?.kind === "saved" ? { ...current, pinned: true } : current); }}>
      <div ref={dialog} tabIndex={-1} role="dialog" aria-modal="false" id={popupId} aria-labelledby={`${popupId}-title`}>
        <header className="reading-explanation-header">
          <span className="reading-explanation-label"><BookOpen size={14} /> {cardCopy.cardLabel}</span>
          <button className="reading-annotation-icon" aria-label={cardCopy.closeCardAria} onClick={() => close(true)}><X size={17} /></button>
        </header>
        <h3 id={`${popupId}-title`}>{term}</h3>
        {active ? <>
          <p className="reading-explanation-body"><MathText text={active.explanation} /></p>
          <div className="reading-explanation-analogy"><span><Lightbulb size={14} /> {cardCopy.analogyHeading}</span><p><MathText text={active.analogy} /></p></div>
          {active.example && <div className="reading-explanation-example"><span>{cardCopy.exampleHeading}</span><pre>{active.example}</pre></div>}
          <footer className="reading-explanation-footer"><span><Check size={13} /> {cardCopy.savedBadge}</span>
            <button disabled={removing} onClick={() => void remove(active)} aria-label={fillAnnotationCard(cardCopy.removeTermAria, { term: active.term })}>
              {removing ? <LoaderCircle size={13} className="reading-annotation-spin" /> : <Trash2 size={13} />}{cardCopy.removeAction}
            </button>
          </footer>
          {removeError && <p role="alert" className="reading-explanation-error">{removeError}</p>}
        </> : popup.kind !== "saved" && <>
          <div className={`reading-explanation-status ${popup.kind === "error" ? "is-error" : ""}`} role={popup.kind === "error" ? "alert" : "status"}>
            {popup.kind === "loading" && <LoaderCircle size={20} className="reading-annotation-spin" />}
            <p>{popup.message}</p>
          </div>
          <div className="reading-explanation-actions">
            {popup.kind === "error" ? <button onClick={() => void explain(popup.target)}><RotateCcw size={14} />{cardCopy.retryExplainAction}</button>
              : <button onClick={() => close()}>{cardCopy.cancelAction}</button>}
          </div>
        </>}
      </div>
    </Floating>}
  </Context.Provider>;
}
