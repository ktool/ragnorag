import fs from 'node:fs';
import path from 'node:path';
import type { CorpusDocument, IndexStatus } from '@rag-lab/shared';
import type { AppContext } from '../context.ts';
import { CORPUS_DIR, CORPUS_MANIFEST, MAX_UPLOAD_BYTES, type ManifestEntry } from '../config.ts';
import type { StoredChunk } from '../store.ts';
import { chunkDocument, indexText } from './chunker.ts';
import { extractPdfPages, isPdf } from './pdf.ts';

const EMBED_BATCH = 96;

interface IndexMeta {
  chunkSize: number;
  chunkOverlap: number;
  embeddingModel: string;
  builtAt: string;
  embeddingTokens: number | null;
}

interface IngestionState {
  running: boolean;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
}

let state: IngestionState = { running: false, message: 'Idle', startedAt: null, finishedAt: null };

export const filePath = (d: ManifestEntry) => path.join(CORPUS_DIR, d.fileName);

export function listDocuments(ctx: AppContext): CorpusDocument[] {
  const rows = new Map(ctx.store.getDocumentRows().map((r) => [r.id, r]));
  return CORPUS_MANIFEST.map((d) => {
    const row = rows.get(d.id);
    const present = fs.existsSync(filePath(d));
    return {
      ...d,
      filePresent: present,
      status: row?.status ?? (present ? 'not_ingested' : 'missing'),
      pageCount: row?.pageCount ?? null,
      chunkCount: row?.chunkCount ?? null,
      error: row?.error ?? (present ? null : `PDF not found at data/corpus/${d.fileName}. Download it from ${d.pdfUrl}.`),
      ingestedAt: row?.ingestedAt ?? null,
    };
  });
}

export function indexStatus(ctx: AppContext): IndexStatus {
  const meta = ctx.store.getKv<IndexMeta>('index_meta');
  const s = ctx.settings();
  const chunkCount = ctx.hasIndex() ? ctx.getIndex().size : 0;
  const docs = ctx.store.getDocumentRows().filter((r) => r.status === 'ingested');
  let staleReason: string | null = null;
  if (meta && chunkCount) {
    const diffs = [
      meta.chunkSize !== s.chunkSize && `chunk size ${meta.chunkSize} → ${s.chunkSize}`,
      meta.chunkOverlap !== s.chunkOverlap && `overlap ${meta.chunkOverlap} → ${s.chunkOverlap}`,
      meta.embeddingModel !== s.embeddingModel && `embedding model ${meta.embeddingModel} → ${s.embeddingModel}`,
    ].filter(Boolean);
    if (diffs.length) staleReason = `Settings changed since the index was built (${diffs.join(', ')}). Re-index to apply.`;
  }
  return {
    chunkCount,
    documentCount: docs.length,
    builtWith: meta ? { chunkSize: meta.chunkSize, chunkOverlap: meta.chunkOverlap, embeddingModel: meta.embeddingModel } : null,
    builtAt: meta?.builtAt ?? null,
    stale: staleReason !== null,
    staleReason,
    ingestion: state,
  };
}

