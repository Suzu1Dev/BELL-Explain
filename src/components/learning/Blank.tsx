import { learningCopy } from "../../copy/learning";

export default function Blank() {
  return <span className="v3-blank" aria-label={learningCopy().figures.controls.blankPendingAria}>?</span>;
}
