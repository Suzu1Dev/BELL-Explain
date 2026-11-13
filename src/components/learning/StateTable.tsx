import { History } from "lucide-react";
import type { FigureCell, StateTable as StateTableData } from "../../../shared/lesson-v3";
import { fill, learningCopy } from "../../copy/learning";
import Blank from "./Blank";
import FigureFrame, { useFigureStep } from "./FigureFrame";
import V3Text from "./V3Text";

export default function StateTable({ figure, predict = false, blank, interactive = true, review = false, reviewRevealed = false }: {
  figure: StateTableData;
  predict?: boolean;
  blank?: FigureCell;
  interactive?: boolean;
  review?: boolean;
  reviewRevealed?: boolean;
}) {
  const answerIndex = blank && (blank.kind === "state" || blank.kind === "state-output") ? blank.row : undefined;
  const figureStep = useFigureStep(figure.rows.length, answerIndex, predict);
  const stepper = interactive ? figureStep : undefined;
  const hasOutput = figure.rows.some(row => row.output !== undefined);
  const current = Math.min(figure.rows.length, figureStep.current + (reviewRevealed && answerIndex !== undefined ? 1 : 0));
  const figures = learningCopy().figures;
  const copy = figures.state;
  const heading = figure.vars.length === 1 ? fill(copy.headerSingleVar, { var: figure.vars[0] })
    : figure.vars.length === 2 ? fill(copy.headerTwoVars, { varA: figure.vars[0], varB: figure.vars[1] })
      : fill(copy.headerManyVars, { vars: figure.vars.join(figures.listSeparator) });
  const ariaHeading = figure.vars.join(figures.listSeparator);
  const blanks = (row: number, name?: string) => {
    if (review && blank && (blank.kind === "state" || blank.kind === "state-output") && blank.row === row && !reviewRevealed) return true;
    if (reviewRevealed || !stepper) return false;
    if (!predict || row < figureStep.current) return false;
    if (!blank) return row === figureStep.current;
    return name
      ? blank.kind === "state" && blank.row === row && blank.var === name
      : blank.kind === "state-output" && blank.row === row;
  };
  return (
    <FigureFrame title={heading} icon={History} caption={figure.caption ? <V3Text text={figure.caption} sourceKey="figure:state-caption" /> : undefined}
      stepper={stepper} ariaLabel={fill(stepper ? copy.regionAria : copy.regionStaticAria, { vars: ariaHeading })}>
      <div className="v3-figure-body">
        <table className="v3-state-table">
          <thead><tr><th scope="col">{copy.colMoment}</th><th scope="col" className="v3-state-code">{copy.colCode}</th>{figure.vars.map(name => <th scope="col" key={name}><code>{name}</code></th>)}{hasOutput && <th scope="col">{copy.colOutput}</th>}</tr></thead>
          <tbody>{figure.rows.map((row, rowIndex) => {
            const future = rowIndex >= current;
            return <tr key={rowIndex} className={`${future ? "is-future" : ""}${rowIndex === current - 1 ? " is-current" : ""}`}>
              <td className="v3-state-moment">{row.moment}</td>
              <td className="v3-state-code">{row.code}</td>
              {figure.vars.map(name => {
                const value = row.values[name];
                return <td className="v3-state-value" key={name}>{blanks(rowIndex, name) ? <>{value.from !== undefined && <><span className="v3-state-from">{value.from}</span><span className="v3-state-arrow">→</span></>}<Blank /></> : <span className="v3-state-value-content" aria-hidden={future || undefined}>
                  {value.from !== undefined && <><span className="v3-state-from">{value.from}</span><span className="v3-state-arrow">→</span></>}<span className="v3-state-to">{value.to}</span>
                </span>}</td>;
              })}
              {hasOutput && <td className="v3-state-output">{blanks(rowIndex) ? <Blank /> : <span className="v3-state-value-content" aria-hidden={future || undefined}>{row.output ?? copy.emptyOutput}</span>}</td>}
            </tr>;
          })}</tbody>
        </table>
      </div>
    </FigureFrame>
  );
}
