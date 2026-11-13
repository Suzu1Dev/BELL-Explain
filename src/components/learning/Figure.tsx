import type { Figure as FigureData, FigureCell } from "../../../shared/lesson-v3";
import RubikIllustration from "../RubikIllustration";
import AnnotatedCode from "./AnnotatedCode";
import StateTable from "./StateTable";
import Compare from "./Compare";
import Sequence from "./Sequence";
import Timeline from "./Timeline";
import KeyFact from "./KeyFact";
import D2Diagram from "./D2Diagram";

export default function Figure({ figure, predict = false, blank, interactive = true, review = false, reviewRevealed = false }: {
  figure: FigureData;
  predict?: boolean;
  blank?: FigureCell;
  interactive?: boolean;
  review?: boolean;
  reviewRevealed?: boolean;
}) {
  switch (figure.kind) {
    case "annotated-code": return <AnnotatedCode figure={figure} />;
    case "state": return <StateTable figure={figure} predict={predict} blank={blank} interactive={interactive} review={review} reviewRevealed={reviewRevealed} />;
    case "compare": return <Compare figure={figure} predict={predict} blank={blank} review={review} reviewRevealed={reviewRevealed} />;
    case "sequence": return <Sequence figure={figure} predict={predict} blank={blank} interactive={interactive} reviewRevealed={reviewRevealed} />;
    case "timeline": return <Timeline figure={figure} />;
    case "keyfact": return <KeyFact figure={figure} predict={predict} blank={blank} review={review} reviewRevealed={reviewRevealed} />;
    case "d2": return <D2Diagram figure={figure} interactive={interactive} />;
    case "rubik-2x2": return (
      <div className="v3-figure v3-rubik-figure">
        <RubikIllustration
          data={{
            kind: "rubik-2x2",
            title: figure.title,
            caption: figure.caption,
            setupMoves: figure.setupMoves,
            focus: [{ sectionIndex: 0, view: figure.view ?? "moves" }],
          }}
          sectionIndex={0}
        />
      </div>
    );
  }
}
