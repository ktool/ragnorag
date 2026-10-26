import { useCallback, useEffect, useState } from 'react';
import { Activity, BarChart3, Database, FlaskConical, GitBranch, LayoutDashboard, PlayCircle, Settings as SettingsIcon } from 'lucide-react';
import type { GoldenQuestion, HealthResponse } from '@rag-lab/shared';
import { api } from './api.ts';
import { ChunkModal, cx } from './ui.tsx';
import { Overview } from './pages/Overview.tsx';
import { LiveDemo } from './pages/LiveDemo.tsx';
import { Lab } from './pages/Lab.tsx';
import { Evaluation } from './pages/Evaluation.tsx';
import { Corpus } from './pages/Corpus.tsx';
import { AgentTrace } from './pages/AgentTrace.tsx';
import { SettingsPage } from './pages/Settings.tsx';

export type Page = 'overview' | 'demo' | 'lab' | 'evaluation' | 'corpus' | 'trace' | 'settings';

const NAV: Array<{ id: Page; label: string; icon: typeof Activity; advanced?: boolean }> = [
  { id: 'demo', label: 'Compare', icon: PlayCircle },
  { id: 'corpus', label: 'Documents', icon: Database },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
  // Detailed views, hidden under "Advanced" to keep the demo simple.
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, advanced: true },
  { id: 'lab', label: 'Optimization Lab', icon: FlaskConical, advanced: true },
  { id: 'evaluation', label: 'Evaluation', icon: BarChart3, advanced: true },
  { id: 'trace', label: 'Agent Trace', icon: GitBranch, advanced: true },
];

export interface Shared {
  health: HealthResponse | null;
  questions: GoldenQuestion[];
  refreshHealth: () => void;
  navigate: (page: Page, opts?: { questionId?: string; runId?: string }) => void;
  openChunk: (chunkId: string) => void;
  demoQuestionId: string | null;
  traceRunId: string | null;
  setTraceRunId: (id: string | null) => void;
}

const pageFromHash = (): Page => {
  const h = window.location.hash.replace('#', '') as Page;
  return NAV.some((n) => n.id === h) ? h : 'demo';
};

export function App() {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [questions, setQuestions] = useState<GoldenQuestion[]>([]);
  const [chunkId, setChunkId] = useState<string | null>(null);
  const [demoQuestionId, setDemoQuestionId] = useState<string | null>(null);
  const [traceRunId, setTraceRunId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(() => NAV.some((n) => n.advanced && n.id === pageFromHash()));

  const refreshHealth = useCallback(() => {
    api.health().then(
      (h) => {
        setHealth(h);
        setHealthError(false);
      },
      () => setHealthError(true),
    );
  }, []);

  useEffect(() => {
    refreshHealth();
    api.questions().then((r) => setQuestions(r.questions), () => {});
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [refreshHealth]);

  const navigate: Shared['navigate'] = (p, opts) => {
    if (opts?.questionId) setDemoQuestionId(opts.questionId);
    if (opts?.runId) setTraceRunId(opts.runId);
    window.location.hash = p;
    setPage(p);
  };

  const shared: Shared = { health, questions, refreshHealth, navigate, openChunk: setChunkId, demoQuestionId, traceRunId, setTraceRunId };

  return (
    <div className="flex h-full">
      <aside className="flex w-64 shrink-0 flex-col border-r border-ink-700 bg-ink-900">
        <div className="px-5 pb-4 pt-5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-accent-strong to-teal/80 text-sm font-bold text-white">R</div>
            <div>
              <div className="text-[15px] font-semibold text-white">RAG Evaluation Lab</div>
              <div className="text-[11px] text-slate-500">NIST cybersecurity corpus</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 px-3">
          {NAV.filter((n) => !n.advanced || showAdvanced).map((n, i, list) => (
            <div key={n.id}>
              {n.advanced && !list[i - 1]?.advanced && <div className="px-3 pb-1 pt-4 text-[10px] font-semibold uppercase tracking-wider text-slate-600">Advanced</div>}
              <button
                onClick={() => navigate(n.id)}
                className={cx(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                  page === n.id ? 'bg-accent/15 font-medium text-white' : 'text-slate-400 hover:bg-ink-800 hover:text-slate-200',
                )}
              >
                <n.icon className={cx('h-4 w-4', page === n.id ? 'text-accent' : '')} />
                {n.label}
              </button>
            </div>
          ))}
          <button onClick={() => setShowAdvanced(!showAdvanced)} className="mt-3 px-3 text-xs text-slate-600 hover:text-slate-400">
            {showAdvanced ? 'Hide advanced views' : 'Show advanced views'}
          </button>
        </nav>
        <div className="space-y-1.5 border-t border-ink-700 px-5 py-4 text-xs">
          <StatusLine ok={!healthError && Boolean(health)} label={healthError ? 'API unreachable' : 'API online'} />
          <StatusLine ok={Boolean(health?.openaiKeyConfigured)} label={health?.openaiKeyConfigured ? 'OpenAI key configured' : 'OpenAI key missing'} />
          <StatusLine ok={Boolean(health?.corpusReady)} label={health?.corpusReady ? `${health.chunkCount.toLocaleString()} chunks indexed` : 'Corpus not ingested'} />
        </div>
      </aside>

      <main className="scroll-thin flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] px-8 py-7">
          {healthError && (
            <div className="mb-5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
              Cannot reach the API server. Start it with <code className="font-mono">npm run dev</code> from the project root.
            </div>
          )}
          {page === 'overview' && <Overview {...shared} />}
          {page === 'demo' && <LiveDemo {...shared} />}
          {page === 'lab' && <Lab {...shared} />}
          {page === 'evaluation' && <Evaluation {...shared} setQuestions={setQuestions} />}
          {page === 'corpus' && <Corpus {...shared} />}
          {page === 'trace' && <AgentTrace {...shared} />}
          {page === 'settings' && <SettingsPage {...shared} />}
        </div>
      </main>
      <ChunkModal chunkId={chunkId} onClose={() => setChunkId(null)} />
    </div>
  );
}

function StatusLine({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-slate-400">
      <span className={cx('h-1.5 w-1.5 rounded-full', ok ? 'bg-teal' : 'bg-amber-400')} />
      {label}
    </div>
  );
}
