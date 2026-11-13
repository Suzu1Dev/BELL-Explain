import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, BookOpen, CheckCheck, CornerDownRight, ListTodo, LoaderCircle, RotateCcw } from "lucide-react";
import type { ReviewCardView } from "../../shared/learning";
import { api, ApiError } from "../lib/api";
import { intervalLabel } from "../lib/review";
import { fill, learningCopy } from "../copy/learning";
import MathText, { ProseBlocks } from "./MathText";
import RecallReviewCard from "./learning/RecallReviewCard";
import "./review-session.css";

function LegacyReviewContent({ card, revealed, setRevealed, hints, setHints, answer, openNote, personalAvailable, sendToPersonal, saving, rate }: {
  card: ReviewCardView;
  revealed: boolean;
  setRevealed: (value: boolean) => void;
  hints: boolean;
  setHints: (value: boolean) => void;
  answer: { current: HTMLDivElement | null };
  openNote: (lessonId: string, sectionId?: string) => void;
  personalAvailable?: boolean;
  sendToPersonal?: (card: ReviewCardView) => void;
  saving: boolean;
  rate: (rating: 1 | 2 | 3 | 4) => void;
}) {
  const copy = learningCopy();
  const kindLabels: Record<ReviewCardView["kind"], string> = {
    section: copy.review.kindSectionLegacy,
    term: copy.review.kindTermLegacy,
    check: copy.review.kindCheckLegacy,
    recall: copy.review.kindRecall,
  };
  const ratings = [
    { value: 1, label: copy.review.grades.again, hint: copy.review.grades.againHint },
    { value: 2, label: copy.review.grades.hard, hint: copy.review.grades.hardHint },
    { value: 3, label: copy.review.grades.good, hint: copy.review.grades.goodHint },
    { value: 4, label: copy.review.grades.easy, hint: copy.review.grades.easyHint },
  ] as const;
  const promptText = card.kind === "term" && card.term
    ? fill(copy.review.promptTermMeaning, { term: card.term })
    : card.prompt;
  return <>
    <header className="review-card-meta">
      <span className="review-kind">{kindLabels[card.kind]}</span>
      {card.isNew && <span className="review-new">{copy.review.newCardBadge}</span>}
    </header>
    <h2 className="review-prompt">{card.kind === "section" ? copy.review.promptSectionLegacy : card.code || card.plainTerm ? promptText : <MathText text={promptText} />}</h2>
    {card.context && <blockquote className="review-context">{card.code ? card.context : <MathText text={card.context} />}</blockquote>}
    {!revealed && card.hints.length > 0 && (
      hints ? (
        <div className="review-hints" aria-label={copy.review.hintAria}>{card.hints.map((hint) => <span key={hint}><MathText text={hint} /></span>)}</div>
      ) : (
        <button type="button" className="review-hint-button" onClick={() => setHints(true)}>{copy.review.hintButton}</button>
      )
    )}
    {!revealed ? <button type="button" className="primary-button review-reveal" onClick={() => setRevealed(true)} autoFocus>{copy.review.showAnswer} <kbd>{copy.review.shortcutSpace}</kbd></button> : (
      <>
        <div className="review-answer" ref={answer} tabIndex={-1}>
          {card.kind === "section"
            ? <ProseBlocks text={card.answer} />
            : <p><MathText text={card.answer} /></p>}
          {card.keyPoints && card.keyPoints.length > 0 && <ul>{card.keyPoints.map((point) => <li key={point}><MathText text={point} /></li>)}</ul>}
          {card.analogy && <p className="review-analogy"><MathText text={card.analogy} /></p>}
        </div>
        <div className="review-card-actions">
          <button type="button" className="review-open" onClick={() => openNote(card.lessonId, card.sectionId)}><CornerDownRight size={14} />{copy.review.backToSectionLegacy}</button>
          <button type="button" className="review-open" onClick={() => sendToPersonal?.(card)} disabled={!personalAvailable} title={personalAvailable ? copy.lesson.topbar.sendToPersonalTooltip : copy.lesson.topbar.sendToPersonalUnavailable}><ListTodo size={14} />{copy.lesson.topbar.sendToPersonal}</button>
        </div>
        <div className="review-ratings" role="group" aria-label={copy.review.gradesGroupAria}>
          {ratings.map((rating) => (
            <button key={rating.value} type="button" className={`review-rating rating-${rating.value}`} onClick={() => rate(rating.value)} disabled={saving} title={rating.hint}>
              <b><kbd>{rating.value}</kbd>{rating.label}</b>
              <small>{fill(copy.review.intervals.afterLegacy, { interval: intervalLabel(card.intervals[rating.value]) })}</small>
            </button>
          ))}
        </div>
      </>
    )}
  </>;
}

/**
 * Today's review: recall first, then reveal and rate how well it came back.
 * Space or Enter reveals; 1–4 rate.
 */
