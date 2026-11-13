import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import { fill, learningCopy } from "../../copy/learning";

export function useFigureStep(total: number, answerIndex: number | undefined, predict: boolean) {
  const [current, setCurrent] = useState(() => answerIndex === undefined ? total : Math.max(1, Math.min(total, answerIndex)));
  useEffect(() => {
    setCurrent(value => Math.min(total, predict && answerIndex !== undefined ? Math.max(1, answerIndex) : value));
  }, [total, answerIndex, predict]);
  return { current, total, setCurrent };
}

export default function FigureFrame({ title, icon: Icon, caption, stepper, ariaLabel, actions, children, showHeader = true }: {
  title: ReactNode;
  icon: LucideIcon;
  showHeader?: boolean;
  caption?: ReactNode;
  stepper?: { current: number; total: number; setCurrent: (step: number) => void };
  ariaLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const copy = learningCopy().figures.controls;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!stepper) return;
    const next = event.key === "ArrowLeft" ? stepper.current - 1
      : event.key === "ArrowRight" ? stepper.current + 1
        : event.key === "Home" ? 1 : 0;
    if (!next) return;
    event.preventDefault();
    stepper.setCurrent(Math.max(1, Math.min(stepper.total, next)));
  };
  return (
    <figure className="v3-figure" tabIndex={stepper ? 0 : undefined} aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {showHeader && <div className="v3-figure-head">
        <span className="v3-figure-title"><Icon size={14} aria-hidden="true" />{title}</span>
        <span className="v3-figure-controls">
          {stepper && <>
            <button type="button" className="icon-button" aria-label={copy.prevStepAria} disabled={stepper.current <= 1} onClick={() => stepper.setCurrent(stepper.current - 1)}><ChevronLeft size={15} /></button>
            <span className="v3-figure-position" aria-hidden="true">{fill(copy.position, { current: stepper.current, total: stepper.total })}</span>
            <span className="sr-only" aria-live="polite" aria-atomic="true">{fill(copy.positionLiveAria, { current: stepper.current, total: stepper.total })}</span>
            <button type="button" className="icon-button" aria-label={copy.nextStepAria} disabled={stepper.current >= stepper.total} onClick={() => stepper.setCurrent(stepper.current + 1)}><ChevronRight size={15} /></button>
          </>}
          {actions}
        </span>
      </div>}
      {children}
      {caption && <figcaption className="v3-figure-caption">{caption}</figcaption>}
    </figure>
  );
}
