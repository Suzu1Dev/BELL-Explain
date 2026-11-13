import { Check, CircleDashed, Clock, RotateCcw } from "lucide-react";
import type { RecallState } from "../../../shared/learning";
import type { LessonNoteV3 } from "../../../shared/lesson-v3";
import { learningCopy } from "../../copy/learning";
import { wrapUpStatus } from "./recall-state";
import V3Text from "./V3Text";

const icons = { check: Check, again: RotateCcw, waiting: Clock, unanswered: CircleDashed } as const;

export default function WrapUp({ lesson, recalls, onFocusRecall }: {
  lesson: LessonNoteV3;
  recalls: Record<string, RecallState>;
  onFocusRecall: (stepId: string) => void;
}) {
  const copy = learningCopy();
  return (
    <>
      <h2>{copy.wrapUp.heading}</h2>
      <ol className="v3-recap">
        {lesson.steps.map(step => {
          const status = wrapUpStatus(recalls[step.id], copy);
          const Icon = icons[status.icon];
          return <li key={step.id} className="v3-recap-row" data-rating={recalls[step.id]?.rating}><a href={`#section-${step.id}`} onClick={event => { event.preventDefault(); onFocusRecall(step.id); }}><Icon size={16} aria-hidden="true" /><span className="v3-recap-lead"><V3Text text={step.lead} sourceKey={`${step.id}:recap`} /></span><span className="v3-recap-status">{status.text}</span></a></li>;
        })}
      </ol>
    </>
  );
}
