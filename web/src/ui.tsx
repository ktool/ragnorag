import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ExternalLink, Loader2, X, AlertTriangle } from 'lucide-react';
import type { ChunkMeta } from '@rag-lab/shared';
import { api } from './api.ts';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

// ---------- formatting ----------
export const fmtMs = (ms?: number | null) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
export const fmtNum = (n?: number | null) => (n == null ? '—' : n.toLocaleString());
export const fmtCost = (c?: number | null) => (c == null ? 'n/a' : c < 0.01 ? `$${c.toFixed(5)}` : `$${c.toFixed(4)}`);
export const fmtPct = (x?: number | null) => (x == null ? '—' : `${Math.round(x * 100)}%`);
export const fmtScore = (x?: number | null, digits = 1) => (x == null ? '—' : x.toFixed(digits));

// ---------- layout ----------
export function Card({ title, subtitle, actions, children, className }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-xl border border-ink-700 bg-ink-900/80 shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-ink-700/70 px-5 py-3.5">
          <div>
            {title && <h2 className="text-[15px] font-semibold text-slate-100">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-slate-400">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-slate-400">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; loading?: boolean; size?: 'sm' | 'md' };
export function Button({ variant = 'secondary', loading, size = 'md', className, children, disabled, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-4 py-2 text-sm',
        variant === 'primary' && 'bg-accent-strong text-white hover:bg-accent',
        variant === 'secondary' && 'border border-ink-600 bg-ink-800 text-slate-200 hover:bg-ink-700',
        variant === 'ghost' && 'text-slate-300 hover:bg-ink-800',
        variant === 'danger' && 'bg-rose-600/90 text-white hover:bg-rose-600',
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

const TONES = {
  neutral: 'bg-ink-700 text-slate-300 border-ink-600',
  accent: 'bg-accent/15 text-violet-200 border-accent/30',
  teal: 'bg-teal/10 text-teal-200 border-teal/30',
  green: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
  amber: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  red: 'bg-rose-500/10 text-rose-300 border-rose-500/30',
};
export function Badge({ tone = 'neutral', children, className, title }: { tone?: keyof typeof TONES; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium', TONES[tone], className)}>
      {children}
    </span>
  );
}

/** Provenance of a value: the UI always distinguishes these. */
export type ValueKind = 'measured' | 'estimated' | 'llm' | 'human' | 'na';
const KIND: Record<ValueKind, { label: string; tone: keyof typeof TONES; title: string }> = {
  measured: { label: 'measured', tone: 'teal', title: 'Deterministic: measured from execution or computed from relevance judgments' },
  estimated: { label: 'estimated', tone: 'amber', title: 'Estimated from measured usage × configured pricing' },
  llm: { label: 'LLM-judged', tone: 'accent', title: 'Produced by an LLM evaluator; not objective ground truth' },
  human: { label: 'human', tone: 'green', title: 'Human reviewer score' },
  na: { label: 'n/a', tone: 'neutral', title: 'Not applicable or not evaluated' },
};
export function KindTag({ kind }: { kind: ValueKind }) {
  const k = KIND[kind];
  return (
    <Badge tone={k.tone} title={k.title} className="uppercase tracking-wide !text-[9.5px]">
      {k.label}
    </Badge>
  );
}

export function Stat({ label, value, kind, hint }: { label: string; value: ReactNode; kind?: ValueKind; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 px-3.5 py-3">
      <div className="flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-wide text-slate-400">
        <span>{label}</span>
        {kind && <KindTag kind={kind} />}
      </div>
      <div className="mt-1 text-lg font-semibold text-slate-100 tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-slate-500">{hint}</div>}
    </div>
  );
}

export function ErrorBox({ error, title = 'Something went wrong' }: { error: unknown; title?: string }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex gap-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <div className="font-medium">{title}</div>
        <div className="mt-0.5 text-rose-200/80">{msg}</div>
      </div>
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-600 px-6 py-10 text-center">
      <div className="text-sm font-medium text-slate-300">{title}</div>
      {children && <div className="mx-auto mt-1.5 max-w-xl text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-400">
      <Loader2 className="h-4 w-4 animate-spin text-accent" /> {label}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-3 rounded-lg px-1 py-1.5', disabled && 'cursor-not-allowed opacity-50')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent-strong' : 'bg-ink-600')}
      >
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all', checked ? 'left-4.5' : 'left-0.5')} />
      </button>
      <span>
        <span className="block text-sm text-slate-200">{label}</span>
        {hint && <span className="block text-xs text-slate-500">{hint}</span>}
      </span>
    </label>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-400">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputCls = 'w-full rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-accent';

// ---------- answer rendering ----------
const CITE = /^[a-z0-9.]+(?:-[a-z0-9.]+)*-\d{4}-[0-9a-f]{6}$/;

function inline(text: string, onCite: (id: string) => void, valid: Set<string>, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\[([^\]]+)\]|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const ids = m[1].split(/[,;]\s*/).map((s) => s.trim());
      if (ids.every((id) => CITE.test(id))) {
        ids.forEach((id) =>
          out.push(
            <button
              key={`${key}-${i++}`}
              onClick={() => onCite(id)}
              title={valid.has(id) ? 'Open source chunk' : 'Citation does not resolve to supplied evidence'}
              className={cx(
                'mx-0.5 inline-flex rounded border px-1 align-baseline font-mono text-[10.5px] leading-4',
                valid.has(id) ? 'border-teal/40 bg-teal/10 text-teal-200 hover:bg-teal/20' : 'border-rose-500/40 bg-rose-500/10 text-rose-300',
              )}
            >
              {id.replace(/-[0-9a-f]{6}$/, '')}
            </button>,
          ),
        );
      } else out.push(<span key={`${key}-${i++}`}>[{m[1]}]</span>);
    } else if (m[2] !== undefined) out.push(<strong key={`${key}-${i++}`}>{m[2]}</strong>);
    else if (m[3] !== undefined) out.push(<code key={`${key}-${i++}`} className="rounded bg-ink-800 px-1 font-mono text-[12px]">{m[3]}</code>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Minimal markdown (headings, lists, bold, code) with clickable citation chips. */
export function Answer({ text, onCite, validIds }: { text: string; onCite: (id: string) => void; validIds: string[] }) {
  const valid = new Set(validIds);
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let list: { ordered: boolean; start: number; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const k = blocks.length;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, onCite, valid, `${k}-${i}`)}</li>);
    blocks.push(list.ordered ? <ol key={k} start={list.start}>{items}</ol> : <ul key={k}>{items}</ul>);
    list = null;
  };
  lines.forEach((raw, idx) => {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const num = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (bullet || num) {
      const ordered = Boolean(num);
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, start: num ? Number(num[1]) : 1, items: [] };
      list.items.push(bullet ? bullet[1] : num![2]);
      return;
    }
    flush();
    if (!line.trim()) return;
    if (heading) blocks.push(<h4 key={idx}>{inline(heading[2], onCite, valid, `h${idx}`)}</h4>);
    else blocks.push(<p key={idx}>{inline(line, onCite, valid, `p${idx}`)}</p>);
  });
  flush();
  return <div className="prose-answer text-[14.5px] text-slate-200">{blocks}</div>;
}

