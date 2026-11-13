import { Timer, Zap } from "lucide-react";
import type { Timeline as TimelineData } from "../../../shared/lesson-v3";
import { fill, learningCopy } from "../../copy/learning";
import FigureFrame from "./FigureFrame";
import V3Text from "./V3Text";

export default function Timeline({ figure }: { figure: TimelineData }) {
  const position = (at: number) => 2 + at / figure.span * 96;
  const firingRow = figure.rows.find(row => row.fire);
  const wait = firingRow?.ranges?.find(range => range.state === "wait")
    ?? figure.rows.flatMap(row => row.ranges || []).find(range => range.state === "wait");
  const copy = learningCopy().figures;
  return (
    <FigureFrame title={wait ? fill(copy.timeline.headerWithSpan, { span: wait.to - wait.from, unit: figure.unit }) : copy.kinds.timeline} icon={Timer}
      caption={figure.caption ? <V3Text text={figure.caption} sourceKey="figure:timeline-caption" /> : undefined}>
      <div className="v3-figure-body">
        <div className="v3-timeline">
          {figure.rows.map((row, rowIndex) => {
            const marks = row.marks ?? [];
            let prevPos = -100;
            let upper = false;
            const stagger = marks.map(mark => {
              const pos = position(mark.at);
              if (Math.abs(pos - prevPos) < 14) {
                upper = !upper;
                prevPos = pos;
                return upper ? "upper" : "lower";
              }
              upper = false;
              prevPos = pos;
              return undefined;
            });
            const hasStagger = stagger.some(Boolean);
            return <div className="v3-timeline-row" key={rowIndex}>
              <span className="v3-timeline-label"><V3Text text={row.label} sourceKey={`figure:timeline-row:${rowIndex}`} /></span>
              <div className={`v3-timeline-track${hasStagger ? " is-staggered" : ""}`}>
                {marks.map((mark, index) => <span className="v3-timeline-mark" data-stagger={stagger[index]} key={`mark-${index}`} style={{ left: `${position(mark.at)}%` }}><span className="v3-timeline-key"><V3Text text={mark.label} sourceKey={`figure:timeline-mark:${rowIndex}:${index}`} /></span></span>)}
                {row.ranges?.map((range, index) => <span className={`v3-timeline-range${range.state === "cancel" ? " is-cancelled" : ""}`} key={`range-${index}`}
                  style={{ left: `${position(range.from)}%`, width: `${(range.to - range.from) / figure.span * 96}%` }}>
                  {range.label ? <V3Text text={range.label} sourceKey={`figure:timeline-range:${rowIndex}:${index}`} /> : (range.state === "cancel" ? copy.timeline.canceledRange : `${range.to - range.from} ${figure.unit}`)}
                </span>)}
                {row.fire && <span className="v3-timeline-mark v3-timeline-fire-mark" style={{ left: `${position(row.fire.at)}%` }}>
                  <span className="v3-timeline-fire" aria-label={fill(copy.timeline.fireAria, { label: row.fire.label })}><Zap size={13} aria-hidden="true" /><span><V3Text text={row.fire.label} sourceKey={`figure:timeline-fire:${rowIndex}`} /></span></span>
                </span>}
              </div>
            </div>;
          })}
          <div className="v3-timeline-axis" aria-hidden="true"><span /><div>{Array.from({ length: 7 }, (_, index) => {
            const value = figure.span * index / 6;
            return <span key={index} style={{ left: `${position(value)}%` }}>{Number.isInteger(value) ? value : value.toFixed(1)}</span>;
          })}</div></div>
        </div>
      </div>
    </FigureFrame>
  );
}
