import { downloadCorpus } from '../corpus/ingest.ts';

const results = await downloadCorpus();
if (results.some((r) => !r.ok)) {
  console.error('Some downloads failed. Place the PDFs manually in data/corpus/ (see README).');
  process.exit(1);
}
