import { useEffect, useState, type ReactNode } from 'react';
import { ChevronDown, Gavel, Info, Play } from 'lucide-react';
import type { JudgeResult, Mode, RetrievalConfig, RunResult } from '@rag-lab/shared';
import { api } from '../api.ts';
import type { Shared } from '../App.tsx';
import { ChunkTable, Steps } from '../RunView.tsx';
import { AgentTimeline } from './AgentTrace.tsx';
import { Answer, Badge, Button, ErrorBox, KindTag, PageHeader, Spinner, cx, fmtMs, fmtNum, fmtPct, inputCls, type ValueKind } from '../ui.tsx';

/** Flat list of approaches. Each optimization adds exactly one technique to Basic RAG, so its effect is isolated. */
type VariantId = 'no_rag' | 'basic_rag' | 'hybrid' | 'rewrite' | 'rerank' | 'auto_filter' | 'agentic_rag';
type Group = 'none' | 'basic' | 'optimized' | 'agentic';
interface Variant {
  id: VariantId;
  group: Group;
  label: string;
  hint: string;
  mode: Mode;
  retrieval?: Partial<RetrievalConfig>;
}
/** Optimized RAG with every technique off = vector search like Basic RAG (citation validation and abstention stay on). */
const ONE_TECHNIQUE = { keyword: false, vector: true, queryRewrite: false, rerank: false, autoFilter: false };
const VARIANTS: Variant[] = [
  { id: 'no_rag', group: 'none', label: 'No RAG', hint: 'Model knowledge only', mode: 'no_rag' },
  { id: 'basic_rag', group: 'basic', label: 'Basic RAG', hint: 'Vector search → answer', mode: 'basic_rag' },
  { id: 'hybrid', group: 'optimized', label: 'Hybrid search', hint: 'Basic + keyword search, RRF', mode: 'optimized_rag', retrieval: { ...ONE_TECHNIQUE, keyword: true } },
  { id: 'rewrite', group: 'optimized', label: 'Rewrite question', hint: 'Basic + query rewrite', mode: 'optimized_rag', retrieval: { ...ONE_TECHNIQUE, queryRewrite: true } },
  { id: 'rerank', group: 'optimized', label: 'Rerank', hint: 'Basic + cross-encoder rerank', mode: 'optimized_rag', retrieval: { ...ONE_TECHNIQUE, rerank: true } },
  { id: 'auto_filter', group: 'optimized', label: 'Auto filter', hint: 'Basic + inferred document filter', mode: 'optimized_rag', retrieval: { ...ONE_TECHNIQUE, autoFilter: true } },
  { id: 'agentic_rag', group: 'agentic', label: 'Agentic RAG', hint: 'Agent plans its searches', mode: 'agentic_rag' },
];
const VIDS = VARIANTS.map((v) => v.id);

/** One color per family (validated for contrast and color-blind separation on the navy surface); No RAG stays neutral. */
const GROUP_STYLE: Record<Group, { card: string; chip: string; head: string }> = {
  none: { card: 'border-ink-600', chip: 'border-slate-500/60 bg-ink-700/60 text-slate-200', head: 'border-t-slate-500' },
  basic: { card: 'border-[#3987e5]/60', chip: 'border-[#3987e5]/70 bg-[#3987e5]/15 text-blue-100', head: 'border-t-[#3987e5]' },
  optimized: { card: 'border-[#199e70]/70', chip: 'border-[#199e70]/80 bg-[#199e70]/15 text-emerald-100', head: 'border-t-[#199e70]' },
  agentic: { card: 'border-[#9085e9]/70', chip: 'border-[#9085e9]/80 bg-[#9085e9]/15 text-violet-100', head: 'border-t-[#9085e9]' },
};
const V = Object.fromEntries(VARIANTS.map((v) => [v.id, v])) as Record<VariantId, Variant>;

interface Slot {
  status: 'idle' | 'running' | 'done' | 'error';
  run?: RunResult;
  error?: unknown;
  judge?: JudgeResult;
  judging?: boolean;
  judgeError?: string;
}
type Slots = Record<VariantId, Slot>;

const emptySlots = (status: Slot['status'] = 'idle') => Object.fromEntries(VIDS.map((m) => [m, { status }])) as Slots;

