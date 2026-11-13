import { ArrowLeft, FileText, ListTodo } from "lucide-react";
import type { RefObject } from "react";
import type { ReviewCardView } from "../../../shared/learning";
import { recallParts } from "../../../shared/lesson-v3";
import { fill, learningCopy } from "../../copy/learning";
import { intervalLabel } from "../../lib/review";
import Figure from "./Figure";
import V3Text from "./V3Text";

export default function RecallReviewCard({ card, revealed, setRevealed, hints, setHints, answerRef, saving, rate, openNote, personalAvailable, sendToPersonal }: {
  card: ReviewCardView;
  revealed: boolean;
  setRevealed: (value: boolean) => void;
  hints: boolean;
  setHints: (value: boolean) => void;
  answerRef: RefObject<HTMLDivElement | null>;
  saving: boolean;
  rate: (rating: 1 | 2 | 3 | 4) => void;
  openNote: (lessonId: string, sectionId?: string) => void;
  personalAvailable?: boolean;
  sendToPersonal?: (card: ReviewCardView) => void;
}) {
  const copy = learningCopy();
  const parts = recallParts(card.answer);
  const grades = [
    { value: 1 as const, label: copy.review.grades.again, hint: copy.review.grades.againHint },
    { value: 2 as const, label: copy.review.grades.hard, hint: copy.review.grades.hardHint },
    { value: 3 as const, label: copy.review.grades.good, hint: copy.review.grades.goodHint },
    { value: 4 as const, label: copy.review.grades.easy, hint: copy.review.grades.easyHint },
  ];
  return (
    <>
      <header className="rc-head">
        <span className="rc-source"><FileText size={14} aria-hidden="true" />{fill(copy.review.sourceChip, { lessonTitle: card.lessonTitle, step: card.step ?? 1 })}</span>
        <span className="rc-tags"><span className="review-kind">{copy.review.kindRecall}</span>{card.isNew && <span className="review-new">{copy.review.newCardBadge}</span>}</span>
      </header>
      <h2 className="rc-q"><V3Text text={card.prompt} sourceKey={`review:${card.id}:prompt`} /></h2>
      {card.blank && card.figure && <Figure figure={card.figure} blank={card.blank} predict interactive={false} review={!revealed} reviewRevealed={revealed} />}
      {!revealed && hints && card.hints.length > 0 && <div className="rc-hint" aria-label={copy.review.hintAria}><V3Text text={card.hints[0]} sourceKey={`review:${card.id}:hint`} /></div>}
      {!revealed && <div className="rc-actions">
        {!hints && card.hints.length > 0 && <button type="button" className="quiet-button" onClick={() => setHints(true)}>{copy.review.hintButton}</button>}
        <button type="button" className="primary-button review-reveal" onClick={() => setRevealed(true)} autoFocus>{copy.review.showAnswer}<kbd>Space</kbd></button>
      </div>}
      {revealed && (
        <>
          <div className="rc-answer" ref={answerRef} tabIndex={-1} aria-live="polite">
            <p className="rc-answer-big"><V3Text text={parts.verdict} sourceKey={`review:${card.id}:verdict`} /></p>
            {parts.reason && <p className="rc-answer-why"><V3Text text={parts.reason} sourceKey={`review:${card.id}:reason`} /></p>}
            {!card.blank && card.figure && <Figure figure={card.figure} interactive={false} reviewRevealed />}
          </div>
          <div className="review-card-actions">
            <button type="button" className="quiet-button" onClick={() => openNote(card.lessonId, card.sectionId)}><ArrowLeft size={14} />{copy.review.backToStep}</button>
            <button type="button" className="quiet-button" onClick={() => sendToPersonal?.(card)} disabled={!personalAvailable} title={personalAvailable ? copy.lesson.topbar.sendToPersonalTooltip : copy.lesson.topbar.sendToPersonalUnavailable}><ListTodo size={14} />{copy.lesson.topbar.sendToPersonal}</button>
          </div>
          <div className="review-ratings" role="group" aria-label={copy.review.gradesGroupAria}>
            {grades.map(rating => <button key={rating.value} type="button" className={`review-rating rating-${rating.value}`} onClick={() => rate(rating.value)} disabled={saving} title={rating.hint}><b><kbd>{rating.value}</kbd>{rating.label}</b><small>{intervalLabel(card.intervals[rating.value])}</small></button>)}
          </div>
        </>
      )}
    </>
  );
}
