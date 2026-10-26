import { z } from 'zod';

// ---------- Modes & retrieval configuration ----------

export const ModeSchema = z.enum(['no_rag', 'basic_rag', 'optimized_rag', 'agentic_rag']);
export type Mode = z.infer<typeof ModeSchema>;
export const MODES: Mode[] = ['no_rag', 'basic_rag', 'optimized_rag', 'agentic_rag'];
export const MODE_LABELS: Record<Mode, string> = {
  no_rag: 'No RAG',
  basic_rag: 'Basic RAG',
  optimized_rag: 'Optimized RAG',
  agentic_rag: 'Agentic RAG',
};

export const MetadataFiltersSchema = z.object({
  documentIds: z.array(z.string()).default([]),
  publicationVersion: z.string().optional(),
  section: z.string().optional(),
  controlId: z.string().optional(),
});
export type MetadataFilters = z.infer<typeof MetadataFiltersSchema>;

export const RetrievalConfigSchema = z.object({
  topK: z.number().int().min(1).max(20).default(6),
  candidateK: z.number().int().min(1).max(100).default(30),
  keyword: z.boolean().default(true),
  vector: z.boolean().default(true),
  rrfK: z.number().int().min(1).max(500).default(60),
  queryRewrite: z.boolean().default(true),
  /** Let the query-analysis call infer document/control filters from the question. */
  autoFilter: z.boolean().default(true),
  rerank: z.boolean().default(true),
  citationValidation: z.boolean().default(true),
  abstention: z.boolean().default(true),
  /** Abstain without generation if best reranker score is below this (only when rerank is on). 0 disables. */
  minRerankScore: z.number().min(0).max(1).default(0),
  filters: MetadataFiltersSchema.default({ documentIds: [] }),
});
export type RetrievalConfig = z.infer<typeof RetrievalConfigSchema>;

// ---------- Corpus ----------

export interface CorpusDocument {
  id: string;
  title: string;
  shortTitle: string;
  publicationVersion: string;
  publicationDate: string;
  sourceUrl: string;
  pdfUrl: string;
  fileName: string;
  versionNote?: string;
  filePresent: boolean;
  status: 'missing' | 'not_ingested' | 'ingesting' | 'ingested' | 'error';
  pageCount: number | null;
  chunkCount: number | null;
  error: string | null;
  ingestedAt: string | null;
}

export interface ChunkMeta {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  publicationVersion: string;
  sectionNumber: string | null;
  sectionTitle: string | null;
  controlId: string | null;
  pageNumber: number;
  pageEnd: number;
  sourceUrl: string;
  text: string;
}

export interface IndexStatus {
  chunkCount: number;
  documentCount: number;
  builtWith: { chunkSize: number; chunkOverlap: number; embeddingModel: string } | null;
  builtAt: string | null;
  stale: boolean;
  staleReason: string | null;
  ingestion: { running: boolean; message: string; startedAt: string | null; finishedAt: string | null };
}

// ---------- Usage / timing ----------

export type CallPurpose = 'answer' | 'query_rewrite' | 'agent_planning' | 'embedding' | 'judge';

export interface ModelCall {
  purpose: CallPurpose;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** 'api' = reported by the OpenAI API usage field; 'unavailable' = API returned no usage. */
  usageSource: 'api' | 'unavailable';
  latencyMs: number;
  costUsd: number | null;
}

export interface UsageSummary {
  answerInput: number;
  answerOutput: number;
  planningInput: number; // query rewrite + agent planning
  planningOutput: number;
  embeddingTokens: number;
  totalTokens: number;
  calls: number;
  costUsd: number | null; // null when pricing is missing for any model used
  costNote: string;
  usageComplete: boolean;
}

export interface StageTimings {
  totalMs: number;
  retrievalMs?: number;
  queryRewriteMs?: number;
  rerankMs?: number;
  generationMs?: number;
  agentOrchestrationMs?: number;
}

// ---------- Run results ----------

