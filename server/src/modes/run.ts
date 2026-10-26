import { randomUUID } from 'node:crypto';
import {
  RetrievalConfigSchema,
  type ChunkMeta,
  type Mode,
  type RetrievalConfig,
  type RunResult,
} from '@rag-lab/shared';
import type { AppContext } from '../context.ts';
import { NotReadyError } from '../context.ts';
import { CORPUS_VERSION, PROMPT_VERSION } from '../config.ts';
import { MissingApiKeyError } from '../providers/openai.ts';
import { UsageTracker } from '../usage.ts';
import { optimizedRetrieve, vectorOnly, type RetrievalOutcome } from '../retrieval/pipeline.ts';
import { getQuestion } from '../eval/golden.ts';
import { hasRelevanceJudgments, retrievalMetrics } from '../eval/metrics.ts';
import {
  ANSWER_SCHEMA,
  checkCitations,
  formatEvidence,
  GROUNDED_INSTRUCTIONS,
  NO_RAG_INSTRUCTIONS,
  parseStructuredAnswer,
  reasoningParam,
  stripInvalidMarkers,
  type StructuredAnswer,
} from './answer.ts';
import { runAgent } from './agent.ts';

export interface RunInput {
  mode: Mode;
  question: string;
  questionId?: string | null;
  retrieval?: Partial<RetrievalConfig>;
  batchId?: string | null;
}

/** Errors the user must fix (setup); everything else is recorded on the run itself. */
export const isSetupError = (e: unknown) => e instanceof NotReadyError || e instanceof MissingApiKeyError;

