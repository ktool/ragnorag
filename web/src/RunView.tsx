import { useState } from 'react';
import { ChevronDown, ChevronRight, ShieldAlert, ShieldCheck, FileWarning } from 'lucide-react';
import { MODE_LABELS, type PipelineStep, type RankedChunk, type RunResult } from '@rag-lab/shared';
import { Answer, Badge, Card, KindTag, Stat, cx, fmtCost, fmtMs, fmtNum, fmtPct } from './ui.tsx';

const SCORE_LABEL: Record<RankedChunk['scoreType'], string> = { cosine: 'cosine', bm25plus: 'BM25+', rrf: 'RRF', rerank: 'rerank' };

export function RunView({ run, onCite, showSteps = false }: { run: RunResult; onCite: (id: string) => void; showSteps?: boolean }) {
  const validIds = run.citations.filter((c) => c.valid).map((c) => c.chunkId);
  return (
    <div className="space-y-5">
      <Card
        title={
          <span className="flex items-center gap-2">
            {MODE_LABELS[run.mode]} answer
            {run.abstained && <Badge tone="amber">abstained / insufficient evidence</Badge>}
            {run.noEvidenceSupplied && <Badge tone="neutral">no corpus evidence supplied</Badge>}
          </span>
        }
        subtitle={`${run.config.answerModel} · ${run.config.promptVersion} · ${new Date(run.createdAt).toLocaleString()}`}
      >
        {run.error ? (
          <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">Run failed: {run.error}</div>
        ) : (
          <Answer text={run.answer || '(empty answer)'} onCite={onCite} validIds={validIds} />
        )}
        {run.noEvidenceSupplied && !run.error && (
          <p className="mt-4 rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-xs text-slate-400">
            Baseline: the model answered from its training data only. Nothing in this answer is grounded in the corpus, even if it happens to be correct.
          </p>
        )}
        {run.rewrittenQuery && (
          <p className="mt-4 text-xs text-slate-400">
            Rewritten search query: <span className="font-mono text-slate-300">{run.rewrittenQuery}</span>
          </p>
        )}
      </Card>

      {!run.noEvidenceSupplied && <Citations run={run} onCite={onCite} />}
      <MetricsSummary run={run} />
      {!run.noEvidenceSupplied && run.retrieved.length > 0 && (
        <Card
          title={run.mode === 'agentic_rag' ? 'Evidence retrieved by the agent' : 'Retrieved chunks (passed to the model)'}
          subtitle={run.mode === 'agentic_rag' ? 'All unique chunks returned by tool calls, in first-seen order' : 'Final ranking order and scores'}
        >
          <ChunkTable chunks={run.retrieved} onCite={onCite} cited={new Set(validIds)} hideScore={run.mode === 'agentic_rag'} />
        </Card>
      )}
      {showSteps && run.steps.length > 0 && <Steps steps={run.steps} onCite={onCite} />}
    </div>
  );
}

