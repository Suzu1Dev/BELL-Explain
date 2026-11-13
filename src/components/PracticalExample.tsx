import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Braces,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  Eye,
  FastForward,
  Lightbulb,
  LoaderCircle,
  Monitor,
  Pause,
  PencilLine,
  Play,
  RotateCcw,
  StepForward,
} from "lucide-react";
import { isCodeSource } from "../../shared/annotations";
import type { CodeExample } from "../../shared/types";
import { codeExecutionCopy, fillExecCopy } from "../copy/code-execution";
import {
  formatPracticalCurrentFocus,
  formatPracticalLineLabel,
  formatPracticalStepButtonAria,
  practicalExampleCopy,
} from "../copy/practical-search";
import {
  isSandboxRunnable,
  isStepExecutableExample,
  runCodeInSandbox,
  type SandboxRunResult,
} from "../lib/code-runner";
import CodeBlock from "./CodeBlock";
import MathText, { ProseBlocks } from "./MathText";
import { AnnotatedText } from "./ReadingAnnotations";
import "./practical-example.css";

export function lineLabel(startLine: number, endLine: number) {
  return formatPracticalLineLabel(startLine, endLine);
}

interface ActiveExecutionStep {
  startLine: number;
  endLine: number;
  explanation: string;
  state?: string;
  output?: string;
  isLiveRuntime?: boolean;
}

