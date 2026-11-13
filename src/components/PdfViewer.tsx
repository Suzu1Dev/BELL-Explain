import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDownToLine, ChevronLeft, ChevronRight, LoaderCircle, LockKeyhole, Minus, MoveHorizontal, Plus, RefreshCw } from "lucide-react";
import { GlobalWorkerOptions, PasswordResponses, TextLayer, getDocument, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { api } from "../lib/api";
import { pdfViewerCopy, pdfViewerDocumentAria, pdfViewerPageAria } from "../copy/pdf-viewer";
import "./pdf-viewer.css";

GlobalWorkerOptions.workerSrc = workerUrl;

/** A page to scroll to; a new key repeats the jump even for the same page. */
export interface PdfTarget { page: number; key: number; }
interface Size { width: number; height: number; }
interface Painted { scale: number; task?: RenderTask; text?: TextLayer; }
const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3];

export default function PdfViewer({ documentId, fileName, target, highlightPages = [], onPageChange }: {
  documentId: string;
  fileName: string;
  target?: PdfTarget;
  /** Pages cited by the section being read; they get a visible marker. */
  highlightPages?: number[];
  onPageChange?: (page: number) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<number, HTMLDivElement>());
  const pdf = useRef<PDFDocumentProxy | null>(null);
  const sizes = useRef(new Map<number, Size>());
  const painted = useRef(new Map<number, Painted>());
  const [status, setStatus] = useState<"loading" | "password" | "ready" | "missing" | "error">("loading");
  const [pages, setPages] = useState(0);
  const [base, setBase] = useState<Size>({ width: 612, height: 792 });
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [unlock, setUnlock] = useState<{ retry: boolean; submit: (password: string) => void }>();
  const [password, setPassword] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [, setLayout] = useState(0);
  const [downloading, setDownloading] = useState(false);
  // Zoom 1 fits the page width; the 32 px leaves room for the page gutter.
  const scale = width ? Math.max(0.1, ((width - 32) / base.width) * zoom) : 0;

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    setPages(0);
    setUnlock(undefined);
    const task = getDocument({
      url: `/api/documents/${encodeURIComponent(documentId)}/file`,
      cMapUrl: "/api/pdfjs/cmaps/", cMapPacked: true,
      standardFontDataUrl: "/api/pdfjs/standard_fonts/", wasmUrl: "/api/pdfjs/wasm/",
      enableXfa: false, disableAutoFetch: true,
    });
    // The password stays inside pdf.js for this view; it is never sent to BELL.
    task.onPassword = (submit: (password: string) => void, reason: number) => {
      if (cancelled) return;
      setUnlock({ retry: reason === PasswordResponses.INCORRECT_PASSWORD, submit });
      setStatus("password");
    };
    task.promise.then(async document => {
      const first = await document.getPage(1);
      if (cancelled) return;
      const natural = first.getViewport({ scale: 1 });
      pdf.current = document;
      sizes.current = new Map([[1, { width: natural.width, height: natural.height }]]);
      setBase({ width: natural.width, height: natural.height });
      setPages(document.numPages);
      setUnlock(undefined);
      setStatus("ready");
    }, (error: { status?: number; missing?: boolean; name?: string }) => {
      if (!cancelled) setStatus(error?.status === 404 || error?.missing || error?.name === "MissingPDFException" ? "missing" : "error");
    });
    return () => {
      cancelled = true;
      for (const entry of painted.current.values()) { entry.task?.cancel(); entry.text?.cancel(); }
      painted.current.clear();
      pdf.current = null;
      void task.destroy();
    };
  }, [documentId, attempt]);

  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Paint pages near the viewport and release far ones, so long books stay light.
  useEffect(() => {
    const root = scroller.current;
    const document = pdf.current;
    if (!root || !document || !scale || status !== "ready") return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const release = (number: number) => {
      const entry = painted.current.get(number);
      if (!entry) return;
      entry.task?.cancel();
      entry.text?.cancel();
      painted.current.delete(number);
      elements.current.get(number)?.querySelectorAll("canvas, .textLayer").forEach(node => node.remove());
    };
    const paint = async (number: number) => {
      if (painted.current.get(number)?.scale === scale) return;
      release(number);
      const entry: Painted = { scale };
      painted.current.set(number, entry);
      try {
        const page = await document.getPage(number);
        const element = elements.current.get(number);
        if (painted.current.get(number) !== entry || !element) return;
        const natural = page.getViewport({ scale: 1 });
        const known = sizes.current.get(number);
        if (!known || known.width !== natural.width || known.height !== natural.height) {
          sizes.current.set(number, { width: natural.width, height: natural.height });
          setLayout(value => value + 1);
        }
        const viewport = page.getViewport({ scale });
        const canvas = window.document.createElement("canvas");
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        canvas.setAttribute("aria-hidden", "true");
        entry.task = page.render({ canvas, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
        await entry.task.promise;
        if (painted.current.get(number) !== entry) return;
        element.querySelectorAll("canvas, .textLayer").forEach(node => node.remove());
        element.prepend(canvas);
        const layer = window.document.createElement("div");
        layer.className = "textLayer";
        layer.style.setProperty("--total-scale-factor", String(scale));
        element.append(layer);
        entry.text = new TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
        await entry.text.render();
      } catch {
        // A cancelled or failed paint is retried when the page scrolls back into view.
        if (painted.current.get(number) === entry) painted.current.delete(number);
      }
    };
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const number = Number((entry.target as HTMLElement).dataset.page);
        if (entry.isIntersecting) void paint(number);
        else release(number);
      }
    }, { root, rootMargin: "1600px 0px" });
    for (const element of elements.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [scale, pages, status]);

  // Keep the reading position when the zoom or pane width changes.
  const previousScale = useRef(0);
  useLayoutEffect(() => {
    const root = scroller.current;
    if (root && previousScale.current && scale && previousScale.current !== scale)
      root.scrollTop = root.scrollTop * (scale / previousScale.current);
    previousScale.current = scale;
  }, [scale]);

  const goTo = (page: number, smooth = true) => {
    const element = elements.current.get(Math.min(Math.max(1, page), pages));
    const root = scroller.current;
    if (!element || !root) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.scrollTo({ top: element.offsetTop - 12, behavior: smooth && !reduced ? "smooth" : "auto" });
  };
  useEffect(() => {
    if (target && status === "ready" && scale) goTo(target.page);
    // A jump waits until the layout has a scale; zoom changes alone do not jump.
  }, [target?.key, status, scale > 0]);

  useEffect(() => { setPageInput(String(current)); onPageChange?.(current); }, [current]);
  const frame = useRef(0);
  const trackPage = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const root = scroller.current;
      if (!root || !pages) return;
      const probe = root.scrollTop + root.clientHeight * 0.3;
      let low = 1, high = pages;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((elements.current.get(middle)?.offsetTop ?? Infinity) <= probe) low = middle;
        else high = middle - 1;
      }
      setCurrent(low);
    });
  };
  const submitPage = (event: FormEvent) => {
    event.preventDefault();
    const page = Number(pageInput);
    if (Number.isInteger(page) && page >= 1 && page <= pages) goTo(page, false);
    else setPageInput(String(current));
  };
  const submitPassword = (event: FormEvent) => {
    event.preventDefault();
    if (!unlock || !password) return;
    unlock.submit(password);
    setPassword("");
    setStatus("loading");
  };
  const zoomBy = (direction: 1 | -1) => setZoom(value => {
    const index = ZOOMS.findIndex(item => item >= value - 0.001);
    return ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, (index < 0 ? ZOOMS.length - 1 : index) + direction))];
  });
  const ready = status === "ready";
  const copy = pdfViewerCopy();
  const pagesId = useId();

  return <div className="pdf-viewer">
    <div className="pdf-toolbar" role="toolbar" aria-label={copy.toolbarAria}>
      <button type="button" className="pdf-tool" onClick={() => goTo(current - 1)} disabled={!ready || current <= 1} aria-label={copy.prevPage} title={copy.prevPage}><ChevronLeft size={16} aria-hidden="true" /></button>
      <form className="pdf-page-field" onSubmit={submitPage}>
        <input value={pageInput} onChange={event => setPageInput(event.target.value.replace(/\D/g, "").slice(0, 5))} onBlur={submitPage} inputMode="numeric" aria-label={copy.currentPageAria} aria-describedby={pagesId} disabled={!ready} />
        <span id={pagesId}>/ {pages || "–"}</span>
      </form>
      <button type="button" className="pdf-tool" onClick={() => goTo(current + 1)} disabled={!ready || current >= pages} aria-label={copy.nextPage} title={copy.nextPage}><ChevronRight size={16} aria-hidden="true" /></button>
      <span className="pdf-toolbar-gap" />
      <button type="button" className="pdf-tool" onClick={() => zoomBy(-1)} disabled={!ready || zoom <= ZOOMS[0]} aria-label={copy.zoomOut} title={copy.zoomOut}><Minus size={15} aria-hidden="true" /></button>
      <button type="button" className="pdf-zoom" onClick={() => setZoom(1)} disabled={!ready} aria-label={zoom === 1 ? copy.fitWidth : `${Math.round(zoom * 100)}% · ${copy.fitWidth}`} title={copy.fitWidth}>{zoom === 1 ? <><MoveHorizontal size={13} aria-hidden="true" /><span>{copy.fitWidth}</span></> : `${Math.round(zoom * 100)}%`}</button>
      <button type="button" className="pdf-tool" onClick={() => zoomBy(1)} disabled={!ready || zoom >= ZOOMS.at(-1)!} aria-label={copy.zoomIn} title={copy.zoomIn}><Plus size={15} aria-hidden="true" /></button>
      <button type="button" className="pdf-tool" disabled={downloading || status === "missing"} aria-label={copy.downloadOriginal} title={copy.downloadOriginal} onClick={async () => {
        setDownloading(true);
        try { await api.downloadDocument(documentId, fileName); } catch { /* The viewer stays usable; the reader's source tab reports download errors. */ }
        finally { setDownloading(false); }
      }}>{downloading ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <ArrowDownToLine size={15} aria-hidden="true" />}</button>
    </div>
    <div className="pdf-scroller" ref={scroller} onScroll={trackPage} tabIndex={0} role="document" aria-label={pdfViewerDocumentAria(fileName)}>
      {ready && Array.from({ length: pages }, (_, index) => {
        const number = index + 1;
        const size = sizes.current.get(number) || base;
        return <div key={number} data-page={number} ref={element => { if (element) elements.current.set(number, element); else elements.current.delete(number); }}
          className={`pdf-page${highlightPages.includes(number) ? " is-cited" : ""}`}
          style={{ width: Math.floor(size.width * scale), height: Math.floor(size.height * scale) }}
          aria-label={pdfViewerPageAria(number)}>
          <span className="pdf-page-number" aria-hidden="true">{number}</span>
        </div>;
      })}
      {status === "loading" && <div className="pdf-state" role="status"><LoaderCircle className="spin" size={22} aria-hidden="true" /><span>{copy.loading}</span></div>}
      {status === "password" && <form className="pdf-state pdf-password" onSubmit={submitPassword}>
        <LockKeyhole size={24} aria-hidden="true" />
        <strong role={unlock?.retry ? "alert" : undefined}>{unlock?.retry ? copy.passwordRetryTitle : copy.passwordTitle}</strong>
        <span>{copy.passwordPrivacyHint}</span>
        <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoFocus aria-label={copy.passwordInputAria} aria-invalid={unlock?.retry || undefined} autoComplete="off" />
        <button type="submit" className="document-choose" disabled={!password}>{copy.unlockAction}</button>
      </form>}
      {status === "missing" && <div className="pdf-state" role="status"><strong>{copy.missingTitle}</strong><span>{copy.missingBody}</span></div>}
      {status === "error" && <div className="pdf-state" role="alert"><strong>{copy.errorTitle}</strong><span>{copy.errorBody}</span><button type="button" className="text-button" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={13} aria-hidden="true" />{copy.reopenAction}</button></div>}
    </div>
  </div>;
}
