import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import {
  EvaluationRequestSchema,
  GoldenQuestionSchema,
  HumanReviewSchema,
  RunRequestSchema,
  SettingsPatchSchema,
  type HealthResponse,
} from '@rag-lab/shared';
import { APP_VERSION, MAX_UPLOAD_BYTES, saveSettings } from './config.ts';
import { NotReadyError, type AppContext } from './context.ts';
import { downloadCorpus, indexStatus, ingestCorpus, listDocuments, saveUploadedPdf } from './corpus/ingest.ts';
import { getQuestion, listQuestions, updateQuestion } from './eval/golden.ts';
import { judgeRun, RUBRIC_VERSION } from './eval/judge.ts';
import { resolveRelevantChunks } from './eval/metrics.ts';
import { evaluationRows, rowsToCsv, startEvaluation } from './eval/runner.ts';
import { executeRun } from './modes/run.ts';
import { hasApiKey, MissingApiKeyError } from './providers/openai.ts';

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const stripEmbedding = <T extends { embedding?: unknown }>({ embedding: _e, ...rest }: T) => rest;

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));

  api.get('/health', (_req, res) => {
    const body: HealthResponse = {
      ok: true,
      openaiKeyConfigured: hasApiKey(),
      corpusReady: ctx.hasIndex(),
      chunkCount: ctx.hasIndex() ? ctx.getIndex().size : 0,
      version: APP_VERSION,
    };
    res.json(body);
  });

  // ----- corpus -----
  api.get('/corpus/documents', (_req, res) => {
    res.json({ documents: listDocuments(ctx), index: indexStatus(ctx) });
  });

  api.get('/corpus/documents/:id/chunks', (req, res) => {
    const q = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(200).default(50), search: z.string().optional() }).parse(req.query);
    const all = ctx.hasIndex() ? ctx.getIndex().chunks.filter((c) => c.documentId === req.params.id) : [];
    const filtered = q.search ? all.filter((c) => `${c.chunkId} ${c.controlId ?? ''} ${c.sectionTitle ?? ''} ${c.text}`.toLowerCase().includes(q.search!.toLowerCase())) : all;
    res.json({ total: filtered.length, chunks: filtered.slice(q.offset, q.offset + q.limit).map(stripEmbedding) });
  });

  api.get('/corpus/chunks/:chunkId', (req, res) => {
    const c = ctx.getIndex().get(req.params.chunkId);
    if (!c) throw new HttpError(404, `Chunk ${req.params.chunkId} not found in the current index`);
    res.json(stripEmbedding(c));
  });

  const startIngest = (_req: Request, res: Response) => {
    if (!hasApiKey()) throw new MissingApiKeyError();
    if (indexStatus(ctx).ingestion.running) throw new HttpError(409, 'Ingestion is already running');
    ingestCorpus(ctx, (m) => console.log(`[ingest] ${m}`)).catch((e) => console.error('[ingest] failed', e));
    res.status(202).json({ started: true, index: indexStatus(ctx) });
  };
  api.post('/corpus/ingest', startIngest);
  api.post('/corpus/reindex', startIngest);

  api.post('/corpus/download', async (req, res) => {
    const ids = z.object({ documentIds: z.array(z.string()).optional() }).parse(req.body ?? {}).documentIds;
    res.json({ results: await downloadCorpus(() => {}, ids) });
  });

  api.post('/corpus/documents/:id/upload', express.raw({ type: 'application/pdf', limit: MAX_UPLOAD_BYTES }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'Send the PDF as the request body with Content-Type: application/pdf');
    try {
      saveUploadedPdf(String(req.params.id), new Uint8Array(req.body));
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : 'Upload failed');
    }
    res.json({ ok: true, documents: listDocuments(ctx) });
  });

  // ----- golden questions -----
  api.get('/questions', (_req, res) => res.json({ questions: listQuestions() }));
  api.patch('/questions/:id', (req, res) => {
    const patch = GoldenQuestionSchema.partial().omit({ id: true }).parse(req.body);
    res.json(updateQuestion(String(req.params.id), patch));
  });
  api.get('/questions/:id/relevant', (req, res) => {
    const q = getQuestion(String(req.params.id));
    if (!q) throw new HttpError(404, 'Unknown question');
    res.json({ chunkIds: ctx.hasIndex() ? resolveRelevantChunks(q, ctx.getIndex().chunks) : [] });
  });

  // ----- runs -----
  api.post('/demo/run', async (req, res) => {
    const body = RunRequestSchema.parse(req.body);
    res.json(await executeRun(ctx, body));
  });

  api.get('/runs', (req, res) => {
    const limit = z.coerce.number().int().min(1).max(500).default(50).parse(req.query.limit);
    res.json({ runs: ctx.store.listRuns({ limit }) });
  });
  api.get('/runs/:runId', (req, res) => {
    const run = ctx.store.getRun(req.params.runId);
    if (!run) throw new HttpError(404, 'Run not found');
    res.json({ run, judge: ctx.store.getJudgment(run.runId), human: ctx.store.getHumanReview(run.runId) });
  });
  api.get('/runs/:runId/trace', (req, res) => {
    const run = ctx.store.getRun(req.params.runId);
    if (!run) throw new HttpError(404, 'Run not found');
    res.json({ runId: run.runId, mode: run.mode, question: run.question, steps: run.steps, agentSteps: run.agentSteps, agentStats: run.agentStats, modelCalls: run.modelCalls, timings: run.timings, citations: run.citations, answer: run.answer });
  });
  api.post('/runs/:runId/judge', async (req, res) => {
    const run = ctx.store.getRun(req.params.runId);
    if (!run) throw new HttpError(404, 'Run not found');
    const force = req.query.force === 'true';
    const cached = ctx.store.getJudgment(run.runId);
    const current = cached && cached.rubricVersion === RUBRIC_VERSION && cached.judgeModel === ctx.settings().judgeModel;
    res.json(current && !force ? cached : await judgeRun(ctx, run, getQuestion(run.questionId)));
  });
  api.post('/runs/:runId/review', (req, res) => {
    const run = ctx.store.getRun(req.params.runId);
    if (!run) throw new HttpError(404, 'Run not found');
    const review = { ...HumanReviewSchema.parse(req.body), runId: run.runId, createdAt: new Date().toISOString() };
    ctx.store.saveHumanReview(review);
    res.json(review);
  });

  // ----- evaluation -----
  api.post('/evaluation/run', (req, res) => {
    if (!hasApiKey()) throw new MissingApiKeyError();
    res.status(202).json(startEvaluation(ctx, EvaluationRequestSchema.parse(req.body)));
  });
  api.get('/evaluation/batches', (_req, res) => res.json({ batches: ctx.store.listBatches() }));
  api.get('/evaluation/results', (req, res) => {
    const batchId = typeof req.query.batchId === 'string' ? req.query.batchId : undefined;
    const runs = batchId ? ctx.store.listRuns({ batchId }) : ctx.store.listRuns({ limit: 200 });
    res.json({ batch: ctx.store.listBatches().find((b) => b.batchId === batchId) ?? null, rows: evaluationRows(ctx, runs) });
  });
  api.get('/evaluation/export', (req, res) => {
    const batchId = typeof req.query.batchId === 'string' ? req.query.batchId : undefined;
    const rows = evaluationRows(ctx, batchId ? ctx.store.listRuns({ batchId }) : ctx.store.listRuns({ limit: 500 }));
    const name = `rag-eval-${batchId?.slice(0, 8) ?? 'all'}`;
    if (req.query.format === 'csv') {
      res.type('text/csv').attachment(`${name}.csv`).send(rowsToCsv(rows));
    } else {
      res.attachment(`${name}.json`).json({ exportedAt: new Date().toISOString(), rows });
    }
  });

  // ----- settings -----
  api.get('/settings', (_req, res) => res.json(ctx.settings()));
  api.patch('/settings', (req, res) => {
    const patch = SettingsPatchSchema.parse(req.body);
    if (patch.chunkOverlap !== undefined || patch.chunkSize !== undefined) {
      const size = patch.chunkSize ?? ctx.settings().chunkSize;
      const overlap = patch.chunkOverlap ?? ctx.settings().chunkOverlap;
      if (overlap >= size) throw new HttpError(400, 'Chunk overlap must be smaller than chunk size');
    }
    res.json(saveSettings(patch));
  });

  api.use((_req, _res, next) => next(new HttpError(404, 'Not found')));
  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ error: 'Validation failed', details: err.issues });
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err instanceof NotReadyError) return res.status(409).json({ error: err.message });
    if (err instanceof MissingApiKeyError) return res.status(503).json({ error: err.message });
    if ((err as { type?: string })?.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
    console.error(err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
  });

  app.use('/api/v1', api);
  app.use('/api', api);
  return app;
}
