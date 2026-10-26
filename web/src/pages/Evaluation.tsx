import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Download, Gavel, Play } from 'lucide-react';
import { CartesianGrid, LabelList, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import { MODES, MODE_LABELS, type EvaluationBatch, type EvaluationRow, type GoldenQuestion, type Mode } from '@rag-lab/shared';
import { api } from '../api.ts';
import type { Shared } from '../App.tsx';
import { RunView } from '../RunView.tsx';
import { Badge, Button, Card, Empty, ErrorBox, Field, KindTag, PageHeader, Spinner, Toggle, cx, fmtCost, fmtMs, fmtNum, fmtPct, fmtScore, inputCls, type ValueKind } from '../ui.tsx';
import { GoldenEditor } from './GoldenEditor.tsx';

/** Categorical slots validated for CVD separation and contrast on the #0b1220 surface. */
export const MODE_COLORS: Record<Mode, string> = { no_rag: '#3987e5', basic_rag: '#d95926', optimized_rag: '#199e70', agentic_rag: '#c98500' };

const avg = (xs: Array<number | null | undefined>) => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

interface Agg {
  mode: Mode;
  n: number;
  judged: number;
  human: number;
  groundedness: number | null;
  faithfulness: number | null;
  correctness: number | null;
  completeness: number | null;
  relevance: number | null;
  citationSupport: number | null;
  citationValid: number | null;
  citationCoverage: number | null;
  unsupportedRate: number | null;
  abstentionQuality: number | null;
  humanCorrectness: number | null;
  recall: number | null;
  precision: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  embeddingTokens: number | null;
  totalTokens: number | null;
  latency: number | null;
  cost: number | null;
  costComplete: boolean;
  toolCalls: number | null;
  rounds: number | null;
  duplicates: number | null;
  toolErrors: number | null;
  errors: number;
}

function aggregate(rows: EvaluationRow[], mode: Mode): Agg {
  const rs = rows.filter((r) => r.run.mode === mode);
  const ok = rs.filter((r) => !r.run.error);
  const j = ok.map((r) => r.judge?.output).filter(Boolean) as NonNullable<EvaluationRow['judge']>['output'][];
  const abst = j.map((x) => x.abstentionCorrect).filter((x): x is boolean => x !== null);
  return {
    mode,
    n: rs.length,
    judged: j.length,
    human: ok.filter((r) => r.human).length,
    groundedness: avg(j.map((x) => x.groundedness)),
    faithfulness: avg(j.map((x) => x.faithfulness)),
    correctness: avg(j.map((x) => x.correctness)),
    completeness: avg(j.map((x) => x.completeness)),
    relevance: avg(j.map((x) => x.relevance)),
    citationSupport: avg(j.map((x) => x.citationSupport)),
    citationValid: avg(ok.map((r) => (r.run.citationCheck && r.run.citationCheck.total ? r.run.citationCheck.valid / r.run.citationCheck.total : null))),
    citationCoverage: avg(j.map((x) => (x.claimsNeedingEvidence ? x.claimsWithCitation / x.claimsNeedingEvidence : null))),
    unsupportedRate: avg(j.map((x) => (x.totalClaims ? x.unsupportedClaims / x.totalClaims : null))),
    abstentionQuality: abst.length ? abst.filter(Boolean).length / abst.length : null,
    humanCorrectness: avg(ok.map((r) => r.human?.correctness)),
    recall: avg(ok.map((r) => r.run.retrievalMetrics?.recallAtK)),
    precision: avg(ok.map((r) => r.run.retrievalMetrics?.precisionAtK)),
    inputTokens: avg(ok.map((r) => r.run.usage.answerInput + r.run.usage.planningInput)),
    outputTokens: avg(ok.map((r) => r.run.usage.answerOutput + r.run.usage.planningOutput)),
    embeddingTokens: avg(ok.map((r) => r.run.usage.embeddingTokens)),
    totalTokens: avg(ok.map((r) => r.run.usage.totalTokens)),
    latency: avg(ok.map((r) => r.run.timings.totalMs)),
    cost: avg(ok.map((r) => r.run.usage.costUsd)),
    costComplete: ok.every((r) => r.run.usage.costUsd !== null),
    toolCalls: mode === 'agentic_rag' ? avg(ok.map((r) => r.run.agentStats?.toolCalls)) : null,
    rounds: mode === 'agentic_rag' ? avg(ok.map((r) => r.run.agentStats?.retrievalRounds)) : null,
    duplicates: mode === 'agentic_rag' ? avg(ok.map((r) => r.run.agentStats?.duplicateSearches)) : null,
    toolErrors: mode === 'agentic_rag' ? avg(ok.map((r) => r.run.agentStats?.toolErrors)) : null,
    errors: rs.length - ok.length,
  };
}

export function Evaluation(props: Shared & { setQuestions: (q: GoldenQuestion[]) => void }) {
  const [tab, setTab] = useState<'results' | 'golden'>('results');
  return (
    <>
      <PageHeader
        title="Evaluation Results"
        description="Benchmark the four modes on the golden questions. Deterministic metrics are computed from execution and reviewed relevance judgments; quality scores are LLM-judged (labelled) and can be overridden by human review."
      />
      <div className="mb-5 inline-flex rounded-lg border border-ink-600 bg-ink-850 p-0.5">
        {(['results', 'golden'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cx('rounded-md px-4 py-1.5 text-sm', tab === t ? 'bg-accent-strong text-white' : 'text-slate-400 hover:text-slate-200')}>
            {t === 'results' ? 'Benchmark results' : 'Golden dataset'}
          </button>
        ))}
      </div>
      {tab === 'results' ? <Results {...props} /> : <GoldenEditor questions={props.questions} setQuestions={props.setQuestions} openChunk={props.openChunk} />}
    </>
  );
}

