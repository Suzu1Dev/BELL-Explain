import { logEvent } from './log.js';

export class AppError extends Error {
  constructor(public status: number, message: string, public readonly code?: string) { super(message); this.name = 'AppError'; }
}
export interface ValidationIssue { path: string; code: string; }
/** A model reply that failed validation. Issues keep field paths and codes only, never values. */
export class SchemaValidationError extends AppError {
  constructor(message: string, readonly stage: string, readonly issues: ValidationIssue[]) { super(502, message); this.name = 'SchemaValidationError'; }
}
export function schemaFailure(stage: string, message: string, error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string }> }): SchemaValidationError {
  const issues = error.issues.slice(0, 20).map(issue => ({ path: issue.path.map(String).join('.'), code: issue.code }));
  logEvent('schema.invalid', { stage, issues, total: error.issues.length });
  return new SchemaValidationError(message, stage, issues);
}
export function publicError(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof Error && error.name === 'AbortError') return '這次工作已取消。';
  if (error instanceof Error && error.name === 'TimeoutError') return '等待來源或模型回應超過時間，尚未儲存不完整的筆記。請稍後重試。';
  return '產生過程遇到問題，尚未儲存不完整的筆記。請稍後再試。';
}
