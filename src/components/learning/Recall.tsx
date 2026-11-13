import { useEffect, useRef, useState } from "react";
import { Brain, Check, CircleCheck, CircleDashed, Clock, Lightbulb, LoaderCircle, RotateCcw } from "lucide-react";
import type { RecallAnswer, RecallState } from "../../../shared/learning";
import { recallParts, type Step } from "../../../shared/lesson-v3";
import { api, ApiError } from "../../lib/api";
import { learningCopy } from "../../copy/learning";
import { recallConfirmation } from "./recall-state";
import V3Text from "./V3Text";

export default function Recall({ lessonId, step, state, loading, onRated }: {
  lessonId: string;
  step: Step;
  state?: RecallState;
  loading: boolean;
  onRated: (state: RecallState) => void;
}) {
  const copy = learningCopy();
  const [revealed, setRevealed] = useState(false);
  const [reread, setReread] = useState(false);
  const [hint, setHint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState<RecallAnswer>();
  const [error, setError] = useState<"save" | "gone">();
  const [justRated, setJustRated] = useState(false);
  const rememberedRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const questionId = `${step.id}-recall-q`;
  const parts = recallParts(step.recall.answer);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const update = () => setNow(new Date());
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  useEffect(() => {
    if (revealed && !state) rememberedRef.current?.focus();
  }, [revealed, state]);
  useEffect(() => {
    if (justRated) statusRef.current?.focus();
  }, [justRated]);

  const rate = async (rating: RecallAnswer) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const timer = window.setTimeout(() => setSlow(rating), 400);
    try {
      onRated(await api.rateRecall(lessonId, step.id, rating));
      setJustRated(true);
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 404 ? "gone" : "save");
    } finally {
      window.clearTimeout(timer);
      setSlow(undefined);
      setBusy(false);
    }
  };

  const answer = <p className="v3-recall-a"><b><V3Text text={parts.verdict} sourceKey={`${step.id}:recall-verdict`} /></b>{parts.reason && <> <V3Text text={parts.reason} sourceKey={`${step.id}:recall-reason`} /></>}</p>;
  const confirmation = state ? recallConfirmation(state, copy, now) : undefined;
  const waiting = state && (state.status === "waiting" || state.status === "tomorrow");
  const StatusIcon = !state ? CircleDashed : waiting ? Clock : state.rating === "remembered" ? CircleCheck : RotateCcw;

  return (
    <section className="v3-recall-card" data-state={state ? "rated" : revealed ? "revealed" : "unrated"} data-waiting={waiting || undefined} role="group" aria-labelledby={questionId}>
      <div className="v3-recall-top">
        <span className="v3-recall-label"><Brain size={16} aria-hidden="true" />{copy.recall.title}</span>
        {confirmation && <div className="v3-recall-state" ref={statusRef} tabIndex={-1} role="status"><StatusIcon size={15} aria-hidden="true" /><span>{confirmation}</span></div>}
      </div>
      <p className="v3-recall-q" id={questionId} tabIndex={-1}><V3Text text={step.recall.question} sourceKey={`${step.id}:recall-question`} /></p>
      {waiting && <p className="v3-recall-waiting">{copy.recall.waitingTooltip}</p>}
      {state ? (
        <>
          {reread && answer}
          <button type="button" className="quiet-button v3-recall-reread" aria-expanded={reread} onClick={() => setReread(value => !value)}>{reread ? copy.recall.hideAnswer : copy.recall.showAnswer}</button>
        </>
      ) : loading ? <div className="v3-recall-loading" aria-hidden="true" /> : (
        <>
          {revealed && answer}
          <div className="v3-recall-actions" aria-busy={busy}>
            {!revealed && step.recall.hint && <button type="button" className="quiet-button" onClick={() => setHint(value => !value)}>{copy.recall.hintButton}</button>}
            {!revealed ? <button type="button" className="primary-button" onClick={() => setRevealed(true)}>{copy.recall.showAnswer}</button> : (
              <>
                <button type="button" className="secondary-button" ref={rememberedRef} disabled={busy} onClick={() => void rate("remembered")}>{slow === "remembered" ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{copy.recall.buttons.remembered}</button>
                <button type="button" className="quiet-button" disabled={busy} onClick={() => void rate("unsure")}>{slow === "unsure" && <LoaderCircle className="spin" size={15} />}{copy.recall.buttons.unsure}</button>
              </>
            )}
          </div>
          {hint && step.recall.hint && <p className="v3-recall-hint"><Lightbulb size={15} aria-hidden="true" /><V3Text text={step.recall.hint} sourceKey={`${step.id}:recall-hint`} /></p>}
          {error && <p className="v3-recall-error" role="alert">{error === "gone" ? copy.recall.stepGoneError : copy.recall.saveError}{error === "gone" && <button type="button" className="quiet-button" onClick={() => window.location.reload()}>{copy.states.lesson.retryAction}</button>}</p>}
        </>
      )}
    </section>
  );
}
