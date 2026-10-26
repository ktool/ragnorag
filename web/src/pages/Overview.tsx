import { useEffect, useState } from 'react';
import { ArrowRight, Bot, Database, Layers, Sparkles } from 'lucide-react';
import type { CorpusDocument, EvaluationBatch, IndexStatus } from '@rag-lab/shared';
import { api } from '../api.ts';
import type { Shared } from '../App.tsx';
import { Badge, Button, Card, PageHeader, Stat } from '../ui.tsx';

const MODES = [
  { icon: Sparkles, name: 'No RAG', desc: 'Baseline: the model answers from training data. No corpus evidence, no retrieval metrics.' },
  { icon: Database, name: 'Basic RAG', desc: 'Embed the question, take the top-K chunks by cosine similarity, answer only from them with citations.' },
  { icon: Layers, name: 'Optimized RAG', desc: 'Metadata filters, query rewriting, BM25+-style keyword and vector search fused with RRF, local cross-encoder reranking, citation validation and abstention.' },
  { icon: Bot, name: 'Agentic RAG', desc: 'A bounded tool-calling agent that decides what to search, refines queries, inspects chunks and stops when evidence is sufficient (max 3 tool rounds).' },
];

export function Overview({ questions, navigate, health }: Shared) {
  const [docs, setDocs] = useState<CorpusDocument[]>([]);
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const [batch, setBatch] = useState<EvaluationBatch | null>(null);

  useEffect(() => {
    api.documents().then((r) => {
      setDocs(r.documents);
      setIndex(r.index);
    }, () => {});
    api.batches().then((r) => setBatch(r.batches[0] ?? null), () => {});
  }, []);

  const primary = questions.filter((q) => q.primary);
  return (
    <>
      <PageHeader
        title="RAG Evaluation Lab"
        description="A working comparison of four answer strategies over the same public NIST cybersecurity corpus and the same evaluation questions. Every number is measured from real execution, computed from reviewed relevance judgments, or explicitly labelled as LLM-judged or human-reviewed."
      />

      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {primary.map((q, i) => (
          <button
            key={q.id}
            onClick={() => navigate('demo', { questionId: q.id })}
            className="group flex flex-col items-start rounded-xl border border-accent/30 bg-gradient-to-br from-accent/10 to-ink-900 p-5 text-left transition-colors hover:border-accent/60"
          >
            <div className="mb-2 flex items-center gap-2">
              <Badge tone="accent">Primary question {i + 1}</Badge>
              <span className="text-xs text-slate-400">{q.category.replace('Primary: ', '')}</span>
            </div>
            <p className="text-[15px] leading-relaxed text-slate-100">{q.text}</p>
            <span className="mt-3 inline-flex items-center gap-1 text-sm text-accent group-hover:underline">
              Open in Live Demo <ArrowRight className="h-4 w-4" />
            </span>
          </button>
        ))}
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        {MODES.map((m) => (
          <Card key={m.name} className="h-full">
            <m.icon className="mb-3 h-5 w-5 text-teal" />
            <div className="mb-1 text-sm font-semibold text-white">{m.name}</div>
            <p className="text-sm leading-relaxed text-slate-400">{m.desc}</p>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <Card title="Corpus" subtitle="Public NIST publications" className="xl:col-span-2" actions={<Button size="sm" onClick={() => navigate('corpus')}>Manage</Button>}>
          <div className="mb-4 grid grid-cols-3 gap-3">
            <Stat label="Documents ingested" value={`${index?.documentCount ?? 0} / ${docs.length}`} />
            <Stat label="Chunks indexed" value={(index?.chunkCount ?? 0).toLocaleString()} />
            <Stat label="Index" value={index?.stale ? 'Stale' : index?.chunkCount ? 'Current' : 'Not built'} hint={index?.builtWith ? `${index.builtWith.chunkSize} words / ${index.builtWith.chunkOverlap} overlap` : undefined} />
          </div>
          <ul className="divide-y divide-ink-700/60 text-sm">
            {docs.map((d) => (
              <li key={d.id} className="flex items-center justify-between py-2">
                <span className="text-slate-200">{d.title}</span>
                <Badge tone={d.status === 'ingested' ? 'green' : d.status === 'missing' || d.status === 'error' ? 'red' : 'amber'}>{d.status.replace('_', ' ')}</Badge>
              </li>
            ))}
          </ul>
          {!health?.openaiKeyConfigured && (
            <p className="mt-3 text-xs text-amber-300">Add OPENAI_API_KEY to .env and restart the server to enable ingestion and runs.</p>
          )}
        </Card>
        <Card title="Latest benchmark" actions={<Button size="sm" onClick={() => navigate('evaluation')}>Results</Button>}>
          {batch ? (
            <div className="space-y-2 text-sm">
              <div className="text-slate-300">{new Date(batch.createdAt).toLocaleString()}</div>
              <div className="text-slate-400">
                {batch.questionIds.length} question(s) × {batch.modes.length} mode(s) × {batch.repeats} repeat(s)
              </div>
              <Badge tone={batch.status === 'done' ? 'green' : batch.status === 'error' ? 'red' : 'amber'}>
                {batch.status} · {batch.progress.done}/{batch.progress.total}
              </Badge>
            </div>
          ) : (
            <p className="text-sm text-slate-400">No benchmark has been run yet.</p>
          )}
        </Card>
      </div>
    </>
  );
}
