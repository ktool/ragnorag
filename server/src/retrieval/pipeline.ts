import type { MetadataFilters, PipelineStep, RankedChunk, RetrievalConfig } from '@rag-lab/shared';
import { CORPUS_MANIFEST } from '../config.ts';
import type { AppContext } from '../context.ts';
import type { UsageTracker } from '../usage.ts';
import { indexText } from '../corpus/chunker.ts';
import { reasoningParam } from '../modes/answer.ts';
import { reciprocalRankFusion, toRanked, type IndexedChunk } from './search.ts';

export interface RetrievalOutcome {
  chunks: IndexedChunk[];
  ranked: RankedChunk[];
  steps: PipelineStep[];
  rewrittenQuery: string | null;
  retrievalMs: number;
  queryRewriteMs: number;
  rerankMs: number;
  topRerankScore: number | null;
}

const DOC_IDS = CORPUS_MANIFEST.map((d) => d.id);

const analysisInstructions = (rewrite: boolean, filter: boolean) => `You prepare search requests for a corpus of NIST cybersecurity publications:
${CORPUS_MANIFEST.map((d) => `- ${d.id}: ${d.title}`).join('\n')}
Do not answer the question.
${
  rewrite
    ? `searchQuery: rewrite the question into one concise keyword-rich search query. Expand acronyms next to the acronym (e.g. "PEP policy enforcement point"). Keep identifiers the question mentions (e.g. AC-2) verbatim. Do not add control identifiers, document names or topics that the question does not mention or clearly imply.`
    : 'searchQuery: return the question unchanged.'
}
${
  filter
    ? `documentIds: list the documents the question clearly targets. Return an empty list when the question could draw on several documents or you are unsure; an empty list means no restriction.
controlId: a control or outcome identifier only if the question names one (e.g. "AC-2", "PR.AA"); otherwise null.`
    : 'documentIds: return an empty list. controlId: return null.'
}`;

export interface QueryAnalysis {
  searchQuery: string;
  documentIds: string[];
  controlId: string | null;
  ms: number;
}

/** One model call that rewrites the query and/or infers metadata filters, depending on what is enabled. */
export async function analyzeQuery(ctx: AppContext, question: string, opts: { rewrite: boolean; filter: boolean }, tracker: UsageTracker, signal?: AbortSignal): Promise<QueryAnalysis> {
  const started = performance.now();
  const { response } = await tracker.respond(
    ctx.providers.responses(),
    'query_rewrite',
    {
      model: ctx.settings().answerModel,
      instructions: analysisInstructions(opts.rewrite, opts.filter),
      input: question,
      max_output_tokens: 1000,
      ...reasoningParam(ctx.settings()),
      text: {
        format: {
          type: 'json_schema',
          name: 'query_analysis',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              searchQuery: { type: 'string' },
              documentIds: { type: 'array', items: { type: 'string', enum: DOC_IDS } },
              controlId: { type: ['string', 'null'] },
            },
            required: ['searchQuery', 'documentIds', 'controlId'],
            additionalProperties: false,
          },
        },
      },
    },
    signal,
  );
  const parsed = JSON.parse(response.output_text || '{}') as Partial<QueryAnalysis>;
  return {
    searchQuery: (opts.rewrite && parsed.searchQuery?.trim()) || question,
    documentIds: opts.filter ? (parsed.documentIds ?? []).filter((d) => DOC_IDS.includes(d)) : [],
    controlId: opts.filter ? parsed.controlId?.trim() || null : null,
    ms: performance.now() - started,
  };
}

