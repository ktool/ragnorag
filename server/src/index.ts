import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { DB_PATH, ROOT_DIR } from './config.ts';
import { AppContext, defaultProviders } from './context.ts';
import { createApp } from './app.ts';
import { Store } from './store.ts';
import { hasApiKey } from './providers/openai.ts';

const ctx = new AppContext(new Store(DB_PATH), defaultProviders());
const app = createApp(ctx);

// Serve the built frontend when available (npm run build && npm start).
const webDist = path.join(ROOT_DIR, 'web', 'dist');
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api).*/, (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

const port = Number(process.env.PORT ?? 8787);
app.listen(port, '127.0.0.1', () => {
  console.log(`RAG Evaluation Lab API on http://127.0.0.1:${port}`);
  if (!hasApiKey()) console.warn('OPENAI_API_KEY is not set — add it to .env (see .env.example).');
  console.log(ctx.hasIndex() ? `Corpus index loaded: ${ctx.getIndex().size} chunks` : 'Corpus not ingested yet: run `npm run ingest` or use the UI.');
  // Warm the local reranker so the first live demo run is not delayed by the model download/load.
  const t = performance.now();
  ctx.getReranker().then(
    (r) => console.log(`Reranker ready: ${r.modelId} (${Math.round(performance.now() - t)} ms)`),
    (e) => console.warn(e instanceof Error ? e.message : e),
  );
});
