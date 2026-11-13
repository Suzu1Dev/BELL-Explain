import type { Express } from "express";

export const CODE_SANDBOX_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; form-action 'none'; frame-ancestors 'self'";

const WORKER_SOURCE = `
const blocked = () => { throw new Error("Network access is disabled in sandbox."); };
self.fetch = blocked;
self.XMLHttpRequest = blocked;
self.WebSocket = blocked;
self.EventSource = blocked;
self.importScripts = blocked;

const MAX_CHARS = 12000;
const MAX_LINES = 120;
let totalChars = 0;
const entries = [];
let truncated = false;

function fmt(val, depth = 0, seen = new WeakSet()) {
  if (val === undefined) return "undefined";
  if (val === null) return "null";
  if (typeof val === "string") return depth === 0 ? val : JSON.stringify(val);
  if (typeof val === "number" || typeof val === "boolean" || typeof val === "bigint") return String(val);
  if (typeof val === "symbol") return val.toString();
  if (typeof val === "function") return "[Function" + (val.name ? ": " + val.name : "") + "]";
  if (val instanceof Error) return (val.name || "Error") + ": " + val.message;
  if (typeof val === "object") {
    if (seen.has(val)) return "[Circular]";
    if (depth >= 3) return Array.isArray(val) ? "[Array]" : "[Object]";
    seen.add(val);
    if (Array.isArray(val)) {
      const items = val.slice(0, 24).map(v => fmt(v, depth + 1, seen));
      if (val.length > 24) items.push("…+" + (val.length - 24));
      return "[" + items.join(", ") + "]";
    }
    if (val instanceof Map) {
      const items = [...val.entries()].slice(0, 16).map(([k, v]) => fmt(k, depth + 1, seen) + " => " + fmt(v, depth + 1, seen));
      return "Map(" + val.size + ") {" + items.join(", ") + "}";
    }
    if (val instanceof Set) {
      const items = [...val.values()].slice(0, 16).map(v => fmt(v, depth + 1, seen));
      return "Set(" + val.size + ") {" + items.join(", ") + "}";
    }
    const keys = Object.keys(val);
    const pairs = keys.slice(0, 16).map(k => k + ": " + fmt(val[k], depth + 1, seen));
    if (keys.length > 16) pairs.push("…");
    return "{" + (pairs.length ? " " + pairs.join(", ") + " " : "") + "}";
  }
  return String(val);
}

function push(level, args, startMs, line) {
  if (truncated) return;
  if (entries.length >= MAX_LINES) { truncated = true; return; }
  const text = args.map(a => fmt(a, 0)).join(" ");
  const slice = totalChars + text.length > MAX_CHARS ? text.slice(0, Math.max(0, MAX_CHARS - totalChars)) : text;
  totalChars += slice.length;
  const entry = {
    level,
    text: slice,
    atMs: Math.max(0, Math.round(performance.now() - startMs)),
    ...(typeof line === "number" && line > 0 ? { line } : {}),
  };
  entries.push(entry);
  self.postMessage({ partial: true, entry });
  if (totalChars >= MAX_CHARS) truncated = true;
}

self.onmessage = async (ev) => {
  const code = String(ev.data?.code ?? "");
  const rawCode = typeof ev.data?.rawCode === "string" ? ev.data.rawCode : code;
  const startMs = performance.now();
  const origSetTimeout = self.setTimeout.bind(self);
  const origClearTimeout = self.clearTimeout.bind(self);
  const pendingTimers = new Set();
  let settleCheck = null;

  self.setTimeout = (fn, ms = 0, ...rest) => {
    const delay = Math.max(0, Number(ms) || 0);
    if (delay > 1500) return origSetTimeout(() => {}, 1500);
    const id = origSetTimeout(() => {
      pendingTimers.delete(id);
      try { if (typeof fn === "function") fn(...rest); }
      catch (err) { push("error", [err], startMs); }
      finally { if (settleCheck) settleCheck(); }
    }, delay);
    pendingTimers.add(id);
    return id;
  };
  self.clearTimeout = (id) => {
    pendingTimers.delete(id);
    origClearTimeout(id);
    if (settleCheck) settleCheck();
  };

  const customConsole = {
    log: (...a) => push("log", a, startMs),
    info: (...a) => push("log", a, startMs),
    warn: (...a) => push("warn", a, startMs),
    error: (...a) => push("error", a, startMs),
    dir: (v) => push("log", [v], startMs),
    clear: () => { entries.length = 0; totalChars = 0; truncated = false; },
  };
  const tracedConsole = (line, method, ...a) => {
    const level = method === "warn" ? "warn" : method === "error" ? "error" : "log";
    push(level, method === "dir" ? [a[0]] : a, startMs, line);
  };

  let errorText = undefined;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let fn;
    try {
      fn = new AsyncFunction("console", "__bellConsole", '"use strict";\\n' + code);
    } catch (syntaxErr) {
      if (rawCode !== code) {
        fn = new AsyncFunction("console", "__bellConsole", '"use strict";\\n' + rawCode);
      } else {
        throw syntaxErr;
      }
    }
    const result = await fn(customConsole, tracedConsole);
    await new Promise((resolve) => {
      const check = () => {
        if (pendingTimers.size === 0) origSetTimeout(resolve, 0);
      };
      settleCheck = check;
      check();
    });
    if (entries.length === 0 && result !== undefined) {
      push("result", [result], startMs);
    }
  } catch (err) {
    errorText = err instanceof Error ? (err.name + ": " + err.message) : String(err);
  }
  self.postMessage({
    ok: !errorText,
    entries,
    truncated,
    error: errorText,
    durationMs: Math.max(1, Math.round(performance.now() - startMs)),
  });
};
`;

export const CODE_SANDBOX_HTML = `<!doctype html>
<meta charset="utf-8">
<script>
(() => {
  const WORKER_SOURCE = ${JSON.stringify(WORKER_SOURCE)};

  window.addEventListener("message", (event) => {
    const port = event.ports && event.ports[0];
    const data = event.data;
    if (!port || !data || data.type !== "bell-sandbox-run") return;
    const timeoutMs = Math.min(Math.max(Number(data.timeoutMs) || 2500, 200), 5000);
    const started = performance.now();
    const blob = new Blob([WORKER_SOURCE], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url);
    const partialEntries = [];
    let done = false;
    const finish = (payload) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      worker.terminate();
      URL.revokeObjectURL(url);
      port.postMessage({ runId: data.runId, ...payload });
      port.close();
    };
    const timer = setTimeout(() => {
      finish({
        ok: false,
        timedOut: true,
        entries: partialEntries,
        truncated: false,
        error: "TimeoutError: Execution exceeded " + (timeoutMs / 1000).toFixed(1) + "s limit.",
        durationMs: Math.round(performance.now() - started),
      });
    }, timeoutMs);
    worker.onmessage = (ev) => {
      if (ev.data && ev.data.partial) { partialEntries.push(ev.data.entry); return; }
      finish(ev.data);
    };
    worker.onerror = (ev) => finish({
      ok: false,
      entries: [],
      truncated: false,
      error: ev.message || "Error: Worker execution failed.",
      durationMs: Math.max(1, Math.round(performance.now() - started)),
    });
    worker.postMessage({
      code: String(data.code ?? ""),
      rawCode: typeof data.rawCode === "string" ? data.rawCode : undefined,
    });
  });
})();
</script>
`;

export function registerCodeSandboxRoute(app: Express): void {
  app.get("/api/code-sandbox", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", CODE_SANDBOX_CSP);
    res.status(200).send(CODE_SANDBOX_HTML);
  });
}
