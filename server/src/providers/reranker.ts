import type { Reranker } from './types.ts';

/**
 * Local cross-encoder reranker via flashrank-js (ONNX through @huggingface/transformers).
 * The model is downloaded from Hugging Face on first use and cached under data/model-cache.
 * Inference runs locally: it consumes no OpenAI tokens; only its latency is recorded.
 */
export async function createFlashrankReranker(model: string, cacheDir: string): Promise<Reranker> {
  const { Reranker: Flashrank } = await import('flashrank-js');
  const instance = await Flashrank.create({ model, cacheDir });
  return {
    modelId: instance.modelId,
    async score(query, documents) {
      if (documents.length === 0) return [];
      const results = await instance.rerank({ query, documents, returnDocuments: false, batchSize: 16 });
      const scores = new Array<number>(documents.length).fill(0);
      for (const r of results) scores[r.index] = r.score;
      return scores;
    },
  };
}