function Citations({ run, onCite }: { run: RunResult; onCite: (id: string) => void }) {
  const c = run.citationCheck;
  return (
    <Card
      title="Citations"
      subtitle="Each citation is checked against the chunks actually supplied to (or retrieved by) the model"
      actions={c && <KindTag kind="measured" />}
    >
      {run.citations.length === 0 ? (
        <p className="text-sm text-slate-400">No citations returned.</p>
      ) : (
        <ul className="space-y-2">
          {run.citations.map((cit) => (
            <li key={cit.chunkId} className="flex items-start gap-3 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
              {cit.valid ? <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal" /> : <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />}
              <div className="min-w-0 flex-1 text-sm">
                <button onClick={() => onCite(cit.chunkId)} className="font-mono text-[12.5px] text-teal-200 hover:underline">
                  {cit.chunkId}
                </button>
                {cit.valid ? (
                  <span className="ml-2 text-xs text-slate-400">
                    {cit.documentTitle} · p.{cit.pageNumber}
                    {cit.sectionTitle ? ` · ${cit.sectionTitle}` : ''}
                    {cit.controlId ? ` · ${cit.controlId}` : ''}
                  </span>
                ) : (
                  <span className="ml-2 text-xs text-rose-300">does not resolve to supplied evidence</span>
                )}
                <div className="mt-0.5 text-xs text-slate-400">{cit.supports}</div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {c && c.invalidIds.length > 0 && run.config.retrieval?.citationValidation && run.mode !== 'basic_rag' && (
        <p className="mt-3 flex items-center gap-2 text-xs text-amber-300">
          <FileWarning className="h-3.5 w-3.5" /> Citation validation removed {c.invalidIds.length} invalid citation(s) from the answer.
        </p>
      )}
    </Card>
  );
}

export function MetricsSummary({ run }: { run: RunResult }) {
  const u = run.usage;
  const t = run.timings;
  const c = run.citationCheck;
  const m = run.retrievalMetrics;
  return (
    <Card title="Execution metrics" subtitle="Token counts are API-reported usage; cost is an estimate from configured pricing">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Total latency" value={fmtMs(t.totalMs)} kind="measured" />
        {t.retrievalMs != null && <Stat label="Retrieval" value={fmtMs(t.retrievalMs)} kind="measured" />}
        {t.queryRewriteMs != null && <Stat label="Query rewrite" value={fmtMs(t.queryRewriteMs)} kind="measured" />}
        {t.rerankMs != null && <Stat label="Rerank (local)" value={fmtMs(t.rerankMs)} kind="measured" hint="no API tokens" />}
        {t.generationMs != null && <Stat label="Generation" value={fmtMs(t.generationMs)} kind="measured" />}
        {t.agentOrchestrationMs != null && <Stat label="Agent loop" value={fmtMs(t.agentOrchestrationMs)} kind="measured" />}
        <Stat label="Answer tokens in / out" value={`${fmtNum(u.answerInput)} / ${fmtNum(u.answerOutput)}`} kind="measured" />
        <Stat label="Rewrite + planning in / out" value={`${fmtNum(u.planningInput)} / ${fmtNum(u.planningOutput)}`} kind="measured" />
        <Stat label="Embedding tokens" value={fmtNum(u.embeddingTokens)} kind="measured" />
        <Stat label="Total tokens" value={fmtNum(u.totalTokens)} kind="measured" hint={`${u.calls} API call(s)${u.usageComplete ? '' : ' · some usage unavailable'}`} />
        <Stat label="Est. API cost" value={fmtCost(u.costUsd)} kind="estimated" hint={u.costUsd == null ? 'configure pricing in Settings' : undefined} />
        {c && <Stat label="Citations valid" value={`${c.valid}/${c.total}`} kind="measured" hint="resolve to supplied chunks" />}
        {c && <Stat label="Sentences cited" value={c.sentences ? fmtPct(c.sentencesWithCitation / c.sentences) : '—'} kind="measured" hint="heuristic coverage" />}
        {run.agentStats && <Stat label="Tool calls / rounds" value={`${run.agentStats.toolCalls} / ${run.agentStats.retrievalRounds}`} kind="measured" />}
        {m ? (
          <>
            <Stat label={`Recall@${m.k}`} value={fmtPct(m.recallAtK)} kind="measured" hint={`${m.relevantFound}/${m.relevantTotal} evidence items`} />
            <Stat label={`Precision@${m.k}`} value={fmtPct(m.precisionAtK)} kind="measured" />
          </>
        ) : (
          <Stat label="Retrieval metrics" value={run.noEvidenceSupplied ? 'N/A' : 'Not evaluated'} kind="na" hint={run.noEvidenceSupplied ? 'no retrieval in this mode' : 'custom question: no relevance judgments'} />
        )}
      </div>
      {m?.note && <p className="mt-3 text-xs text-slate-500">{m.note}</p>}
    </Card>
  );
}

export function ChunkTable({ chunks, onCite, cited, hideScore, limit }: { chunks: RankedChunk[]; onCite: (id: string) => void; cited?: Set<string>; hideScore?: boolean; limit?: number }) {
  const shown = limit ? chunks.slice(0, limit) : chunks;
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full text-left text-[13px]">
        <thead className="text-[11px] uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-2 pr-3">#</th>
            <th className="py-2 pr-3">Chunk</th>
            <th className="py-2 pr-3">Source</th>
            {!hideScore && <th className="py-2 pr-3">Score</th>}
            {!hideScore && <th className="py-2 pr-3">Kw / Vec rank</th>}
            <th className="py-2">Preview</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-700/60">
          {shown.map((c) => (
            <tr key={c.chunkId} className="align-top">
              <td className="py-2 pr-3 text-slate-500 tabular-nums">{c.rank}</td>
              <td className="py-2 pr-3">
                <button onClick={() => onCite(c.chunkId)} className={cx('font-mono text-[12px] hover:underline', cited?.has(c.chunkId) ? 'text-teal-200' : 'text-slate-300')}>
                  {c.chunkId}
                </button>
                {cited?.has(c.chunkId) && <Badge tone="teal" className="ml-1.5">cited</Badge>}
              </td>
              <td className="whitespace-nowrap py-2 pr-3 text-xs text-slate-400">
                <div className="text-slate-300">{c.documentId}</div>
                p.{c.pageNumber}
                {c.controlId ? ` · ${c.controlId}` : ''}
                {c.sectionTitle && <div className="max-w-[220px] truncate" title={c.sectionTitle}>{c.sectionTitle}</div>}
              </td>
              {!hideScore && (
                <td className="whitespace-nowrap py-2 pr-3 font-mono text-xs text-slate-300 tabular-nums">
                  {c.score.toFixed(4)} <span className="text-slate-500">{SCORE_LABEL[c.scoreType]}</span>
                </td>
              )}
              {!hideScore && (
                <td className="py-2 pr-3 font-mono text-xs text-slate-400 tabular-nums">
                  {c.lexicalRank ?? '–'} / {c.vectorRank ?? '–'}
                </td>
              )}
              <td className="py-2 text-xs leading-relaxed text-slate-400">{c.preview}…</td>
            </tr>
          ))}
        </tbody>
      </table>
      {limit && chunks.length > limit && <p className="mt-2 text-xs text-slate-500">Showing top {limit} of {chunks.length}.</p>}
    </div>
  );
}

export function Steps({ steps, onCite }: { steps: PipelineStep[]; onCite: (id: string) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Card title="Pipeline trace" subtitle="Actual intermediate results from each retrieval stage">
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i} className="rounded-lg border border-ink-700 bg-ink-850">
            <button className="flex w-full items-center gap-3 px-3 py-2.5 text-left" onClick={() => setOpen(open === i ? null : i)}>
              {s.results ? open === i ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" /> : <span className="w-4" />}
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent/20 text-[11px] font-semibold text-violet-200">{i + 1}</span>
              <span className="text-sm font-medium text-slate-100">{s.name}</span>
              <span className="ml-auto font-mono text-xs text-slate-400">{fmtMs(s.durationMs)}</span>
            </button>
            <div className="whitespace-pre-wrap px-3 pb-2.5 pl-[3.25rem] text-xs text-slate-400">{s.detail}</div>
            {open === i && s.results && (
              <div className="border-t border-ink-700 px-3 py-2">
                <ChunkTable chunks={s.results} onCite={onCite} limit={15} />
              </div>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}
