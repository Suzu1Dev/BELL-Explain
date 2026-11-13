import { isIP } from "node:net";
import { parseSuiteLinks, type SuiteLinks } from "./suite.js";

export interface RuntimeConfig {
  host: string;
  port: number;
  allowedOrigins: string[];
  /** BELL_SUITE_LINKS: sibling BELL apps' browser origins, for links only. */
  suiteLinks: SuiteLinks;
  /**
   * BELL_LESSON_V3=1: write new notes in format 3. Off unless set, because a device or
   * sync server that predates format 3 cannot read one; see `AppOptions.lessonV3` for the
   * rollout order.
   */
  lessonV3: boolean;
}

function validHostname(value: string): boolean {
  return value.length <= 253 && !/^[\d.]+$/.test(value) && value.split(".").every(label =>
    label.length >= 1 && label.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label),
  );
}

/** Exact browser origins only; paths, credentials, and wildcard hosts are not origins. */
export function validateAllowedOrigins(values: readonly string[]): string[] {
  if (values.length > 32) throw new Error("BELL_ALLOWED_ORIGINS 最多可設定 32 個來源。");
  return [...new Set(values.map(value => {
    const origin = value.trim();
    let url: URL;
    try { url = new URL(origin); }
    catch { throw new Error("BELL_ALLOWED_ORIGINS 必須是以逗號分隔的完整 HTTP 或 HTTPS origin。"); }
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (
      !/^https?:\/\/[^/?#\\\s]+$/i.test(origin) ||
      origin.includes("@") || origin.endsWith(":") ||
      url.username || url.password || url.search || url.hash ||
      (!isIP(hostname) && !validHostname(hostname))
    ) {
      throw new Error("BELL_ALLOWED_ORIGINS 不可包含萬用字元、憑證、路徑、查詢或 fragment。");
    }
    return url.origin;
  }))];
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const host = env.BELL_HOST === undefined ? "127.0.0.1" : env.BELL_HOST.trim();
  if (!isIP(host) && !validHostname(host)) {
    throw new Error("BELL_HOST 必須是有效的 IP 位址或主機名稱，不可包含通訊協定、路徑或連接埠。");
  }
  const value = env.BELL_PORT === undefined ? "3001" : env.BELL_PORT.trim();
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("BELL_PORT 必須是 1–65535 的整數。");
  }
  const origins = env.BELL_ALLOWED_ORIGINS?.trim();
  const allowedOrigins = validateAllowedOrigins(origins ? origins.split(",") : []);
  const lessonV3 = env.BELL_LESSON_V3 === undefined ? "" : env.BELL_LESSON_V3.trim();
  if (!["", "0", "1"].includes(lessonV3)) throw new Error("BELL_LESSON_V3 只能是 1（開啟新格式）或 0（關閉）。");
  // A tailnet link must share a tailnet with Explain's own origins, so these are read first.
  return { host, port, allowedOrigins, suiteLinks: parseSuiteLinks(env.BELL_SUITE_LINKS, allowedOrigins), lessonV3: lessonV3 === "1" };
}
