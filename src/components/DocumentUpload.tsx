import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDownToLine, Check, CircleHelp, FileText, Images, LoaderCircle, LockKeyhole, RefreshCw, ScanText, Upload, X } from "lucide-react";
import { DOCUMENT_ACCEPT, DOCUMENT_MAX_BYTES, DOCUMENT_MAX_MB, DOCUMENT_MAX_READING_PAGES, DOCUMENT_MAX_SLIDES, DOCUMENT_MAX_UNITS, DOCUMENT_MAX_VISUAL_PAGES, DOCUMENT_READING_BATCH, type DocumentMetadata, type DocumentPreview, type DocumentRange } from "../../shared/documents";
import type { Source } from "../../shared/types";
import { api, ApiError } from "../lib/api";
import "./document-upload.css";

/** What the composer sends with a document lesson; `error` blocks submission. */
export interface DocumentLessonChoice { range?: DocumentRange; visual: boolean; password?: string; error?: string; }

const unitNames = { page: "頁", slide: "張投影片", section: "段" };
const sizeLabel = (size: number) => size < 1024 * 1024
  ? `${Math.max(1, Math.round(size / 1024))} KB`
  : `${(size / (1024 * 1024)).toFixed(1)} MB`;

function FileSummary({ value }: { value: DocumentMetadata }) {
  return <div className="document-file-summary">
    <span className="document-file-icon"><FileText size={23} /></span>
    <div><strong>{value.name}</strong><span>{value.format.toUpperCase()} · {sizeLabel(value.size)} · 已擷取 {value.parsedUnits} / {value.totalUnits} {unitNames[value.unitLabel]} · {value.extractedChars.toLocaleString()} 字元</span></div>
  </div>;
}

/**
 * Deep reading: the model reads a PDF's figure, formula and scanned pages once,
 * and its transcription is kept with the file for every later lesson.
 */
function DeepReading({ value, range, visual, reading, password, onDeepRead, onStopReading }: {
  value: DocumentPreview;
  range: { range?: DocumentRange; error?: string };
  visual: boolean;
  reading?: { id: string; message: string };
  password?: string;
  onDeepRead?: (options: { range?: DocumentRange; password?: string }) => void;
  onStopReading?: (id: string) => void;
}) {
  const inRange = (page: number) => !range.range || (page >= range.range.start && page <= range.range.end);
  const read = new Set(value.readUnits.filter(inRange));
  const known = value.visualUnits !== undefined;
  const candidates = [...new Set([...value.imageOnlyUnits, ...(value.visualUnits || [])])].filter(inRange);
  const pending = candidates.filter(page => !read.has(page));
  const batch = Math.min(pending.length, DOCUMENT_MAX_READING_PAGES);
  const where = range.range ? "所選範圍" : "這份 PDF ";
  const locked = value.encrypted && !password;
  return <div className="document-reading">
    <span><b><ScanText size={14} />深度解析圖表與公式</b><small>
      {known ? `${where}有 ${candidates.length} 頁含圖表、公式或掃描內容，已解析 ${read.size} 頁。` : "會先找出含圖表、公式或掃描內容的頁面。"}
      模型逐頁閱讀這些頁面一次，把文字、公式與圖表說明存在檔案裡；之後的解說與依問題選頁都會用到，不必每次附影像。
      {visual && pending.length > DOCUMENT_MAX_VISUAL_PAGES ? ` 解說時每次最多附 ${DOCUMENT_MAX_VISUAL_PAGES} 頁影像，其餘未解析的頁面只依文字層。` : ""}
      {pending.length > DOCUMENT_MAX_READING_PAGES ? ` 一次最多解析 ${DOCUMENT_MAX_READING_PAGES} 頁，剩下的可再按一次。` : ""}
    </small></span>
    {reading ? (
      <div className="document-reading-progress" role="status">
        <LoaderCircle size={14} className="spin" /><span>{reading.message}</span>
        {onStopReading && !reading.id.startsWith("pending:") && <button type="button" className="text-button" onClick={() => onStopReading(reading.id)}>停止</button>}
      </div>
    ) : (
      <div className="document-reading-actions">
        <button type="button" className="text-button" onClick={() => onDeepRead?.({ range: range.range, password })}
          disabled={!onDeepRead || !!range.error || locked || (known && !pending.length)} title="會呼叫目前選取的模型">
          {known && !candidates.length ? "沒有需要深度解析的頁面" : known && !pending.length ? "已全部解析" : known ? `深度解析 ${batch} 頁（約 ${Math.ceil(batch / DOCUMENT_READING_BATCH)} 次模型呼叫）` : "深度解析"}
        </button>
        {!onDeepRead && <small>連接 Codex、Claude Code 或支援影像輸入的 AI API 後可使用。</small>}
        {onDeepRead && locked && <small>請先在下方輸入 PDF 密碼。</small>}
      </div>
    )}
  </div>;
}

