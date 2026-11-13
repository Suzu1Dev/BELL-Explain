export type IndexState = 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
export interface RepositoryIndex {
  id: string;
  source: 'github' | 'local';
  location: string;
  label: string;
  commit: string | null;
  state: IndexState;
  totalFiles: number;
  indexedFiles: number;
  skippedFiles: number;
  pendingFiles: number;
  chunks: number;
  indexedBytes: number;
  truncated: boolean;
  scope: string;
  createdAt: string;
  updatedAt: string;
}
export interface IndexJob {
  id: string;
  repositoryId: string;
  state: IndexState;
  phase: string;
  processedFiles: number;
  totalFiles: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
}
export interface RepositoryFile {
  path: string;
  bytes: number;
  state: 'pending' | 'indexed' | 'skipped';
  reason?: string;
  chunks: number;
}
export interface KnowledgeResult {
  id: string;
  kind: 'lesson' | 'repo';
  ownerId: string;
  title: string;
  text: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  sectionId?: string;
  score: number;
  semanticScore?: number;
  lexicalScore: number;
  citation: string;
}
export interface KnowledgeSearch {
  mode: 'hybrid' | 'keyword';
  model?: string;
  warning?: string;
  results: KnowledgeResult[];
}
export interface KnowledgeStatus {
  embedding: {
    enabled: boolean;
    state: 'disabled' | 'loading' | 'ready' | 'error';
    provider: 'local' | 'api' | 'custom';
    model: string;
    dimensions: number | null;
    indexedChunks: number;
    totalChunks: number;
    error?: string;
  };
  limits: {
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
    maxChunks: number;
    maxCloneBytes: number;
  };
}
