import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SettingsSchema, type Settings } from '@rag-lab/shared';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '../..');
export const DATA_DIR = process.env.RAG_LAB_DATA_DIR ?? path.join(ROOT_DIR, 'data');
export const CORPUS_DIR = path.join(DATA_DIR, 'corpus');
export const DB_PATH = path.join(DATA_DIR, 'rag-lab.db');
export const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
export const GOLDEN_PATH = path.join(ROOT_DIR, 'server', 'golden', 'questions.json');
export const MODEL_CACHE_DIR = path.join(DATA_DIR, 'model-cache');
export const APP_VERSION = '0.1.0';
export const PROMPT_VERSION = 'prompts-v1';
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface ManifestEntry {
  id: string;
  title: string;
  shortTitle: string;
  publicationVersion: string;
  publicationDate: string;
  sourceUrl: string;
  pdfUrl: string;
  fileName: string;
  versionNote?: string;
}

/** Versions verified against the downloaded PDFs on 2026-10-26 (see README "Corpus"). */
export const CORPUS_MANIFEST: ManifestEntry[] = [
  {
    id: 'csf-2.0',
    title: 'The NIST Cybersecurity Framework (CSF) 2.0',
    shortTitle: 'CSF 2.0',
    publicationVersion: 'CSWP 29 (CSF 2.0)',
    publicationDate: '2024-02-26',
    sourceUrl: 'https://www.nist.gov/cyberframework',
    pdfUrl: 'https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf',
    fileName: 'NIST.CSWP.29.pdf',
  },
  {
    id: 'sp800-207',
    title: 'NIST SP 800-207: Zero Trust Architecture',
    shortTitle: 'SP 800-207',
    publicationVersion: 'SP 800-207 (Final)',
    publicationDate: '2020-08-11',
    sourceUrl: 'https://csrc.nist.gov/pubs/sp/800/207/final',
    pdfUrl: 'https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-207.pdf',
    fileName: 'NIST.SP.800-207.pdf',
  },
  {
    id: 'sp800-53r5',
    title: 'NIST SP 800-53 Rev. 5: Security and Privacy Controls for Information Systems and Organizations',
    shortTitle: 'SP 800-53r5',
    publicationVersion: 'SP 800-53 Rev. 5 (includes updates as of 2020-12-10)',
    publicationDate: '2020-09 (updated 2020-12-10)',
    sourceUrl: 'https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final',
    pdfUrl: 'https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-53r5.pdf',
    fileName: 'NIST.SP.800-53r5.pdf',
    versionNote:
      'NIST published Release 5.2.0 (2025-08-27) in its online control catalog only; the PDF used here is the Rev. 5 upd1 text. Controls added in 5.2.0 (e.g. SA-24) are not in this corpus.',
  },
];

export const CORPUS_VERSION = CORPUS_MANIFEST.map((d) => `${d.id}@${d.publicationDate}`).join(';');

export const DEFAULT_SETTINGS: Settings = {
  answerModel: process.env.ANSWER_MODEL ?? 'gpt-4.1-mini',
  judgeModel: process.env.JUDGE_MODEL ?? 'gpt-4.1-mini',
  embeddingModel: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
  rerankerModel: 'mini',
  chunkSize: 220,
  chunkOverlap: 40,
  agentMaxRounds: 3,
  runTimeoutMs: 180_000,
  maxOutputTokens: 4000,
  // gpt-4.1-mini is not a reasoning model, so reasoning.effort is omitted.
  reasoningEffort: '',
  // Intentionally empty: enter verified prices from https://openai.com/api/pricing in Settings.
  pricing: {},
  pricingSource: '',
  retrievalDefaults: {
    topK: 6,
    candidateK: 30,
    keyword: true,
    vector: true,
    rrfK: 60,
    queryRewrite: true,
    autoFilter: true,
    rerank: true,
    citationValidation: true,
    abstention: true,
    minRerankScore: 0,
    filters: { documentIds: [] },
  },
};

let cached: Settings | null = null;

export function loadSettings(): Settings {
  if (cached) return cached;
  let stored: unknown = {};
  if (fs.existsSync(SETTINGS_PATH)) stored = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  cached = SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...(stored as object) });
  return cached;
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = SettingsSchema.parse({ ...loadSettings(), ...patch });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  cached = next;
  return next;
}

/** For tests: replace the cached settings without touching disk. */
export function setSettingsForTest(s: Settings) {
  cached = s;
}
