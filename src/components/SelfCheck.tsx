import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CircleHelp, CornerDownRight, Eye, LoaderCircle, RotateCcw, Sparkles } from "lucide-react";
import type { Lesson } from "../../shared/types";
import type { CheckReference, CheckVerdict, SelfCheckItem } from "../../shared/learning";
import { api, checkAnswer } from "../lib/api";
import MathText from "./MathText";
import { learningCopy } from "../copy/learning";
import "./self-check.css";

export const VERDICT_LABELS: Record<CheckVerdict, string> = {
  correct: "答對了",
  partial: "部分正確",
  incorrect: "還沒答到",
  unanswered: "直接看了答案",
};
const cleanHeading = (heading: string) => heading.replace(/^\d+\s*[/．.、：:]\s*/, "");
const attemptDate = (at: string) =>
  new Intl.DateTimeFormat("zh-TW", { month: "short", day: "numeric" }).format(new Date(at));

/**
 * Follow-up questions at the end of a note: expand, write an answer, then compare.
 * The model is called only when the learner asks it to grade; later attempts can
 * be self-assessed against the answer it already wrote.
 */
export default function SelfCheck({ lesson, configured, openSection, followUp, onRecorded }: {
  lesson: Lesson;
  /** Whether a model is connected, so grading can be offered. */
  configured: boolean;
  openSection: (sectionId: string) => void;
  followUp: (question: string) => void;
  /** An attempt was saved; a missed one may have joined today's review. */
  onRecorded?: () => void;
}) {
  const copy = learningCopy();
  const fallback = () => lesson.followUpQuestions.map((question, index) => ({ index, question }));
  const [items, setItems] = useState<SelfCheckItem[]>(fallback);
  const [loadError, setLoadError] = useState("");
  const questions = lesson.followUpQuestions.join("\n");
  useEffect(() => {
    let active = true;
    setItems(fallback());
    api.checks(lesson.id)
      .then((list) => { if (active) { setItems(list); setLoadError(""); } })
      .catch(() => { if (active) setLoadError("暫時讀不到作答紀錄，仍可以作答。"); });
    return () => { active = false; };
  }, [lesson.id, questions]);
  if (!items.length) return null;
  const showModelNote = !configured && items.some((item) => !item.reference);
  const update = (next: SelfCheckItem) => {
    setItems((current) => current.map((item) => (item.index === next.index ? next : item)));
    onRecorded?.();
  };
  return (
    <section className="followup-section self-check" aria-labelledby="self-check-title">
      <span className="followup-icon"><CircleHelp size={20} /></span>
      <h3 id="self-check-title">{copy.wrapUp.selfCheck.heading}</h3>
      <p>有想法再展開。先寫下答案，再對照講解；沒答到的題目會排進今日複習。</p>
      {loadError && <p className="self-check-note">{loadError}</p>}
      {items.map((item) => (
        <details className="self-check-details" key={`${item.index}:${item.question}`}>
          <summary><span>Q{item.index + 1}</span><MathText text={item.question} /></summary>
          <CheckCard
            lesson={lesson}
            item={item}
            configured={configured}
            onChange={update}
            openSection={openSection}
            followUp={followUp}
          />
        </details>
      ))}
      {showModelNote && <p className="self-check-note">還沒連接模型：可以先寫下答案，連接 Codex、Claude Code 或 AI API 後再對照。</p>}
    </section>
  );
}

type Shown = { reference: CheckReference; verdict?: CheckVerdict; feedback?: string };

