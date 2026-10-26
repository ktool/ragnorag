import type {
  ChunkMeta,
  CorpusDocument,
  EvaluationBatch,
  EvaluationRequest,
  EvaluationRow,
  GoldenQuestion,
  HealthResponse,
  HumanReview,
  HumanReviewInput,
  IndexStatus,
  JudgeResult,
  RunRequest,
  RunResult,
  Settings,
} from '@rag-lab/shared';

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly details?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: init?.body && !(init.body instanceof Blob) ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const details = body?.details;
    const detailMsg = Array.isArray(details) ? `: ${details.map((d: any) => `${d.path?.join('.')} ${d.message}`).join('; ')}` : '';
    throw new ApiError((body?.error ?? `Request failed (${res.status})`) + detailMsg, res.status, details);
  }
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  health: () => request<HealthResponse>('/health'),
  documents: () => request<{ documents: CorpusDocument[]; index: IndexStatus }>('/corpus/documents'),
  documentChunks: (id: string, offset = 0, search = '') =>
    request<{ total: number; chunks: ChunkMeta[] }>(`/corpus/documents/${id}/chunks?offset=${offset}&limit=50${search ? `&search=${encodeURIComponent(search)}` : ''}`),
  chunk: (chunkId: string) => request<ChunkMeta>(`/corpus/chunks/${encodeURIComponent(chunkId)}`),
  ingest: () => request<{ started: boolean }>('/corpus/ingest', json('POST')),
  reindex: () => request<{ started: boolean }>('/corpus/reindex', json('POST')),
  download: () => request<{ results: Array<{ id: string; ok: boolean; message: string }> }>('/corpus/download', json('POST', {})),
  upload: (id: string, file: File) =>
    request<{ ok: boolean }>(`/corpus/documents/${id}/upload`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/pdf' } }),
  questions: () => request<{ questions: GoldenQuestion[] }>('/questions'),
  updateQuestion: (id: string, patch: Partial<GoldenQuestion>) => request<GoldenQuestion>(`/questions/${id}`, json('PATCH', patch)),
  relevantChunks: (id: string) => request<{ chunkIds: string[] }>(`/questions/${id}/relevant`),
  run: (req: RunRequest) => request<RunResult>('/demo/run', json('POST', req)),
  runs: (limit = 50) => request<{ runs: RunResult[] }>(`/runs?limit=${limit}`),
  getRun: (id: string) => request<{ run: RunResult; judge: JudgeResult | null; human: HumanReview | null }>(`/runs/${id}`),
  judge: (id: string, force = false) => request<JudgeResult>(`/runs/${id}/judge${force ? '?force=true' : ''}`, json('POST')),
  review: (id: string, review: HumanReviewInput) => request<HumanReview>(`/runs/${id}/review`, json('POST', review)),
  startEvaluation: (req: Partial<EvaluationRequest> & { questionIds: string[] }) => request<EvaluationBatch>('/evaluation/run', json('POST', req)),
  batches: () => request<{ batches: EvaluationBatch[] }>('/evaluation/batches'),
  results: (batchId?: string) => request<{ batch: EvaluationBatch | null; rows: EvaluationRow[] }>(`/evaluation/results${batchId ? `?batchId=${batchId}` : ''}`),
  exportUrl: (batchId: string | undefined, format: 'csv' | 'json') => `/api/v1/evaluation/export?format=${format}${batchId ? `&batchId=${batchId}` : ''}`,
  settings: () => request<Settings>('/settings'),
  saveSettings: (patch: Partial<Settings>) => request<Settings>('/settings', json('PATCH', patch)),
};
