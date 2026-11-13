import { CircleCheck, Layers, X, type LucideIcon } from "lucide-react";
import type { Compare as CompareData, FigureCell } from "../../../shared/lesson-v3";
import { learningCopy } from "../../copy/learning";
import FigureFrame from "./FigureFrame";
import V3Text from "./V3Text";
import Blank from "./Blank";

const toneIcons: Record<string, LucideIcon | undefined> = { wrong: X, right: CircleCheck };

export default function Compare({ figure, predict = false, blank, review = false, reviewRevealed = false }: { figure: CompareData; predict?: boolean; blank?: FigureCell; review?: boolean; reviewRevealed?: boolean }) {
  const concealed = review && predict && !reviewRevealed;
  return (
    <FigureFrame title={learningCopy().figures.kinds.compare} icon={Layers}>
      <div className="v3-figure-body">
        <div className="v3-compare" data-columns={figure.items.length} style={{ "--v3-columns": figure.items.length } as React.CSSProperties}>
          {figure.items.map((item, itemIndex) => {
            const Icon = toneIcons[item.tone || ""];
            return <section className={`v3-compare-item${item.tone ? ` is-${item.tone}` : ""}`} key={itemIndex}>
              <h3>{Icon && <Icon size={16} aria-hidden="true" />}<V3Text text={item.title} sourceKey={`figure:compare-item:${itemIndex}`} /></h3>
              <dl>{figure.rows.map((row, rowIndex) => <div key={rowIndex}>
                <dt><V3Text text={row.label} sourceKey={`figure:compare-label:${itemIndex}:${rowIndex}`} /></dt>
                <dd>{concealed && blank?.kind === "compare" && blank.item === itemIndex && blank.row === rowIndex ? <Blank /> : <V3Text text={row.values[itemIndex]} sourceKey={`figure:compare:${itemIndex}:${rowIndex}`} />}</dd>
              </div>)}</dl>
            </section>;
          })}
        </div>
        {figure.verdict && <p className={`v3-compare-verdict${concealed ? " is-concealed" : ""}`} aria-hidden={concealed || undefined}><CircleCheck size={15} aria-hidden="true" /><span><V3Text text={figure.verdict} sourceKey="figure:compare-verdict" /></span></p>}
      </div>
    </FigureFrame>
  );
}