export default function ReviewSession({ openNote, onReviewed, personalAvailable, sendToPersonal }: {
  openNote: (lessonId: string, sectionId?: string) => void;
  /** Called after each rating so counts elsewhere stay current. */
  onReviewed: () => void;
  personalAvailable?: boolean;
  sendToPersonal?: (card: ReviewCardView) => void;
}) {
  const copy = learningCopy();
  const [cards, setCards] = useState<ReviewCardView[]>();
  const [position, setPosition] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [hints, setHints] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [again, setAgain] = useState(0);
  // Cards still in their learning steps once the queue is done.
  const [remaining, setRemaining] = useState(0);
  const load = useCallback(async () => {
    setError("");
    setCards(undefined);
    setAgain(0);
    setRemaining(0);
    try {
      setCards(await api.reviewDue());
      setPosition(0);
      setRevealed(false);
      setHints(false);
    } catch {
      setCards([]);
      setError(learningCopy().states.review.loadError);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const card = cards?.[position];
  const finished = Boolean(cards?.length) && !card;
  useEffect(() => {
    if (!finished) return;
    let active = true;
    api.reviewSummary().then((summary) => { if (active) setRemaining(summary.due); }).catch(() => {});
    return () => { active = false; };
  }, [finished]);

  const rate = useCallback(async (rating: 1 | 2 | 3 | 4) => {
    if (!card || saving) return;
    setSaving(true);
    setError("");
    const next = () => {
      setPosition((index) => index + 1);
      setRevealed(false);
      setHints(false);
    };
    try {
      await api.reviewRate(card.id, rating);
      if (rating === 1) setAgain((count) => count + 1);
      next();
      onReviewed();
    } catch (cause) {
      // The card's section or note was removed meanwhile (perhaps on another device): move on.
      if (cause instanceof ApiError && cause.status === 404) {
        setError(learningCopy().states.review.cardRemovedSkipped);
        next();
      } else setError(learningCopy().states.review.rateError);
    } finally {
      setSaving(false);
    }
  }, [card, saving, onReviewed]);

  const answer = useRef<HTMLDivElement>(null);
  // Revealing removes the focused reveal button: focus moves to the answer, so Tab reaches the ratings next.
  useEffect(() => {
    if (!revealed || !answer.current) return;
    const scroller = answer.current.closest<HTMLElement>(".workspace-content");
    if (scroller && window.matchMedia("(max-width: 390px)").matches) {
      const ratings = answer.current.parentElement?.querySelector<HTMLElement>(".review-ratings");
      scroller.style.scrollPaddingBottom = `${ratings?.offsetHeight ?? 0}px`;
    }
    answer.current.focus();
    answer.current.scrollIntoView({ block: "nearest" });
    return () => { if (scroller) scroller.style.scrollPaddingBottom = ""; };
  }, [revealed]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!card || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      // Shortcuts belong to the card, not to an open dialog over it.
      if (target?.closest("dialog, [role='dialog']") || document.querySelector("dialog[open], [role='dialog']")) return;
      if (!revealed && (event.key === " " || event.key === "Enter")) {
        // A focused button or link keeps its own Space and Enter, except the reveal button itself.
        const control = target?.closest("button, a");
        if (control && !control.classList.contains("review-reveal")) return;
        event.preventDefault();
        setRevealed(true);
      } else if (revealed && ["1", "2", "3", "4"].includes(event.key)) {
        event.preventDefault();
        void rate(Number(event.key) as 1 | 2 | 3 | 4);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [card, revealed, rate]);

  if (!cards) {
    return (
      <div className="review-page page-container">
        <div className="loading-state"><LoaderCircle size={22} className="spin" />{copy.states.review.loading}</div>
      </div>
    );
  }
  const total = cards.length;
  return (
    <div className="review-page page-container">
      {total > 0 && card && (
        <div className="review-session-heading">
          <span className="review-source">{card.category} · <MathText text={card.lessonTitle} /></span>
          <span className="review-count" aria-live="polite">{fill(copy.review.position, { current: position + 1, total })}</span>
        </div>
      )}
      {total > 0 && <progress className="review-progress" value={position} max={total} aria-label={copy.review.progressAria} />}
      {error && (
        <div className="page-error" role="alert">
          <span>{error}</span>
          {!card && <button onClick={() => void load()}>{copy.states.review.reloadAction}</button>}
        </div>
      )}
      {card ? (
        <article className={`review-card ${revealed ? "revealed" : ""}`} aria-live={card.kind === "recall" ? undefined : "polite"}>
          {card.kind === "recall" ? <RecallReviewCard card={card} revealed={revealed} setRevealed={setRevealed} hints={hints} setHints={setHints} answerRef={answer} saving={saving} rate={(rating) => void rate(rating)} openNote={openNote} personalAvailable={personalAvailable} sendToPersonal={sendToPersonal} /> : null}
          {card.kind !== "recall" && <LegacyReviewContent card={card} revealed={revealed} setRevealed={setRevealed} hints={hints} setHints={setHints} answer={answer} openNote={openNote} personalAvailable={personalAvailable} sendToPersonal={sendToPersonal} saving={saving} rate={(rating) => void rate(rating)} />}
        </article>
      ) : total > 0 ? (
        <div className="review-done">
          <CheckCheck size={28} />
          <h2>{total === 1 ? copy.states.review.doneTitleOne : fill(copy.states.review.doneTitle, { total })}</h2>
          <p>{again ? again === 1 ? copy.states.review.doneBodyWithAgainOne : fill(copy.states.review.doneBodyWithAgain, { again }) : copy.states.review.doneBodyClean}</p>
          <div className="review-done-actions">
            {remaining > 0 && <button onClick={() => void load()}><RotateCcw size={15} />{remaining === 1 ? copy.states.review.donePracticeRemainingOne : fill(copy.states.review.donePracticeRemaining, { remaining })}</button>}
            <a href="#/home">{copy.states.review.doneBackHome} <ArrowRight size={15} /></a>
          </div>
        </div>
      ) : !error && (
        <div className="review-done">
          <BookOpen size={28} />
          <h2>{copy.states.review.emptyDueTitle}</h2>
          <div className="review-done-actions">
            <a href="#/library">{copy.states.review.openLibraryAction} <ArrowRight size={15} /></a>
          </div>
        </div>
      )}
    </div>
  );
}