export interface RankedChunk {
  chunkId: string;
  rank: number;
  score: number;
  scoreType: 'cosine' | 'bm25plus' | 'rrf' | 'rerank';
  lexicalRank?: number | null;
  vectorRank?: number | null;
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  sectionTitle: string | null;
  controlId: string | null;
  preview: string;
}

export interface PipelineStep {
  name: string;
  detail: string;
  durationMs: number;
  results?: RankedChunk[];
}

export interface Citation {
  chunkId: string;
  supports: string;
  valid: boolean;
  documentId?: string;
  documentTitle?: string;
  pageNumber?: number;
  sectionTitle?: string | null;
  controlId?: string | null;
  sourceUrl?: string;
}

export interface CitationCheck {
  total: number;
  valid: number;
  invalidIds: string[];
  inlineMarkers: number;
  sentences: number;
  sentencesWithCitation: number;
}

export interface AgentStep {
  index: number;
  kind: 'model_call' | 'tool_call' | 'final';
  tool?: string;
  arguments?: Record<string, unknown>;
  reason?: string;
  resultCount?: number;
  resultIds?: string[];
  error?: string;
  duplicate?: boolean;
  durationMs: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  summary: string;
}

export interface AgentStats {
  toolCalls: number;
  retrievalRounds: number;
  searchCalls: number;
  duplicateSearches: number;
  toolErrors: number;
  hitRoundLimit: boolean;
}

export interface RunResult {
  runId: string;
  batchId: string | null;
  createdAt: string;
  mode: Mode;
  questionId: string | null;
  question: string;
  answer: string;
  abstained: boolean;
  noEvidenceSupplied: boolean;
  rewrittenQuery: string | null;
  citations: Citation[];
  citationCheck: CitationCheck | null;
  retrieved: RankedChunk[];
  /** Chunks in the final answer's context: top-K for Basic/Optimized; the chunks the agent's final answer cited. */
  finalContextChunkIds?: string[];
  steps: PipelineStep[];
  agentSteps: AgentStep[];
  agentStats: AgentStats | null;
  modelCalls: ModelCall[];
  usage: UsageSummary;
  timings: StageTimings;
  config: {
    answerModel: string;
    embeddingModel: string;
    promptVersion: string;
    retrieval: RetrievalConfig | null;
    corpusVersion: string;
    rerankerModel: string | null;
    agentMaxRounds?: number;
  };
  retrievalMetrics: RetrievalMetrics | null;
  error: string | null;
}

// ---------- Evaluation ----------

export const EvidenceSpecSchema = z.object({
  documentId: z.string(),
  page: z.number().int().optional(),
  /** Exact phrase (whitespace/case-insensitive) that a relevant chunk must contain. */
  mustContain: z.string().min(3),
  grade: z.number().int().min(1).max(3).default(2),
  note: z.string().optional(),
});
export type EvidenceSpec = z.infer<typeof EvidenceSpecSchema>;

export const GoldenQuestionSchema = z.object({
  id: z.string(),
  text: z.string().min(5),
  category: z.string(),
  primary: z.boolean().default(false),
  expectedAnswerPoints: z.array(z.string()),
  expectedDocumentIds: z.array(z.string()),
  sourceReferences: z.array(z.string()).default([]),
  relevantEvidence: z.array(EvidenceSpecSchema).default([]),
  relevantChunkIds: z.array(z.string()).default([]),
  abstention: z.enum(['expected', 'acceptable', 'not_expected']),
  reviewerNotes: z.string().default(''),
  validationStatus: z.enum(['validated', 'needs_review', 'unsupported']).default('needs_review'),
});
export type GoldenQuestion = z.infer<typeof GoldenQuestionSchema>;

export interface RetrievalMetrics {
  k: number;
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
  ndcgAtK: number;
  relevantFound: number;
  relevantTotal: number;
  relevantChunkIds: string[];
  /** Expected source documents that contributed at least one judged-relevant chunk to the evaluated set. */
  documentCoverage?: { expected: string[]; covered: string[]; relevantByDocument: Record<string, string[]> };
  note: string;
}

