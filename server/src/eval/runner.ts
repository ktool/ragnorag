import { randomUUID } from 'node:crypto';
import type { EvaluationBatch, EvaluationRequest, EvaluationRow, RunResult } from '@rag-lab/shared';
import { MODE_LABELS } from '@rag-lab/shared';
import type { AppContext } from '../context.ts';
import { executeRun } from '../modes/run.ts';
import { getQuestion } from './golden.ts';
import { judgeRun } from './judge.ts';

/** Starts a background benchmark: every question × mode × repeat runs sequentially, then is optionally judged. */
export function startEvaluation(ctx: AppContext, req: EvaluationRequest): EvaluationBatch {
  const questions = req.questionIds.map((id) => {
    const q = getQuestion(id);
    if (!q) throw new Error(`Unknown question id ${id}`);
    return q;
  });
  ctx.getIndex(); // fail fast if not ingested
  const batch: EvaluationBatch = {
    batchId: randomUUID(),
    createdAt: new Date().toISOString(),
    questionIds: req.questionIds,
    modes: req.modes,
    repeats: req.repeats,
    judged: req.judge,
    status: 'running',
    progress: { done: 0, total: questions.length * req.modes.length * req.repeats, message: 'Queued' },
  };
  ctx.store.saveBatch(batch);

  void (async () => {
    try {
      for (let r = 0; r < req.repeats; r++) {
        for (const q of questions) {
          for (const mode of req.modes) {
            batch.progress.message = `Run ${r + 1}/${req.repeats}: ${MODE_LABELS[mode]} — ${q.id}`;
            ctx.store.saveBatch(batch);
            const run = await executeRun(ctx, { mode, question: q.text, questionId: q.id, retrieval: req.retrieval, batchId: batch.batchId });
            if (req.judge && !run.error) {
              batch.progress.message = `Judging ${MODE_LABELS[mode]} — ${q.id}`;
              ctx.store.saveBatch(batch);
              try {
                await judgeRun(ctx, run, q);
              } catch (e) {
                console.error('Judge failed', e);
              }
            }
            batch.progress.done++;
            ctx.store.saveBatch(batch);
          }
        }
      }
      batch.status = 'done';
      batch.progress.message = 'Complete';
    } catch (e) {
      batch.status = 'error';
      batch.progress.message = e instanceof Error ? e.message : String(e);
    }
    ctx.store.saveBatch(batch);
  })();

  return batch;
}

export function evaluationRows(ctx: AppContext, runs: RunResult[]): EvaluationRow[] {
  return runs.map((run) => ({ run, judge: ctx.store.getJudgment(run.runId), human: ctx.store.getHumanReview(run.runId) }));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function rowsToCsv(rows: EvaluationRow[]): string {
  const header = [
    'run_id', 'batch_id', 'created_at', 'question_id', 'mode', 'answer_model', 'prompt_version', 'corpus_version', 'error', 'abstained',
    'judge_model', 'groundedness_llm', 'faithfulness_llm', 'correctness_llm', 'completeness_llm', 'relevance_llm', 'citation_support_llm', 'unsupported_claim_rate_llm', 'citation_coverage_llm',
    'human_correctness', 'human_groundedness', 'human_completeness', 'human_citation_correctness',
    'citations_total', 'citations_valid', 'recall_at_k', 'precision_at_k', 'reciprocal_rank', 'ndcg_at_k', 'k',
    'answer_input_tokens', 'answer_output_tokens', 'planning_input_tokens', 'planning_output_tokens', 'embedding_tokens', 'total_tokens', 'model_calls',
    'total_ms', 'retrieval_ms', 'rewrite_ms', 'rerank_ms', 'generation_ms', 'cost_usd_estimated',
    'agent_tool_calls', 'agent_rounds', 'agent_duplicate_searches', 'agent_tool_errors',
  ];
  const lines = rows.map(({ run, judge, human }) => {
    const j = judge?.output;
    const m = run.retrievalMetrics;
    return [
      run.runId, run.batchId, run.createdAt, run.questionId, run.mode, run.config.answerModel, run.config.promptVersion, run.config.corpusVersion, run.error, run.abstained,
      judge?.judgeModel, j?.groundedness, j?.faithfulness, j?.correctness, j?.completeness, j?.relevance, j?.citationSupport,
      j && j.totalClaims ? (j.unsupportedClaims / j.totalClaims).toFixed(3) : '',
      j && j.claimsNeedingEvidence ? (j.claimsWithCitation / j.claimsNeedingEvidence).toFixed(3) : '',
      human?.correctness, human?.groundedness, human?.completeness, human?.citationCorrectness,
      run.citationCheck?.total, run.citationCheck?.valid, m?.recallAtK, m?.precisionAtK, m?.reciprocalRank, m?.ndcgAtK, m?.k,
      run.usage.answerInput, run.usage.answerOutput, run.usage.planningInput, run.usage.planningOutput, run.usage.embeddingTokens, run.usage.totalTokens, run.usage.calls,
      run.timings.totalMs, run.timings.retrievalMs, run.timings.queryRewriteMs, run.timings.rerankMs, run.timings.generationMs, run.usage.costUsd,
      run.agentStats?.toolCalls, run.agentStats?.retrievalRounds, run.agentStats?.duplicateSearches, run.agentStats?.toolErrors,
    ].map(csvCell).join(',');
  });
  return [header.join(','), ...lines].join('\n') + '\n';
}