export default function PracticalExample({
  code,
  language,
  example,
  annotationSectionId,
  predict = false,
}: {
  code: string;
  language: string;
  example: CodeExample;
  annotationSectionId?: string;
  /** Ask for a prediction before showing the result and the last step. */
  predict?: boolean;
}) {
  const id = useId();
  const copy = practicalExampleCopy();
  const execCopy = codeExecutionCopy();
  const runnable = isSandboxRunnable(language);

  const hasAuthoredStepOutputs = useMemo(
    () => example.walkthrough.some((step) => Boolean(step.output?.trim())),
    [example.walkthrough],
  );

  const [selectedIndex, setSelectedIndex] = useState(0);
  const [guess, setGuess] = useState("");
  const [resultShown, setResultShown] = useState(false);
  const [lastStepShown, setLastStepShown] = useState(false);

  const [draftCode, setDraftCode] = useState(code);
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [liveRun, setLiveRun] = useState<SandboxRunResult | null>(null);
  const [playing, setPlaying] = useState(false);
  const [traceActive, setTraceActive] = useState(() => !predict && hasAuthoredStepOutputs);

  const playTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listRef = useRef<HTMLOListElement | null>(null);
  const stepRefs = useRef<Array<HTMLDivElement | null>>([]);

  const isDirty = draftCode !== code;
  const stepExecutable = useMemo(
    () => isStepExecutableExample(language, draftCode, example),
    [language, draftCode, example],
  );

  useEffect(() => {
    setDraftCode(code);
    setEditing(false);
    setLiveRun(null);
    setPlaying(false);
    setSelectedIndex(0);
    setTraceActive(!predict && hasAuthoredStepOutputs);
  }, [code, predict, hasAuthoredStepOutputs]);

  useEffect(
    () => () => {
      if (playTimer.current !== null) clearTimeout(playTimer.current);
    },
    [],
  );

  const draftLineCount = useMemo(() => Math.max(1, draftCode.split("\n").length), [draftCode]);

  const useLiveRuntimeSteps =
    Boolean(liveRun?.ok && liveRun.entries.length > 0) && (isDirty || !hasAuthoredStepOutputs);

  const effectiveSteps: ActiveExecutionStep[] = useMemo(() => {
    if (useLiveRuntimeSteps && liveRun) {
      return liveRun.entries.map((entry, idx) => {
        const line = Math.max(1, Math.min(draftLineCount, entry.line ?? 1));
        return {
          startLine: line,
          endLine: line,
          explanation: fillExecCopy(execCopy.liveTraceStepText, {
            step: idx + 1,
            ms: entry.atMs,
          }),
          output: entry.level === "result" ? `-> ${entry.text}` : entry.text,
          isLiveRuntime: true,
        };
      });
    }
    return example.walkthrough;
  }, [useLiveRuntimeSteps, liveRun, draftLineCount, execCopy.liveTraceStepText, example.walkthrough]);

  const totalSteps = effectiveSteps.length;
  const lastIndex = Math.max(0, totalSteps - 1);
  const safeIndex = Math.min(selectedIndex, lastIndex);
  const hideResult = predict && !resultShown;
  const hideLastStep = predict && !lastStepShown && lastIndex > 0 && !useLiveRuntimeSteps;
  const selected = effectiveSteps[safeIndex] ?? effectiveSteps[0];

  const breakpointLines = useMemo(
    () => (stepExecutable ? new Set(effectiveSteps.map((step) => step.startLine)) : undefined),
    [stepExecutable, effectiveSteps],
  );

  useEffect(() => {
    const container = listRef.current;
    const item = stepRefs.current[safeIndex];
    if (!container || !item || container.scrollHeight <= container.clientHeight) return;
    const cRect = container.getBoundingClientRect();
    const iRect = item.getBoundingClientRect();
    if (iRect.top < cRect.top) {
      container.scrollTop = Math.max(0, container.scrollTop + (iRect.top - cRect.top) - 4);
    } else if (iRect.bottom > cRect.bottom) {
      container.scrollTop += iRect.bottom - cRect.bottom + 4;
    }
  }, [safeIndex]);

  useEffect(() => {
    if (!playing) return;
    if (safeIndex >= lastIndex) {
      playTimer.current = setTimeout(() => {
        setPlaying(false);
      }, 450);
      return;
    }
    playTimer.current = setTimeout(() => {
      setSelectedIndex((prev) => Math.min(lastIndex, prev + 1));
    }, 1050);
    return () => {
      if (playTimer.current !== null) clearTimeout(playTimer.current);
    };
  }, [playing, safeIndex, lastIndex]);

  const stopPlay = () => {
    if (playTimer.current !== null) {
      clearTimeout(playTimer.current);
      playTimer.current = null;
    }
    setPlaying(false);
  };

  const selectStep = (index: number, activateProgressive = false) => {
    stopPlay();
    const clamped = Math.max(0, Math.min(lastIndex, index));
    setSelectedIndex(clamped);
    if (activateProgressive || (!hideResult && (hasAuthoredStepOutputs || useLiveRuntimeSteps))) {
      setTraceActive(true);
    }
  };

  const handleLineClick = (lineNum: number) => {
    const exactAfter = effectiveSteps.findIndex(
      (step, idx) => idx > safeIndex && step.startLine === lineNum,
    );
    if (exactAfter >= 0) {
      selectStep(exactAfter);
      return;
    }
    const exactAny = effectiveSteps.findIndex((step) => step.startLine === lineNum);
    if (exactAny >= 0) {
      selectStep(exactAny);
      return;
    }
    const containing = effectiveSteps.findIndex(
      (step) => lineNum >= step.startLine && lineNum <= step.endLine,
    );
    if (containing >= 0) selectStep(containing);
  };

  const ensureSandboxExecuted = async (): Promise<SandboxRunResult | null> => {
    if (!runnable) return null;
    if (liveRun !== null) return liveRun;
    setRunning(true);
    try {
      const res = await runCodeInSandbox(draftCode, language);
      setLiveRun(res);
      return res;
    } finally {
      setRunning(false);
    }
  };

  const resolveStepCountAfterRun = (res: SandboxRunResult | null): number => {
    if (res?.ok && res.entries.length > 0 && (isDirty || !hasAuthoredStepOutputs)) {
      return res.entries.length;
    }
    return example.walkthrough.length;
  };

  const handlePlayTrace = async () => {
    if (playing) {
      stopPlay();
      return;
    }
    setEditing(false);

    if (!isDirty && hasAuthoredStepOutputs) {
      const nextLast = Math.max(0, example.walkthrough.length - 1);
      const startIdx = !traceActive || safeIndex >= nextLast ? 0 : safeIndex;
      setSelectedIndex(startIdx);
      setTraceActive(true);
      setLastStepShown(true);
      setResultShown(true);
      if (example.walkthrough.length > 1 && startIdx < nextLast) {
        setPlaying(true);
      }
      void ensureSandboxExecuted().then((res) => {
        if (res && !res.ok) {
          stopPlay();
          setTraceActive(false);
        }
      });
      return;
    }

    const res = await ensureSandboxExecuted();
    setLastStepShown(true);
    setResultShown(true);
    if (res && !res.ok) {
      setTraceActive(false);
      return;
    }

    const nextTotal = resolveStepCountAfterRun(res);
    const nextLast = Math.max(0, nextTotal - 1);
    const startIdx = !traceActive || safeIndex >= nextLast ? 0 : safeIndex;
    setSelectedIndex(startIdx);
    setTraceActive(true);
    if (nextTotal > 1 && startIdx < nextLast) {
      setPlaying(true);
    }
  };

  const handleStepOnce = async () => {
    stopPlay();
    setEditing(false);

    if (!isDirty && hasAuthoredStepOutputs) {
      const nextLast = Math.max(0, example.walkthrough.length - 1);
      const nextIdx = !traceActive ? 0 : safeIndex >= nextLast ? 0 : safeIndex + 1;
      setTraceActive(true);
      setSelectedIndex(nextIdx);
      setLastStepShown(true);
      setResultShown(true);
      void ensureSandboxExecuted().then((res) => {
        if (res && !res.ok) setTraceActive(false);
      });
      return;
    }

    const res = await ensureSandboxExecuted();
    setLastStepShown(true);
    setResultShown(true);
    if (res && !res.ok) {
      setTraceActive(false);
      return;
    }

    const nextTotal = resolveStepCountAfterRun(res);
    const nextLast = Math.max(0, nextTotal - 1);
    if (!traceActive) {
      setTraceActive(true);
      setSelectedIndex(0);
      return;
    }
    setSelectedIndex(safeIndex >= nextLast ? 0 : safeIndex + 1);
  };

  const handleRunToEnd = async () => {
    stopPlay();
    setEditing(false);

    const res = await ensureSandboxExecuted();
    setLastStepShown(true);
    setResultShown(true);
    if (res && !res.ok) {
      setTraceActive(false);
      return;
    }

    const nextTotal = resolveStepCountAfterRun(res);
    setTraceActive(true);
    setSelectedIndex(Math.max(0, nextTotal - 1));
  };

  const handleResetCode = () => {
    stopPlay();
    setDraftCode(code);
    setLiveRun(null);
    setSelectedIndex(0);
    setTraceActive(!predict && hasAuthoredStepOutputs);
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (runnable && !running) void handlePlayTrace();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const target = event.currentTarget;
      const start = target.selectionStart ?? 0;
      const end = target.selectionEnd ?? start;
      const nextValue = `${draftCode.slice(0, start)}  ${draftCode.slice(end)}`;
      setDraftCode(nextValue);
      setLiveRun(null);
      setTraceActive(false);
      requestAnimationFrame(() => {
        target.selectionStart = start + 2;
        target.selectionEnd = start + 2;
      });
    }
  };

  // Prose typesets its formulas; the expected output is program output and stays as written.
  const annotated = (text: string, field: string) => {
    const sourceKey = `${annotationSectionId}:${field}`;
    const math = !isCodeSource(sourceKey);
    return annotationSectionId ? (
      <AnnotatedText text={text} sourceKey={sourceKey} math={math} />
    ) : math ? (
      <MathText text={text} />
    ) : (
      text
    );
  };

  const hasProgressiveSteps =
    hasAuthoredStepOutputs || effectiveSteps.some((step) => Boolean(step.isLiveRuntime));
  const showProgressiveConsole =
    stepExecutable && traceActive && hasProgressiveSteps && !(liveRun && !liveRun.ok);
  const atFinalStep = safeIndex >= lastIndex;

  const pastOutputs = useMemo(() => {
    if (!showProgressiveConsole) return [];
    return effectiveSteps
      .slice(0, safeIndex)
      .map((step) => step.output)
      .filter((out): out is string => Boolean(out && out.trim()));
  }, [showProgressiveConsole, effectiveSteps, safeIndex]);

  const currentStepOutput =
    showProgressiveConsole && selected?.output?.trim() ? selected.output : undefined;

  const statusNote = hideResult
    ? copy.predictFirstNote
    : liveRun && !liveRun.ok
      ? liveRun.timedOut
        ? execCopy.liveTimedOutNote
        : fillExecCopy(execCopy.liveErrorNote, { ms: liveRun.durationMs })
      : showProgressiveConsole
        ? !atFinalStep
          ? fillExecCopy(execCopy.steppingStatusNote, {
              current: safeIndex + 1,
              total: totalSteps,
            })
          : liveRun?.ok
            ? fillExecCopy(execCopy.liveExecutedNote, { ms: liveRun.durationMs })
            : fillExecCopy(execCopy.tracedExecutedNote, { total: totalSteps })
        : liveRun?.ok
          ? fillExecCopy(execCopy.liveExecutedNote, { ms: liveRun.durationMs })
          : copy.derivedNotExecutedNote;

  const resultStateClass = hideResult
    ? " practical-predicting"
    : liveRun && !liveRun.ok
      ? " practical-live-error"
      : showProgressiveConsole
        ? atFinalStep && liveRun?.ok
          ? " practical-live-ok"
          : " practical-traced"
        : liveRun?.ok
          ? " practical-live-ok"
          : "";

  const playButtonLabel = running
    ? execCopy.runningAction
    : playing
      ? execCopy.stopTraceAction
      : traceActive && atFinalStep && totalSteps > 1
        ? execCopy.replayTraceAction
        : execCopy.traceAction;

  return (
    <section className="practical-example" aria-labelledby={`${id}-title`}>
      <header className="practical-example-header">
        <span className="practical-example-icon" aria-hidden="true">
          <Braces size={20} aria-hidden="true" />
        </span>
        <div>
          <span className="practical-example-eyebrow">{copy.eyebrow}</span>
          <h4 id={`${id}-title`}>{annotated(example.title, "example-title")}</h4>
        </div>
      </header>

      <div className="practical-example-scenario">
        <strong>{copy.scenarioLabel}</strong>
        <p>{annotated(example.scenario, "example-scenario")}</p>
      </div>
      <p className="practical-example-environment">
        <Monitor size={14} aria-hidden="true" />
        <span>
          <strong>{copy.environmentLabel}</strong>{" "}
          {annotated(example.environment, "example-environment")}
        </span>
      </p>

      {stepExecutable && (
        <div className="practical-debugger-bar" role="toolbar" aria-label={execCopy.toolbarAria}>
          <div className="practical-debugger-actions">
            <button
              type="button"
              className="practical-run-btn"
              onClick={() => void handlePlayTrace()}
              disabled={running}
            >
              {running ? (
                <LoaderCircle size={14} className="practical-spin" aria-hidden="true" />
              ) : playing ? (
                <Pause size={13} aria-hidden="true" />
              ) : (
                <Play size={13} aria-hidden="true" />
              )}
              <span>{playButtonLabel}</span>
            </button>

            {!editing && (
              <button
                type="button"
                className="practical-tool-btn"
                onClick={() => void handleStepOnce()}
                disabled={running}
              >
                <StepForward size={13} aria-hidden="true" />
                <span>{execCopy.nextStepAction}</span>
              </button>
            )}

            <button
              type="button"
              className="practical-tool-btn"
              onClick={() => void handleRunToEnd()}
              disabled={running}
            >
              <FastForward size={13} aria-hidden="true" />
              <span>{execCopy.runAction}</span>
            </button>

            {runnable && (
              <button
                type="button"
                className={`practical-tool-btn${editing ? " is-active" : ""}`}
                onClick={() => {
                  stopPlay();
                  setEditing((prev) => !prev);
                }}
                aria-pressed={editing}
              >
                <PencilLine size={13} aria-hidden="true" />
                <span>{editing ? execCopy.doneEditAction : execCopy.editAction}</span>
              </button>
            )}

            {isDirty && (
              <button
                type="button"
                className="practical-tool-btn"
                onClick={handleResetCode}
              >
                <RotateCcw size={13} aria-hidden="true" />
                <span>{execCopy.resetCodeAction}</span>
              </button>
            )}

            {isDirty && !editing && (
              <span className="practical-dirty-pill">{execCopy.editedBadge}</span>
            )}
          </div>

          {!editing && totalSteps > 1 && (
            <div className="practical-stepper">
              <button
                type="button"
                className="practical-stepper-btn"
                aria-label={execCopy.prevBreakpointAria}
                disabled={safeIndex <= 0}
                onClick={() => selectStep(safeIndex - 1, traceActive)}
              >
                <ChevronLeft size={14} aria-hidden="true" />
              </button>
              <span className="practical-stepper-pos">
                {fillExecCopy(execCopy.breakpointProgress, {
                  current: safeIndex + 1,
                  total: totalSteps,
                })}
              </span>
              <button
                type="button"
                className="practical-stepper-btn"
                aria-label={execCopy.nextBreakpointAria}
                disabled={safeIndex >= lastIndex}
                onClick={() => {
                  const nextIdx = safeIndex + 1;
                  if (nextIdx === lastIndex && hideLastStep) setLastStepShown(true);
                  selectStep(nextIdx, traceActive);
                }}
              >
                <ChevronRight size={14} aria-hidden="true" />
              </button>
            </div>
          )}
        </div>
      )}

      <div className={`practical-workbench${editing ? " is-editing" : ""}`}>
        <div id={`${id}-code`} className="practical-example-code">
          <div className="practical-code-caption">
            <span>{copy.codeCaption}</span>
            <span aria-live="polite" aria-atomic="true">
              {selected &&
                (!isDirty || useLiveRuntimeSteps) &&
                formatPracticalCurrentFocus(lineLabel(selected.startLine, selected.endLine))}
            </span>
          </div>
          {editing ? (
            <div className="practical-editor-shell">
              <textarea
                className="practical-code-editor"
                value={draftCode}
                onChange={(event) => {
                  setDraftCode(event.target.value);
                  setLiveRun(null);
                  setTraceActive(false);
                }}
                onKeyDown={handleEditorKeyDown}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                rows={Math.min(22, Math.max(6, draftCode.split("\n").length + 1))}
                aria-label={execCopy.editorAria}
              />
              <p className="practical-editor-hint">{execCopy.editHint}</p>
            </div>
          ) : (
            <CodeBlock
              code={draftCode}
              language={language}
              highlightRange={isDirty && !useLiveRuntimeSteps ? undefined : selected}
              breakpoints={isDirty && !useLiveRuntimeSteps ? undefined : breakpointLines}
              activeBreakpointLine={
                stepExecutable && (!isDirty || useLiveRuntimeSteps)
                  ? selected?.startLine
                  : undefined
              }
              onLineClick={isDirty && !useLiveRuntimeSteps ? undefined : handleLineClick}
              annotationSource={
                !isDirty && annotationSectionId ? `${annotationSectionId}:code` : undefined
              }
            />
          )}
        </div>

        <div className="practical-example-walkthrough">
          <h5>
            <CornerDownRight size={16} aria-hidden="true" />
            {useLiveRuntimeSteps ? execCopy.liveTraceHeading : copy.walkthroughHeading}
          </h5>
          <p className="practical-example-hint">
            {useLiveRuntimeSteps ? execCopy.liveTraceHint : copy.walkthroughHint}
          </p>
          <ol ref={listRef} aria-label={copy.walkthroughListAria}>
            {effectiveSteps.map((step, index) => {
              const stepLines = lineLabel(step.startLine, step.endLine);
              const isSelected = safeIndex === index;
              const isVisited = showProgressiveConsole && index < safeIndex;
              const isFuture = showProgressiveConsole && index > safeIndex;
              const concealed = hideLastStep && index === lastIndex;
              const stepClass = [
                "practical-step",
                isSelected ? "selected" : "",
                isVisited ? "is-visited" : "",
                isFuture ? "is-future" : "",
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <li key={`${step.startLine}-${step.endLine}-${index}`}>
                  <div
                    ref={(el) => {
                      stepRefs.current[index] = el;
                    }}
                    className={stepClass}
                    onClick={() => {
                      if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
                      selectStep(index);
                    }}
                  >
                    <button
                      type="button"
                      className="practical-step-number"
                      onClick={(event) => {
                        event.stopPropagation();
                        selectStep(index);
                      }}
                      aria-label={formatPracticalStepButtonAria(index + 1, stepLines)}
                      aria-pressed={isSelected}
                      aria-controls={`${id}-code`}
                    >
                      {index + 1}
                    </button>
                    <span className="practical-step-content">
                      <span className="practical-step-meta">
                        <span className="practical-step-lines">{stepLines}</span>
                        {showProgressiveConsole && isSelected && step.output && (
                          <span className="practical-step-emit-pill">
                            {execCopy.emittedNowBadge}
                          </span>
                        )}
                      </span>
                      {concealed ? (
                        <span className="practical-step-explanation practical-step-hidden">
                          {copy.lastStepPrompt}
                          <button
                            type="button"
                            className="practical-reveal-inline"
                            onClick={(event) => {
                              event.stopPropagation();
                              setLastStepShown(true);
                              selectStep(index);
                            }}
                          >
                            <Eye size={13} aria-hidden="true" />
                            {copy.revealStepAction}
                          </button>
                        </span>
                      ) : (
                        <>
                          <span className="practical-step-explanation">
                            {step.isLiveRuntime
                              ? step.explanation
                              : annotated(step.explanation, `example-walkthrough:${index}`)}
                          </span>
                          {step.state && (
                            <span className="practical-step-watch">
                              <b>{execCopy.watchLabel}</b>
                              <code>{step.state}</code>
                            </span>
                          )}
                        </>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <div className={`practical-example-result${resultStateClass}`}>
        <div className="practical-result-heading">
          <h5>
            <CheckCheck size={16} aria-hidden="true" />
            {copy.expectedResultHeading}
          </h5>
          <span>{statusNote}</span>
        </div>
        {hideResult ? (
          <div className="practical-guess">
            <label htmlFor={`${id}-guess`}>{copy.guessLabel}</label>
            <textarea
              id={`${id}-guess`}
              value={guess}
              onChange={(event) => setGuess(event.target.value)}
              rows={3}
              maxLength={2000}
              placeholder={copy.guessPlaceholder}
            />
            <button
              type="button"
              className="practical-reveal"
              onClick={() => setResultShown(true)}
            >
              <Eye size={14} aria-hidden="true" />
              {copy.revealResultAction}
            </button>
          </div>
        ) : (
          <>
            {predict && guess.trim() && (
              <div className="practical-your-guess">
                <span>{copy.yourGuessLabel}</span>
                <p>{guess}</p>
              </div>
            )}

            {showProgressiveConsole && totalSteps > 1 && (
              <div className="practical-output-progress">
                {effectiveSteps.map((step, idx) => {
                  const state =
                    idx < safeIndex ? "is-done" : idx === safeIndex ? "is-current" : "is-upcoming";
                  return (
                    <button
                      key={idx}
                      type="button"
                      className={`practical-progress-seg ${state}${step.output ? " has-out" : ""}`}
                      aria-label={fillExecCopy(execCopy.breakpointProgress, {
                        current: idx + 1,
                        total: totalSteps,
                      })}
                      onClick={() => selectStep(idx, true)}
                    />
                  );
                })}
              </div>
            )}

            <pre tabIndex={0} aria-label={copy.expectedResultAria}>
              {liveRun && !liveRun.ok ? (
                liveRun.outputText || execCopy.emptyOutputPlaceholder
              ) : showProgressiveConsole ? (
                pastOutputs.length === 0 && !currentStepOutput ? (
                  atFinalStep ? (
                    liveRun?.outputText || execCopy.emptyOutputPlaceholder
                  ) : (
                    <span className="practical-out-pending">
                      {fillExecCopy(execCopy.pendingStepOutputNote, {
                        current: safeIndex + 1,
                        total: totalSteps,
                      })}
                    </span>
                  )
                ) : (
                  <>
                    {pastOutputs.length > 0 && (
                      <span className="practical-out-past">
                        {pastOutputs.join("\n")}
                        {currentStepOutput ? "\n" : ""}
                      </span>
                    )}
                    {currentStepOutput && (
                      <span className="practical-out-now">{currentStepOutput}</span>
                    )}
                    {!currentStepOutput && !atFinalStep && (
                      <span className="practical-out-idle-note">
                        {"\n"}
                        {execCopy.noNewOutputOnStepHint}
                      </span>
                    )}
                  </>
                )
              ) : liveRun ? (
                liveRun.outputText || execCopy.emptyOutputPlaceholder
              ) : (
                annotated(example.expectedOutput, "example-output")
              )}
            </pre>
          </>
        )}
      </div>

      <div className="practical-example-application">
        <Lightbulb size={17} aria-hidden="true" />
        <div>
          <h5>{copy.applicationHeading}</h5>
          <ProseBlocks
            text={example.application}
            renderLine={(line) => annotated(line, "example-application")}
          />
        </div>
      </div>
    </section>
  );
}