// ---------- chunk viewer ----------
export function ChunkModal({ chunkId, onClose }: { chunkId: string | null; onClose: () => void }) {
  const [chunk, setChunk] = useState<ChunkMeta | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (!chunkId) return;
    setChunk(null);
    setError(null);
    api.chunk(chunkId).then(setChunk, setError);
  }, [chunkId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!chunkId) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-3xl overflow-hidden rounded-xl border border-ink-600 bg-ink-900 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-ink-700 px-5 py-3">
          <div className="font-mono text-sm text-teal-200">{chunkId}</div>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-ink-800 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="scroll-thin max-h-[calc(85vh-52px)] overflow-y-auto p-5">
          {error ? <ErrorBox error={error} title="Chunk not found" /> : null}
          {!chunk && !error && <Spinner label="Loading chunk…" />}
          {chunk && (
            <>
              <dl className="mb-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <Meta label="Document">{chunk.documentTitle}</Meta>
                <Meta label="Version">{chunk.publicationVersion}</Meta>
                <Meta label="Section">{[chunk.sectionNumber, chunk.sectionTitle].filter(Boolean).join(' ') || '—'}</Meta>
                <Meta label="Control / outcome ID">{chunk.controlId ?? '—'}</Meta>
                <Meta label="PDF page">{chunk.pageNumber === chunk.pageEnd ? chunk.pageNumber : `${chunk.pageNumber}–${chunk.pageEnd}`}</Meta>
                <Meta label="Source">
                  <a href={chunk.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                    NIST publication page <ExternalLink className="h-3 w-3" />
                  </a>
                </Meta>
              </dl>
              <div className="whitespace-pre-wrap rounded-lg border border-ink-700 bg-ink-850 p-4 text-[13.5px] leading-relaxed text-slate-200">{chunk.text}</div>
              <p className="mt-2 text-[11px] text-slate-500">Original extracted text, shown verbatim. Page numbers are PDF page indexes, not printed page labels.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-slate-200">{children}</dd>
    </div>
  );
}
