import fs from 'node:fs';
import { z } from 'zod';
import { GoldenQuestionSchema, type GoldenQuestion } from '@rag-lab/shared';
import { GOLDEN_PATH } from '../config.ts';

const FileSchema = z.object({ version: z.string(), notes: z.string(), questions: z.array(GoldenQuestionSchema) });
type GoldenFile = z.infer<typeof FileSchema>;

let path = GOLDEN_PATH;
export const setGoldenPathForTest = (p: string) => (path = p);

function read(): GoldenFile {
  return FileSchema.parse(JSON.parse(fs.readFileSync(path, 'utf8')));
}

export function listQuestions(): GoldenQuestion[] {
  return read().questions;
}

export function getQuestion(id: string | null | undefined): GoldenQuestion | null {
  if (!id) return null;
  return listQuestions().find((q) => q.id === id) ?? null;
}

export function updateQuestion(id: string, patch: Partial<GoldenQuestion>): GoldenQuestion {
  const file = read();
  const idx = file.questions.findIndex((q) => q.id === id);
  if (idx < 0) throw new Error(`Unknown question ${id}`);
  const next = GoldenQuestionSchema.parse({ ...file.questions[idx], ...patch, id });
  file.questions[idx] = next;
  fs.writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
  return next;
}
