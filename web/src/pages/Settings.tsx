import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { Settings } from '@rag-lab/shared';
import { api } from '../api.ts';
import type { Shared } from '../App.tsx';
import { Button, Card, ErrorBox, Field, PageHeader, Spinner, inputCls } from '../ui.tsx';

export function SettingsPage({ health }: Shared) {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.settings().then(setS, setError);
  }, []);
  if (!s) return error ? <ErrorBox error={error} /> : <Spinner label="Loading settings…" />;

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });
  const usedModels = [...new Set([s.answerModel, s.judgeModel, s.embeddingModel])];
  const pricingRows = [...new Set([...usedModels, ...Object.keys(s.pricing)])];

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const { chunkSize: _a, chunkOverlap: _b, retrievalDefaults: _c, ...rest } = s!;
      setS(await api.saveSettings(rest));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e);
    }
    setSaving(false);
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Model, agent and pricing configuration. The OpenAI API key is read from the server environment only and is never sent to the browser."
        actions={<Button variant="primary" onClick={save} loading={saving}>{saved ? 'Saved' : 'Save settings'}</Button>}
      />
      <div className="mb-5">
        <ErrorBox error={error} />
      </div>
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card title="Models" subtitle="The same answer model and generation settings are used across all four modes">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Answer model (all modes, rewrite, agent)">
              <input className={inputCls} value={s.answerModel} onChange={(e) => set('answerModel', e.target.value)} />
            </Field>
            <Field label="Evaluator (LLM judge) model">
              <input className={inputCls} value={s.judgeModel} onChange={(e) => set('judgeModel', e.target.value)} />
            </Field>
            <Field label="Embedding model" hint="Changing this marks the index stale; re-index on the Corpus page.">
              <input className={inputCls} value={s.embeddingModel} onChange={(e) => set('embeddingModel', e.target.value)} />
            </Field>
            <Field label="Reranker (flashrank-js alias or HF repo)" hint="Local ONNX model; downloaded once to data/model-cache.">
              <input className={inputCls} value={s.rerankerModel} onChange={(e) => set('rerankerModel', e.target.value)} />
            </Field>
            <Field label="Reasoning effort" hint="Sent to every generation call. Choose “omit” for non-reasoning models.">
              <select className={inputCls} value={s.reasoningEffort} onChange={(e) => set('reasoningEffort', e.target.value as Settings['reasoningEffort'])}>
                <option value="">omit</option>
                {['none', 'minimal', 'low', 'medium', 'high'].map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </Field>
            <Field label="Max output tokens per call">
              <input type="number" className={inputCls} value={s.maxOutputTokens} onChange={(e) => set('maxOutputTokens', Number(e.target.value))} />
            </Field>
          </div>
        </Card>

        <Card title="Agent & reliability">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Max tool-call rounds" hint="Demo default: 3. The agent is forced to answer after this.">
              <input type="number" min={1} max={5} className={inputCls} value={s.agentMaxRounds} onChange={(e) => set('agentMaxRounds', Number(e.target.value))} />
            </Field>
            <Field label="Run timeout (ms)" hint="Whole-run cancellation, including all model and tool calls.">
              <input type="number" min={10000} step={1000} className={inputCls} value={s.runTimeoutMs} onChange={(e) => set('runTimeoutMs', Number(e.target.value))} />
            </Field>
          </div>
          <div className="mt-4 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs text-slate-400">
            OpenAI key: {health?.openaiKeyConfigured ? 'configured on the server' : 'missing — set OPENAI_API_KEY in .env and restart'}. Chunking and retrieval defaults are edited in the Optimization Lab.
          </div>
        </Card>

        <Card
          title="Pricing (USD per 1M tokens)"
          subtitle="Used only to estimate cost from API-reported tokens. Empty by default: enter current prices from openai.com/api/pricing and record the source."
          className="xl:col-span-2"
        >
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="py-2 pr-3">Model</th>
                <th className="py-2 pr-3">Input / 1M</th>
                <th className="py-2 pr-3">Output / 1M</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pricingRows.map((m) => {
                const p = s.pricing[m];
                return (
                  <tr key={m}>
                    <td className="py-1.5 pr-3 font-mono text-[13px] text-slate-300">{m}</td>
                    <td className="py-1.5 pr-3">
                      <input type="number" min={0} step="0.001" className={inputCls} placeholder="not set" value={p?.inputPerMillion ?? ''}
                        onChange={(e) => set('pricing', { ...s.pricing, [m]: { inputPerMillion: Number(e.target.value), outputPerMillion: p?.outputPerMillion ?? 0 } })} />
                    </td>
                    <td className="py-1.5 pr-3">
                      <input type="number" min={0} step="0.001" className={inputCls} placeholder="not set" value={p?.outputPerMillion ?? ''}
                        onChange={(e) => set('pricing', { ...s.pricing, [m]: { inputPerMillion: p?.inputPerMillion ?? 0, outputPerMillion: Number(e.target.value) } })} />
                    </td>
                    <td className="py-1.5">
                      {p && (
                        <Button size="sm" variant="ghost" onClick={() => { const { [m]: _, ...rest } = s.pricing; set('pricing', rest); }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <AddModel onAdd={(m) => set('pricing', { ...s.pricing, [m]: { inputPerMillion: 0, outputPerMillion: 0 } })} />
          <div className="mt-4">
            <Field label="Pricing source and date (recorded with your settings)">
              <input className={inputCls} value={s.pricingSource} placeholder="e.g. openai.com/api/pricing, checked 2026-10-26" onChange={(e) => set('pricingSource', e.target.value)} />
            </Field>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Embedding models are priced on input tokens only. Local reranker inference is never counted as API tokens. LLM-judge calls are excluded from per-run cost.
          </p>
        </Card>
      </div>
    </>
  );
}

function AddModel({ onAdd }: { onAdd: (m: string) => void }) {
  const [m, setM] = useState('');
  return (
    <div className="mt-3 flex gap-2">
      <input className={`${inputCls} max-w-xs`} placeholder="Add model ID" value={m} onChange={(e) => setM(e.target.value)} />
      <Button size="sm" disabled={!m.trim()} onClick={() => { onAdd(m.trim()); setM(''); }}>
        <Plus className="h-3.5 w-3.5" /> Add
      </Button>
    </div>
  );
}
