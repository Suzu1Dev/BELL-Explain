import type { StoredLesson } from './lesson-v3.js';

export interface SyncSettingsInput { remoteUrl: string; token: string; uploadExisting: true; }
export interface SyncStatus {
  configured: boolean;
  remoteUrl: string | null;
  syncing: boolean;
  pending: number;
  conflicts: number;
  lastSyncedAt: string | null;
  lastError: string | null;
}
export interface SyncDocument { id: string; revision: number; hash: string; lesson: StoredLesson | null; }
export interface SyncOperation { operationId: string; id: string; baseRevision: number; lesson: StoredLesson | null; }
export interface SyncPushResult { accepted: boolean; document: SyncDocument; }
export interface SyncConflict {
  id: string;
  local: StoredLesson | null;
  remote: StoredLesson | null;
  remoteRevision: number;
}
export type SyncResolution = 'local' | 'remote' | 'both';
