import { useEffect, useState } from 'react';
import { AlertTriangle, Bot, CheckCircle2, Search, User, Wrench } from 'lucide-react';
import type { AgentStep, RunResult } from '@rag-lab/shared';
import { api } from '../api.ts';
import type { Shared } from '../App.tsx';
import { Answer, Badge, Card, Empty, ErrorBox, KindTag, PageHeader, Spinner, Stat, cx, fmtMs, fmtNum, inputCls } from '../ui.tsx';

export function AgentTrace({ traceRunId, setTraceRunId, openChunk, navigate }: Shared) {
  const [runs, setRuns] = useState<RunResult[]>([]);
  const [run, setRun] = useState<RunResult | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api.runs(200).then((r) => {
      const agentRuns = r.runs.filter((x) => x.mode === 'agentic_rag');
      setRuns(agentRuns);
      if (!traceRunId && agentRuns[0]) setTraceRunId(agentRuns[0].runId);
    }, setError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!traceRunId) return;
    setRun(null);
    api.getRun(traceRunId).then((r) => setRun(r.run), setError);
  }, [traceRunId]);

  return (
    <>
      <PageHeader
        title="Agent Trace"
        description="The actual sequence of model calls and tool executions recorded for an agentic run. Concise action summaries and the model's stated reason for each tool call are shown; hidden reasoning is not exposed."
      />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <select className={cx(inputCls, 'max-w-2xl')} value={traceRunId ?? ''} onChange={(e) => setTraceRunId(e.target.value || null)}>
          {!runs.length && <option value="">No agentic runs yet</option>}
          {runs.map((r) => (
            <option key={r.runId} value={r.runId}>
              {new Date(r.createdAt).toLocaleString()} · {r.questionId ?? 'custom'} · {r.question.slice(0, 70)}
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={error} />
      {!runs.length && !error ? (
        <Empty title="No agent runs recorded">
          Run a question in <button className="text-accent hover:underline" onClick={() => navigate('demo')}>Live Demo</button> with the Agentic RAG mode.
        </Empty>
      ) : !run ? (
        traceRunId && <Spinner label="Loading trace…" />
      ) : (
        <Trace run={run} openChunk={openChunk} />
      )}
    </>
  );
}

/** The recorded agent actions as a vertical timeline (reused on the Compare page). */
export function AgentTimeline({ run, openChunk }: { run: RunResult; openChunk: (id: string) => void }) {
  return (
    <ol className="relative space-y-3 border-l border-ink-600 pl-6">
      <Item icon={User} tone="neutral" title="User question">
        <p className="text-sm text-slate-200">{run.question}</p>
      </Item>
      {run.agentSteps.map((step) => (
        <StepItem key={step.index} step={step} openChunk={openChunk} />
      ))}
      {run.error && (
        <Item icon={AlertTriangle} tone="red" title="Run error">
          <p className="text-sm text-rose-200">{run.error}</p>
        </Item>
      )}
    </ol>
  );
}

function Trace({ run, openChunk }: { run: RunResult; openChunk: (id: string) => void }) {
  const s = run.agentStats;
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_420px]">
      <Card title="Timeline" subtitle={`${run.config.answerModel} · max ${run.config.agentMaxRounds ?? '?'} tool rounds · ${new Date(run.createdAt).toLocaleString()}`}>
        <AgentTimeline run={run} openChunk={openChunk} />
      </Card>
      <div className="space-y-5">
        <Card title="Agent metrics" actions={<KindTag kind="measured" />}>
          <div className="grid grid-cols-2 gap-3">
            <Stat label="Tool calls" value={s?.toolCalls ?? '—'} />
            <Stat label="Retrieval rounds" value={s?.retrievalRounds ?? '—'} />
            <Stat label="Search calls" value={s?.searchCalls ?? '—'} />
            <Stat label="Duplicates blocked" value={s?.duplicateSearches ?? '—'} />
            <Stat label="Tool errors" value={s?.toolErrors ?? '—'} />
            <Stat label="Round limit reached" value={s ? (s.hitRoundLimit ? 'yes' : 'no') : '—'} />
            <Stat label="End-to-end" value={fmtMs(run.timings.totalMs)} />
            <Stat label="All tokens" value={fmtNum(run.usage.totalTokens)} hint={`${run.usage.calls} API calls`} />
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Planning tokens {fmtNum(run.usage.planningInput)} in / {fmtNum(run.usage.planningOutput)} out; final answer {fmtNum(run.usage.answerInput)} in / {fmtNum(run.usage.answerOutput)} out; embeddings {fmtNum(run.usage.embeddingTokens)}.
          </p>
        </Card>
        <Card title="Final answer" actions={run.abstained ? <Badge tone="amber">insufficient evidence</Badge> : null}>
          <Answer text={run.answer || '(no answer)'} onCite={openChunk} validIds={run.citations.filter((c) => c.valid).map((c) => c.chunkId)} />
          {run.citationCheck && (
            <p className="mt-3 text-xs text-slate-400">
              {run.citationCheck.valid}/{run.citationCheck.total} citations resolve to chunks the tools actually returned.
              {run.citationCheck.invalidIds.length > 0 && <span className="text-rose-300"> Invalid: {run.citationCheck.invalidIds.join(', ')}</span>}
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}

const TONES = { neutral: 'bg-ink-700 text-slate-300', accent: 'bg-accent/25 text-violet-200', teal: 'bg-teal/20 text-teal-200', red: 'bg-rose-500/20 text-rose-300', green: 'bg-emerald-500/20 text-emerald-300' };

function Item({ icon: Icon, tone, title, meta, children }: { icon: typeof Bot; tone: keyof typeof TONES; title: string; meta?: string; children?: React.ReactNode }) {
  return (
    <li className="relative">
      <span className={cx('absolute -left-[37px] flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-ink-900', TONES[tone])}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="rounded-lg border border-ink-700 bg-ink-850 px-3.5 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-slate-100">{title}</span>
          {meta && <span className="font-mono text-[11px] text-slate-400">{meta}</span>}
        </div>
        {children && <div className="mt-1.5">{children}</div>}
      </div>
    </li>
  );
}

function StepItem({ step, openChunk }: { step: AgentStep; openChunk: (id: string) => void }) {
  if (step.kind === 'model_call') {
    return (
      <Item icon={Bot} tone="accent" title={step.summary} meta={`${fmtMs(step.durationMs)} · ${fmtNum(step.inputTokens)} in / ${fmtNum(step.outputTokens)} out`} />
    );
  }
  if (step.kind === 'final') return <Item icon={CheckCircle2} tone="green" title={step.summary} />;
  const icon = step.tool === 'search_documents' ? Search : Wrench;
  return (
    <Item icon={icon} tone={step.error ? 'red' : step.duplicate ? 'neutral' : 'teal'} title={`${step.tool}`} meta={`${fmtMs(step.durationMs)}${step.resultCount != null ? ` · ${step.resultCount} result(s)` : ''}`}>
      <div className="space-y-1.5 text-xs">
        <div className="text-slate-300">{step.summary}</div>
        {step.reason && <div className="text-slate-400"><span className="text-slate-500">Reason given:</span> {step.reason}</div>}
        {step.arguments && Object.keys(step.arguments).length > 0 && (
          <pre className="scroll-thin overflow-x-auto rounded bg-ink-900 px-2 py-1.5 font-mono text-[11px] text-slate-400">{JSON.stringify(step.arguments, null, 0)}</pre>
        )}
        {step.duplicate && <Badge>duplicate search blocked</Badge>}
        {step.error && <div className="text-rose-300">Error: {step.error}</div>}
        {step.resultIds && step.resultIds.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {step.resultIds.map((id) => (
              <button key={id} onClick={() => openChunk(id)} className="rounded border border-ink-600 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-300 hover:border-teal/50 hover:text-teal-200">
                {id}
              </button>
            ))}
          </div>
        )}
      </div>
    </Item>
  );
}