/** Basic RAG retrieval: embed the query and return the top-K chunks by cosine similarity. */
export async function vectorOnly(ctx: AppContext, question: string, topK: number, tracker: UsageTracker, signal?: AbortSignal): Promise<RetrievalOutcome> {
  const started = performance.now();
  const index = ctx.getIndex();
  const emb = await tracker.embed(ctx.providers.embeddings(), [question], signal);
  const hits = index.vector(emb.vectors[0], topK);
  const ranked = toRanked(hits, 'cosine');
  const ms = performance.now() - started;
  return {
    chunks: hits.map((h) => h.chunk),
    ranked,
    steps: [{ name: 'Vector search', detail: `Cosine similarity over ${index.size} chunks, top ${topK}`, durationMs: Math.round(ms), results: ranked }],
    rewrittenQuery: null,
    retrievalMs: ms,
    queryRewriteMs: 0,
    rerankMs: 0,
    topRerankScore: null,
  };
}

/** Optimized retrieval: optional query analysis (rewrite and/or auto filter) → keyword and/or vector search → RRF → optional rerank → top K. */
export async function optimizedRetrieve(
  ctx: AppContext,
  question: string,
  cfg: RetrievalConfig,
  tracker: UsageTracker,
  signal?: AbortSignal,
): Promise<RetrievalOutcome> {
  if (!cfg.keyword && !cfg.vector) throw new Error('Enable keyword search, vector search, or both.');
  const index = ctx.getIndex();
  const steps: PipelineStep[] = [];
  let query = question;
  let rewrittenQuery: string | null = null;
  let queryRewriteMs = 0;

  let filters: MetadataFilters = cfg.filters;
  let autoFiltered = false;
  if (cfg.queryRewrite || cfg.autoFilter) {
    const qa = await analyzeQuery(ctx, question, { rewrite: cfg.queryRewrite, filter: cfg.autoFilter }, tracker, signal);
    queryRewriteMs = qa.ms;
    if (cfg.queryRewrite) {
      rewrittenQuery = qa.searchQuery;
      query = qa.searchQuery;
      steps.push({ name: 'Query rewrite', detail: `Original: "${question}"\nRewritten: "${qa.searchQuery}"`, durationMs: Math.round(qa.ms) });
    }
    if (cfg.autoFilter) {
      // Inferred filters apply only where no manual filter is set.
      // Every document selected is the same as no restriction.
      const inferredDocs = qa.documentIds.length === DOC_IDS.length ? [] : qa.documentIds;
      const docs = cfg.filters.documentIds.length ? cfg.filters.documentIds : inferredDocs;
      const control = cfg.filters.controlId ?? qa.controlId ?? undefined;
      autoFiltered = docs.length > 0 || Boolean(control);
      filters = { ...cfg.filters, documentIds: docs, controlId: control };
      steps.push({
        name: 'Metadata filter (auto)',
        detail: autoFiltered
          ? `Inferred from the question: ${[docs.length ? `documents = ${docs.join(', ')}` : '', control ? `control = ${control}` : ''].filter(Boolean).join('; ')}`
          : 'No specific document or control inferred: searching all documents',
        durationMs: cfg.queryRewrite ? 0 : Math.round(qa.ms),
      });
    }
  }

  const retrievalStart = performance.now();
  let lexical: ReturnType<typeof index.lexical> = [];
  let vector: ReturnType<typeof index.vector> = [];
  const queryVector = cfg.vector ? (await tracker.embed(ctx.providers.embeddings(), [query], signal)).vectors[0] : null;
  const search = (f: MetadataFilters) => {
    lexical = cfg.keyword ? index.lexical(query, cfg.candidateK, f) : [];
    vector = queryVector ? index.vector(queryVector, cfg.candidateK, f) : [];
  };
  search(filters);
  if (autoFiltered && !lexical.length && !vector.length) {
    filters = cfg.filters;
    search(filters);
    steps.push({ name: 'Metadata filter (auto)', detail: 'Inferred filter matched no chunks: fell back to the unfiltered search', durationMs: 0 });
  }
  const filterDesc = describeFilters(filters);
  if (cfg.keyword) {
    steps.push({ name: 'Keyword search (BM25+-style, MiniSearch)', detail: `Top ${cfg.candidateK} candidates${filterDesc}`, durationMs: 0, results: toRanked(lexical, 'bm25plus') });
  }
  if (cfg.vector) {
    steps.push({ name: 'Vector search (cosine)', detail: `Top ${cfg.candidateK} candidates${filterDesc}`, durationMs: 0, results: toRanked(vector, 'cosine') });
  }
  const searchMs = performance.now() - retrievalStart;
  for (const st of steps) if (st.name.startsWith('Keyword search') || st.name.startsWith('Vector search')) st.durationMs = Math.round(searchMs / (cfg.keyword && cfg.vector ? 2 : 1));

  type Candidate = { chunk: IndexedChunk; score: number; lexicalRank: number | null; vectorRank: number | null };
  let candidates: Candidate[];
  let scoreType: RankedChunk['scoreType'];
  if (cfg.keyword && cfg.vector) {
    const t = performance.now();
    const fused = reciprocalRankFusion(
      [lexical.map((h) => ({ id: h.chunk.chunkId })), vector.map((h) => ({ id: h.chunk.chunkId }))],
      cfg.rrfK,
    );
    candidates = fused.map((f) => ({ chunk: index.get(f.id)!, score: f.score, lexicalRank: f.ranks[0], vectorRank: f.ranks[1] }));
    scoreType = 'rrf';
    steps.push({
      name: 'Reciprocal Rank Fusion',
      detail: `score = Σ 1/(${cfg.rrfK} + rank); ${candidates.length} unique candidates`,
      durationMs: Math.round(performance.now() - t),
      results: toRanked(candidates.slice(0, cfg.candidateK), 'rrf'),
    });
  } else {
    const src = cfg.keyword ? lexical : vector;
    candidates = src.map((h, i) => ({ ...h, lexicalRank: cfg.keyword ? i + 1 : null, vectorRank: cfg.vector ? i + 1 : null }));
    scoreType = cfg.keyword ? 'bm25plus' : 'cosine';
  }
  candidates = candidates.slice(0, cfg.candidateK);
  const retrievalMs = performance.now() - retrievalStart;

  let rerankMs = 0;
  let topRerankScore: number | null = null;
  if (cfg.rerank && candidates.length) {
    const t = performance.now();
    const reranker = await ctx.getReranker();
    // Rerank against the user's original question; reorders the existing candidates only.
    const scores = await reranker.score(question, candidates.map((c) => indexText(c.chunk)));
    candidates = candidates.map((c, i) => ({ ...c, score: scores[i] })).sort((a, b) => b.score - a.score);
    scoreType = 'rerank';
    rerankMs = performance.now() - t;
    topRerankScore = candidates[0]?.score ?? null;
    steps.push({
      name: 'Cross-encoder rerank (local)',
      detail: `${reranker.modelId} reordered ${candidates.length} candidates (local inference, no API tokens)`,
      durationMs: Math.round(rerankMs),
      results: toRanked(candidates, 'rerank'),
    });
  }

  const final = candidates.slice(0, cfg.topK);
  const ranked = toRanked(final, scoreType);
  steps.push({ name: 'Final context', detail: `Top ${cfg.topK} chunks passed to the answer model`, durationMs: 0, results: ranked });
  return { chunks: final.map((c) => c.chunk), ranked, steps, rewrittenQuery, retrievalMs, queryRewriteMs, rerankMs, topRerankScore };
}

function describeFilters(f: MetadataFilters): string {
  const parts = [
    f.documentIds?.length ? `documents=${f.documentIds.join(',')}` : '',
    f.publicationVersion ? `version=${f.publicationVersion}` : '',
    f.section ? `section=${f.section}` : '',
    f.controlId ? `control=${f.controlId}` : '',
  ].filter(Boolean);
  return parts.length ? `; filters: ${parts.join('; ')}` : '; no metadata filters';
}