function CheckCard({ lesson, item, configured, onChange, openSection, followUp }: {
  lesson: Lesson;
  item: SelfCheckItem;
  configured: boolean;
  onChange: (item: SelfCheckItem) => void;
  openSection: (sectionId: string) => void;
  followUp: (question: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [shown, setShown] = useState<Shown>();
  const [stage, setStage] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const blank = !answer.trim();
  const busy = Boolean(stage) || saving;

  const grade = async () => {
    if (busy) return;
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setError("");
    setStage("正在送出答案…");
    try {
      const result = await checkAnswer(lesson.id, item.index, answer, current.signal, setStage);
      const reference = { referenceAnswer: result.referenceAnswer, keyPoints: result.keyPoints, sectionIds: result.sectionIds };
      setShown({ reference, verdict: result.verdict, feedback: result.feedback });
      onChange({ ...item, reference, lastAttempt: result.attempt });
    } catch (cause) {
      if (!current.signal.aborted) setError(cause instanceof Error ? cause.message : "批改失敗，請稍後再試。");
    } finally {
      if (controller.current === current) { controller.current = null; setStage(""); }
    }
  };
  const record = async (verdict: CheckVerdict, reference: CheckReference) => {
    setSaving(true);
    setError("");
    try {
      const attempt = await api.selfCheck(lesson.id, item.index, answer, verdict);
      setShown({ reference, verdict: attempt.verdict });
      onChange({ ...item, lastAttempt: attempt });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "無法記錄這次作答，請再試一次。");
    } finally {
      setSaving(false);
    }
  };
  // With a reference already written, comparing costs nothing: the learner judges their own answer.
  const compare = () => {
    if (!item.reference) return void grade();
    if (blank) return void record("unanswered", item.reference);
    setShown({ reference: item.reference });
  };
  const again = () => {
    setShown(undefined);
    setAnswer("");
    setError("");
  };
  const sectionLinks = (shown?.reference.sectionIds || []).flatMap((id) => {
    const index = lesson.sections.findIndex((section) => section.id === id);
    return index < 0 ? [] : [{ id, label: `${index + 1} ${cleanHeading(lesson.sections[index].heading)}` }];
  });
  const canGrade = configured || Boolean(item.reference);

  return (
    <article className={`self-check-card${shown?.verdict ? ` verdict-${shown.verdict}` : ""}`}>
      {!shown ? (
        <>
          <textarea
            className="self-check-answer"
            aria-label={`Q${item.index + 1} 你的答案`}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="用自己的話寫下答案。寫不出來也沒關係，寫下卡住的地方。"
            rows={3}
            maxLength={4000}
            disabled={busy}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && canGrade) { event.preventDefault(); compare(); }
            }}
          />
          {item.lastAttempt && (
            <p className="self-check-last">
              上次：{VERDICT_LABELS[item.lastAttempt.verdict]} · {attemptDate(item.lastAttempt.at)}
              {item.lastAttempt.gradedBy === "self" ? "（自評）" : "（模型批改）"}
            </p>
          )}
          <div className="self-check-actions">
            <button
              type="button"
              className="self-check-primary"
              onClick={compare}
              disabled={busy || !canGrade}
              title={canGrade ? "⌘/Ctrl + Enter" : "連接模型後，才能請模型對照講解"}
            >
              {stage ? <LoaderCircle size={14} className="spin" /> : item.reference ? <Eye size={14} /> : <Sparkles size={14} />}
              {item.reference ? (blank ? "直接看參考答案" : "對照參考答案") : blank ? "直接看講解" : "對照講解"}
            </button>
            {item.reference && configured && !blank && (
              <button type="button" onClick={() => void grade()} disabled={busy}>請模型批改這次答案</button>
            )}
            <button type="button" className="self-check-extend" onClick={() => followUp(item.question)} disabled={busy}>
              延伸成新筆記 <ArrowUpRight size={14} />
            </button>
          </div>
          {stage && <p className="self-check-stage" role="status">{stage}</p>}
        </>
      ) : (
        <div className="self-check-result" aria-live="polite">
          {answer.trim() && (
            <div className="self-check-yours">
              <strong>你的答案</strong>
              <p>{answer}</p>
            </div>
          )}
          {shown.verdict && <span className="self-check-verdict">{VERDICT_LABELS[shown.verdict]}</span>}
          {shown.feedback && <p className="self-check-feedback"><MathText text={shown.feedback} /></p>}
          <div className="self-check-reference">
            <strong>參考答案</strong>
            <p><MathText text={shown.reference.referenceAnswer} /></p>
            {shown.reference.keyPoints.length > 0 && (
              <ul>{shown.reference.keyPoints.map((point) => <li key={point}><MathText text={point} /></li>)}</ul>
            )}
          </div>
          {sectionLinks.length > 0 && (
            <div className="self-check-sections">
              <span>回到筆記：</span>
              {sectionLinks.map((link) => (
                <button key={link.id} type="button" onClick={() => openSection(link.id)}>
                  <CornerDownRight size={13} /><MathText text={link.label} />
                </button>
              ))}
            </div>
          )}
          {!shown.verdict ? (
            <div className="self-check-assess" role="group" aria-label="對照之後的自評">
              <span>對照之後，你覺得自己：</span>
              {(["correct", "partial", "incorrect"] as const).map((verdict) => (
                <button key={verdict} type="button" onClick={() => void record(verdict, shown.reference)} disabled={saving}>
                  {VERDICT_LABELS[verdict]}
                </button>
              ))}
            </div>
          ) : (
            <div className="self-check-actions">
              <button type="button" onClick={again}><RotateCcw size={14} />再寫一次</button>
              <button type="button" className="self-check-extend" onClick={() => followUp(item.question)}>
                延伸成新筆記 <ArrowUpRight size={14} />
              </button>
            </div>
          )}
          {shown.verdict && shown.verdict !== "correct" && !lesson.isDemo && (
            <p className="self-check-note">這題已排進複習，過一陣子會再出現。</p>
          )}
        </div>
      )}
      {error && <p className="self-check-error" role="alert">{error}</p>}
    </article>
  );
}