export function LiveDemo({ questions, demoQuestionId, openChunk, setTraceRunId }: Shared) {
  const [questionId, setQuestionId] = useState<string | null>(demoQuestionId ?? null);
  const [text, setText] = useState('');
  const [slots, setSlots] = useState<Slots>(() => emptySlots());
  const [selected, setSelected] = useState<VariantId[]>([...VIDS]);
  useEffect(() => {
    const q = questions.find((x) => x.id === (demoQuestionId ?? questionId)) ?? questions.find((x) => x.primary);
    if (q && !text) {
      setQuestionId(q.id);
      setText(q.text);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questions, demoQuestionId]);

  const update = (m: VariantId, patch: Partial<Slot>) => setSlots((s) => ({ ...s, [m]: { ...s[m], ...patch } }));
  const running = VIDS.some((m) => slots[m].status === 'running');
  const judging = VIDS.some((m) => slots[m].judging);
  const okRuns = VIDS.filter((m) => slots[m].status === 'done');
  const anyResult = VIDS.some((m) => slots[m].status !== 'idle');

  function pick(id: string) {
    const q = questions.find((x) => x.id === id);
    if (!q) return;
    setQuestionId(q.id);
    setText(q.text);
    setSlots(emptySlots());
  }

  /** Runs the selected approaches in parallel with the same question and server-side settings. */
  function compare() {
    const q = text.trim();
    setSlots((prev) =>
      Object.fromEntries(VIDS.map((m) => [m, selected.includes(m) ? { status: 'running' } : prev[m].run?.question === q ? prev[m] : { status: 'idle' }])) as Slots,
    );
    for (const m of selected) {
      api.run({ question: q, mode: V[m].mode, questionId: questionId ?? undefined, retrieval: V[m].retrieval }).then(
        (run) => {
          update(m, { status: run.error ? 'error' : 'done', run, error: run.error ? new Error(run.error) : undefined });
          if (m === 'agentic_rag') setTraceRunId(run.runId);
        },
        (error) => update(m, { status: 'error', error }),
      );
    }
  }

  /** Explicit, separate action: one LLM-judge call per finished run (cached server-side per run). */
  function score() {
    for (const m of okRuns.filter((x) => !slots[x].judge)) {
      const run = slots[m].run!;
      update(m, { judging: true, judgeError: undefined });
      api.judge(run.runId).then(
        (judge) => update(m, { judge, judging: false }),
        (e) => update(m, { judging: false, judgeError: e instanceof Error ? e.message : String(e) }),
      );
    }
  }

  const primary = questions.filter((q) => q.primary);
  const firstRun = okRuns.map((m) => slots[m].run!)[0];
  const judgeModel = VIDS.map((m) => slots[m].judge?.judgeModel).find(Boolean);

  return (
    <>
      <PageHeader title="Compare: No RAG vs RAG vs Optimized RAG vs Agentic RAG" description="The same question and model. Each optimization column adds one technique to Basic RAG." />

      <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {primary.map((q, i) => (
          <button
            key={q.id}
            onClick={() => pick(q.id)}
            disabled={running}
            className={cx(
              'flex flex-col items-start rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-60',
              questionId === q.id ? 'border-accent bg-accent/10' : 'border-ink-700 bg-ink-900 hover:border-ink-600',
            )}
          >
            <Badge tone="accent">Question {i + 1} · {q.category.replace('Demo: ', '')}</Badge>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-200">{q.text}</p>
          </button>
        ))}
      </div>

      <div className="mb-5 flex flex-wrap items-start gap-3">
        <textarea
          className={cx(inputCls, 'min-h-[67px] flex-1 resize-y text-[14px] leading-relaxed')}
          rows={2}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (questions.find((q) => q.id === questionId)?.text !== e.target.value) setQuestionId(null);
          }}
          placeholder="Or type your own question…"
        />
        <button
          onClick={compare}
          disabled={!text.trim() || running || selected.length === 0}
          className="inline-flex h-[46px] items-center gap-2 rounded-lg bg-accent-strong px-6 text-sm font-semibold text-white hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Play className="h-4 w-4" />
          {selected.length === VIDS.length ? 'Compare all' : selected.length === 1 ? `Run ${V[selected[0]].label}` : `Run ${selected.length} approaches`}
        </button>
      </div>

      <div className="-mt-2 mb-5 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-xs text-slate-500">Approaches:</span>
        {VARIANTS.map((v) => {
          const on = selected.includes(v.id);
          return (
            <button
              key={v.id}
              disabled={running}
              title={v.hint}
              onClick={() => setSelected(on ? selected.filter((x) => x !== v.id) : VIDS.filter((x) => x === v.id || selected.includes(x)))}
              className={cx('rounded-md border px-2 py-0.5 text-[11.5px] transition-colors disabled:opacity-60', on ? GROUP_STYLE[v.group].chip : 'border-ink-600 text-slate-500 hover:text-slate-300')}
            >
              {on ? '✓ ' : ''}
              {v.label}
            </button>
          );
        })}
      </div>

      {anyResult && (
        <section className="mb-5 rounded-xl border border-ink-700 bg-ink-900/80">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700/70 px-5 py-3">
            <div className="text-xs text-slate-400">
              {firstRun ? (
                <>
                  Model <span className="text-slate-200">{firstRun.config.answerModel}</span> for every approach · {firstRun.questionId ? `golden question ${firstRun.questionId}` : 'custom question'}
                  {judgeModel && <> · quality scored by <span className="text-slate-200">{judgeModel}</span></>}
                </>
              ) : (
                'Running…'
              )}
            </div>
            <Button size="sm" onClick={score} loading={judging} disabled={running || !okRuns.length || okRuns.every((m) => slots[m].judge)}>
              <Gavel className="h-3.5 w-3.5" /> {okRuns.length && okRuns.every((m) => slots[m].judge) ? 'Answers scored' : 'Score answers (LLM judge)'}
            </Button>
          </header>
          <ComparisonTable slots={slots} openChunk={openChunk} />
        </section>
      )}

      {okRuns.length > 0 && (
        <div className="mb-5">
          <Disclosure title="Detailed evaluation" hint="Faithfulness, completeness and retrieval metrics">
            <DetailedEvaluation slots={slots} openChunk={openChunk} />
          </Disclosure>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
        {VIDS.map((m) => (
          <AnswerCard key={m} variant={V[m]} slot={slots[m]} openChunk={openChunk} />
        ))}
      </div>

      {okRuns.length > 0 && <TechnicalDetails slots={slots} openChunk={openChunk} />}
    </>
  );
}

// ---------------- comparison table ----------------

type Cell = { node: ReactNode; value?: number | null; title?: string };
interface Row {
  label: string;
  kind: ValueKind;
  /** 'high'/'low' = highlight best; undefined = never highlight (e.g. token counts). */
  better?: 'high' | 'low';
  note?: string;
  cell: (run: RunResult, judge: JudgeResult | undefined, slot: Slot, openChunk: (id: string) => void) => Cell;
}

const DOC_SHORT: Record<string, string> = { 'csf-2.0': 'CSF', 'sp800-207': '800-207', 'sp800-53r5': '800-53' };

const NA: Cell = { node: <span className="text-slate-500">N/A</span> };
const notEvaluated = (title?: string): Cell => ({ node: <span className="text-slate-500">Not evaluated</span>, title });
const score5 = (v: number | null | undefined, slot: Slot): Cell =>
  slot.judging ? { node: <Spinner /> } : v == null ? notEvaluated(slot.judgeError ?? 'Press “Score answers” to run the LLM judge') : { node: `${v} / 5`, value: v };

const SECTIONS: Array<{ title: string; rows: Row[] }> = [
  {
    title: 'Answer quality',
    rows: [
      { label: 'Answer correctness', kind: 'llm', better: 'high', cell: (_r, j, s) => score5(j?.output.correctness, s) },
      { label: 'Groundedness', kind: 'llm', better: 'high', cell: (r, j, s) => (r.noEvidenceSupplied ? NA : score5(j?.output.groundedness, s)) },
      {
        label: 'Citations resolve',
        kind: 'measured',
        better: 'high',
        note: 'Cited chunk IDs that exist and were actually retrieved for this run (the source exists).',
        cell: (r) => {
          if (r.noEvidenceSupplied) return NA;
          const c = r.citationCheck;
          if (!c || c.total === 0) return { node: <span className="text-slate-400">No citations</span>, value: 0 };
          return { node: `${c.valid}/${c.total}`, value: c.valid / c.total };
        },
      },
      {
        label: 'Citation support',
        kind: 'llm',
        better: 'high',
        note: 'Whether the cited chunks actually support the sentences that cite them (LLM-judged).',
        cell: (r, j, s) => {
          if (r.noEvidenceSupplied) return NA;
          if (j && j.output.citationSupport == null) return { node: <span className="text-slate-400">No citations</span> };
          return score5(j?.output.citationSupport, s);
        },
      },
      {
        label: 'Relevant document coverage',
        kind: 'measured',
        better: 'high',
        note: 'Expected source documents that contributed at least one judged-relevant retrieved chunk. Agent: union of all tool results.',
        cell: (r, _j, _s, openChunk) => {
          if (r.noEvidenceSupplied) return NA;
          const cov = r.retrievalMetrics?.documentCoverage;
          if (!cov) return notEvaluated('Needs relevance judgments (golden question)');
          return {
            value: cov.covered.length / Math.max(1, cov.expected.length),
            node: (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span>{cov.covered.length}/{cov.expected.length}</span>
                {cov.expected.map((d) => {
                  const ids = cov.relevantByDocument[d] ?? [];
                  return (
                    <button
                      key={d}
                      disabled={!ids.length}
                      onClick={() => openChunk(ids[0])}
                      title={ids.length ? `${ids.length} relevant chunk(s): ${ids.join(', ')}. Click to open the first.` : 'No relevant chunk retrieved from this document'}
                      className={cx('rounded border px-1 text-[10.5px] font-normal', ids.length ? 'border-teal/40 text-teal-200 hover:bg-teal/10' : 'border-ink-600 text-slate-600 line-through')}
                    >
                      {DOC_SHORT[d] ?? d}
                    </button>
                  );
                })}
              </span>
            ),
          };
        },
      },
    ],
  },
  {
    title: 'Performance',
    rows: [
      { label: 'Total latency', kind: 'measured', better: 'low', cell: (r) => ({ node: fmtMs(r.timings.totalMs), value: r.timings.totalMs }) },
      { label: 'Input tokens', kind: 'measured', note: 'Answer + query-rewrite + agent-planning calls', cell: (r) => ({ node: fmtNum(r.usage.answerInput + r.usage.planningInput) }) },
      { label: 'Output tokens', kind: 'measured', note: 'Answer + query-rewrite + agent-planning calls', cell: (r) => ({ node: fmtNum(r.usage.answerOutput + r.usage.planningOutput) }) },
      {
        label: 'Total tokens',
        kind: 'measured',
        note: 'All API calls in the run, including embeddings',
        cell: (r) => ({ node: fmtNum(r.usage.totalTokens), title: `${r.usage.calls} API call(s); embedding tokens ${r.usage.embeddingTokens}` }),
      },
    ],
  },
  {
    title: 'Agentic behavior',
    rows: [
      {
        label: 'Tool-call count',
        kind: 'measured',
        cell: (r) => (r.mode !== 'agentic_rag' || !r.agentStats ? NA : { node: `${r.agentStats.toolCalls} (${r.agentStats.retrievalRounds} round${r.agentStats.retrievalRounds === 1 ? '' : 's'})` }),
      },
    ],
  },
];

function ComparisonTable({ slots, openChunk }: { slots: Slots; openChunk: (id: string) => void }) {
  return (
    <div className="scroll-thin overflow-x-auto">
      <table className="w-full table-fixed text-left text-[13.5px]">
        <colgroup>
          <col className="w-[270px]" />
          {VIDS.map((m) => <col key={m} />)}
        </colgroup>
        <thead>
          <tr>
            <th />
            <th colSpan={2} />
            <th colSpan={4} className="px-3 pt-3 text-left text-[10.5px] font-semibold uppercase tracking-wider text-[#4cc59a]">Optimized RAG · one technique each</th>
            <th />
          </tr>
          <tr className="border-b border-ink-700">
            <th className="px-5 py-2.5" />
            {VIDS.map((m) => (
              <th key={m} className={cx('border-t-2 px-3 py-2.5 align-bottom', GROUP_STYLE[V[m].group].head)}>
                <div className="flex items-center gap-2 text-[14px] font-semibold text-white">
                  {V[m].label}
                  {slots[m].status === 'running' && <Spinner />}
                  {slots[m].status === 'error' && <Badge tone="red">failed</Badge>}
                  {slots[m].status === 'idle' && <span className="text-[11px] font-normal text-slate-600">not run</span>}
                </div>
                <div className="text-[11px] font-normal text-slate-500">{V[m].hint}</div>
              </th>
            ))}
          </tr>
        </thead>
        {SECTIONS.map((section) => (
          <tbody key={section.title}>
            <tr>
              <td colSpan={VIDS.length + 1} className="bg-ink-850/70 px-5 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-slate-500">{section.title}</td>
            </tr>
            {section.rows.map((row) => {
              const cells = VIDS.map((m) => {
                const s = slots[m];
                if (s.status === 'running') return { node: <span className="text-slate-600">…</span> } as Cell;
                if (s.status !== 'done' || !s.run) return { node: <span className="text-slate-600">{s.status === 'error' ? 'Failed' : '—'}</span> } as Cell;
                return row.cell(s.run, s.judge, s, openChunk);
              });
              const nums = cells.map((c) => c.value).filter((v): v is number => typeof v === 'number');
              const best = row.better && nums.length >= 2 ? (row.better === 'high' ? Math.max(...nums) : Math.min(...nums)) : null;
              const distinct = new Set(nums).size > 1;
              return (
                <tr key={row.label} className="border-t border-ink-700/50">
                  <td className="px-5 py-2.5">
                    <div className="flex items-center gap-2 text-slate-300" title={row.note}>
                      {row.label}
                      <KindTag kind={row.kind} />
                    </div>
                  </td>
                  {cells.map((c, i) => {
                    const isBest = best !== null && distinct && c.value === best;
                    return (
                      <td key={VIDS[i]} className="px-3 py-2.5 tabular-nums" title={c.title ?? (isBest ? (row.better === 'high' ? 'Highest in this row' : 'Lowest in this row') : undefined)}>
                        <span className={cx('inline-flex items-center gap-1.5 rounded-md', isBest ? 'bg-teal/10 px-1.5 py-0.5 font-semibold text-teal-200 ring-1 ring-teal/25' : 'text-slate-100')}>
                          {c.node}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
      <p className="border-t border-ink-700/50 px-5 py-2.5 text-[11px] text-slate-500">
        Highlight = best value within a single row only; it is not an overall verdict. Token counts are not ranked, since fewer tokens is not automatically better. N/A = does not apply to this mode · Not evaluated = not measured yet.
      </p>
    </div>
  );
}

// ---------------- answer cards ----------------

/** Plain-text preview: drops markdown markers and inline citation IDs. */
const preview = (text: string) =>
  text
    .replace(/\[[^\]]*-\d{4}-[0-9a-f]{6}[^\]]*\]/g, '')
    .replace(/[#*`>]/g, '')
    .replace(/^\s*[-•]\s+/gm, '• ')
    .replace(/\n{2,}/g, '\n')
    .trim();

function AnswerCard({ variant, slot, openChunk }: { variant: Variant; slot: Slot; openChunk: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const r = slot.run;
  const valid = r ? r.citations.filter((c) => c.valid) : [];
  const docs = [...new Set(valid.map((c) => c.documentId))];
  useEffect(() => {
    setOpen(false);
    setShowSteps(false);
  }, [r?.runId]);

  return (
    <section className={cx('flex flex-col rounded-xl border bg-ink-900/80', GROUP_STYLE[variant.group].card)}>
      <header className="flex items-center justify-between gap-2 border-b border-ink-700/70 px-4 py-2.5">
        <span>
          <span className="block text-[14px] font-semibold text-white">{variant.label}</span>
          <span className="block text-[11px] text-slate-500">{variant.hint}</span>
        </span>
        {r?.abstained && <Badge tone="amber">declined: not enough evidence</Badge>}
      </header>
      <div className="px-4 py-3">
        {slot.status === 'running' && <Flow title="Processing…" steps={plannedFlow(variant.id)} running />}
        {slot.status === 'idle' && <Flow title="How it works" steps={plannedFlow(variant.id)} />}
        {slot.status === 'error' && <ErrorBox error={slot.error} title="Run failed" />}
        {r && !r.error && (
          <>
            {showSteps && (
              <div className="mb-3 border-b border-ink-700/70 pb-3">
                <Flow title="What happened (measured)" steps={actualFlow(r)} />
              </div>
            )}
            {open ? (
              <>
                <Answer text={r.answer || '(empty answer)'} onCite={openChunk} validIds={valid.map((c) => c.chunkId)} />
                {r.citations.length > 0 && (
                  <ul className="mt-3 space-y-1 border-t border-ink-700/70 pt-2.5 text-xs">
                    {r.citations.map((c) => (
                      <li key={c.chunkId} className="flex gap-2">
                        <button onClick={() => openChunk(c.chunkId)} className={cx('font-mono hover:underline', c.valid ? 'text-teal-200' : 'text-rose-300')}>
                          {c.chunkId}
                        </button>
                        <span className="text-slate-500">{c.valid ? `${c.documentId} · p.${c.pageNumber}${c.controlId ? ` · ${c.controlId}` : ''}` : 'not in retrieved evidence'}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="line-clamp-6 whitespace-pre-line text-[13.5px] leading-relaxed text-slate-300">{preview(r.answer) || '(empty answer)'}</p>
            )}
          </>
        )}
      </div>
      {r && !r.error && (
        <footer className="mt-auto border-t border-ink-700/70 px-4 py-2 text-xs text-slate-400">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span title={docs.join(', ')}>
              {r.noEvidenceSupplied ? <span className="text-amber-300/90">no sources</span> : `${valid.length} source${valid.length === 1 ? '' : 's'}${docs.length ? ` · ${docs.length} doc${docs.length === 1 ? '' : 's'}` : ''}`}
            </span>
            <span>{fmtMs(r.timings.totalMs)}</span>
            <span title="Input / output tokens across all model calls in this run">
              {fmtNum(r.usage.answerInput + r.usage.planningInput)} in · {fmtNum(r.usage.answerOutput + r.usage.planningOutput)} out
            </span>
          </div>
          <div className="mt-1.5 flex gap-4">
            <button onClick={() => setShowSteps(!showSteps)} className="text-accent hover:underline">{showSteps ? 'Hide steps' : 'Steps'}</button>
            <button onClick={() => setOpen(!open)} className="ml-auto inline-flex items-center gap-1 text-accent hover:underline">
              {open ? 'Collapse' : 'Full answer'} <ChevronDown className={cx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
            </button>
          </div>
        </footer>
      )}
    </section>
  );
}

// ---------------- pipeline flow ----------------

interface FlowStep {
  label: string;
  detail?: string;
  ms?: number;
}

/** What each mode does, shown while it runs (an explanation, not live progress). */
function plannedFlow(id: VariantId): FlowStep[] {
  const generate: FlowStep = { label: 'Generate the answer', detail: 'Only from the top chunks, with citations' };
  const validate: FlowStep = { label: 'Validate citations', detail: 'Drop citations not in the evidence' };
  switch (id) {
    case 'no_rag':
      return [{ label: 'Send the question to the model' }, { label: 'Model answers from its training data', detail: 'No documents are searched' }];
    case 'basic_rag':
      return [{ label: 'Embed the question', detail: 'OpenAI embeddings' }, { label: 'Vector search', detail: 'Top-K most similar chunks' }, generate];
    case 'hybrid':
      return [{ label: 'Two searches', detail: 'Keyword (BM25+) and vector (cosine)' }, { label: 'Fuse rankings', detail: 'Reciprocal Rank Fusion' }, generate, validate];
    case 'rewrite':
      return [{ label: 'Rewrite the question', detail: 'Into a concise search query (one model call)' }, { label: 'Vector search', detail: 'With the rewritten query' }, generate, validate];
    case 'rerank':
      return [{ label: 'Vector search', detail: 'Top 30 candidates' }, { label: 'Rerank candidates', detail: 'Local cross-encoder keeps the best K' }, generate, validate];
    case 'auto_filter':
      return [{ label: 'Infer metadata filter', detail: 'Which documents or control the question targets' }, { label: 'Vector search', detail: 'Only within the inferred filter' }, generate, validate];
    case 'agentic_rag':
      return [{ label: 'Plan', detail: 'Model decides what to search for' }, { label: 'Search tool', detail: 'Hybrid search, optionally filtered by document or control' }, { label: 'Answer', detail: 'Citing only chunks the tools returned' }];
  }
}

const STEP_LABEL: Record<string, string> = {
  'Metadata filter (auto)': 'Auto metadata filter',
  'Query rewrite': 'Rewrite the question',
  'Keyword search (BM25+-style, MiniSearch)': 'Keyword search (BM25+)',
  'Vector search (cosine)': 'Vector search',
  'Vector search': 'Embed + vector search',
  'Reciprocal Rank Fusion': 'Fuse rankings (RRF)',
  'Cross-encoder rerank (local)': 'Rerank (local)',
  'Final context': 'Top chunks to the model',
  'Abstention gate': 'Abstention gate',
};

/** The steps that actually ran, with measured durations from the run record. */
function actualFlow(r: RunResult): FlowStep[] {
  const gen: FlowStep = { label: 'Generate the answer', ms: r.timings.generationMs };
  if (r.mode === 'no_rag') return [{ label: 'Model answers (no documents)', ms: r.timings.generationMs }];
  if (r.mode === 'agentic_rag') {
    return r.agentSteps.map((s) => ({
      label: s.kind === 'model_call' ? (s.summary.startsWith('Model requested') ? 'Plan next action' : 'Write final answer') : s.kind === 'final' ? 'Done' : s.tool === 'search_documents' ? 'Search' : (s.tool ?? 'Tool'),
      detail: s.kind === 'model_call' ? s.summary.replace(/^Model /, '') : s.kind === 'final' ? s.summary : `${s.summary}${s.reason ? ` · why: ${s.reason}` : ''}`,
      ms: s.kind === 'final' ? undefined : s.durationMs,
    }));
  }
  const steps: FlowStep[] = r.steps.map((s) => ({
    label: STEP_LABEL[s.name] ?? s.name,
    detail: s.name === 'Query rewrite' ? `“${r.rewrittenQuery}”` : s.name === 'Metadata filter (auto)' ? s.detail : s.results ? `${s.results.length} chunk${s.results.length === 1 ? '' : 's'}` : undefined,
    ms: s.name === 'Final context' ? undefined : s.durationMs,
  }));
  if (r.steps.some((s) => s.name === 'Abstention gate')) return steps;
  steps.push(gen);
  if (r.citationCheck && r.mode === 'optimized_rag' && r.config.retrieval?.citationValidation) {
    steps.push({ label: 'Validate citations', detail: `${r.citationCheck.valid}/${r.citationCheck.total} resolve to retrieved chunks` });
  }
  return steps;
}

function Flow({ title, steps, running }: { title: string; steps: FlowStep[]; running?: boolean }) {
  return (
    <div>
      <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
        {title}
      </div>
      <ol className="space-y-1.5">
        {steps.map((st, i) => (
          <li key={i} className="flex gap-2.5 text-[12.5px]">
            <span className={cx('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold', running ? 'bg-accent/20 text-violet-200' : 'bg-ink-700 text-slate-300')}>{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="text-slate-200">{st.label}</span>
              {st.detail && <span className="block truncate text-[11.5px] text-slate-500" title={st.detail}>{st.detail}</span>}
            </span>
            {st.ms != null && <span className="shrink-0 font-mono text-[11px] text-slate-500">{fmtMs(st.ms)}</span>}
          </li>
        ))}
      </ol>
      {running && <p className="mt-2 text-[11px] text-slate-600">Measured timings for each step appear when the run finishes.</p>}
    </div>
  );
}

// ---------------- technical details (collapsed) ----------------

function Disclosure({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <details className="group rounded-xl border border-ink-700 bg-ink-900/60">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-3 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-4 w-4 -rotate-90 text-slate-500 transition-transform group-open:rotate-0" />
        <span className="text-sm font-medium text-slate-200">{title}</span>
        <span className="text-xs text-slate-500">{hint}</span>
      </summary>
      <div className="space-y-4 border-t border-ink-700/70 p-5">{children}</div>
    </details>
  );
}

function TechnicalDetails({ slots, openChunk }: { slots: Slots; openChunk: (id: string) => void }) {
  const retrievalRuns = VIDS.filter((id) => V[id].mode === 'basic_rag' || V[id].mode === 'optimized_rag')
    .map((id) => ({ id, run: slots[id].run }))
    .filter((x) => x.run && !x.run.error);
  const agent = slots.agentic_rag.run;
  return (
    <div className="mt-6 space-y-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Technical details</div>

      {retrievalRuns.length > 0 && (
        <Disclosure title="Retrieval: chunks, search stages, RRF and rerank scores" hint="Basic RAG and each optimization">
          {retrievalRuns.map(({ id, run }) => (
            <div key={id}>
              <div className="mb-2 text-sm font-medium text-slate-200">
                {V[id].label}
                {run!.rewrittenQuery && <span className="ml-2 text-xs font-normal text-slate-400">rewritten query: “{run!.rewrittenQuery}”</span>}
              </div>
              <Steps steps={run!.steps} onCite={openChunk} />
            </div>
          ))}
        </Disclosure>
      )}

      {agent && !agent.error && (
        <Disclosure title="Agent tool-call trace" hint={agent.agentStats ? `${agent.agentStats.toolCalls} tool calls · ${agent.agentStats.retrievalRounds} rounds · ${agent.agentStats.duplicateSearches} duplicate searches blocked · ${agent.agentStats.toolErrors} tool errors` : ''}>
          <AgentTimeline run={agent} openChunk={openChunk} />
          <div>
            <div className="mb-2 text-sm font-medium text-slate-200">Evidence the agent retrieved</div>
            <ChunkTable chunks={agent.retrieved} onCite={openChunk} cited={new Set(agent.citations.filter((c) => c.valid).map((c) => c.chunkId))} hideScore />
          </div>
        </Disclosure>
      )}
    </div>
  );
}

/** Plain-language explanations shown on hover in Detailed evaluation. */
const METRIC_HELP: Record<string, string> = {
  Faithfulness: 'Does the answer keep the meaning of the sources, without exaggerating or mixing things up?',
  Completeness: 'How many of the expected key points the answer covers.',
  Relevance: 'Does the answer actually address the question that was asked?',
  'Unsupported claims': 'Statements in the answer that the retrieved sources do not back up.',
  'Abstention appropriate': "Was it right to answer, or right to say there isn't enough information?",
  'Recall@K': 'Of all the passages that should have been found, how many were retrieved.',
  'Precision@K': 'Of the passages retrieved, how many were actually useful.',
  'Relevant chunks by document': 'The useful passages that were retrieved, grouped by document. Click one to read it.',
  'Final answer context': 'The passages the model actually used to write its answer.',
};

function InfoTip({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <span className="group/tip relative inline-flex">
      <Info className="h-3.5 w-3.5 cursor-help text-slate-500 hover:text-slate-300" aria-label={text} />
      <span role="tooltip" className="pointer-events-none absolute left-5 top-1/2 z-20 hidden w-64 -translate-y-1/2 rounded-md border border-ink-600 bg-ink-800 px-2.5 py-1.5 text-[11.5px] font-normal normal-case leading-snug tracking-normal text-slate-200 shadow-lg group-hover/tip:block">
        {text}
      </span>
    </span>
  );
}

function DetailedEvaluation({ slots, openChunk }: { slots: Slots; openChunk: (id: string) => void }) {
  const chips = (ids: string[]) => (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <button key={id} onClick={() => openChunk(id)} className="rounded border border-ink-600 px-1 font-mono text-[10.5px] text-slate-300 hover:border-teal/50 hover:text-teal-200">
          {id.replace(/-[0-9a-f]{6}$/, '')}
        </button>
      ))}
    </span>
  );
  const rows: Array<{ label: string; kind: ValueKind; get: (r: RunResult, j?: JudgeResult) => ReactNode }> = [
    { label: 'Faithfulness', kind: 'llm', get: (r, j) => (r.noEvidenceSupplied ? 'N/A' : j?.output.faithfulness != null ? `${j.output.faithfulness} / 5` : 'Not evaluated') },
    {
      label: 'Completeness',
      kind: 'llm',
      get: (_r, j) => {
        if (!j) return 'Not evaluated';
        const pts = j.output.expectedPointsCovered;
        return pts.length
          ? `${pts.filter(Boolean).length} of ${pts.length} reference points (${j.output.completeness} / 5)`
          : `${j.output.completeness} / 5 (per-point coverage unavailable)`;
      },
    },
    { label: 'Relevance', kind: 'llm', get: (_r, j) => (j ? `${j.output.relevance} / 5` : 'Not evaluated') },
    { label: 'Unsupported claims', kind: 'llm', get: (_r, j) => (j ? `${j.output.unsupportedClaims} of ${j.output.totalClaims}` : 'Not evaluated') },
    { label: 'Abstention appropriate', kind: 'llm', get: (_r, j) => (!j ? 'Not evaluated' : j.output.abstentionCorrect == null ? 'n/a' : j.output.abstentionCorrect ? 'yes' : 'no') },
    { label: 'Recall@K', kind: 'measured', get: (r) => (r.noEvidenceSupplied ? 'N/A' : r.retrievalMetrics ? `${fmtPct(r.retrievalMetrics.recallAtK)} (K=${r.retrievalMetrics.k})` : 'Not evaluated') },
    { label: 'Precision@K', kind: 'measured', get: (r) => (r.noEvidenceSupplied ? 'N/A' : r.retrievalMetrics ? fmtPct(r.retrievalMetrics.precisionAtK) : 'Not evaluated') },
    {
      label: 'Relevant chunks by document',
      kind: 'measured',
      get: (r) => {
        if (r.noEvidenceSupplied) return 'N/A';
        const cov = r.retrievalMetrics?.documentCoverage;
        if (!cov) return 'Not evaluated';
        return (
          <span className="flex flex-col gap-1.5">
            {cov.expected.map((d) => (
              <span key={d} className="flex flex-col gap-0.5">
                <span className="text-[11px] text-slate-500">{DOC_SHORT[d] ?? d}</span>
                {cov.relevantByDocument[d]?.length ? chips(cov.relevantByDocument[d]) : <span className="text-[11px] text-slate-600">none retrieved</span>}
              </span>
            ))}
          </span>
        );
      },
    },
    {
      label: 'Final answer context',
      kind: 'measured',
      get: (r) =>
        r.noEvidenceSupplied ? 'N/A' : !r.finalContextChunkIds ? 'Not recorded' : r.mode === 'agentic_rag' ? (
          <span className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-500">cited {r.finalContextChunkIds.length} of {r.retrieved.length} retrieved</span>
            {chips(r.finalContextChunkIds)}
          </span>
        ) : (
          <span className="text-[11px] text-slate-400">top {r.finalContextChunkIds.length} chunks (same as evaluated set)</span>
        ),
    },
  ];
  return (
    <>
      <div className="scroll-thin overflow-x-auto">
        <table className="w-full table-fixed text-left text-[13px]">
          <colgroup>
            <col className="w-[270px]" />
            {VIDS.map((m) => <col key={m} />)}
          </colgroup>
          <thead className="text-[11px] uppercase tracking-wide text-slate-500">
            <tr>
              <th className="py-2" />
              {VIDS.map((m) => <th key={m} className="px-3 py-2">{V[m].label}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700/50 tabular-nums">
            {rows.map((row) => (
              <tr key={row.label}>
                <td className="py-2"><span className="flex items-center gap-2 text-slate-300">{row.label} <InfoTip text={METRIC_HELP[row.label]} /> <KindTag kind={row.kind} /></span></td>
                {VIDS.map((m) => (
                  <td key={m} className="px-3 py-2 text-slate-200">{slots[m].run && !slots[m].run!.error ? row.get(slots[m].run!, slots[m].judge) : '—'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">
        Retrieval metrics use the same relevance judgments for every mode and are only computed for golden questions. Basic and Optimized are evaluated on their top-K context; the agent on the union of chunks its tool calls returned (so its K is larger), with the chunks its final answer cited shown separately.
      </p>
    </>
  );
}