export default function DocumentUpload({ value, onChange, onUploading, question, onQuestionChange, onChoiceChange, disabled, reading, onDeepRead, onStopReading }: {
  value?: DocumentPreview;
  onChange: (value: DocumentPreview | undefined) => void;
  onUploading: (uploading: boolean) => void;
  question: string;
  onQuestionChange: (question: string) => void;
  onChoiceChange: (choice: DocumentLessonChoice) => void;
  disabled: boolean;
  /** A deep reading of this file in progress (on any tab or device). */
  reading?: { id: string; message: string };
  /** Starts a deep reading; absent while no model is connected. */
  onDeepRead?: (options: { range?: DocumentRange; password?: string }) => void;
  onStopReading?: (id: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const operation = useRef<AbortController | null>(null);
  const onUploadingRef = useRef(onUploading);
  onUploadingRef.current = onUploading;
  const [uploading, setUploading] = useState(false);
  const [file, setFile] = useState<File>();
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  // A locked PDF waits here for its password; the password is kept only in memory.
  const [locked, setLocked] = useState<{ file: File; retry: boolean }>();
  const [passwordInput, setPasswordInput] = useState("");
  const [password, setPassword] = useState<string>();
  const [scope, setScope] = useState<"all" | "range" | "chapter">("all");
  const [start, setStart] = useState("1");
  const [end, setEnd] = useState("1");
  const [chapter, setChapter] = useState(0);
  const [visual, setVisual] = useState(true);
  const [choiceError, setChoiceError] = useState<string>();
  const choiceRef = useRef(onChoiceChange);
  choiceRef.current = onChoiceChange;
  const unit = value ? unitNames[value.unitLabel] : "頁";
  const isPdf = value?.format === "pdf";
  const outline = value?.outline || [];
  const imageOnly = value?.imageOnlyUnits || [];
  /** The pages chosen in the scope controls, or an error explaining why the range is invalid. */
  const chosenRange = (): { range?: DocumentRange; error?: string } => {
    if (!value) return {};
    if (scope === "range") {
      const from = Number(start), to = Number(end);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > value.parsedUnits || from > to)
        return { error: `請輸入第 1–${value.parsedUnits} ${unit}之間的範圍，起點不能大於終點。` };
      return { range: { start: from, end: to } };
    }
    if (scope === "chapter" && outline[chapter]) return { range: { start: outline[chapter].start, end: Math.min(outline[chapter].end, value.parsedUnits) } };
    return {};
  };
  // Report the lesson choice whenever the document or its controls change.
  useEffect(() => {
    if (!value) { choiceRef.current({ visual: false }); return; }
    const chosen = chosenRange();
    const range = chosen.range;
    let error = chosen.error;
    const from = range?.start ?? 1, to = range?.end ?? value.parsedUnits;
    const scans = imageOnly.filter(page => page >= from && page <= to).length;
    if (!error && isPdf && !visual && scans === to - from + 1) error = "所選範圍都是沒有文字層的頁面，請開啟「附上頁面影像」或選擇其他範圍。";
    if (!error && isPdf && value.encrypted && visual && !password && scans === to - from + 1) error = "所選範圍都是沒有文字層的頁面，請輸入 PDF 密碼以附上頁面影像。";
    setChoiceError(error);
    choiceRef.current({ range, visual: isPdf && visual, password, error });
  }, [value, scope, start, end, chapter, visual, password]);

  useEffect(() => () => {
    operation.current?.abort();
    operation.current = null;
    onUploadingRef.current(false);
  }, []);

  const cancel = () => {
    operation.current?.abort();
    operation.current = null;
    setUploading(false);
    onUploading(false);
    setError("");
    setFile(undefined);
    setLocked(undefined);
  };
  const upload = async (chosen: File, unlockWith?: string) => {
    if (disabled) return;
    const extension = chosen.name.split(".").pop()?.toLowerCase();
    if (!extension || !["pdf", "docx", "pptx", "txt", "md"].includes(extension)) {
      setError("請選擇 PDF、DOCX、PPTX、TXT 或 Markdown 檔案。");
      return;
    }
    if (chosen.size === 0 || chosen.size > DOCUMENT_MAX_BYTES) {
      setError(chosen.size === 0 ? "這份檔案是空的，請選擇有內容的檔案。" : `檔案超過 ${DOCUMENT_MAX_MB} MB，請先分成較小的章節再上傳。`);
      return;
    }
    operation.current?.abort();
    const run = new AbortController();
    operation.current = run;
    setFile(chosen);
    setUploading(true);
    onUploading(true);
    setError("");
    setLocked(undefined);
    const previousId = value?.id;
    onChange(undefined);
    if (previousId) void api.removeDocument(previousId).catch(() => {});
    try {
      const parsed = await api.uploadDocument(chosen, run.signal, unlockWith);
      if (run.signal.aborted || operation.current !== run) {
        void api.removeDocument(parsed.id).catch(() => {});
        return;
      }
      // A new document starts with the whole file, page images on and no stale password.
      setScope("all"); setStart("1"); setEnd(String(parsed.parsedUnits)); setChapter(0); setVisual(true);
      setPassword(unlockWith);
      onChange(parsed);
    } catch (cause) {
      if (run.signal.aborted || operation.current !== run) return;
      if (cause instanceof ApiError && cause.status === 423) setLocked({ file: chosen, retry: !!unlockWith });
      else setError(cause instanceof Error ? cause.message : "無法讀取檔案，請重新嘗試。");
    } finally {
      if (operation.current === run) {
        operation.current = null;
        setUploading(false);
        onUploading(false);
      }
    }
  };
  const choose = (files: FileList | null) => {
    if (!files?.length || disabled) return;
    if (files.length !== 1) {
      setError("一次解釋一份檔案，請先選擇其中一份。");
      return;
    }
    void upload(files[0]);
  };
  const remove = () => {
    if (disabled) return;
    cancel();
    if (value) void api.removeDocument(value.id).catch(() => {});
    setPassword(undefined);
    onChange(undefined);
  };
  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    if (!locked || !passwordInput) return;
    const secret = passwordInput;
    setPasswordInput("");
    void upload(locked.file, secret);
  };
  return <div className="document-composer">
    <input ref={input} className="document-native-input" type="file" tabIndex={-1} accept={DOCUMENT_ACCEPT} aria-label="選擇要解釋的檔案" disabled={disabled || uploading}
      onChange={(event) => { choose(event.target.files); event.target.value = ""; }} />
    {uploading ? <div className="document-upload-progress" role="status" aria-live="polite">
      <LoaderCircle className="spin" size={27} />
      <div><strong>正在上傳與擷取文字</strong><span>{file?.name}</span><small>讀取頁面與章節，保留可回查的來源位置。</small></div>
      <button className="text-button" onClick={cancel}><X size={14} />取消</button>
    </div> : value ? <div className="document-ready">
      <div className="document-ready-header"><FileSummary value={value} /><button className="icon-button" onClick={remove} disabled={disabled} aria-label="移除已上傳的檔案" title="移除檔案"><X size={16} /></button></div>
      <div className="document-ready-status"><span><Check size={14} />文字已準備好</span><button className="text-button" onClick={() => input.current?.click()} disabled={disabled}><RefreshCw size={13} />更換檔案</button></div>
      {!!value.warnings.length && <div className="document-warnings" role="status"><CircleHelp size={16} /><ul>{value.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
      <fieldset className="document-scope" disabled={disabled}>
        <legend>解說範圍</legend>
        <div className="document-scope-options" role="radiogroup" aria-label="解說範圍">
          <label><input type="radio" name="document-scope" checked={scope === "all"} onChange={() => setScope("all")} />整份文件<small>依提問挑選重點</small></label>
          <label><input type="radio" name="document-scope" checked={scope === "range"} onChange={() => setScope("range")} />指定{unit === "頁" ? "頁碼" : "範圍"}</label>
          {!!outline.length && <label><input type="radio" name="document-scope" checked={scope === "chapter"} onChange={() => setScope("chapter")} />選擇章節<small>{outline.length} 個書籤</small></label>}
        </div>
        {scope === "range" && <div className="document-range">
          <span>第</span><input inputMode="numeric" value={start} onChange={event => setStart(event.target.value.replace(/\D/g, "").slice(0, 5))} aria-label={`起始${unit}`} />
          <span>–</span><input inputMode="numeric" value={end} onChange={event => setEnd(event.target.value.replace(/\D/g, "").slice(0, 5))} aria-label={`結束${unit}`} />
          <span>{unit}，共 {value.parsedUnits} {unit}</span>
        </div>}
        {choiceError && <p className="document-scope-error" role="alert">{choiceError}</p>}
        {scope === "chapter" && !!outline.length && <select className="document-chapter" value={chapter} onChange={event => setChapter(Number(event.target.value))} aria-label="選擇章節">
          {outline.map((entry, index) => <option key={index} value={index}>{"　".repeat(entry.depth)}{entry.title} · 第 {entry.start}{entry.end > entry.start ? `–${entry.end}` : ""} 頁</option>)}
        </select>}
      </fieldset>
      {isPdf && <label className="document-visual">
        <input type="checkbox" checked={visual} onChange={event => setVisual(event.target.checked)} disabled={disabled} />
        <span><b><Images size={14} />附上頁面影像</b><small>把範圍內的掃描頁與含圖表的頁面轉成影像給模型看（每次最多 {DOCUMENT_MAX_VISUAL_PAGES} 頁），會增加用量與等待時間；Codex、Claude Code 與 Antigravity 可用。{imageOnly.length ? `這份 PDF 有 ${imageOnly.length} 頁沒有文字層。` : ""}</small></span>
      </label>}
      {isPdf && <DeepReading value={value} range={chosenRange()} visual={visual} reading={reading} password={password}
        onDeepRead={onDeepRead} onStopReading={onStopReading} />}
      {/* A note reopened for a follow-up comes back without the password, which is never stored. */}
      {isPdf && value.encrypted && (visual || onDeepRead) && <label className="document-password">
        <span><LockKeyhole size={13} />PDF 密碼<small>附上頁面影像與深度解析需要密碼；只用於這次讀取，不會儲存。</small></span>
        <input type="password" value={password || ""} onChange={event => setPassword(event.target.value || undefined)} maxLength={256} autoComplete="off" aria-label="PDF 密碼" disabled={disabled} />
      </label>}
      <details className="document-preview"><summary>預覽擷取文字 <span>開頭節錄 · {value.preview.length.toLocaleString()} 字元</span></summary><pre tabIndex={0} aria-label="擷取文字預覽">{value.preview}</pre></details>
    </div> : locked ? <form className="document-locked" onSubmit={submitPassword}>
      <span className="document-drop-icon"><LockKeyhole size={23} strokeWidth={1.6} /></span>
      <div><strong>{locked.retry ? "密碼不正確，請再試一次" : "這份 PDF 有密碼保護"}</strong><p>{locked.file.name}</p><small>密碼只用於讀取與這次解說，不會儲存；之後檢視原檔時會再詢問。</small></div>
      <input type="password" value={passwordInput} onChange={event => setPasswordInput(event.target.value)} maxLength={256} autoFocus autoComplete="off" aria-label="PDF 密碼" disabled={disabled} />
      <div className="document-locked-actions"><button type="button" className="text-button" onClick={cancel}><X size={13} />取消</button><button className="document-choose" disabled={disabled || !passwordInput}>開啟 PDF</button></div>
    </form> : <div className={`document-dropzone${dragging ? " is-dragging" : ""}${disabled ? " is-disabled" : ""}`}
      onDragEnter={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? "none" : "copy"; }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files); }}>
      <span className="document-drop-icon"><Upload size={25} strokeWidth={1.6} /></span>
      <div><strong>把講義、規格書或技術文件放進來</strong><p>拖曳檔案至此，或選擇電腦中的檔案。</p></div>
      <button className="document-choose" onClick={() => input.current?.click()} disabled={disabled}>選擇檔案 <Upload size={14} /></button>
      <small>PDF、Word、PowerPoint、TXT、Markdown · 每份上限 {DOCUMENT_MAX_MB} MB</small>
    </div>}
    {error && <div className="document-upload-error" role="alert"><CircleHelp size={16} /><span>{error}</span>{file && !uploading && <button onClick={() => void upload(file)} disabled={disabled}><RefreshCw size={13} />重試</button>}</div>}
    <label className="document-question"><span>這份文件，你想先看懂什麼？<small>選填</small></span><textarea value={question} onChange={(event) => onQuestionChange(event.target.value)} maxLength={4000} disabled={disabled} rows={2} placeholder="例如：用白話解釋整體架構，搭配一個小案例；或整理規格中的必要條件與例外情況。" /></label>
    <p className="document-reading-note">PDF 最多解析 {DOCUMENT_MAX_UNITS} 頁、簡報 {DOCUMENT_MAX_SLIDES} 張。可指定頁碼或章節；長範圍會依你的問題選取相關段落，並標示解說範圍。掃描頁與圖表可附上頁面影像讓模型閱讀。</p>
  </div>;
}

