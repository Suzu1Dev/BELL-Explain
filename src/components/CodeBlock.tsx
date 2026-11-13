import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { AnnotatedText } from "./ReadingAnnotations";
import {
  codeBlockCopy,
  formatCodeRegionAria,
  resolveCodeRelatedNotesLocale,
} from "../copy/code-related-notes";
import { copyText } from "../lib/clipboard";
import "./practical-example.css";

export function codeTokens(line: string) {
  const parts = line.split(
    /(\/\/.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`|\b(?:const|let|var|return|function|async|await|new|if|else|class|import|from|export|default|throw|true|false|null|undefined)\b|\b\d+\b)/g,
  );
  return parts.map((part, i) => {
    const kind = part.startsWith("//")
      ? "comment"
      : /^["'`]/.test(part)
        ? "string"
        : /^(const|let|var|return|function|async|await|new|if|else|class|import|from|export|default|throw|true|false|null|undefined)$/.test(
              part,
            )
          ? "keyword"
          : /^\d+$/.test(part)
            ? "number"
            : "";
    return (
      <span key={i} className={kind ? `syntax-${kind}` : undefined}>
        {part}
      </span>
    );
  });
}

export default function CodeBlock({
  code,
  language = "javascript",
  filename,
  highlightRange,
  annotationSource,
  breakpoints,
  activeBreakpointLine,
  onLineClick,
}: {
  code: string;
  language?: string;
  filename?: string;
  highlightRange?: { startLine: number; endLine: number };
  annotationSource?: string;
  breakpoints?: ReadonlySet<number>;
  activeBreakpointLine?: number;
  onLineClick?: (lineNumber: number) => void;
}) {
  const locale = resolveCodeRelatedNotesLocale();
  const copy = codeBlockCopy(locale);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) clearTimeout(copiedTimer.current);
    },
    [],
  );

  async function handleCopy() {
    if (copiedTimer.current !== null) {
      clearTimeout(copiedTimer.current);
      copiedTimer.current = null;
    }
    setCopied(false);
    setCopyError(false);
    try {
      await copyText(code);
      setCopied(true);
      setCopyError(false);
      copiedTimer.current = setTimeout(() => {
        copiedTimer.current = null;
        setCopied(false);
      }, 2000);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  }
  return (
    <div className="code-block">
      <div className="code-header">
        <span>
          <i aria-hidden="true" />
          {filename || language || "code"}
        </span>
        <button
          type="button"
          className="icon-button"
          onClick={handleCopy}
          aria-label={copy.copyCode}
          title={copy.copyCode}
        >
          {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        </button>
      </div>
      <pre
        tabIndex={0}
        role="region"
        aria-label={formatCodeRegionAria(language, highlightRange, locale)}
      >
        <code>
          {code.split("\n").map((line, i) => {
            const lineNum = i + 1;
            const highlighted =
              highlightRange !== undefined &&
              lineNum >= highlightRange.startLine &&
              lineNum <= highlightRange.endLine;
            const hasBreakpoint = Boolean(breakpoints?.has(lineNum));
            const isActiveHead = activeBreakpointLine === lineNum;
            const lineClasses = [
              "code-line",
              highlighted ? "practical-code-highlighted" : "",
              hasBreakpoint ? "practical-code-breakpoint" : "",
              isActiveHead ? "practical-code-active-head" : "",
              onLineClick ? "practical-code-clickable" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <span
                className={lineClasses}
                key={i}
                aria-current={highlighted ? "step" : undefined}
                onClick={
                  onLineClick
                    ? () => {
                        if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
                        onLineClick(lineNum);
                      }
                    : undefined
                }
              >
                <span className="line-number" aria-hidden="true">
                  {breakpoints && <i className="bp-marker" aria-hidden="true" />}
                  {lineNum}
                </span>
                <span>{annotationSource ? <AnnotatedText text={line} sourceKey={annotationSource} renderPlain={codeTokens} /> : codeTokens(line)}</span>
              </span>
            );
          })}
        </code>
      </pre>
      {copyError && (
        <small role="status" className="copy-error">
          {copy.copyFallback}
        </small>
      )}
    </div>
  );
}
