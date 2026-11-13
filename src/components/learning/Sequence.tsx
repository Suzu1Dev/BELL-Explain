import { ListChecks } from "lucide-react";
import type { FigureCell, Sequence as SequenceData } from "../../../shared/lesson-v3";
import { fill, learningCopy } from "../../copy/learning";
import Blank from "./Blank";
import FigureFrame, { useFigureStep } from "./FigureFrame";
import V3Text from "./V3Text";

export default function Sequence({ figure, predict = false, blank, interactive = true, reviewRevealed = false }: {
  figure: SequenceData;
  predict?: boolean;
  blank?: FigureCell;
  interactive?: boolean;
  reviewRevealed?: boolean;
}) {
  const answerIndex = blank?.kind === "sequence" ? blank.event : undefined;
  const figureStep = useFigureStep(figure.events.length, answerIndex, predict);
  const stepper = interactive ? figureStep : undefined;
  const current = Math.min(figure.events.length, figureStep.current + (reviewRevealed && answerIndex !== undefined ? 1 : 0));
  const lanes = new Map(figure.lanes.map((lane, index) => [lane.id, { ...lane, index, color: index % 4 + 1 }]));
  const hasOutput = figure.events.some(event => event.output !== undefined);
  const copy = learningCopy().figures;
  return (
    <FigureFrame title={copy.kinds.sequence} icon={ListChecks} stepper={stepper}
      caption={figure.caption ? <V3Text text={figure.caption} sourceKey="figure:sequence-caption" /> : undefined}
      ariaLabel={fill(stepper ? copy.sequence.regionAria : copy.sequence.regionStaticAria, { lanes: figure.lanes.map(lane => lane.label).join(copy.listSeparator) })}>
      <div className="v3-figure-body">
        <div className="v3-sequence-lanes" aria-hidden="true">
          {figure.lanes.map((lane, index) => <span className="v3-sequence-lane" key={lane.id} style={{ "--v3-lane": `var(--lane-${index % 4 + 1})` } as React.CSSProperties}>
            <i aria-hidden="true" /><V3Text text={lane.label} sourceKey={`figure:sequence-lane-head:${index}`} />
          </span>)}
        </div>
        <div className="v3-sequence" role="list">
          {figure.events.map((event, index) => {
            const lane = lanes.get(event.lane) ?? { label: event.lane, index: 0, color: 1 };
            const future = index >= current;
            const isBlank = !reviewRevealed && predict && index >= figureStep.current && (blank ? blank.kind === "sequence" && blank.event === index : index === figureStep.current);
            return <span className={`v3-sequence-event${future && !isBlank ? " is-future" : ""}${index === current - 1 ? " is-current" : ""}`} role="listitem" key={index}
              onClick={stepper ? () => stepper.setCurrent(index + 1) : undefined}
              style={{ "--v3-lane": `var(--lane-${lane.color})`, "--v3-lane-tint": `var(--lane-${lane.color}-tint)` } as React.CSSProperties}>
              {isBlank ? <Blank /> : <span className="v3-sequence-event-content" aria-hidden={future || undefined}><span className="v3-pin">{index + 1}</span><span className="v3-sequence-lane-badge"><i aria-hidden="true" /><V3Text text={lane.label} sourceKey={`figure:sequence-lane:${index}`} /></span><span className="v3-sequence-label"><V3Text text={event.label} sourceKey={`figure:sequence-event:${index}`} /></span>{event.output !== undefined && <span className="v3-sequence-inline-out">→ <V3Text text={event.output} sourceKey={`figure:sequence-inline-out:${index}`} /></span>}</span>}
            </span>;
          })}
        </div>
        {hasOutput && <div className="v3-sequence-output"><span>{copy.sequence.consoleLabel}</span>{figure.events.map((event, index) => event.output !== undefined && <span className={`v3-sequence-token${index === current - 1 ? " is-current" : ""}`} key={index}>
          <span className="v3-sequence-event-content" aria-hidden={index >= current || undefined}><V3Text text={event.output} sourceKey={`figure:sequence-out:${index}`} /></span>
        </span>)}</div>}
      </div>
    </FigureFrame>
  );
}
