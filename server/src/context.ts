import type { Settings } from '@rag-lab/shared';
import { loadSettings, MODEL_CACHE_DIR } from './config.ts';
import { OpenAIEmbeddings, openAIResponses } from './providers/openai.ts';
import { createFlashrankReranker } from './providers/reranker.ts';
import type { Providers, Reranker } from './providers/types.ts';
import { CorpusIndex } from './retrieval/search.ts';
import type { Store } from './store.ts';

export class NotReadyError extends Error {}

/** Shared application state: storage, the loaded in-memory index, settings and providers. */
export class AppContext {
  private index: CorpusIndex | null = null;
  private rerankerPromise: Promise<Reranker> | null = null;
  private rerankerKey = '';

  constructor(
    readonly store: Store,
    readonly providers: Providers,
    readonly settings: () => Settings = loadSettings,
  ) {}

  reloadIndex() {
    const chunks = this.store.loadChunks();
    this.index = chunks.length ? new CorpusIndex(chunks) : null;
  }

  getIndex(): CorpusIndex {
    if (!this.index) this.reloadIndex();
    if (!this.index) throw new NotReadyError('The corpus has not been ingested yet. Open "Corpus & Ingestion" and run ingestion (or `npm run ingest`).');
    return this.index;
  }

  hasIndex() {
    if (!this.index) this.reloadIndex();
    return this.index !== null;
  }

  /** Lazily loads the reranker once per model; a failed load is retried on the next request. */
  getReranker(): Promise<Reranker> {
    const key = this.settings().rerankerModel;
    if (!this.rerankerPromise || this.rerankerKey !== key) {
      this.rerankerKey = key;
      this.rerankerPromise = this.providers.reranker().catch((e) => {
        this.rerankerPromise = null;
        throw new Error(`Reranker unavailable (${key}): ${e instanceof Error ? e.message : String(e)}. Disable reranking or check network access to huggingface.co for the first model download.`);
      });
    }
    return this.rerankerPromise;
  }
}

export function defaultProviders(settings: () => Settings = loadSettings): Providers {
  return {
    embeddings: () => new OpenAIEmbeddings(settings().embeddingModel),
    responses: () => openAIResponses,
    reranker: () => createFlashrankReranker(settings().rerankerModel, MODEL_CACHE_DIR),
  };
}
