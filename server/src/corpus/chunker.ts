import { createHash } from 'node:crypto';
import type { ChunkMeta } from '@rag-lab/shared';

export interface ChunkDocInfo {
  documentId: string;
  documentTitle: string;
  publicationVersion: string;
  sourceUrl: string;
}

export interface ChunkOptions {
  /** Target chunk size in words. */
  chunkSize: number;
  /** Words of trailing context repeated at the start of the next chunk (same section only). */
  chunkOverlap: number;
}

export type Chunk = ChunkMeta & { ordinal: number };

interface Line {
  text: string;
  page: number;
  words: number;
  sectionNumber: string | null;
  sectionTitle: string | null;
  controlId: string | null;
}

const CONTROL_HEADING = /^([A-Z]{2}-\d{1,2})\s+([A-Z0-9][A-Z0-9 ,\-/&|()—–]{3,})$/;
const SECTION_HEADING = /^(\d{1,2}(?:\.\d{1,2}){0,3})\.?\s+(\S.{1,100})$/;
const CSF_ID = /\b([A-Z]{2}\.[A-Z]{2}(?:-\d{2})?)\b/;

const countWords = (s: string) => (s.match(/\S+/g) ?? []).length;

/**
 * Removes running headers/footers and layout noise. Lines repeated on many pages
 * (e.g. "This publication is available free of charge from: ...") are dropped;
 * identifiers, headings and control text are left untouched.
 */
export function cleanPages(pages: string[]): string[][] {
  const split = pages.map((p) =>
    p
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter((l) => l.length > 0),
  );
  const freq = new Map<string, number>();
  for (const lines of split) for (const l of new Set(lines)) freq.set(l, (freq.get(l) ?? 0) + 1);
  const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
  return split.map((lines) =>
    lines.filter((l) => {
      if ((freq.get(l) ?? 0) >= threshold && pages.length > 3) return false;
      if (/^\d{1,4}$/.test(l)) return false; // bare page numbers
      if (/^[ivxlc]{1,6}$/i.test(l)) return false; // roman page numbers
      if (/^_{5,}$/.test(l)) return false;
      if (/^(CHAPTER|APPENDIX) [A-Z]+ PAGE \d+$/.test(l)) return false;
      if (/\.{5,}\s*[\divxlc]+$/i.test(l)) return false; // table-of-contents dot leaders
      return true;
    }),
  );
}

export function detectSectionHeading(line: string): { number: string; title: string } | null {
  const m = SECTION_HEADING.exec(line);
  if (!m) return null;
  const title = m[2].trim();
  const words = title.split(' ');
  if (words.length > 12 || /[.,;:]$/.test(title) || /\. /.test(title)) return null;
  if (Number(m[1].split('.')[0]) > 20) return null;
  const significant = words.filter((w) => w.length > 3);
  const capitalized = significant.filter((w) => /^[A-Z(]/.test(w));
  if (significant.length === 0 || capitalized.length / significant.length < 0.6) return null;
  return { number: m[1], title };
}

export function detectControlHeading(line: string, nextLine: string | undefined): string | null {
  const m = CONTROL_HEADING.exec(line);
  if (!m || !nextLine) return null;
  return /^(Control:|\[Withdrawn)/.test(nextLine) ? m[1] : null;
}

export function stableChunkId(documentId: string, ordinal: number, text: string): string {
  const hash = createHash('sha1').update(text).digest('hex').slice(0, 6);
  return `${documentId}-${String(ordinal).padStart(4, '0')}-${hash}`;
}

/** Joins lines, repairing words hyphenated across line breaks only when the hyphen ends the line. */
function joinLines(lines: Line[]): string {
  let out = '';
  for (const l of lines) {
    if (!out) out = l.text;
    else if (out.endsWith('-') && /^[a-z]/.test(l.text)) out += l.text;
    else out += ' ' + l.text;
  }
  return out;
}

export function chunkDocument(pages: string[], info: ChunkDocInfo, opts: ChunkOptions): Chunk[] {
  if (opts.chunkOverlap >= opts.chunkSize) throw new Error('chunkOverlap must be smaller than chunkSize');
  const cleaned = cleanPages(pages);

  // 1. Annotate every line with its section/control context.
  const lines: Line[] = [];
  let section: { number: string; title: string } | null = null;
  let control: string | null = null;
  cleaned.forEach((pageLines, pi) => {
    pageLines.forEach((text, li) => {
      const next = pageLines[li + 1] ?? cleaned[pi + 1]?.[0];
      const ctrl = detectControlHeading(text, next);
      const sec = ctrl ? null : detectSectionHeading(text);
      if (ctrl) control = ctrl;
      if (sec) {
        section = sec;
        control = null;
      }
      lines.push({
        text,
        page: pi + 1,
        words: countWords(text),
        sectionNumber: section?.number ?? null,
        sectionTitle: section?.title ?? null,
        controlId: control,
      });
    });
  });

  // 2. Group consecutive lines that share a section/control, then window them into chunks.
  const chunks: Chunk[] = [];
  const emit = (group: Line[]) => {
    const text = joinLines(group);
    if (countWords(text) < 5) return;
    const first = group[0];
    const ordinal = chunks.length;
    chunks.push({
      chunkId: stableChunkId(info.documentId, ordinal, text),
      ordinal,
      documentId: info.documentId,
      documentTitle: info.documentTitle,
      publicationVersion: info.publicationVersion,
      sectionNumber: first.sectionNumber,
      sectionTitle: first.sectionTitle,
      controlId: first.controlId ?? CSF_ID.exec(text)?.[1] ?? null,
      pageNumber: first.page,
      pageEnd: group[group.length - 1].page,
      sourceUrl: info.sourceUrl,
      text,
    });
  };

  let current: Line[] = [];
  let words = 0;
  let fresh = 0; // lines added since the last emit (excludes carried overlap)
  const key = (l: Line) => `${l.sectionNumber}|${l.controlId}`;
  for (const line of lines) {
    if (current.length && key(current[0]) !== key(line)) {
      if (fresh > 0) emit(current);
      current = [];
      words = 0;
      fresh = 0;
    }
    current.push(line);
    words += line.words;
    fresh++;
    if (words >= opts.chunkSize) {
      emit(current);
      // Carry trailing lines (up to chunkOverlap words) into the next chunk.
      const carry: Line[] = [];
      let carried = 0;
      for (let i = current.length - 1; i > 0; i--) {
        if (carried + current[i].words > opts.chunkOverlap) break;
        carry.unshift(current[i]);
        carried += current[i].words;
      }
      current = carry;
      words = carried;
      fresh = 0;
    }
  }
  if (fresh > 0) emit(current);
  return chunks;
}

/** Text used for embeddings and keyword indexing: a short metadata header plus the original text. */
export function indexText(c: ChunkMeta): string {
  const header = [c.documentTitle, c.sectionNumber && `${c.sectionNumber} ${c.sectionTitle ?? ''}`, c.controlId]
    .filter(Boolean)
    .join(' | ');
  return `${header}\n${c.text}`;
}
