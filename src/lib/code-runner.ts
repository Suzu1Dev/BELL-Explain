export interface SandboxLogEntry {
  level: "log" | "warn" | "error" | "result";
  text: string;
  atMs: number;
  line?: number;
}

export interface SandboxRunResult {
  ok: boolean;
  entries: SandboxLogEntry[];
  outputText: string;
  error?: string;
  timedOut?: boolean;
  truncated?: boolean;
  durationMs: number;
}

const RUNNABLE_LANGUAGES = new Set([
  "js",
  "javascript",
  "mjs",
  "cjs",
  "node",
  "ts",
  "typescript",
]);

export function isSandboxRunnable(language?: string): boolean {
  if (!language) return false;
  return RUNNABLE_LANGUAGES.has(language.trim().toLowerCase());
}

export function isTypeScriptLanguage(language?: string): boolean {
  if (!language) return false;
  const normalized = language.trim().toLowerCase();
  return normalized === "ts" || normalized === "typescript";
}

const CONSOLE_CALL_RE = /\bconsole\s*\.\s*(log|info|warn|error|dir)\s*\(/;

export function hasConsoleOutputCall(code: string): boolean {
  return CONSOLE_CALL_RE.test(code);
}

/**
 * Only code examples whose execution unfolds step-by-step to emit observable output
 * use the step-execution debugger and progressive output console. Static configs,
 * CLI flag lists, and structural code-reading walkthroughs stay calm and static.
 */
export function isStepExecutableExample(
  language: string | undefined,
  code: string,
  example: {
    walkthrough: ReadonlyArray<{ startLine: number; output?: string; state?: string }>;
    expectedOutput: string;
  },
): boolean {
  if (example.walkthrough.some((step) => Boolean(step.output?.trim()))) {
    return true;
  }
  return isSandboxRunnable(language) && hasConsoleOutputCall(code);
}

export function isStepExecutableAnnotatedCode(figure: {
  language: string;
  source: string;
  output?: string;
}): boolean {
  return (
    isSandboxRunnable(figure.language) &&
    (figure.output !== undefined || hasConsoleOutputCall(figure.source))
  );
}

function preserveLines(segment: string): string {
  return segment.replace(/[^\n]+/g, "");
}

function stripParamTypes(paramList: string): string {
  const parts: string[] = [];
  let depthAngle = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthBrace = 0;
  let start = 0;
  for (let i = 0; i < paramList.length; i += 1) {
    const ch = paramList[i];
    if (ch === "<") depthAngle += 1;
    else if (ch === ">" && depthAngle > 0) depthAngle -= 1;
    else if (ch === "(") depthParen += 1;
    else if (ch === ")" && depthParen > 0) depthParen -= 1;
    else if (ch === "[") depthBracket += 1;
    else if (ch === "]" && depthBracket > 0) depthBracket -= 1;
    else if (ch === "{") depthBrace += 1;
    else if (ch === "}" && depthBrace > 0) depthBrace -= 1;
    else if (
      ch === "," &&
      depthAngle === 0 &&
      depthParen === 0 &&
      depthBracket === 0 &&
      depthBrace === 0
    ) {
      parts.push(paramList.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(paramList.slice(start));

  return parts
    .map((raw) => {
      const cleaned = raw.replace(
        /^(\s*)(?:public|private|protected|readonly)\s+/,
        "$1",
      );
      // Match simple identifier or rest parameter with optional `?` and `: Type` before optional `= default`.
      return cleaned.replace(
        /^(\s*(?:\.\.\.)?[A-Za-z_$][\w$]*)\s*\??\s*:\s*([^=]+?)(\s*=[\s\S]*)?$/,
        (_m, id: string, typePart: string, def = "") =>
          `${id}${preserveLines(typePart)}${def}`,
      );
    })
    .join(",");
}

function stripInterfaceBlocks(source: string): string {
  const re = /\b(?:export\s+)?interface\s+[A-Za-z_$][\w$]*[^{]*\{/g;
  let out = "";
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    out += source.slice(cursor, match.index);
    let depth = 1;
    let i = match.index + match[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
      i += 1;
    }
    out += preserveLines(source.slice(match.index, i));
    cursor = i;
    re.lastIndex = i;
  }
  out += source.slice(cursor);
  return out;
}

function maskStringsAndComments(
  code: string,
  tokens: string[],
): string {
  const pushToken = (raw: string) => {
    const idx = tokens.push(raw) - 1;
    const newlines = raw.match(/\n/g)?.join("") ?? "";
    return `__BELL_TOK_${idx}__${newlines}`;
  };
  let out = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", i + 2);
      const stop = end === -1 ? code.length : end;
      out += pushToken(code.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      out += pushToken(code.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch && code[j] !== "\n") {
        if (code[j] === "\\") j += 1;
        j += 1;
      }
      const stop = j < code.length && code[j] === ch ? j + 1 : j;
      out += pushToken(code.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === "`") {
      // Mask literal text chunks inside template strings while leaving `${...}` expressions unmasked.
      out += "`";
      i += 1;
      let chunkStart = i;
      while (i < code.length && code[i] !== "`") {
        if (code[i] === "\\") {
          i += 2;
          continue;
        }
        if (code[i] === "$" && code[i + 1] === "{") {
          if (i > chunkStart) out += pushToken(code.slice(chunkStart, i));
          out += "${";
          i += 2;
          let braceDepth = 1;
          const exprStart = i;
          while (i < code.length && braceDepth > 0) {
            if (code[i] === "'" || code[i] === '"') {
              const q = code[i];
              i += 1;
              while (i < code.length && code[i] !== q && code[i] !== "\n") {
                if (code[i] === "\\") i += 1;
                i += 1;
              }
              if (code[i] === q) i += 1;
              continue;
            }
            if (code[i] === "{") braceDepth += 1;
            else if (code[i] === "}") braceDepth -= 1;
            if (braceDepth > 0) i += 1;
          }
          out += maskStringsAndComments(code.slice(exprStart, i), tokens);
          if (code[i] === "}") {
            out += "}";
            i += 1;
          }
          chunkStart = i;
          continue;
        }
        i += 1;
      }
      if (i > chunkStart) out += pushToken(code.slice(chunkStart, i));
      if (code[i] === "`") {
        out += "`";
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Lightweight line-preserving TypeScript type stripper for educational snippets.
 * shortcut: covers interfaces, type aliases, generics, variable/param/return annotations, and `as` casts; upgrade to bundled transpiler if decorators/enums/namespaces are needed.
 */
export function stripTypeScriptTypes(code: string): string {
  const tokens: string[] = [];
  const masked = maskStringsAndComments(code, tokens);

  let out = stripInterfaceBlocks(masked);

  // Strip `type Foo = ...;` aliases.
  out = out.replace(
    /^[ \t]*(?:export\s+)?type\s+[A-Za-z_$][\w$]*(?:<[^\n>]*>)?\s*=\s*[^;\n]+;?[ \t]*$/gm,
    "",
  );

  // Strip `export` modifiers so module-style snippets execute inside AsyncFunction.
  out = out.replace(/^[ \t]*export\s+default\s+/gm, "");
  out = out.replace(
    /^[ \t]*export\s+(?=(?:async\s+)?function\b|const\b|let\b|var\b|class\b)/gm,
    "",
  );

  // Strip `implements Foo, Bar` on classes.
  out = out.replace(/\bimplements\s+[A-Za-z_$][\w$<>,\s.]*(?=\{)/g, "");

  // Strip generic type parameters on functions (`function id<T>(x: T)`).
  out = out.replace(
    /\bfunction(\s+[A-Za-z_$][\w$]*)?\s*<[^()\n]+>\s*\(/g,
    "function$1(",
  );

  // Strip parameter & return types on `function ...(...) : Ret {`.
  out = out.replace(
    /(\bfunction(?:\s+[A-Za-z_$][\w$]*)?\s*)\(([^()]*)\)\s*(?::\s*([^{;\n]+?))?\s*(?=\{)/g,
    (_m, head: string, params: string, ret = "") =>
      `${head}(${stripParamTypes(params)})${preserveLines(ret)} `,
  );

  // Strip parameter & return types on arrow functions `(a: number): number =>`.
  out = out.replace(
    /(?:<[^()\n]+>\s*)?\(([^()]*)\)\s*(?::\s*([^=;\n]+?))?\s*=>/g,
    (_m, params: string, ret = "") =>
      `(${stripParamTypes(params)})${preserveLines(ret)} =>`,
  );

  // Strip variable annotations `const count: number = 0`.
  out = out.replace(
    /\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*([^=;\n]+?)(?=\s*=)/g,
    (_m, kw: string, id: string, typePart: string) =>
      `${kw} ${id}${preserveLines(typePart)}`,
  );

  // Strip `as Type` assertions without crossing line boundaries or swallowing subsequent tokens.
  out = out.replace(
    /[ \t]+as[ \t]+(?:const\b|(?:[A-Z][\w$<>[\].]*|\b(?:string|number|boolean|any|unknown|never|void|object)\b(?:\[\])*)(?:[ \t]*[|&][ \t]*(?:[A-Z][\w$<>[\].]*|\b(?:string|number|boolean|any|unknown|never|void|object|null|undefined)\b(?:\[\])*))*)/g,
    "",
  );

  return out.replace(/__BELL_TOK_(\d+)__\n*/g, (_m, idx: string) => tokens[Number(idx)] ?? "");
}

function countNewlines(segment: string): number {
  let count = 0;
  for (let i = 0; i < segment.length; i += 1) {
    if (segment[i] === "\n") count += 1;
  }
  return count;
}

/**
 * Rewrites `console.<log|info|warn|error|dir>(` outside strings/comments to
 * `__bellConsole(<1-based-line>, "<method>", ` while preserving exact line numbers.
 */
export function instrumentConsoleLines(code: string, startLine = 1): string {
  const callRe = /^console([ \t\r\n]*\.[ \t\r\n]*)(log|info|warn|error|dir)([ \t\r\n]*)\(/;
  let out = "";
  let line = startLine;
  let i = 0;

  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];

    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", i + 2);
      const stop = end === -1 ? code.length : end;
      out += code.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      const chunk = code.slice(i, stop);
      line += countNewlines(chunk);
      out += chunk;
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch && code[j] !== "\n") {
        if (code[j] === "\\") j += 1;
        j += 1;
      }
      const stop = j < code.length && code[j] === ch ? j + 1 : j;
      const chunk = code.slice(i, stop);
      line += countNewlines(chunk);
      out += chunk;
      i = stop;
      continue;
    }
    if (ch === "`") {
      out += "`";
      i += 1;
      while (i < code.length && code[i] !== "`") {
        if (code[i] === "\\") {
          const esc = code.slice(i, i + 2);
          line += countNewlines(esc);
          out += esc;
          i += 2;
          continue;
        }
        if (code[i] === "$" && code[i + 1] === "{") {
          out += "${";
          i += 2;
          let braceDepth = 1;
          const exprStart = i;
          while (i < code.length && braceDepth > 0) {
            if (code[i] === "'" || code[i] === '"') {
              const q = code[i];
              i += 1;
              while (i < code.length && code[i] !== q && code[i] !== "\n") {
                if (code[i] === "\\") i += 1;
                i += 1;
              }
              if (code[i] === q) i += 1;
              continue;
            }
            if (code[i] === "{") braceDepth += 1;
            else if (code[i] === "}") braceDepth -= 1;
            if (braceDepth > 0) i += 1;
          }
          const expr = code.slice(exprStart, i);
          out += instrumentConsoleLines(expr, line);
          line += countNewlines(expr);
          if (code[i] === "}") {
            out += "}";
            i += 1;
          }
          continue;
        }
        if (code[i] === "\n") line += 1;
        out += code[i];
        i += 1;
      }
      if (code[i] === "`") {
        out += "`";
        i += 1;
      }
      continue;
    }

    if (ch === "c" && code.startsWith("console", i)) {
      const prev = i > 0 ? code[i - 1] : "";
      if (!prev || !/[A-Za-z0-9_$.]/.test(prev)) {
        const match = callRe.exec(code.slice(i));
        if (match) {
          const [, sep1, method, sep2] = match;
          const preserved = preserveLines(sep1) + preserveLines(sep2);
          out += `__bellConsole(${line}, "${method}", ${preserved}`;
          line += countNewlines(match[0]);
          i += match[0].length;
          continue;
        }
      }
    }

    if (ch === "\n") line += 1;
    out += ch;
    i += 1;
  }

  return out;
}

let sandboxIframe: HTMLIFrameElement | null = null;
let sandboxReady: Promise<HTMLIFrameElement> | null = null;
let runSeq = 0;

function resetSandboxIframe(): void {
  if (sandboxIframe?.parentNode) {
    sandboxIframe.parentNode.removeChild(sandboxIframe);
  }
  sandboxIframe = null;
  sandboxReady = null;
}

function ensureSandboxIframe(): Promise<HTMLIFrameElement> {
  if (sandboxReady && sandboxIframe?.isConnected) {
    return sandboxReady;
  }
  resetSandboxIframe();
  sandboxReady = new Promise<HTMLIFrameElement>((resolve, reject) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("aria-hidden", "true");
    iframe.tabIndex = -1;
    iframe.style.cssText =
      "position:fixed;left:-9999px;top:0;width:0;height:0;border:0;opacity:0;pointer-events:none;";
    iframe.dataset.bellSandbox = "true";
    iframe.src = "/api/code-sandbox";
    const onLoad = () => {
      cleanup();
      resolve(iframe);
    };
    const onError = () => {
      cleanup();
      resetSandboxIframe();
      reject(new Error("Failed to load code sandbox frame."));
    };
    const cleanup = () => {
      iframe.removeEventListener("load", onLoad);
      iframe.removeEventListener("error", onError);
    };
    iframe.addEventListener("load", onLoad);
    iframe.addEventListener("error", onError);
    document.body.appendChild(iframe);
    sandboxIframe = iframe;
  });
  return sandboxReady;
}

export function formatSandboxOutput(entries: SandboxLogEntry[], error?: string): string {
  const lines = entries.map((entry) =>
    entry.level === "result" ? `→ ${entry.text}` : entry.text,
  );
  if (error) lines.push(error);
  return lines.join("\n");
}

export async function runCodeInSandbox(
  code: string,
  language = "javascript",
  options?: { timeoutMs?: number },
): Promise<SandboxRunResult> {
  if (typeof document === "undefined" || typeof MessageChannel === "undefined") {
    return {
      ok: false,
      entries: [],
      outputText: "Error: Browser sandbox is unavailable.",
      error: "Error: Browser sandbox is unavailable.",
      durationMs: 0,
    };
  }

  const timeoutMs = Math.min(Math.max(options?.timeoutMs ?? 2500, 200), 5000);
  const preparedCode = isTypeScriptLanguage(language)
    ? stripTypeScriptTypes(code)
    : code;
  const instrumentedCode = instrumentConsoleLines(preparedCode);

  let iframe: HTMLIFrameElement;
  try {
    iframe = await ensureSandboxIframe();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      entries: [],
      outputText: message,
      error: message,
      durationMs: 0,
    };
  }

  const targetWindow = iframe.contentWindow;
  if (!targetWindow) {
    resetSandboxIframe();
    return {
      ok: false,
      entries: [],
      outputText: "Error: Sandbox window unavailable.",
      error: "Error: Sandbox window unavailable.",
      durationMs: 0,
    };
  }

  runSeq += 1;
  const runId = `run-${runSeq}`;

  return new Promise<SandboxRunResult>((resolve) => {
    const channel = new MessageChannel();
    let settled = false;
    const finish = (result: SandboxRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(outerGuard);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve(result);
    };

    const outerGuard = setTimeout(() => {
      resetSandboxIframe();
      const error = `TimeoutError: Execution exceeded ${(timeoutMs / 1000).toFixed(1)}s limit.`;
      finish({
        ok: false,
        timedOut: true,
        entries: [],
        outputText: error,
        error,
        durationMs: timeoutMs,
      });
    }, timeoutMs + 900);

    channel.port1.onmessage = (event) => {
      const payload = event.data ?? {};
      const entries: SandboxLogEntry[] = Array.isArray(payload.entries)
        ? payload.entries
        : [];
      const error =
        typeof payload.error === "string" && payload.error.length > 0
          ? payload.error
          : undefined;
      finish({
        ok: Boolean(payload.ok),
        entries,
        outputText: formatSandboxOutput(entries, error),
        error,
        timedOut: Boolean(payload.timedOut),
        truncated: Boolean(payload.truncated),
        durationMs: Math.max(1, Number(payload.durationMs) || 1),
      });
    };

    targetWindow.postMessage(
      {
        type: "bell-sandbox-run",
        runId,
        code: instrumentedCode,
        rawCode: preparedCode,
        timeoutMs,
      },
      "*",
      [channel.port2],
    );
  });
}