export async function executeRun(ctx: AppContext, input: RunInput): Promise<RunResult> {
  const settings = ctx.settings();
  const cfg = RetrievalConfigSchema.parse({ ...settings.retrievalDefaults, ...(input.retrieval ?? {}) });
  if (input.mode !== 'no_rag') ctx.getIndex(); // fail fast with setup guidance
  const tracker = new UsageTracker(settings.pricing);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Run exceeded ${settings.runTimeoutMs} ms timeout`)), settings.runTimeoutMs);
  const signal = controller.signal;
  const started = performance.now();
  const golden = getQuestion(input.questionId);

  const result: RunResult = {
    runId: randomUUID(),
    batchId: input.batchId ?? null,
    createdAt: new Date().toISOString(),
    mode: input.mode,
    questionId: input.questionId ?? null,
    question: input.question,
    answer: '',
    abstained: false,
    noEvidenceSupplied: input.mode === 'no_rag',
    rewrittenQuery: null,
    citations: [],
    citationCheck: null,
    retrieved: [],
    steps: [],
    agentSteps: [],
    agentStats: null,
    modelCalls: [],
    usage: tracker.summary(),
    timings: { totalMs: 0 },
    config: {
      answerModel: settings.answerModel,
      embeddingModel: settings.embeddingModel,
      promptVersion: PROMPT_VERSION,
      retrieval: input.mode === 'optimized_rag' || input.mode === 'agentic_rag' ? cfg : input.mode === 'basic_rag' ? { ...cfg, keyword: false, vector: true, queryRewrite: false, rerank: false, citationValidation: false, abstention: false, filters: { documentIds: [] } } : null,
      corpusVersion: CORPUS_VERSION,
      rerankerModel: (input.mode === 'optimized_rag' || input.mode === 'agentic_rag') && cfg.rerank ? settings.rerankerModel : null,
      ...(input.mode === 'agentic_rag' ? { agentMaxRounds: settings.agentMaxRounds } : {}),
    },
    retrievalMetrics: null,
    error: null,
  };

  try {
    if (input.mode === 'no_rag') {
      const t = performance.now();
      const { response } = await tracker.respond(
        ctx.providers.responses(),
        'answer',
        { model: settings.answerModel, instructions: NO_RAG_INSTRUCTIONS, input: input.question, max_output_tokens: settings.maxOutputTokens, ...reasoningParam(settings) },
        signal,
      );
      result.answer = response.output_text;
      result.timings.generationMs = Math.round(performance.now() - t);
    } else if (input.mode === 'agentic_rag') {
      const t = performance.now();
      const out = await runAgent(ctx, input.question, cfg, settings.agentMaxRounds, tracker, signal);
      const orchestration = performance.now() - t;
      const ordered = [...out.seen.values()];
      applyAnswer(result, out.answer, out.seen, cfg.citationValidation);
      result.agentSteps = out.steps;
      result.finalContextChunkIds = result.citations.filter((c) => c.valid).map((c) => c.chunkId);
      result.agentStats = out.stats;
      result.retrieved = ordered.map((c, i) => ({
        chunkId: c.chunkId, rank: i + 1, score: 0, scoreType: 'rrf', documentId: c.documentId, documentTitle: c.documentTitle,
        pageNumber: c.pageNumber, sectionTitle: [c.sectionNumber, c.sectionTitle].filter(Boolean).join(' ') || null, controlId: c.controlId, preview: c.text.slice(0, 280),
      }));
      result.timings.retrievalMs = Math.round(out.retrievalMs);
      result.timings.rerankMs = Math.round(out.rerankMs);
      result.timings.agentOrchestrationMs = Math.round(orchestration);
      result.timings.generationMs = Math.round(tracker.calls.filter((c) => c.purpose === 'answer').reduce((s, c) => s + c.latencyMs, 0));
      if (hasRelevanceJudgments(golden)) {
        result.retrievalMetrics = retrievalMetrics(ordered, ordered.length, golden, ctx.getIndex().chunks, 'Agent: union of all unique chunks returned by its tool calls, in first-seen order (K = number retrieved). The final answer context (cited chunks) is recorded separately.');
      }
    } else {
      const retrieval: RetrievalOutcome =
        input.mode === 'basic_rag'
          ? await vectorOnly(ctx, input.question, cfg.topK, tracker, signal)
          : await optimizedRetrieve(ctx, input.question, cfg, tracker, signal);
      result.steps = retrieval.steps;
      result.retrieved = retrieval.ranked;
      result.finalContextChunkIds = retrieval.chunks.map((c) => c.chunkId);
      result.rewrittenQuery = retrieval.rewrittenQuery;
      result.timings.retrievalMs = Math.round(retrieval.retrievalMs);
      result.timings.queryRewriteMs = Math.round(retrieval.queryRewriteMs) || undefined;
      result.timings.rerankMs = Math.round(retrieval.rerankMs) || undefined;
      if (hasRelevanceJudgments(golden)) {
        result.retrievalMetrics = retrievalMetrics(retrieval.chunks, cfg.topK, golden, ctx.getIndex().chunks);
      }

      const optimized = input.mode === 'optimized_rag';
      if (optimized && cfg.rerank && cfg.minRerankScore > 0 && (retrieval.topRerankScore ?? 0) < cfg.minRerankScore) {
        result.abstained = true;
        result.answer = `Insufficient evidence: the best reranked passage scored ${(retrieval.topRerankScore ?? 0).toFixed(3)}, below the abstention threshold of ${cfg.minRerankScore}. No answer was generated.`;
        result.steps.push({ name: 'Abstention gate', detail: 'Generation skipped: retrieved evidence below relevance threshold', durationMs: 0 });
      } else {
        const t = performance.now();
        const { response } = await tracker.respond(
          ctx.providers.responses(),
          'answer',
          {
            model: settings.answerModel,
            instructions: GROUNDED_INSTRUCTIONS(optimized ? cfg.abstention : true),
            input: `Question: ${input.question}\n\nEvidence:\n${formatEvidence(retrieval.chunks)}`,
            max_output_tokens: settings.maxOutputTokens,
            text: { format: { type: 'json_schema', name: 'grounded_answer', strict: true, schema: ANSWER_SCHEMA as any } },
            ...reasoningParam(settings),
          },
          signal,
        );
        result.timings.generationMs = Math.round(performance.now() - t);
        const supplied = new Map<string, ChunkMeta>(retrieval.chunks.map((c) => [c.chunkId, c]));
        applyAnswer(result, parseStructuredAnswer(response.output_text), supplied, optimized && cfg.citationValidation);
      }
    }
  } catch (e) {
    if (isSetupError(e)) throw e;
    const reason = signal.aborted ? (signal.reason as Error)?.message ?? 'Run aborted' : e instanceof Error ? e.message : String(e);
    result.error = reason;
  } finally {
    clearTimeout(timer);
  }

  result.modelCalls = tracker.calls;
  result.usage = tracker.summary();
  result.timings.totalMs = Math.round(performance.now() - started);
  ctx.store.saveRun(result);
  return result;
}

function applyAnswer(result: RunResult, ans: StructuredAnswer, available: Map<string, ChunkMeta>, strip: boolean) {
  const { citations, check } = checkCitations(ans.answer, ans.citations, available);
  result.answer = strip ? stripInvalidMarkers(ans.answer, check.invalidIds) : ans.answer;
  result.citations = strip ? citations.filter((c) => c.valid) : citations;
  result.citationCheck = check;
  result.abstained = ans.insufficientEvidence;
}
