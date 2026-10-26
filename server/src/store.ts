import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  ChunkMeta,
  EvaluationBatch,
  HumanReview,
  JudgeResult,
  RunResult,
} from '@rag-lab/shared';

export interface StoredChunk extends ChunkMeta {
  ordinal: number;
  embedding: Float32Array;
}

export interface DocumentRow {
  id: string;
  status: 'not_ingested' | 'ingesting' | 'ingested' | 'error';
  pageCount: number | null;
  chunkCount: number | null;
  error: string | null;
  ingestedAt: string | null;
}

/** Thin persistence layer over node:sqlite. Complex objects are stored as JSON. */
export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, page_count INTEGER, chunk_count INTEGER,
        error TEXT, ingested_at TEXT);
      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        meta TEXT NOT NULL, embedding BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS chunks_doc ON chunks(document_id, ordinal);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY, batch_id TEXT, created_at TEXT NOT NULL, mode TEXT NOT NULL,
        question_id TEXT, result TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS runs_batch ON runs(batch_id);
      CREATE TABLE IF NOT EXISTS judgments (run_id TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS human_reviews (run_id TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches (batch_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, result TEXT NOT NULL);
    `);
  }

  // ----- documents & chunks -----
  getDocumentRows(): DocumentRow[] {
    return (this.db.prepare('SELECT * FROM documents').all() as any[]).map((r) => ({
      id: r.id,
      status: r.status,
      pageCount: r.page_count,
      chunkCount: r.chunk_count,
      error: r.error,
      ingestedAt: r.ingested_at,
    }));
  }

  setDocumentRow(row: DocumentRow) {
    this.db
      .prepare(
        `INSERT INTO documents (id, status, page_count, chunk_count, error, ingested_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET status=excluded.status, page_count=excluded.page_count,
         chunk_count=excluded.chunk_count, error=excluded.error, ingested_at=excluded.ingested_at`,
      )
      .run(row.id, row.status, row.pageCount, row.chunkCount, row.error, row.ingestedAt);
  }

  replaceChunks(documentId: string, chunks: StoredChunk[]) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);
      const ins = this.db.prepare('INSERT INTO chunks (chunk_id, document_id, ordinal, meta, embedding) VALUES (?,?,?,?,?)');
      for (const c of chunks) {
        const { embedding, ...meta } = c;
        ins.run(c.chunkId, documentId, c.ordinal, JSON.stringify(meta), new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  deleteChunks(documentId: string) {
    this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId);
  }

  loadChunks(): StoredChunk[] {
    const rows = this.db.prepare('SELECT meta, embedding FROM chunks ORDER BY document_id, ordinal').all() as any[];
    return rows.map((r) => {
      const bytes = r.embedding as Uint8Array;
      const copy = new Uint8Array(bytes); // ensure 4-byte alignment
      return { ...JSON.parse(r.meta), embedding: new Float32Array(copy.buffer) };
    });
  }

  // ----- key/value -----
  getKv<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as any;
    return r ? (JSON.parse(r.value) as T) : null;
  }
  setKv(key: string, value: unknown) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
  }

  // ----- runs & evaluations -----
  saveRun(r: RunResult) {
    this.db
      .prepare('INSERT OR REPLACE INTO runs (run_id, batch_id, created_at, mode, question_id, result) VALUES (?,?,?,?,?,?)')
      .run(r.runId, r.batchId, r.createdAt, r.mode, r.questionId, JSON.stringify(r));
  }
  getRun(runId: string): RunResult | null {
    const r = this.db.prepare('SELECT result FROM runs WHERE run_id = ?').get(runId) as any;
    return r ? JSON.parse(r.result) : null;
  }
  listRuns(opts: { batchId?: string; limit?: number } = {}): RunResult[] {
    const rows = opts.batchId
      ? this.db.prepare('SELECT result FROM runs WHERE batch_id = ? ORDER BY created_at').all(opts.batchId)
      : this.db.prepare('SELECT result FROM runs ORDER BY created_at DESC LIMIT ?').all(opts.limit ?? 200);
    return (rows as any[]).map((r) => JSON.parse(r.result));
  }
  saveJudgment(j: JudgeResult) {
    this.db.prepare('INSERT OR REPLACE INTO judgments (run_id, result) VALUES (?,?)').run(j.runId, JSON.stringify(j));
  }
  getJudgment(runId: string): JudgeResult | null {
    const r = this.db.prepare('SELECT result FROM judgments WHERE run_id = ?').get(runId) as any;
    return r ? JSON.parse(r.result) : null;
  }
  saveHumanReview(h: HumanReview) {
    this.db.prepare('INSERT OR REPLACE INTO human_reviews (run_id, result) VALUES (?,?)').run(h.runId, JSON.stringify(h));
  }
  getHumanReview(runId: string): HumanReview | null {
    const r = this.db.prepare('SELECT result FROM human_reviews WHERE run_id = ?').get(runId) as any;
    return r ? JSON.parse(r.result) : null;
  }
  saveBatch(b: EvaluationBatch) {
    this.db.prepare('INSERT OR REPLACE INTO batches (batch_id, created_at, result) VALUES (?,?,?)').run(b.batchId, b.createdAt, JSON.stringify(b));
  }
  listBatches(): EvaluationBatch[] {
    return (this.db.prepare('SELECT result FROM batches ORDER BY created_at DESC').all() as any[]).map((r) => JSON.parse(r.result));
  }
}
