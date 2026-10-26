import { useEffect, useState } from 'react';
import type { GoldenQuestion } from '@rag-lab/shared';
import { api } from '../api.ts';
import { Badge, Button, Card, ErrorBox, Field, cx, inputCls } from '../ui.tsx';

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

export function GoldenEditor({ questions, setQuestions, openChunk }: { questions: GoldenQuestion[]; setQuestions: (q: GoldenQuestion[]) => void; openChunk: (id: string) => void }) {
  const [selected, setSelected] = useState<string>(questions[0]?.id ?? '');
  const q = questions.find((x) => x.id === selected);
  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[320px_1fr]">
      <Card title="Golden questions" subtitle="Stored in server/golden/questions.json">
        <ul className="space-y-1.5">
          {questions.map((x) => (
            <li key={x.id}>
              <button onClick={() => setSelected(x.id)} className={cx('w-full rounded-lg border px-3 py-2 text-left', selected === x.id ? 'border-accent bg-accent/10' : 'border-ink-700 hover:border-ink-600')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-slate-200">{x.id}</span>
                  <Badge tone={x.validationStatus === 'validated' ? 'green' : x.validationStatus === 'unsupported' ? 'red' : 'amber'}>{x.validationStatus.replace('_', ' ')}</Badge>
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{x.category}</div>
              </button>
            </li>
          ))}
        </ul>
      </Card>
      {q && <QuestionForm key={q.id} q={q} openChunk={openChunk} onSaved={(n) => setQuestions(questions.map((x) => (x.id === n.id ? n : x)))} />}
    </div>
  );
}

function QuestionForm({ q, onSaved, openChunk }: { q: GoldenQuestion; onSaved: (q: GoldenQuestion) => void; openChunk: (id: string) => void }) {
  const [f, setF] = useState({
    text: q.text,
    category: q.category,
    points: q.expectedAnswerPoints.join('\n'),
    docs: q.expectedDocumentIds.join(', '),
    refs: q.sourceReferences.join('\n'),
    evidence: JSON.stringify(q.relevantEvidence, null, 2),
    chunkIds: q.relevantChunkIds.join(', '),
    abstention: q.abstention,
    notes: q.reviewerNotes,
    status: q.validationStatus,
  });
  const [resolved, setResolved] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    api.relevantChunks(q.id).then((r) => setResolved(r.chunkIds), () => setResolved(null));
  }, [q.id]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const evidence = JSON.parse(f.evidence);
      const next = await api.updateQuestion(q.id, {
        text: f.text,
        category: f.category,
        expectedAnswerPoints: lines(f.points),
        expectedDocumentIds: f.docs.split(',').map((s) => s.trim()).filter(Boolean),
        sourceReferences: lines(f.refs),
        relevantEvidence: evidence,
        relevantChunkIds: f.chunkIds.split(',').map((s) => s.trim()).filter(Boolean),
        abstention: f.abstention,
        reviewerNotes: f.notes,
        validationStatus: f.status,
      });
      onSaved(next);
      setResolved((await api.relevantChunks(q.id)).chunkIds);
      setOk(true);
      setTimeout(() => setOk(false), 2000);
    } catch (e) {
      setError(e instanceof SyntaxError ? new Error(`Relevant evidence is not valid JSON: ${e.message}`) : e);
    }
    setSaving(false);
  }

  return (
    <Card title={<span className="font-mono">{q.id}</span>} subtitle={q.primary ? 'Primary demo question (human review workflow enabled)' : 'Evaluation question'} actions={<Button variant="primary" size="sm" onClick={save} loading={saving}>{ok ? 'Saved' : 'Save record'}</Button>}>
      <div className="space-y-4">
        <ErrorBox error={error} />
        <Field label="Question text">
          <textarea className={cx(inputCls, 'min-h-[60px]')} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
        </Field>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          <Field label="Category">
            <input className={inputCls} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
          </Field>
          <Field label="Expected documents (comma-separated)">
            <input className={inputCls} value={f.docs} onChange={(e) => setF({ ...f, docs: e.target.value })} />
          </Field>
          <Field label="Abstention">
            <select className={inputCls} value={f.abstention} onChange={(e) => setF({ ...f, abstention: e.target.value as GoldenQuestion['abstention'] })}>
              <option value="not_expected">not expected</option>
              <option value="acceptable">acceptable</option>
              <option value="expected">expected</option>
            </select>
          </Field>
          <Field label="Validation status">
            <select className={inputCls} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as GoldenQuestion['validationStatus'] })}>
              <option value="validated">validated</option>
              <option value="needs_review">needs review</option>
              <option value="unsupported">unsupported by corpus</option>
            </select>
          </Field>
        </div>
        <Field label="Expected answer points (one per line)">
          <textarea className={cx(inputCls, 'min-h-[140px] text-[13px]')} value={f.points} onChange={(e) => setF({ ...f, points: e.target.value })} />
        </Field>
        <Field label="Source section / page references (one per line)">
          <textarea className={cx(inputCls, 'min-h-[60px] text-[13px]')} value={f.refs} onChange={(e) => setF({ ...f, refs: e.target.value })} />
        </Field>
        <Field label="Relevant evidence (JSON)" hint='Each item: { "documentId", "page"? (PDF page), "mustContain" (verbatim phrase), "grade" 1-3 }. A chunk is relevant if it contains the phrase.'>
          <textarea className={cx(inputCls, 'min-h-[180px] font-mono text-[12px]')} value={f.evidence} onChange={(e) => setF({ ...f, evidence: e.target.value })} />
        </Field>
        <Field label="Manually annotated relevant chunk IDs (comma-separated, optional)" hint="Chunk IDs change when chunking settings change; phrase-based evidence is more robust.">
          <input className={cx(inputCls, 'font-mono text-[12px]')} value={f.chunkIds} onChange={(e) => setF({ ...f, chunkIds: e.target.value })} />
        </Field>
        <Field label="Human reviewer notes">
          <textarea className={cx(inputCls, 'min-h-[60px]')} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </Field>
        <div>
          <div className="mb-1 text-xs font-medium text-slate-400">Chunks currently matching the relevance judgments</div>
          {resolved === null ? (
            <p className="text-xs text-slate-500">Index not built.</p>
          ) : resolved.length === 0 ? (
            <p className="text-xs text-amber-300">No chunk matches. Retrieval metrics for this question will be 0 until evidence phrases are fixed.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {resolved.map((id) => (
                <button key={id} onClick={() => openChunk(id)} className="rounded border border-teal/30 bg-teal/10 px-1.5 py-0.5 font-mono text-[11px] text-teal-200 hover:bg-teal/20">
                  {id}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}
