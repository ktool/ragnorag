import { useEffect, useState } from 'react';
import { ArrowRight, Play, RefreshCw, Save } from 'lucide-react';
import type { CorpusDocument, IndexStatus, RetrievalConfig, RunResult, Settings } from '@rag-lab/shared';
import { api } from '../api.ts';
import type { Shared } from '../App.tsx';
import { RunView } from '../RunView.tsx';
import { Badge, Button, Card, Empty, ErrorBox, Field, PageHeader, Spinner, Toggle, cx, inputCls } from '../ui.tsx';

export function Lab({ questions, openChunk, refreshHealth }: Shared) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cfg, setCfg] = useState<RetrievalConfig | null>(null);
  const [docs, setDocs] = useState<CorpusDocument[]>([]);
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const [questionId, setQuestionId] = useState<string>('');
  const [text, setText] = useState('');
  const [run, setRun] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [chunking, setChunking] = useState({ chunkSize: 0, chunkOverlap: 0 });
  const [saved, setSaved] = useState(false);

  const loadCorpus = () =>
    api.documents().then((r) => {
      setDocs(r.documents);
      setIndex(r.index);
    });

  useEffect(() => {
    api.settings().then((s) => {
      setSettings(s);
      setCfg(s.retrievalDefaults);
      setChunking({ chunkSize: s.chunkSize, chunkOverlap: s.chunkOverlap });
    }, setError);
    loadCorpus().catch(setError);
  }, []);

  useEffect(() => {
    if (!text && questions.length) {
      const q = questions.find((x) => x.primary) ?? questions[0];
      setQuestionId(q.id);
      setText(q.text);
    }
  }, [questions, text]);

  useEffect(() => {
    if (!index?.ingestion.running) return;
    const t = setInterval(() => loadCorpus().then(refreshHealth), 2000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index?.ingestion.running]);

  if (!cfg || !settings) return error ? <ErrorBox error={error} /> : <Spinner label="Loading settings…" />;
  const set = <K extends keyof RetrievalConfig>(k: K, v: RetrievalConfig[K]) => setCfg({ ...cfg, [k]: v });
  const setFilter = (patch: Partial<RetrievalConfig['filters']>) => setCfg({ ...cfg, filters: { ...cfg.filters, ...patch } });

  async function runOptimized() {
    setBusy('run');
    setError(null);
    try {
      setRun(await api.run({ question: text.trim(), mode: 'optimized_rag', questionId: questionId || undefined, retrieval: cfg! }));
    } catch (e) {
      setError(e);
    }
    setBusy(null);
  }

  async function saveDefaults() {
    setBusy('save');
    try {
      setSettings(await api.saveSettings({ retrievalDefaults: cfg! }));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e);
    }
    setBusy(null);
  }

  async function saveChunkingAndReindex() {
    setBusy('reindex');
    setError(null);
    try {
      setSettings(await api.saveSettings(chunking));
      await api.reindex();
      await loadCorpus();
    } catch (e) {
      setError(e);
      await loadCorpus().catch(() => {});
    }
    setBusy(null);
  }

  const chunkingChanged = chunking.chunkSize !== settings.chunkSize || chunking.chunkOverlap !== settings.chunkOverlap;
  const pipeline = [
    cfg.filters.documentIds.length || cfg.filters.controlId || cfg.filters.section || cfg.filters.publicationVersion ? 'Metadata filter' : null,
    cfg.queryRewrite ? 'Query rewrite' : null,
    cfg.keyword ? 'Keyword (BM25+)' : null,
    cfg.vector ? 'Vector (cosine)' : null,
    cfg.keyword && cfg.vector ? `RRF (k=${cfg.rrfK})` : null,
    cfg.rerank ? 'Cross-encoder rerank' : null,
    `Top ${cfg.topK}`,
    'Generate',
    cfg.citationValidation ? 'Citation validation' : null,
  ].filter(Boolean) as string[];

  return (
    <>
      <PageHeader
        title="RAG Optimization Lab"
        description="Turn individual retrieval techniques on and off and observe their effect on the actual candidate lists, final context, citations, latency and cost."
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[380px_1fr]">
        <div className="space-y-5">
          <Card title="Retrieval techniques">
            <div className="space-y-1">
              <Toggle checked={cfg.keyword} onChange={(v) => set('keyword', v)} label="Keyword search" hint="MiniSearch BM25+-style scoring (k=1.2, b=0.7, d=0.5)" />
              <Toggle checked={cfg.vector} onChange={(v) => set('vector', v)} label="Vector search" hint={`Cosine similarity, ${settings.embeddingModel}`} />
              <div className="ml-12 text-xs text-slate-500">Hybrid search = both enabled, fused with Reciprocal Rank Fusion.</div>
              <Toggle checked={cfg.queryRewrite} onChange={(v) => set('queryRewrite', v)} label="Query rewriting" hint="Separate model call; tokens tracked as planning" />
              <Toggle checked={cfg.autoFilter} onChange={(v) => set('autoFilter', v)} label="Auto metadata filter" hint="Model infers target documents/control; manual filters below take precedence" />
              <Toggle checked={cfg.rerank} onChange={(v) => set('rerank', v)} label="Reranking" hint="Local cross-encoder reorders the candidate set only" />
              <Toggle checked={cfg.citationValidation} onChange={(v) => set('citationValidation', v)} label="Citation validation" hint="Remove citations that do not resolve to supplied chunks" />
              <Toggle checked={cfg.abstention} onChange={(v) => set('abstention', v)} label="Abstention instruction" hint="Decline when evidence is insufficient" />
            </div>
            <div className="mt-4 grid grid-cols-3 gap-3">
              <Field label="Top K">
                <input type="number" min={1} max={20} className={inputCls} value={cfg.topK} onChange={(e) => set('topK', Number(e.target.value))} />
              </Field>
              <Field label="Candidates">
                <input type="number" min={1} max={100} className={inputCls} value={cfg.candidateK} onChange={(e) => set('candidateK', Number(e.target.value))} />
              </Field>
              <Field label="RRF k">
                <input type="number" min={1} max={500} className={inputCls} value={cfg.rrfK} disabled={!(cfg.keyword && cfg.vector)} onChange={(e) => set('rrfK', Number(e.target.value))} />
              </Field>
            </div>
            <div className="mt-3">
              <Field label="Abstain if top rerank score below" hint="0 disables the gate. Only applies with reranking on.">
                <input type="number" min={0} max={1} step={0.05} className={inputCls} value={cfg.minRerankScore} disabled={!cfg.rerank} onChange={(e) => set('minRerankScore', Number(e.target.value))} />
              </Field>
            </div>
          </Card>

          <Card title="Metadata filters">
            <div className="space-y-3">
              <div>
                <span className="mb-1 block text-xs font-medium text-slate-400">Documents (none = all)</span>
                <div className="flex flex-wrap gap-2">
                  {docs.map((d) => {
                    const on = cfg.filters.documentIds.includes(d.id);
                    return (
                      <button
                        key={d.id}
                        onClick={() => setFilter({ documentIds: on ? cfg.filters.documentIds.filter((x) => x !== d.id) : [...cfg.filters.documentIds, d.id] })}
                        className={cx('rounded-md border px-2.5 py-1 text-xs', on ? 'border-accent bg-accent/15 text-white' : 'border-ink-600 text-slate-400 hover:text-slate-200')}
                      >
                        {d.shortTitle}
                      </button>
                    );
                  })}
                </div>
              </div>
              <Field label="Publication version">
                <select className={inputCls} value={cfg.filters.publicationVersion ?? ''} onChange={(e) => setFilter({ publicationVersion: e.target.value || undefined })}>
                  <option value="">Any</option>
                  {docs.map((d) => <option key={d.id} value={d.publicationVersion}>{d.publicationVersion}</option>)}
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Section" hint='e.g. "3" or "Trust Algorithm"'>
                  <input className={inputCls} value={cfg.filters.section ?? ''} onChange={(e) => setFilter({ section: e.target.value || undefined })} />
                </Field>
                <Field label="Control / outcome ID" hint='e.g. "AC-2" or "PR.AA"'>
                  <input className={inputCls} value={cfg.filters.controlId ?? ''} onChange={(e) => setFilter({ controlId: e.target.value || undefined })} />
                </Field>
              </div>
            </div>
          </Card>

          <Card
            title="Chunking"
            subtitle="Changing chunking requires re-indexing (re-embeds the corpus)"
            actions={index?.stale ? <Badge tone="amber">index stale</Badge> : index?.chunkCount ? <Badge tone="green">index current</Badge> : <Badge>not built</Badge>}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="Chunk size (words)">
                <input type="number" min={50} max={2000} className={inputCls} value={chunking.chunkSize} onChange={(e) => setChunking({ ...chunking, chunkSize: Number(e.target.value) })} />
              </Field>
              <Field label="Overlap (words)">
                <input type="number" min={0} max={500} className={inputCls} value={chunking.chunkOverlap} onChange={(e) => setChunking({ ...chunking, chunkOverlap: Number(e.target.value) })} />
              </Field>
            </div>
            {index?.builtWith && (
              <p className="mt-2 text-xs text-slate-500">
                Current index: {index.builtWith.chunkSize} / {index.builtWith.chunkOverlap} words, {index.chunkCount.toLocaleString()} chunks, {index.builtWith.embeddingModel}
              </p>
            )}
            {index?.staleReason && <p className="mt-2 text-xs text-amber-300">{index.staleReason}</p>}
            {index?.ingestion.running && <div className="mt-2"><Spinner label={index.ingestion.message} /></div>}
            <Button className="mt-3 w-full" onClick={saveChunkingAndReindex} loading={busy === 'reindex'} disabled={Boolean(index?.ingestion.running) || (!chunkingChanged && !index?.stale)}>
              <RefreshCw className="h-4 w-4" /> Save & re-index
            </Button>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <select
                className={cx(inputCls, 'max-w-sm')}
                value={questionId}
                onChange={(e) => {
                  setQuestionId(e.target.value);
                  const q = questions.find((x) => x.id === e.target.value);
                  if (q) setText(q.text);
                }}
              >
                <option value="">Custom question…</option>
                {questions.map((q) => <option key={q.id} value={q.id}>{q.id}</option>)}
              </select>
            </div>
            <textarea
              className={cx(inputCls, 'min-h-[70px] resize-y')}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                if (questions.find((q) => q.id === questionId)?.text !== e.target.value) setQuestionId('');
              }}
            />
            <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
              {pipeline.map((p, i) => (
                <span key={p} className="flex items-center gap-1.5">
                  <span className="rounded-md border border-ink-600 bg-ink-850 px-2 py-1 text-slate-300">{p}</span>
                  {i < pipeline.length - 1 && <ArrowRight className="h-3 w-3 text-slate-600" />}
                </span>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="primary" onClick={runOptimized} loading={busy === 'run'} disabled={!text.trim() || (!cfg.keyword && !cfg.vector)}>
                <Play className="h-4 w-4" /> Run optimized pipeline
              </Button>
              <Button onClick={saveDefaults} loading={busy === 'save'}>
                <Save className="h-4 w-4" /> {saved ? 'Saved' : 'Use as default for demo & evaluation'}
              </Button>
            </div>
            {!cfg.keyword && !cfg.vector && <p className="mt-2 text-xs text-amber-300">Enable keyword search, vector search, or both.</p>}
          </Card>
          <ErrorBox error={error} />
          {run ? <RunView run={run} onCite={openChunk} showSteps /> : <Empty title="No lab run yet">Configure the pipeline and run it to see each stage's actual results.</Empty>}
        </div>
      </div>
    </>
  );
}
