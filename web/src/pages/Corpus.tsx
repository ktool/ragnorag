import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudDownload, Database, ExternalLink, Upload } from 'lucide-react';
import type { ChunkMeta, CorpusDocument, IndexStatus } from '@rag-lab/shared';
import { api } from '../api.ts';
import type { Shared } from '../App.tsx';
import { Badge, Button, Card, ErrorBox, PageHeader, Spinner, Stat, cx, inputCls } from '../ui.tsx';

const STATUS_TONE = { ingested: 'green', ingesting: 'amber', not_ingested: 'amber', missing: 'red', error: 'red' } as const;

export function Corpus({ health, refreshHealth, openChunk }: Shared) {
  const [docs, setDocs] = useState<CorpusDocument[]>([]);
  const [index, setIndex] = useState<IndexStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    () =>
      api.documents().then((r) => {
        setDocs(r.documents);
        setIndex(r.index);
      }, setError),
    [],
  );
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    if (!index?.ingestion.running) return;
    const t = setInterval(() => {
      load();
      refreshHealth();
    }, 1500);
    return () => clearInterval(t);
  }, [index?.ingestion.running, load, refreshHealth]);

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    }
    await load();
    refreshHealth();
    setBusy(null);
  }

  const missing = docs.filter((d) => !d.filePresent);
  return (
    <>
      <PageHeader
        title="Documents"
        description="Three public NIST publications, extracted with PDF.js, chunked with section/control metadata, embedded with OpenAI and indexed locally for keyword (MiniSearch) and vector search."
        actions={
          <>
            {missing.length > 0 && (
              <Button
                onClick={() =>
                  act('download', async () => {
                    const r = await api.download();
                    setNotice(r.results.map((x) => `${x.id}: ${x.ok ? 'downloaded' : `failed (${x.message})`}`).join(' · '));
                  })
                }
                loading={busy === 'download'}
              >
                <CloudDownload className="h-4 w-4" /> Download missing PDFs from NIST
              </Button>
            )}
            <Button variant="primary" onClick={() => act('ingest', api.ingest)} loading={busy === 'ingest'} disabled={Boolean(index?.ingestion.running) || !health?.openaiKeyConfigured}>
              <Database className="h-4 w-4" /> {index?.chunkCount ? 'Re-ingest & rebuild index' : 'Ingest corpus'}
            </Button>
          </>
        }
      />

      {!health?.openaiKeyConfigured && (
        <div className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Ingestion needs embeddings: copy <code className="font-mono">.env.example</code> to <code className="font-mono">.env</code>, set <code className="font-mono">OPENAI_API_KEY</code>, and restart the server.
        </div>
      )}
      {notice && <div className="mb-5 rounded-lg border border-ink-600 bg-ink-850 px-4 py-2 text-sm text-slate-300">{notice}</div>}
      <div className="mb-5">
        <ErrorBox error={error} />
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Documents ingested" value={`${index?.documentCount ?? 0} / ${docs.length}`} />
        <Stat label="Chunks" value={(index?.chunkCount ?? 0).toLocaleString()} />
        <Stat label="Chunking" value={index?.builtWith ? `${index.builtWith.chunkSize} / ${index.builtWith.chunkOverlap}` : '—'} hint="words / overlap" />
        <Stat label="Embedding model" value={<span className="text-sm">{index?.builtWith?.embeddingModel ?? '—'}</span>} />
        <Stat label="Last built" value={<span className="text-sm">{index?.builtAt ? new Date(index.builtAt).toLocaleString() : '—'}</span>} />
      </div>
      {index?.stale && <div className="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">{index.staleReason}</div>}
      {index?.ingestion.running && (
        <div className="mb-5 rounded-lg border border-ink-600 bg-ink-850 px-4 py-3">
          <Spinner label={index.ingestion.message} />
        </div>
      )}
      {!index?.ingestion.running && index?.ingestion.finishedAt && <p className="mb-5 text-xs text-slate-500">Last ingestion: {index.ingestion.message}</p>}

      <Card title="Documents">
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                {['Document', 'Version', 'Published', 'Status', 'Pages', 'Chunks', 'Ingested', ''].map((h) => (
                  <th key={h} className="py-2 pr-4">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/60 align-top">
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="py-3 pr-4">
                    <div className="font-medium text-slate-100">{d.title}</div>
                    <a href={d.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                      {d.sourceUrl} <ExternalLink className="h-3 w-3" />
                    </a>
                    {d.versionNote && <div className="mt-1 max-w-xl text-xs text-amber-300/90">{d.versionNote}</div>}
                    {d.error && <div className="mt-1 max-w-xl text-xs text-rose-300">{d.error}</div>}
                  </td>
                  <td className="py-3 pr-4 text-slate-300">{d.publicationVersion}</td>
                  <td className="whitespace-nowrap py-3 pr-4 text-slate-400">{d.publicationDate}</td>
                  <td className="py-3 pr-4">
                    <Badge tone={STATUS_TONE[d.status]}>{d.status.replace('_', ' ')}</Badge>
                  </td>
                  <td className="py-3 pr-4 tabular-nums">{d.pageCount ?? '—'}</td>
                  <td className="py-3 pr-4 tabular-nums">{d.chunkCount ?? '—'}</td>
                  <td className="whitespace-nowrap py-3 pr-4 text-xs text-slate-400">{d.ingestedAt ? new Date(d.ingestedAt).toLocaleString() : '—'}</td>
                  <td className="py-3">
                    <div className="flex gap-2">
                      {d.status === 'ingested' && (
                        <Button size="sm" onClick={() => setDetail(detail === d.id ? null : d.id)}>
                          {detail === d.id ? 'Hide chunks' : 'Chunks'}
                        </Button>
                      )}
                      <UploadButton doc={d} onDone={() => act('upload', async () => {})} onError={setError} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {detail && <ChunkBrowser documentId={detail} openChunk={openChunk} />}
    </>
  );
}

function UploadButton({ doc, onDone, onError }: { doc: CorpusDocument; onDone: () => void; onError: (e: unknown) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          if (file.size > 25 * 1024 * 1024) return onError(new Error('PDF exceeds the 25 MB limit'));
          setBusy(true);
          try {
            await api.upload(doc.id, file);
            onDone();
          } catch (err) {
            onError(err);
          }
          setBusy(false);
        }}
      />
      <Button size="sm" variant="ghost" onClick={() => ref.current?.click()} loading={busy} title={`Replace ${doc.fileName} (PDF, max 25 MB)`}>
        <Upload className="h-3.5 w-3.5" /> PDF
      </Button>
    </>
  );
}

function ChunkBrowser({ documentId, openChunk }: { documentId: string; openChunk: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; chunks: ChunkMeta[] } | null>(null);
  useEffect(() => {
    const t = setTimeout(() => api.documentChunks(documentId, offset, search).then(setData), 200);
    return () => clearTimeout(t);
  }, [documentId, offset, search]);
  return (
    <Card
      title={`Chunks · ${documentId}`}
      subtitle="Page references are PDF page indexes. Click a chunk ID for full text and metadata."
      className="mt-5"
      actions={
        <input
          className={cx(inputCls, 'w-72')}
          placeholder="Filter by text, section, control ID…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setOffset(0);
          }}
        />
      }
    >
      {!data ? (
        <Spinner />
      ) : (
        <>
          <table className="w-full text-left text-[13px]">
            <thead className="text-[11px] uppercase tracking-wide text-slate-500">
              <tr>
                {['Chunk ID', 'Pages', 'Section', 'Control', 'Text'].map((h) => (
                  <th key={h} className="py-2 pr-3">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-700/60 align-top">
              {data.chunks.map((c) => (
                <tr key={c.chunkId}>
                  <td className="py-2 pr-3">
                    <button onClick={() => openChunk(c.chunkId)} className="font-mono text-[12px] text-teal-200 hover:underline">
                      {c.chunkId}
                    </button>
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 tabular-nums text-slate-400">{c.pageNumber === c.pageEnd ? c.pageNumber : `${c.pageNumber}–${c.pageEnd}`}</td>
                  <td className="max-w-[220px] py-2 pr-3 text-xs text-slate-400">{[c.sectionNumber, c.sectionTitle].filter(Boolean).join(' ') || '—'}</td>
                  <td className="py-2 pr-3 font-mono text-xs text-slate-300">{c.controlId ?? '—'}</td>
                  <td className="py-2 text-xs text-slate-400">{c.text.slice(0, 220)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 flex items-center gap-3 text-xs text-slate-400">
            <Button size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>
              Previous
            </Button>
            {data.total ? `${offset + 1}–${Math.min(offset + 50, data.total)} of ${data.total}` : 'No chunks'}
            <Button size="sm" disabled={offset + 50 >= data.total} onClick={() => setOffset(offset + 50)}>
              Next
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
