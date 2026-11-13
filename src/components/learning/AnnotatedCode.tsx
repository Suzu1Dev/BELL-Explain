import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  Check,
  Copy,
  FastForward,
  LoaderCircle,
  Pause,
  PencilLine,
  Play,
  RotateCcw,
  StepForward,
  TextQuote,
} from "lucide-react";
import type { AnnotatedCode as AnnotatedCodeData } from "../../../shared/lesson-v3";
import { codeExecutionCopy, fillExecCopy } from "../../copy/code-execution";
import { fill, learningCopy } from "../../copy/learning";
import { copyText } from "../../lib/clipboard";
import {
  isStepExecutableAnnotatedCode,
  runCodeInSandbox,
  type SandboxRunResult,
} from "../../lib/code-runner";
import { codeTokens } from "../CodeBlock";
import FigureFrame from "./FigureFrame";
import V3Text from "./V3Text";

export default function AnnotatedCode({ figure }: { figure: AnnotatedCodeData }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [activeNote, setActiveNote] = useState<number | null>(null);
  const [draftCode, setDraftCode] = useState(figure.source);
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [liveRun, setLiveRun] = useState<SandboxRunResult | null>(null);
  const [traceIndex, setTraceIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const playTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const strings = learningCopy().figures.annotatedCode;
  const execCopy = codeExecutionCopy();
  const isDirty = draftCode !== figure.source;

  const stepExecutable = useMemo(
    () =>
      isStepExecutableAnnotatedCode({
        language: figure.language,
        source: draftCode,
        output: figure.output,
      }),
    [figure.language, draftCode, figure.output],
  );

  useEffect(() => {
    setDraftCode(figure.source);
    setEditing(false);
    setActiveNote(null);
    setLiveRun(null);
    setTraceIndex(null);
    setPlaying(false);
  }, [figure.source]);

  useEffect(
    () => () => {
      if (playTimer.current !== null) clearTimeout(playTimer.current);
    },
    [],
  );

  // Map 1-based line number to 0-based note index (first note on that line).
  const lineToNoteIndex = useMemo(() => {
    const map = new Map<number, number>();
    figure.notes.forEach((note, index) => {
      if (!map.has(note.line)) map.set(note.line, index);
    });
    return map;
  }, [figure.notes]);

  const traceEntries = liveRun?.ok ? liveRun.entries : [];
  const totalTraceSteps = traceEntries.length;

  useEffect(() => {
    if (!playing || traceIndex === null) return;
    if (traceIndex >= totalTraceSteps - 1) {
      playTimer.current = setTimeout(() => {
        setPlaying(false);
      }, 450);
      return;
    }
    playTimer.current = setTimeout(() => {
      setTraceIndex((prev) => (prev === null ? 0 : Math.min(totalTraceSteps - 1, prev + 1)));
    }, 950);
    return () => {
      if (playTimer.current !== null) clearTimeout(playTimer.current);
    };
  }, [playing, traceIndex, totalTraceSteps]);

  useEffect(() => {
    if (traceIndex === null || isDirty) return;
    const entry = traceEntries[traceIndex];
    if (entry?.line !== undefined) {
      const noteIdx = lineToNoteIndex.get(entry.line);
      setActiveNote(noteIdx ?? null);
    }
  }, [traceIndex, traceEntries, isDirty, lineToNoteIndex]);

  const stopPlay = () => {
    if (playTimer.current !== null) {
      clearTimeout(playTimer.current);
      playTimer.current = null;
    }
    setPlaying(false);
  };

  const copy = async () => {
    try {
      await copyText(draftCode);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  };

  const ensureExecuted = async (): Promise<SandboxRunResult> => {
    if (liveRun !== null) return liveRun;
    setRunning(true);
    try {
      const res = await runCodeInSandbox(draftCode, figure.language);
      setLiveRun(res);
      return res;
    } finally {
      setRunning(false);
    }
  };

  const handlePlaySteps = async () => {
    if (playing) {
      stopPlay();
      return;
    }
    setEditing(false);
    const res = await ensureExecuted();
    if (!res.ok || res.entries.length === 0) {
      setTraceIndex(null);
      return;
    }
    const last = res.entries.length - 1;
    const start = traceIndex === null || traceIndex >= last ? 0 : traceIndex;
    setTraceIndex(start);
    if (res.entries.length > 1 && start < last) {
      setPlaying(true);
    }
  };

  const handleStepOnce = async () => {
    stopPlay();
    setEditing(false);
    const res = await ensureExecuted();
    if (!res.ok || res.entries.length === 0) {
      setTraceIndex(null);
      return;
    }
    const last = res.entries.length - 1;
    setTraceIndex((prev) => (prev === null || prev >= last ? 0 : prev + 1));
  };

  const handleRunToEnd = async () => {
    stopPlay();
    setEditing(false);
    const res = await ensureExecuted();
    if (!res.ok || res.entries.length === 0) {
      setTraceIndex(null);
      return;
    }
    setTraceIndex(res.entries.length - 1);
  };

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (stepExecutable && !running) void handlePlaySteps();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const target = event.currentTarget;
      const start = target.selectionStart ?? 0;
      const end = target.selectionEnd ?? start;
      const next = `${draftCode.slice(0, start)}  ${draftCode.slice(end)}`;
      setDraftCode(next);
      setLiveRun(null);
      setTraceIndex(null);
      requestAnimationFrame(() => {
        target.selectionStart = start + 2;
        target.selectionEnd = start + 2;
      });
    }
  };

  const tracedLine =
    traceIndex !== null ? traceEntries[traceIndex]?.line : undefined;
  const activeLine =
    tracedLine ?? (activeNote !== null ? figure.notes[activeNote]?.line : undefined);

  const isSteppingMidway =
    traceIndex !== null && totalTraceSteps > 0 && traceIndex < totalTraceSteps - 1;

  const outputLabel = liveRun
    ? liveRun.timedOut
      ? execCopy.liveTimedOutNote
      : !liveRun.ok
        ? fillExecCopy(execCopy.liveErrorNote, { ms: liveRun.durationMs })
        : isSteppingMidway
          ? fillExecCopy(execCopy.steppingStatusNote, {
              current: traceIndex + 1,
              total: totalTraceSteps,
            })
          : fillExecCopy(execCopy.liveExecutedNote, { ms: liveRun.durationMs })
    : strings.outputLabel;

  const pastLines =
    traceIndex !== null && liveRun?.ok
      ? traceEntries
          .slice(0, traceIndex)
          .map((e) => (e.level === "result" ? `-> ${e.text}` : e.text))
      : [];
  const currentOutLine =
    traceIndex !== null && liveRun?.ok && traceEntries[traceIndex]
      ? traceEntries[traceIndex].level === "result"
        ? `-> ${traceEntries[traceIndex].text}`
        : traceEntries[traceIndex].text
      : undefined;

  return (
    <FigureFrame
      title={figure.file || learningCopy().figures.kinds.annotatedCode}
      icon={TextQuote}
      actions={
        <>
          {stepExecutable && (
            <>
              <button
                type="button"
                className="v3-code-run-btn"
                onClick={() => void handlePlaySteps()}
                disabled={running}
              >
                {running ? (
                  <LoaderCircle size={13} className="v3-code-spin" aria-hidden="true" />
                ) : playing ? (
                  <Pause size={12} aria-hidden="true" />
                ) : (
                  <Play size={12} aria-hidden="true" />
                )}
                <span>
                  {running
                    ? execCopy.runningAction
                    : playing
                      ? execCopy.stopTraceAction
                      : traceIndex !== null &&
                          totalTraceSteps > 1 &&
                          traceIndex >= totalTraceSteps - 1
                        ? execCopy.replayTraceAction
                        : execCopy.traceAction}
                </span>
              </button>
              {!editing && (
                <button
                  type="button"
                  className="v3-code-tool-btn"
                  onClick={() => void handleStepOnce()}
                  disabled={running}
                >
                  <StepForward size={12} aria-hidden="true" />
                  <span>{execCopy.nextStepAction}</span>
                </button>
              )}
              <button
                type="button"
                className="v3-code-tool-btn"
                onClick={() => void handleRunToEnd()}
                disabled={running}
              >
                <FastForward size={12} aria-hidden="true" />
                <span>{execCopy.runAction}</span>
              </button>
              <button
                type="button"
                className={`v3-code-tool-btn${editing ? " is-active" : ""}`}
                onClick={() => {
                  stopPlay();
                  setEditing((prev) => !prev);
                }}
                aria-pressed={editing}
              >
                <PencilLine size={12} aria-hidden="true" />
                <span>{editing ? execCopy.doneEditAction : execCopy.editAction}</span>
              </button>
              {isDirty && (
                <button
                  type="button"
                  className="v3-code-tool-btn"
                  onClick={() => {
                    stopPlay();
                    setDraftCode(figure.source);
                    setLiveRun(null);
                    setTraceIndex(null);
                  }}
                >
                  <RotateCcw size={12} aria-hidden="true" />
                  <span>{execCopy.resetCodeAction}</span>
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label={copyState === "copied" ? strings.copiedAria : strings.copyAria}
            onClick={copy}
          >
            {copyState === "copied" ? (
              <Check size={14} aria-hidden="true" />
            ) : (
              <Copy size={14} aria-hidden="true" />
            )}
          </button>
        </>
      }
    >
      <div className={`v3-code-workbench${editing ? " is-editing" : ""}`}>
        {editing ? (
          <div className="v3-code-editor-wrap">
            <textarea
              className="v3-code-editor"
              value={draftCode}
              onChange={(event) => {
                setDraftCode(event.target.value);
                setLiveRun(null);
                setTraceIndex(null);
              }}
              onKeyDown={handleEditorKeyDown}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              rows={Math.min(20, Math.max(6, draftCode.split("\n").length + 1))}
              aria-label={execCopy.editorAria}
            />
            <p className="v3-code-editor-hint">{execCopy.editHint}</p>
          </div>
        ) : (
          <div className="v3-code">
            <pre
              tabIndex={0}
              role="region"
              aria-label={fill(strings.codeRegionAria, { language: figure.language })}
            >
              <code>
                {draftCode.split("\n").map((line, index) => {
                  const number = index + 1;
                  const noteIdx = !isDirty ? lineToNoteIndex.get(number) : undefined;
                  const focused =
                    activeLine !== undefined
                      ? activeLine === number
                      : isDirty
                        ? true
                        : figure.focus.includes(number);
                  const isActivePin = activeLine === number;
                  const lineClasses = [
                    "v3-code-line",
                    focused ? "is-focused" : "is-dimmed",
                    noteIdx !== undefined ? "has-pin" : "",
                    isActivePin ? "is-active-bp" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <span
                      key={index}
                      className={lineClasses}
                      onClick={
                        noteIdx !== undefined
                          ? () => {
                              if (
                                typeof window !== "undefined" &&
                                window.getSelection()?.toString()
                              ) {
                                return;
                              }
                              stopPlay();
                              setTraceIndex(null);
                              setActiveNote((prev) => (prev === noteIdx ? null : noteIdx));
                            }
                          : undefined
                      }
                    >
                      <span className="v3-code-source">{codeTokens(line)}</span>
                      {noteIdx !== undefined && (
                        <span
                          className={`v3-pin${activeNote === noteIdx ? " is-active" : ""}`}
                          aria-label={fill(strings.notePinAria, { n: noteIdx + 1 })}
                        >
                          {noteIdx + 1}
                        </span>
                      )}
                    </span>
                  );
                })}
              </code>
            </pre>
          </div>
        )}
        <ol className="v3-code-notes">
          {figure.notes.map((note, index) => {
            const selected = activeNote === index;
            return (
              <li
                key={`${note.line}-${index}`}
                className={selected ? "v3-note-row is-selected" : "v3-note-row"}
                onClick={() => {
                  if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
                  stopPlay();
                  setTraceIndex(null);
                  setActiveNote((prev) => (prev === index ? null : index));
                }}
              >
                <span className="v3-pin" aria-hidden="true">
                  {index + 1}
                </span>
                <span className="v3-note-body">
                  <em className="v3-note-line">L{note.line}</em>
                  <V3Text text={note.text} sourceKey={`figure:code-note:${index}`} />
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      {(figure.output !== undefined || liveRun !== null) && (
        <div
          className={`v3-code-output${liveRun ? (liveRun.ok ? " is-live-ok" : " is-live-err") : ""}`}
        >
          <span>{outputLabel}</span>
          <pre>
            {liveRun ? (
              !liveRun.ok ? (
                liveRun.outputText || execCopy.emptyOutputPlaceholder
              ) : traceIndex !== null && currentOutLine !== undefined ? (
                <>
                  {pastLines.length > 0 && (
                    <span className="v3-out-past">
                      {pastLines.join("\n")}
                      {"\n"}
                    </span>
                  )}
                  <span className="v3-out-now">{currentOutLine}</span>
                </>
              ) : (
                liveRun.outputText || execCopy.emptyOutputPlaceholder
              )
            ) : (
              figure.output
            )}
          </pre>
        </div>
      )}
      {copyState === "error" && (
        <p className="v3-copy-error" role="status">
          {strings.copyManualFallback}
        </p>
      )}
    </FigureFrame>
  );
}
