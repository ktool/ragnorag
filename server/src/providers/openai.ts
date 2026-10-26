import OpenAI from 'openai';
import type { EmbeddingProvider, ResponsesClient } from './types.ts';

export class MissingApiKeyError extends Error {
  constructor() {
    super('OPENAI_API_KEY is not set. Copy .env.example to .env, add your key, and restart the server.');
  }
}

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) throw new MissingApiKeyError();
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 90_000, maxRetries: 2 });
  return client;
}

export const hasApiKey = () => Boolean(process.env.OPENAI_API_KEY);

export class OpenAIEmbeddings implements EmbeddingProvider {
  constructor(readonly model: string) {}

  async embed(texts: string[], signal?: AbortSignal) {
    const started = performance.now();
    const res = await getClient().embeddings.create({ model: this.model, input: texts }, { signal });
    const vectors = [...res.data].sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
    return { vectors, tokens: res.usage?.prompt_tokens ?? null, latencyMs: performance.now() - started };
  }
}

export const openAIResponses: ResponsesClient = {
  create: (params, signal) => getClient().responses.create(params, { signal }),
};