function Results({ questions, openChunk, health }: Shared) {
  const [batches, setBatches] = useState<EvaluationBatch[]>([]);
  const [batchId, setBatchId] = useState<string>('');
  const [rows, setRows] = useState<EvaluationRow[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [selectedRun, setSelectedRun] = useState<string | null>(null);

  const [qSel, setQSel] = useState<string[]>([]);
  const [modeSel, setModeSel] = useState<Mode[]>([...MODES]);
  const [repeats, setRepeats] = useState(1);
  const [judge, setJudge] = useState(true);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!qSel.length && questions.length) setQSel(questions.filter((q) => q.primary).map((q) => q.id));
  }, [questions, qSel.length]);

  const loadBatches = useCallback(() => api.batches().then((r) => {
    setBatches(r.batches);
    return r.batches;
  }), []);

  const loadResults = useCallback((id: string) => {
    setLoading(true);
    return api.results(id || undefined).then(
      (r) => {
        setRows(r.rows);
        setLoading(false);
      },
      (e) => {
        setError(e);
        setLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    loadBatches().then((b) => {
      const id = b[0]?.batchId ?? '';
      setBatchId(id);
      loadResults(id);
    }, setError);
  }, [loadBatches, loadResults]);

  const current = batches.find((b) => b.batchId === batchId);
  useEffect(() => {
    if (current?.status !== 'running') return;
    const t = setInterval(() => {
      loadBatches();
      loadResults(batchId);
    }, 2500);
    return () => clearInterval(t);
  }, [current?.status, batchId, loadBatches, loadResults]);

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const b = await api.startEvaluation({ questionIds: qSel, modes: modeSel, repeats, judge });
      await loadBatches();
      setBatchId(b.batchId);
      setRows([]);
    } catch (e) {
      setError(e);
    }
    setStarting(false);
  }

  const aggs = useMemo(() => MODES.map((m) => aggregate(rows, m)).filter((a) => a.n > 0), [rows]);
  const hasJudge = aggs.some((a) => a.judged > 0);

  return (
    <div className="space-y-5">
      <Card title="Run benchmark" subtitle="Runs each selected question × mode × repeat sequentially. LLM judging is a separate, optional cost.">
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_auto]">
          <div>
            <span className="mb-1.5 block text-xs font-medium text-slate-400">Questions</span>
            <div className="flex flex-wrap gap-2">
              {questions.map((q) => {
                const on = qSel.includes(q.id);
                return (
                  <button
                    key={q.id}
                    title={q.text}
                    onClick={() => setQSel(on ? qSel.filter((x) => x !== q.id) : [...qSel, q.id])}
                    className={cx('rounded-md border px-2.5 py-1 text-xs', on ? 'border-accent bg-accent/15 text-white' : 'border-ink-600 text-slate-400 hover:text-slate-200')}
                  >
                    {q.id}
                  </button>
                );
              })}
              <button className="px-2 text-xs text-accent hover:underline" onClick={() => setQSel(questions.map((q) => q.id))}>select all</button>
            </div>
            <span className="mb-1.5 mt-4 block text-xs font-medium text-slate-400">Modes</span>
            <div className="flex flex-wrap gap-2">
              {MODES.map((m) => {
                const on = modeSel.includes(m);
                return (
                  <button key={m} onClick={() => setModeSel(on ? modeSel.filter((x) => x !== m) : [...modeSel, m])} className={cx('rounded-md border px-2.5 py-1 text-xs', on ? 'border-accent bg-accent/15 text-white' : 'border-ink-600 text-slate-400')}>
                    {MODE_LABELS[m]}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="w-64 space-y-3">
            <Field label="Repeats per question/mode">
              <input type="number" min={1} max={5} className={inputCls} value={repeats} onChange={(e) => setRepeats(Number(e.target.value))} />
            </Field>
            <Toggle checked={judge} onChange={setJudge} label="LLM-judge answers" hint="Adds one judge call per run" />
            <Button variant="primary" className="w-full" onClick={start} loading={starting} disabled={!qSel.length || !modeSel.length || !health?.corpusReady || current?.status === 'running'}>
              <Play className="h-4 w-4" /> Start ({qSel.length * modeSel.length * repeats} runs)
            </Button>
          </div>
        </div>
      </Card>

      <ErrorBox error={error} />

      <div className="flex flex-wrap items-center gap-3">
        <select className={cx(inputCls, 'max-w-lg')} value={batchId} onChange={(e) => { setBatchId(e.target.value); loadResults(e.target.value); setSelectedRun(null); }}>
          <option value="">All recent runs (including Live Demo)</option>
          {batches.map((b) => (
            <option key={b.batchId} value={b.batchId}>
              {new Date(b.createdAt).toLocaleString()} — {b.questionIds.length}Q × {b.modes.length}M × {b.repeats} · {b.status}
            </option>
          ))}
        </select>
        {current?.status === 'running' && <Spinner label={`${current.progress.done}/${current.progress.total} · ${current.progress.message}`} />}
        {current?.status === 'error' && <Badge tone="red">{current.progress.message}</Badge>}
        <div className="ml-auto flex gap-2">
          <a href={api.exportUrl(batchId || undefined, 'csv')}><Button size="sm"><Download className="h-3.5 w-3.5" /> CSV</Button></a>
          <a href={api.exportUrl(batchId || undefined, 'json')}><Button size="sm"><Download className="h-3.5 w-3.5" /> JSON</Button></a>
        </div>
      </div>

      {loading && !rows.length ? (
        <Spinner label="Loading results…" />
      ) : !rows.length ? (
        <Empty title="No evaluation results yet">
          Ingest the corpus, select questions and modes above, and press Start. Results appear here as each run finishes. Nothing is shown until real runs exist.
        </Empty>
      ) : (
        <>
          <ComparisonTable aggs={aggs} hasJudge={hasJudge} />
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <QualityChart aggs={aggs} x="latency" />
            <QualityChart aggs={aggs} x="cost" />
          </div>
          <QuestionMatrix rows={rows} questions={questions} onSelect={setSelectedRun} selected={selectedRun} />
          {selectedRun && <RunDetail runId={selectedRun} questions={questions} openChunk={openChunk} onChanged={() => loadResults(batchId)} />}
          <History rows={rows} onSelect={setSelectedRun} />
        </>
      )}
    </div>
  );
}

function H({ children, kind }: { children: ReactNode; kind: ValueKind }) {
  return (
    <th className="px-3 py-2 align-bottom font-medium">
      <div className="flex flex-col items-start gap-1">
        <span>{children}</span>
        <KindTag kind={kind} />
      </div>
    </th>
  );
}

function ComparisonTable({ aggs, hasJudge }: { aggs: Agg[]; hasJudge: boolean }) {
  const s = (v: number | null, applicable = true) => (!applicable ? 'N/A' : v == null ? '—' : `${fmtScore(v)}/5`);
  const p = (v: number | null, applicable = true) => (!applicable ? 'N/A' : v == null ? 'Not evaluated' : fmtPct(v));
  return (
    <Card title="Mode comparison" subtitle={`Averages across runs. LLM-judged scores are 1–5 from the evaluator model, not ground truth.${hasJudge ? '' : ' No runs have been judged yet.'}`}>
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full whitespace-nowrap text-left text-[13px]">
          <thead className="text-[11px] uppercase tracking-wide text-slate-500">
            <tr className="border-b border-ink-700">
              <th className="px-3 py-2 align-bottom font-medium">Mode</th>
              <H kind="llm">Grounded</H>
              <H kind="llm">Faithful</H>
              <H kind="llm">Correct</H>
              <H kind="llm">Complete</H>
              <H kind="llm">Relevant</H>
              <H kind="human">Human correct</H>
              <H kind="measured">Citations resolve</H>
              <H kind="llm">Citation support</H>
              <H kind="llm">Citation coverage</H>
              <H kind="llm">Unsupported claims</H>
              <H kind="llm">Abstention quality</H>
              <H kind="measured">Recall@K</H>
              <H kind="measured">Precision@K</H>
              <H kind="measured">Input tok</H>
              <H kind="measured">Output tok</H>
              <H kind="measured">Embed tok</H>
              <H kind="measured">Total tok</H>
              <H kind="measured">Latency</H>
              <H kind="estimated">Est. cost</H>
              <H kind="measured">Tool calls / rounds</H>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700/60 tabular-nums">
            {aggs.map((a) => {
              const rag = a.mode !== 'no_rag';
              return (
                <tr key={a.mode}>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2 font-medium text-slate-100">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ background: MODE_COLORS[a.mode] }} />
                      {MODE_LABELS[a.mode]}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      n={a.n} · judged {a.judged}{a.human ? ` · human ${a.human}` : ''}{a.errors ? ` · ${a.errors} error(s)` : ''}
                    </div>
                  </td>
                  <td className="px-3">{s(a.groundedness, rag)}</td>
                  <td className="px-3">{s(a.faithfulness, rag)}</td>
                  <td className="px-3">{s(a.correctness)}</td>
                  <td className="px-3">{s(a.completeness)}</td>
                  <td className="px-3">{s(a.relevance)}</td>
                  <td className="px-3">{a.humanCorrectness == null ? '—' : `${fmtScore(a.humanCorrectness)}/5`}</td>
                  <td className="px-3">{p(a.citationValid, rag)}</td>
                  <td className="px-3">{s(a.citationSupport, rag)}</td>
                  <td className="px-3">{p(a.citationCoverage, rag)}</td>
                  <td className="px-3">{p(a.unsupportedRate)}</td>
                  <td className="px-3">{p(a.abstentionQuality)}</td>
                  <td className="px-3">{p(a.recall, rag)}</td>
                  <td className="px-3">{p(a.precision, rag)}</td>
                  <td className="px-3">{fmtNum(a.inputTokens && Math.round(a.inputTokens))}</td>
                  <td className="px-3">{fmtNum(a.outputTokens && Math.round(a.outputTokens))}</td>
                  <td className="px-3">{rag ? fmtNum(a.embeddingTokens && Math.round(a.embeddingTokens)) : 'N/A'}</td>
                  <td className="px-3">{fmtNum(a.totalTokens && Math.round(a.totalTokens))}</td>
                  <td className="px-3">{fmtMs(a.latency)}</td>
                  <td className="px-3">{a.costComplete ? fmtCost(a.cost) : 'pricing not set'}</td>
                  <td className="px-3">{a.mode === 'agentic_rag' ? `${fmtScore(a.toolCalls)} / ${fmtScore(a.rounds)}` : 'N/A'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {aggs.some((a) => a.mode === 'agentic_rag') && (
        <p className="mt-3 text-xs text-slate-500">
          Agent: duplicate searches blocked avg {fmtScore(aggs.find((a) => a.mode === 'agentic_rag')?.duplicates)}, tool errors avg {fmtScore(aggs.find((a) => a.mode === 'agentic_rag')?.toolErrors)}. Agent retrieval metrics use all unique chunks the tools returned. Lower token counts are not automatically better — compare them with quality.
        </p>
      )}
    </Card>
  );
}

function QualityChart({ aggs, x }: { aggs: Agg[]; x: 'latency' | 'cost' }) {
  const pricing = aggs.every((a) => a.costComplete);
  const useCost = x === 'cost' && pricing;
  const data = aggs
    .filter((a) => a.correctness != null)
    .map((a) => ({
      mode: a.mode,
      label: MODE_LABELS[a.mode],
      x: x === 'latency' ? (a.latency ?? 0) / 1000 : useCost ? a.cost ?? 0 : a.totalTokens ?? 0,
      y: a.correctness,
    }));
  const xLabel = x === 'latency' ? 'Mean latency (s), measured' : useCost ? 'Mean est. cost (USD)' : 'Mean total tokens, measured';
  const title = x === 'latency' ? 'Quality vs latency' : useCost ? 'Quality vs cost' : 'Quality vs tokens';
  return (
    <Card
      title={title}
      subtitle={x === 'cost' && !pricing ? 'Pricing is not configured, so tokens stand in for cost (Settings → Pricing).' : 'Y: mean correctness (LLM-judged, 1–5). Upper-left is better.'}
    >
      {data.length === 0 ? (
        <p className="text-sm text-slate-400">Judge at least one run to plot quality.</p>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 16, right: 32, bottom: 28, left: 8 }}>
              <CartesianGrid stroke="#1c2842" strokeDasharray="3 3" />
              <XAxis type="number" dataKey="x" name={xLabel} stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 11 }} label={{ value: xLabel, position: 'insideBottom', offset: -14, fill: '#94a3b8', fontSize: 11 }} tickFormatter={(v) => (useCost ? `$${Number(v).toFixed(4)}` : String(Math.round(v * 100) / 100))} />
              <YAxis type="number" dataKey="y" domain={[1, 5]} ticks={[1, 2, 3, 4, 5]} stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 11 }} width={32} />
              <ZAxis range={[140, 140]} />
              <Tooltip
                cursor={{ stroke: '#2a3756' }}
                content={({ payload }) => {
                  const d = payload?.[0]?.payload as (typeof data)[number] | undefined;
                  if (!d) return null;
                  return (
                    <div className="rounded-lg border border-ink-600 bg-ink-900 px-3 py-2 text-xs text-slate-200 shadow-lg">
                      <div className="mb-1 font-medium">{d.label}</div>
                      <div className="text-slate-400">Correctness (LLM): {d.y?.toFixed(2)} / 5</div>
                      <div className="text-slate-400">{xLabel}: {useCost ? fmtCost(d.x) : d.x.toFixed(2)}</div>
                    </div>
                  );
                }}
              />
              {data.map((d) => (
                <Scatter key={d.mode} data={[d]} fill={MODE_COLORS[d.mode]} stroke="#0b1220" strokeWidth={2}>
                  <LabelList dataKey="label" position="top" offset={10} style={{ fill: '#cbd5e1', fontSize: 11 }} />
                </Scatter>
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </Card>
  );
}

function QuestionMatrix({ rows, questions, onSelect, selected }: { rows: EvaluationRow[]; questions: GoldenQuestion[]; onSelect: (id: string) => void; selected: string | null }) {
  const qids = [...new Set(rows.map((r) => r.run.questionId ?? `custom: ${r.run.question.slice(0, 40)}`))];
  return (
    <Card title="Question-level comparison" subtitle="Each cell lists individual runs (repeats are shown separately, not collapsed). Click a run for details.">
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead className="text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2 pr-3">Question</th>
              {MODES.map((m) => <th key={m} className="px-2 py-2">{MODE_LABELS[m]}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700/60">
            {qids.map((qid) => {
              const q = questions.find((x) => x.id === qid);
              return (
                <tr key={qid} className="align-top">
                  <td className="max-w-xs py-2 pr-3">
                    <div className="font-mono text-xs text-slate-300">{qid}</div>
                    {q && <div className="text-xs text-slate-500">{q.category}{q.abstention === 'expected' ? ' · abstention expected' : ''}</div>}
                  </td>
                  {MODES.map((m) => (
                    <td key={m} className="px-2 py-2">
                      <div className="flex flex-col gap-1">
                        {rows
                          .filter((r) => (r.run.questionId ?? `custom: ${r.run.question.slice(0, 40)}`) === qid && r.run.mode === m)
                          .map((r) => (
                            <button
                              key={r.run.runId}
                              onClick={() => onSelect(r.run.runId)}
                              className={cx('rounded-md border px-2 py-1 text-left text-[11.5px] tabular-nums', selected === r.run.runId ? 'border-accent bg-accent/10' : 'border-ink-700 bg-ink-850 hover:border-ink-600')}
                            >
                              {r.run.error ? (
                                <span className="text-rose-300">error</span>
                              ) : (
                                <>
                                  <span className="text-slate-200">{r.judge ? `C ${r.judge.output.correctness}/5` : 'unjudged'}</span>
                                  {r.human && <span className="text-emerald-300"> · H {r.human.correctness}/5</span>}
                                  <span className="text-slate-500"> · {fmtMs(r.run.timings.totalMs)}</span>
                                  {r.run.retrievalMetrics && <span className="text-slate-500"> · R {fmtPct(r.run.retrievalMetrics.recallAtK)}</span>}
                                  {r.run.abstained && <span className="text-amber-300"> · abstained</span>}
                                </>
                              )}
                            </button>
                          ))}
                      </div>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RunDetail({ runId, questions, openChunk, onChanged }: { runId: string; questions: GoldenQuestion[]; openChunk: (id: string) => void; onChanged: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getRun>> | null>(null);
  const [judging, setJudging] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(() => api.getRun(runId).then(setData, setError), [runId]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  if (!data) return error ? <ErrorBox error={error} /> : <Spinner label="Loading run…" />;
  const q = questions.find((x) => x.id === data.run.questionId);
  const j = data.judge;

  async function runJudge(force: boolean) {
    setJudging(true);
    setError(null);
    try {
      await api.judge(runId, force);
      await load();
      onChanged();
    } catch (e) {
      setError(e);
    }
    setJudging(false);
  }

  return (
    <div className="space-y-5">
      <Card
        title={`Run detail · ${MODE_LABELS[data.run.mode]} · ${data.run.questionId ?? 'custom'}`}
        subtitle={`run ${data.run.runId} · corpus ${data.run.config.corpusVersion}`}
        actions={
          <Button size="sm" onClick={() => runJudge(Boolean(j))} loading={judging} disabled={Boolean(data.run.error)}>
            <Gavel className="h-3.5 w-3.5" /> {j ? 'Re-judge' : 'LLM-judge this run'}
          </Button>
        }
      >
        <ErrorBox error={error} />
        {j ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
              <KindTag kind="llm" /> evaluator {j.judgeModel} · {j.rubricVersion} · {new Date(j.createdAt).toLocaleString()}
            </div>
            <div className="grid grid-cols-3 gap-2 text-sm md:grid-cols-6">
              {(['groundedness', 'faithfulness', 'correctness', 'completeness', 'relevance', 'citationSupport'] as const).map((k) => (
                <div key={k} className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
                  <div className="text-[11px] uppercase text-slate-500">{k.replace('citationSupport', 'citation support')}</div>
                  <div className="font-semibold tabular-nums text-slate-100">{j.output[k] == null ? 'N/A' : `${j.output[k]}/5`}</div>
                </div>
              ))}
            </div>
            <p className="text-sm text-slate-300">{j.output.explanation}</p>
            <div className="text-xs text-slate-400">
              Claims: {j.output.totalClaims} · needing evidence {j.output.claimsNeedingEvidence} · cited {j.output.claimsWithCitation} · unsupported {j.output.unsupportedClaims} · abstained {String(j.output.abstained)} · abstention correct {String(j.output.abstentionCorrect)}
            </div>
            {q && (
              <ul className="space-y-1 text-xs">
                {q.expectedAnswerPoints.map((pt, i) => (
                  <li key={i} className={j.output.expectedPointsCovered[i] ? 'text-teal-200' : 'text-slate-500'}>
                    {j.output.expectedPointsCovered[i] ? '✓' : '✗'} {pt}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="text-sm text-slate-400">Not judged yet. Judging is a separate model call and is cached per run.</p>
        )}
      </Card>
      <HumanReviewForm runId={runId} existing={data.human} primary={Boolean(q?.primary)} noEvidence={data.run.noEvidenceSupplied} onSaved={() => { load(); onChanged(); }} />
      <RunView run={data.run} onCite={openChunk} showSteps />
    </div>
  );
}

function HumanReviewForm({ runId, existing, primary, noEvidence, onSaved }: { runId: string; existing: Awaited<ReturnType<typeof api.getRun>>['human']; primary: boolean; noEvidence: boolean; onSaved: () => void }) {
  const [f, setF] = useState({
    reviewer: existing?.reviewer ?? '',
    correctness: existing?.correctness ?? 3,
    groundedness: existing?.groundedness ?? (noEvidence ? null : 3),
    completeness: existing?.completeness ?? 3,
    citationCorrectness: existing?.citationCorrectness ?? (noEvidence ? null : 3),
    notes: existing?.notes ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const score = (k: 'correctness' | 'groundedness' | 'completeness' | 'citationCorrectness', label: string, nullable = false) => (
    <Field label={label}>
      <select className={inputCls} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value === '' ? null : Number(e.target.value) })}>
        {nullable && <option value="">N/A</option>}
        {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
    </Field>
  );
  return (
    <Card title={<span className="flex items-center gap-2">Human review <KindTag kind="human" />{primary && <Badge tone="accent">primary question</Badge>}</span>} subtitle={existing ? `Last saved by ${existing.reviewer} at ${new Date(existing.createdAt).toLocaleString()}` : 'Scores 1–5; stored alongside (not replacing) LLM-judged scores'}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Field label="Reviewer">
          <input className={inputCls} value={f.reviewer} onChange={(e) => setF({ ...f, reviewer: e.target.value })} placeholder="Name or initials" />
        </Field>
        {score('correctness', 'Correctness')}
        {score('groundedness', 'Groundedness', true)}
        {score('completeness', 'Completeness')}
        {score('citationCorrectness', 'Citation correctness', true)}
      </div>
      <div className="mt-3">
        <Field label="Notes">
          <textarea className={cx(inputCls, 'min-h-[60px]')} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          loading={saving}
          disabled={!f.reviewer.trim()}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await api.review(runId, f);
              onSaved();
            } catch (e) {
              setError(e);
            }
            setSaving(false);
          }}
        >
          Save review
        </Button>
        <ErrorBox error={error} />
      </div>
    </Card>
  );
}

function History({ rows, onSelect }: { rows: EvaluationRow[]; onSelect: (id: string) => void }) {
  const sorted = [...rows].sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
  return (
    <Card title="Run history" subtitle="Every execution with its recorded configuration">
      <div className="scroll-thin max-h-96 overflow-auto">
        <table className="w-full text-left text-[12.5px]">
          <thead className="sticky top-0 bg-ink-900 text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              {['Time', 'Mode', 'Question', 'Model', 'Prompt', 'Latency', 'Tokens', 'Status'].map((h) => <th key={h} className="py-2 pr-3">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700/60">
            {sorted.map(({ run, judge }) => (
              <tr key={run.runId} className="cursor-pointer hover:bg-ink-850" onClick={() => onSelect(run.runId)}>
                <td className="py-1.5 pr-3 text-slate-400">{new Date(run.createdAt).toLocaleTimeString()}</td>
                <td className="py-1.5 pr-3">{MODE_LABELS[run.mode]}</td>
                <td className="py-1.5 pr-3 font-mono text-xs">{run.questionId ?? 'custom'}</td>
                <td className="py-1.5 pr-3 text-slate-400">{run.config.answerModel}</td>
                <td className="py-1.5 pr-3 text-slate-400">{run.config.promptVersion}</td>
                <td className="py-1.5 pr-3 tabular-nums">{fmtMs(run.timings.totalMs)}</td>
                <td className="py-1.5 pr-3 tabular-nums">{fmtNum(run.usage.totalTokens)}</td>
                <td className="py-1.5 pr-3">{run.error ? <Badge tone="red">error</Badge> : judge ? <Badge tone="accent">judged</Badge> : <Badge>ok</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