/** Ingests all available PDFs (missing ones are reported and skipped). Rebuilds the in-memory index afterwards. */
export async function ingestCorpus(ctx: AppContext, log: (msg: string) => void = () => {}): Promise<void> {
  if (state.running) throw new Error('Ingestion is already running.');
  state = { running: true, message: 'Starting ingestion…', startedAt: new Date().toISOString(), finishedAt: null };
  const settings = ctx.settings();
  const embeddings = ctx.providers.embeddings();
  const progress = (m: string) => {
    state.message = m;
    log(m);
  };
  let tokens: number | null = 0;
  let anySuccess = false;
  try {
    for (const doc of CORPUS_MANIFEST) {
      const file = filePath(doc);
      if (!fs.existsSync(file)) {
        ctx.store.deleteChunks(doc.id);
        ctx.store.setDocumentRow({ id: doc.id, status: 'error', pageCount: null, chunkCount: 0, error: `Missing PDF: place ${doc.fileName} in data/corpus/ (source: ${doc.pdfUrl})`, ingestedAt: null });
        progress(`Skipped ${doc.shortTitle}: PDF missing`);
        continue;
      }
      ctx.store.setDocumentRow({ id: doc.id, status: 'ingesting', pageCount: null, chunkCount: null, error: null, ingestedAt: null });
      try {
        progress(`${doc.shortTitle}: extracting text`);
        const pages = await extractPdfPages(new Uint8Array(fs.readFileSync(file)));
        const chunks = chunkDocument(
          pages,
          { documentId: doc.id, documentTitle: doc.title, publicationVersion: doc.publicationVersion, sourceUrl: doc.sourceUrl },
          { chunkSize: settings.chunkSize, chunkOverlap: settings.chunkOverlap },
        );
        const stored: StoredChunk[] = [];
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
          progress(`${doc.shortTitle}: embedding chunks ${i + 1}-${Math.min(i + EMBED_BATCH, chunks.length)} of ${chunks.length}`);
          const batch = chunks.slice(i, i + EMBED_BATCH);
          const res = await embeddings.embed(batch.map(indexText));
          tokens = tokens === null || res.tokens === null ? null : tokens + res.tokens;
          batch.forEach((c, j) => stored.push({ ...c, embedding: res.vectors[j] }));
        }
        ctx.store.replaceChunks(doc.id, stored);
        ctx.store.setDocumentRow({ id: doc.id, status: 'ingested', pageCount: pages.length, chunkCount: stored.length, error: null, ingestedAt: new Date().toISOString() });
        anySuccess = true;
        progress(`${doc.shortTitle}: ${pages.length} pages → ${stored.length} chunks`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.store.setDocumentRow({ id: doc.id, status: 'error', pageCount: null, chunkCount: null, error: msg, ingestedAt: null });
        progress(`${doc.shortTitle}: failed — ${msg}`);
        if (msg.includes('OPENAI_API_KEY')) throw e;
      }
    }
    if (anySuccess) {
      ctx.store.setKv('index_meta', {
        chunkSize: settings.chunkSize,
        chunkOverlap: settings.chunkOverlap,
        embeddingModel: settings.embeddingModel,
        builtAt: new Date().toISOString(),
        embeddingTokens: tokens,
      } satisfies IndexMeta);
    }
    ctx.reloadIndex();
    progress(`Ingestion finished. Embedding tokens (API-reported): ${tokens ?? 'unavailable'}`);
  } catch (e) {
    progress(`Ingestion failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    state.running = false;
    state.finishedAt = new Date().toISOString();
  }
}

export function saveUploadedPdf(documentId: string, bytes: Uint8Array) {
  const doc = CORPUS_MANIFEST.find((d) => d.id === documentId);
  if (!doc) throw new Error(`Unknown document ${documentId}`);
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`File exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit`);
  if (!isPdf(bytes)) throw new Error('Uploaded file is not a PDF');
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  fs.writeFileSync(filePath(doc), bytes);
}

/** Downloads the official PDFs from nvlpubs.nist.gov (only the URLs in the manifest). */
export async function downloadCorpus(log: (m: string) => void = console.log, ids?: string[]) {
  fs.mkdirSync(CORPUS_DIR, { recursive: true });
  const results: Array<{ id: string; ok: boolean; message: string }> = [];
  for (const doc of CORPUS_MANIFEST.filter((d) => !ids || ids.includes(d.id))) {
    try {
      const res = await fetch(doc.pdfUrl, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      saveUploadedPdf(doc.id, bytes);
      results.push({ id: doc.id, ok: true, message: `${(bytes.length / 1e6).toFixed(1)} MB` });
      log(`Downloaded ${doc.fileName} (${(bytes.length / 1e6).toFixed(1)} MB)`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      results.push({ id: doc.id, ok: false, message });
      log(`Failed ${doc.fileName}: ${message}`);
    }
  }
  return results;
}
