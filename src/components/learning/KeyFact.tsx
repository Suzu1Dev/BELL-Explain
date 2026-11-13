import { Hash } from "lucide-react";
import type { FigureCell, KeyFact as KeyFactData } from "../../../shared/lesson-v3";
import { learningCopy } from "../../copy/learning";
import FigureFrame from "./FigureFrame";
import V3Text from "./V3Text";
import Blank from "./Blank";

export default function KeyFact({ figure, predict = false, blank, review = false, reviewRevealed = false }: { figure: KeyFactData; predict?: boolean; blank?: FigureCell; review?: boolean; reviewRevealed?: boolean }) {
  return (
    <FigureFrame title={learningCopy().figures.kinds.keyfact} icon={Hash} showHeader={false}>
      <div className="v3-keyfact">
        <div className="v3-keyfact-value">{review && predict && !reviewRevealed && blank?.kind === "keyfact" ? <Blank /> : figure.value}{figure.unit && <small>{figure.unit}</small>}</div>
        <div><h3><V3Text text={figure.label} sourceKey="figure:keyfact-label" /></h3><p><V3Text text={figure.note} sourceKey="figure:keyfact-note" /></p></div>
      </div>
    </FigureFrame>
  );
}
