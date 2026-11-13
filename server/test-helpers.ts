import type { LessonSection } from "../shared/types.js";

/** Add the new live-generation contract to legacy test fixtures. */
export function withExample<T extends {sections:LessonSection[]}>(value:T):T {
  const result=structuredClone(value);
  const section=result.sections.find(section=>section.code.trim());
  if(!section)throw new Error("Fixture needs code");
  const lastLine=section.code.split("\n").length;
  section.codeExample={title:"計數器小案例",scenario:"記住這次呼叫之前的計數。",environment:"JavaScript 教學環境",walkthrough:[
    {startLine:1,endLine:1,explanation:"先建立這個小案例需要的入口。"},
    {startLine:Math.min(2,lastLine),endLine:lastLine,explanation:"呼叫後觀察狀態如何保留並改變。"},
  ],expectedOutput:"依範例呼叫推導出遞增的數字。",application:"適用於理解函式如何保留狀態；不涵蓋跨裝置保存。"};
  return result;
}