export const JudgeOutputSchema = z.object({
  groundedness: z.number().int().min(1).max(5).nullable(),
  faithfulness: z.number().int().min(1).max(5).nullable(),
  correctness: z.number().int().min(1).max(5),
  completeness: z.number().int().min(1).max(5),
  relevance: z.number().int().min(1).max(5),
  citationSupport: z.number().int().min(1).max(5).nullable(),
  totalClaims: z.number().int().min(0),
  claimsNeedingEvidence: z.number().int().min(0),
  claimsWithCitation: z.number().int().min(0),
  unsupportedClaims: z.number().int().min(0),
  expectedPointsCovered: z.array(z.boolean()),
  abstained: z.boolean(),
  abstentionCorrect: z.boolean().nullable(),
  explanation: z.string(),
});
export type JudgeOutput = z.infer<typeof JudgeOutputSchema>;

export interface JudgeResult {
  runId: string;
  judgeModel: string;
  rubricVersion: string;
  createdAt: string;
  output: JudgeOutput;
  modelCall: ModelCall;
}

export const HumanReviewSchema = z.object({
  reviewer: z.string().min(1).max(80),
  correctness: z.number().int().min(1).max(5),
  groundedness: z.number().int().min(1).max(5).nullable(),
  completeness: z.number().int().min(1).max(5),
  citationCorrectness: z.number().int().min(1).max(5).nullable(),
  notes: z.string().max(4000).default(''),
});
export type HumanReviewInput = z.infer<typeof HumanReviewSchema>;
export interface HumanReview extends HumanReviewInput {
  runId: string;
  createdAt: string;
}

export interface EvaluationRow {
  run: RunResult;
  judge: JudgeResult | null;
  human: HumanReview | null;
}

export interface EvaluationBatch {
  batchId: string;
  createdAt: string;
  questionIds: string[];
  modes: Mode[];
  repeats: number;
  judged: boolean;
  status: 'running' | 'done' | 'error';
  progress: { done: number; total: number; message: string };
}

// ---------- Settings ----------

export const PricingSchema = z.record(
  z.string(),
  z.object({ inputPerMillion: z.number().min(0), outputPerMillion: z.number().min(0) }),
);

export const SettingsSchema = z.object({
  answerModel: z.string().min(1),
  judgeModel: z.string().min(1),
  embeddingModel: z.string().min(1),
  rerankerModel: z.string().min(1),
  chunkSize: z.number().int().min(50).max(2000),
  chunkOverlap: z.number().int().min(0).max(500),
  agentMaxRounds: z.number().int().min(1).max(5),
  runTimeoutMs: z.number().int().min(10_000).max(600_000),
  maxOutputTokens: z.number().int().min(256).max(16_000),
  /** Sent as reasoning.effort to every generation call; '' omits it (for non-reasoning models). */
  reasoningEffort: z.enum(['', 'none', 'minimal', 'low', 'medium', 'high']).default('low'),
  pricing: PricingSchema,
  pricingSource: z.string().default(''),
  retrievalDefaults: RetrievalConfigSchema,
});
export type Settings = z.infer<typeof SettingsSchema>;
export const SettingsPatchSchema = SettingsSchema.partial();

// ---------- API requests ----------

export const RunRequestSchema = z.object({
  question: z.string().trim().min(3).max(2000),
  questionId: z.string().optional(),
  mode: ModeSchema,
  retrieval: RetrievalConfigSchema.partial().optional(),
});
export type RunRequest = z.infer<typeof RunRequestSchema>;

export const EvaluationRequestSchema = z.object({
  questionIds: z.array(z.string()).min(1),
  modes: z.array(ModeSchema).min(1).default(MODES),
  repeats: z.number().int().min(1).max(5).default(1),
  judge: z.boolean().default(true),
  retrieval: RetrievalConfigSchema.partial().optional(),
});
export type EvaluationRequest = z.infer<typeof EvaluationRequestSchema>;

export interface HealthResponse {
  ok: boolean;
  openaiKeyConfigured: boolean;
  corpusReady: boolean;
  chunkCount: number;
  version: string;
}

export interface ApiError {
  error: string;
  details?: unknown;
}