export function DocumentOriginal({ source }: { source: Source }) {
  const value = source.document;
  const [availability, setAvailability] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  useEffect(() => {
    if (!value) return;
    const run = new AbortController();
    setAvailability("loading");
    setError("");
    void api.document(value.id, run.signal).then((document) => {
      if (!run.signal.aborted) setAvailability(document ? "ready" : "missing");
    }).catch(() => { if (!run.signal.aborted) setAvailability("error"); });
    return () => run.abort();
  }, [value?.id, attempt]);
  if (!value) return <pre className="document-original-text">{source.content}</pre>;
  return <div className="document-original">
    <FileSummary value={value} />
    <p className="document-original-scope">{source.scope}</p>
    {!!value.warnings.length && <div className="document-warnings"><CircleHelp size={16} /><ul>{value.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
    <div className="document-original-actions">
      {availability === "loading" ? <span><LoaderCircle size={14} className="spin" />確認原始檔案中…</span> : availability === "ready" ? <button className="document-choose" disabled={downloading} onClick={async () => {
        setDownloading(true); setError("");
        try { await api.downloadDocument(value.id, value.name); }
        catch (cause) { setError(cause instanceof Error ? cause.message : "下載失敗，請稍後再試。"); }
        finally { setDownloading(false); }
      }}>{downloading ? <LoaderCircle size={14} className="spin" /> : <ArrowDownToLine size={14} />}下載原始檔案</button>
        : availability === "missing" ? <p>這台伺服器沒有原始檔案。同步筆記會保留解說與擷取文字，原始附件保存在上傳時的伺服器。</p>
          : <><p>暫時無法確認原始檔案。</p><button className="text-button" onClick={() => setAttempt((current) => current + 1)}>重新確認 <RefreshCw size={13} /></button></>}
    </div>
    {error && <p className="document-upload-error" role="alert">{error}</p>}
    <div className="document-text-heading"><h3>本次解說參考的文字</h3><span>{value.selectedUnits.length} {unitNames[value.unitLabel]}</span></div>
    <pre className="document-original-text" tabIndex={0} aria-label="本次解說的文件來源文字">{source.content}</pre>
  </div>;
}
