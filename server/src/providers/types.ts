import type { ChunkMeta, MetadataFilters } from '@rag-lab/shared';
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';

/**
 * Provider seams. The evaluation engine and UI only depend on these interfaces,
 * so an Azure implementation (Azure OpenAI deployments, Azure AI Search) can be
 * swapped in without touching retrieval modes, evaluation or the React app.
 */

export interface EmbeddingResult {
  vectors: Float32Array[];
  /** Tokens reported by the API (usage.prompt_tokens); null if not reported. */
  tokens: number | null;
  latencyMs: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  embed(texts: string[], signal?: AbortSignal): Promise<EmbeddingResult>;
}

/** Minimal surface of the Responses API that the app uses (answer generation, rewriting, agent, judge). */
export interface ResponsesClient {
  create(params: ResponseCreateParamsNonStreaming, signal?: AbortSignal): Promise<Response>;
}

export interface Reranker {
  readonly modelId: string;
  /** Returns one relevance score per document, aligned with the input order. */
  score(query: string, documents: string[]): Promise<number[]>;
}

export interface RetrievedChunk extends ChunkMeta {
  ordinal: number;
}

/**
 * Lexical + vector retrieval over the corpus (LexicalRetriever and VectorRetriever roles).
 * Hybrid fusion (RRF) and reranking are composed on top in retrieval/pipeline.ts.
 * Local implementation: CorpusIndex (MiniSearch + in-memory cosine).
 */
export interface RetrievalBackend {
  readonly size: number;
  /** All chunks (used to resolve relevance judgments for evaluation). */
  readonly chunks: RetrievedChunk[];
  get(chunkId: string): RetrievedChunk | undefined;
  lexical(query: string, k: number, filters?: MetadataFilters): Array<{ chunk: RetrievedChunk; score: number }>;
  vector(queryVector: Float32Array, k: number, filters?: MetadataFilters): Array<{ chunk: RetrievedChunk; score: number }>;
  sections(documentId: string): Array<{ sectionNumber: string | null; sectionTitle: string | null; firstPage: number; chunkCount: number; controlIds: string[] }>;
}

export interface Providers {
  embeddings: () => EmbeddingProvider;
  responses: () => ResponsesClient;
  reranker: () => Promise<Reranker>;
}
