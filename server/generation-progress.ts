import type { GenerateEvent } from "../shared/types.js";
import type { ChatCall, ChatProgress } from "./ai.js";
import { AppError } from "./errors.js";

export const GENERATION_TIMEOUT_MS = 30 * 60_000;
export const EXAMPLE_TIMEOUT_MS = 20 * 60_000;

export function taskDeadline(parent: AbortSignal, timeoutMs: number, message: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new AppError(504, message)), timeoutMs);
  timer.unref();
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    dispose: () => clearTimeout(timer),
  };
}

// Keep the stream alive even before a model emits text. Activity is metadata
// only: neither reasoning text nor unfinished JSON is sent to the browser.
export function withGenerationProgress(
  chat: ChatCall,
  emit: (event: GenerateEvent) => void,
  intervalMs = 5000,
): ChatCall {
  return async (role, instruction, data, signal, onProgress, images) => {
    signal.throwIfAborted();
    const stage = role.includes("整理") ? "organize" : role.includes("分析") ? "analyze" : "teach";
    const started = Date.now();
    let lastSent = started;
    let lastActivity = started;
    let active = true;
    let progress: ChatProgress = { phase: "connecting", outputChars: 0 };
    const report = () => {
      if (!active || signal.aborted) return;
      const elapsed = Math.floor((Date.now() - started) / 1000);
      const duration = elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`;
      const activity = Date.now() - lastActivity > 30_000 && progress.phase !== "connecting"
        ? `仍在等候模型的下一次回應${progress.outputChars ? `，已接收 ${progress.outputChars.toLocaleString("zh-TW")} 字元` : ""}`
        : progress.phase === "writing"
        ? `正在產生解說，已接收 ${progress.outputChars.toLocaleString("zh-TW")} 字元`
        : progress.phase === "thinking" ? "正在思考與規劃內容" : "正在等候模型回應";
      emit({ type: "stage", stage, message: `${role}${activity}（已進行 ${duration}）。` });
      lastSent = Date.now();
    };
    const timer = setInterval(report, intervalMs);
    timer.unref();
    try {
      return await chat(role, instruction, data, signal, (next) => {
        if (!active || signal.aborted) return;
        const changedPhase = next.phase !== progress.phase;
        progress = next;
        lastActivity = Date.now();
        onProgress?.(next);
        if (changedPhase || Date.now() - lastSent >= intervalMs) report();
      }, images);
    } finally {
      active = false;
      clearInterval(timer);
    }
  };
}
