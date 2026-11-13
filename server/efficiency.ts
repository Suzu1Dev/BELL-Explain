import { readFileSync } from "node:fs";
import type { ChatCall } from "./ai.js";
import {
  defaultPonytailMode,
  ponytailPolicyVersion,
  ponytailRevision,
  type PonytailMode,
} from "../shared/efficiency.js";

const fullRules = readFileSync(
  new URL("../vendor/ponytail/rules.md", import.meta.url),
  "utf8",
);
const liteRules =
  "Understand the material and trace end-to-end mechanisms first. Prefer standard library primitives, minimal reproducible examples, and root-cause explanations over filler prose or speculative boilerplate. Preserve complete teaching coverage, primary-source rigor, concrete examples, invariants, and all explicit user requirements.";

export function applyPonytail(
  instruction: string,
  mode: PonytailMode = defaultPonytailMode,
  role = "教學代理",
): string {
  if (mode === "off") return instruction;
  return `${instruction}\n\nBELL Ponytail efficiency guidance (${ponytailPolicyVersion}; mode=${mode}; role=${role}; upstream=${ponytailRevision}):\n${mode === "full" ? fullRules : liteRules}\nApplication boundaries: apply Ponytail's full discipline to code examples, technical reasoning, and prose economy (eliminate filler phrases, speculative abstractions, and unnecessary boilerplate; trace root causes end-to-end; write minimal, idiomatic, reproducible examples). NEVER shorten away source coverage, core concepts, primary-source specification details, expert diagnostic workflows, concrete examples, or any required JSON output fields that help the learner master the material. Do not call tools or add commentary outside the requested JSON.`;
}

export function withPonytail(
  chat: ChatCall,
  mode: PonytailMode = defaultPonytailMode,
): ChatCall {
  if (mode === "off") return chat;
  return (role, instruction, data, signal, onProgress, images) =>
    chat(role, applyPonytail(instruction, mode, role), data, signal, onProgress, images);
}
