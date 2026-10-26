import type { ChunkMeta, GoldenQuestion, RetrievalMetrics } from '@rag-lab/shared';

const norm = (s: string) => s.toLowerCase().replace(/[‐-―-]/g, '-').replace(/\s+/g, ' ').trim();

interface EvidenceItem {
  grade: number;
  matches: (c: ChunkMeta) => boolean;
}

/** Each annotated evidence passage (or manually annotated chunk ID) is one unit of relevance. */
export function evidenceItems(q: GoldenQuestion): EvidenceItem[] {
  const items: EvidenceItem[] = q.relevantEvidence.map((e) => ({
    grade: e.grade,
    matches: (c) =>
      c.documentId === e.documentId &&
      (e.page === undefined || (e.page >= c.pageNumber && e.page <= c.pageEnd)) &&
      norm(c.text).includes(norm(e.mustContain)),
  }));
  for (const id of q.relevantChunkIds) items.push({ grade: 2, matches: (c) => c.chunkId === id });
  return items;
}

export function hasRelevanceJudgments(q: GoldenQuestion | null | undefined): q is GoldenQuestion {
  return Boolean(q && (q.relevantEvidence.length || q.relevantChunkIds.length));
}

/** Chunk IDs in the corpus that satisfy at least one evidence item (for display/annotation). */
export function resolveRelevantChunks(q: GoldenQuestion, corpus: ChunkMeta[]): string[] {
  const items = evidenceItems(q);
  return corpus.filter((c) => items.some((i) => i.matches(c))).map((c) => c.chunkId);
}

/**
 * Deterministic retrieval metrics against evidence-level relevance judgments.
 * - Recall@K: fraction of evidence items matched by at least one of the top K chunks.
 * - Precision@K: fraction of the top K chunks that match any evidence item.
 * - Reciprocal rank: 1 / rank of the first relevant chunk (0 if none); averaged → MRR.
 * - Document coverage: expected documents with at least one relevant chunk in the top K.
 * - nDCG@K: chunk-level graded relevance (gain 2^g − 1, g = best grade the chunk matches),
 *   normalised by the ideal ordering of all relevant chunks in the corpus.
 */
export function retrievalMetrics(ranked: ChunkMeta[], k: number, q: GoldenQuestion, corpus: ChunkMeta[], note = ''): RetrievalMetrics {
  const items = evidenceItems(q);
  const grade = (c: ChunkMeta) => Math.max(0, ...items.filter((it) => it.matches(c)).map((it) => it.grade));
  const top = ranked.slice(0, k);
  const relevantByDocument: Record<string, string[]> = {};
  for (const c of top) if (grade(c) > 0) (relevantByDocument[c.documentId] ??= []).push(c.chunkId);
  const satisfied = new Set<number>();
  let relevantInTop = 0;
  let rr = 0;
  let dcg = 0;
  top.forEach((c, i) => {
    items.forEach((it, idx) => it.matches(c) && satisfied.add(idx));
    const g = grade(c);
    if (g > 0) {
      relevantInTop++;
      if (rr === 0) rr = 1 / (i + 1);
      dcg += (2 ** g - 1) / Math.log2(i + 2);
    }
  });
  const ideal = corpus
    .map(grade)
    .filter((g) => g > 0)
    .sort((a, b) => b - a)
    .slice(0, k)
    .reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);

  return {
    k,
    recallAtK: items.length ? satisfied.size / items.length : 0,
    precisionAtK: top.length ? relevantInTop / top.length : 0,
    reciprocalRank: rr,
    ndcgAtK: ideal ? dcg / ideal : 0,
    relevantFound: satisfied.size,
    relevantTotal: items.length,
    relevantChunkIds: resolveRelevantChunks(q, corpus),
    documentCoverage: {
      expected: q.expectedDocumentIds,
      covered: q.expectedDocumentIds.filter((d) => relevantByDocument[d]?.length),
      relevantByDocument,
    },
    note,
  };
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
