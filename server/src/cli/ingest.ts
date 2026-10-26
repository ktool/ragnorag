import { DB_PATH } from '../config.ts';
import { AppContext, defaultProviders } from '../context.ts';
import { ingestCorpus, listDocuments } from '../corpus/ingest.ts';
import { Store } from '../store.ts';

const ctx = new AppContext(new Store(DB_PATH), defaultProviders());
try {
  await ingestCorpus(ctx, (m) => console.log(m));
  console.table(listDocuments(ctx).map((d) => ({ id: d.id, status: d.status, pages: d.pageCount, chunks: d.chunkCount, error: d.error ?? '' })));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
