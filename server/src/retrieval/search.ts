import MiniSearch from 'minisearch';
import type { ChunkMeta, MetadataFilters, RankedChunk } from '@rag-lab/shared';
import { indexText } from '../corpus/chunker.ts';
import type { RetrievalBackend } from '../providers/types.ts';

export interface IndexedChunk extends ChunkMeta {
  ordinal: number;
  embedding: Float32Array;
}

export interface Hit {
  chunk: IndexedChunk;
  score: number;
}

const STOPWORDS = new Set(
  'a an and are as at be by does do for from how in into is it its of on or that the this to what when which with who why according'.split(' '),
);

/** Keeps security identifiers such as "AC-2", "AC-2(1)" and "PR.AA-01" as single tokens. */
export function tokenize(text: string): string[] {
  return text.match(/[A-Za-z]{2}-\d{1,2}(?:\(\d{1,2}\))?|[A-Za-z]{2}\.[A-Za-z]{2}(?:-\d{2})?|[\p{L}\p{N}]+/gu) ?? [];
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function matchesFilters(c: ChunkMeta, f: MetadataFilters | undefined): boolean {
  if (!f) return true;
  if (f.documentIds?.length && !f.documentIds.includes(c.documentId)) return false;
  if (f.publicationVersion && c.publicationVersion !== f.publicationVersion) return false;
  if (f.section) {
    const s = f.section.toLowerCase();
    const hay = `${c.sectionNumber ?? ''} ${c.sectionTitle ?? ''}`.toLowerCase();
    if (!(c.sectionNumber === f.section || c.sectionNumber?.startsWith(f.section + '.') || hay.includes(s))) return false;
  }
  if (f.controlId) {
    const id = f.controlId.toUpperCase();
    const own = c.controlId?.toUpperCase();
    // Exact control or its enhancements; otherwise accept chunks that mention the identifier verbatim.
    const ownMatch = own === id || own?.startsWith(id + '(');
    const textMatch = new RegExp(`(^|[^A-Z0-9.-])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^0-9])`).test(c.text.toUpperCase());
    if (!ownMatch && !textMatch) return false;
  }
  return true;
}

/** In-memory corpus index: MiniSearch (BM25+-style) for keywords and brute-force cosine for vectors. */
export class CorpusIndex implements RetrievalBackend {
  readonly chunks: IndexedChunk[];
  private byId: Map<string, IndexedChunk>;
  private mini: MiniSearch<{ chunkId: string; content: string }>;

  constructor(chunks: IndexedChunk[]) {
    this.chunks = chunks;
    this.byId = new Map(chunks.map((c) => [c.chunkId, c]));
    this.mini = new MiniSearch({
      idField: 'chunkId',
      fields: ['content'],
      tokenize,
      processTerm: (t) => {
        const lower = t.toLowerCase();
        return STOPWORDS.has(lower) ? null : lower;
      },
    });
    this.mini.addAll(chunks.map((c) => ({ chunkId: c.chunkId, content: indexText(c) })));
  }

  get size() {
    return this.chunks.length;
  }

  get(chunkId: string) {
    return this.byId.get(chunkId);
  }

  lexical(query: string, k: number, filters?: MetadataFilters): Hit[] {
    const results = this.mini.search(query, {
      combineWith: 'OR',
      filter: (r) => matchesFilters(this.byId.get(r.id as string)!, filters),
    });
    return results.slice(0, k).map((r) => ({ chunk: this.byId.get(r.id as string)!, score: r.score }));
  }

  vector(queryVector: Float32Array, k: number, filters?: MetadataFilters): Hit[] {
    const hits: Hit[] = [];
    for (const c of this.chunks) {
      if (!matchesFilters(c, filters)) continue;
      hits.push({ chunk: c, score: cosine(queryVector, c.embedding) });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, k);
  }

  sections(documentId: string) {
    const seen = new Map<string, { sectionNumber: string | null; sectionTitle: string | null; firstPage: number; chunkCount: number; controlIds: Set<string> }>();
    for (const c of this.chunks) {
      if (c.documentId !== documentId) continue;
      const key = `${c.sectionNumber}|${c.sectionTitle}`;
      const s = seen.get(key) ?? { sectionNumber: c.sectionNumber, sectionTitle: c.sectionTitle, firstPage: c.pageNumber, chunkCount: 0, controlIds: new Set<string>() };
      s.chunkCount++;
      if (c.controlId) s.controlIds.add(c.controlId);
      seen.set(key, s);
    }
    return [...seen.values()].map((s) => ({ ...s, controlIds: [...s.controlIds] }));
  }
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ_lists 1 / (k + rank_list(d)), ranks starting at 1.
 * Only ranks are used, so incompatible raw scores (BM25+ vs cosine) are never mixed.
 */
export function reciprocalRankFusion(lists: Array<Array<{ id: string }>>, k = 60): Array<{ id: string; score: number; ranks: (number | null)[] }> {
  const fused = new Map<string, { score: number; ranks: (number | null)[] }>();
  lists.forEach((list, li) => {
    list.forEach((item, idx) => {
      const entry = fused.get(item.id) ?? { score: 0, ranks: lists.map(() => null) };
      if (entry.ranks[li] !== null) return; // ignore duplicates within one list
      entry.ranks[li] = idx + 1;
      entry.score += 1 / (k + idx + 1);
      fused.set(item.id, entry);
    });
  });
  return [...fused.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function toRanked(
  hits: Array<{ chunk: ChunkMeta; score: number; lexicalRank?: number | null; vectorRank?: number | null }>,
  scoreType: RankedChunk['scoreType'],
): RankedChunk[] {
  return hits.map((h, i) => ({
    chunkId: h.chunk.chunkId,
    rank: i + 1,
    score: Number(h.score.toFixed(5)),
    scoreType,
    lexicalRank: h.lexicalRank,
    vectorRank: h.vectorRank,
    documentId: h.chunk.documentId,
    documentTitle: h.chunk.documentTitle,
    pageNumber: h.chunk.pageNumber,
    sectionTitle: h.chunk.sectionNumber ? `${h.chunk.sectionNumber} ${h.chunk.sectionTitle ?? ''}`.trim() : h.chunk.sectionTitle,
    controlId: h.chunk.controlId,
    preview: h.chunk.text.slice(0, 280),
  }));
}
