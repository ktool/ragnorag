# RAG Evaluation Lab

A locally runnable demo that compares four ways of answering questions about the same public NIST cybersecurity corpus. It was built for a live presentation to banking-technology architects and engineers.

| Mode | What it does |
|---|---|
| **No RAG** | The model answers from training data alone. No corpus evidence, so no retrieval metrics. |
| **Basic RAG** | Embeds the question, takes the top-K chunks by cosine similarity, answers only from those chunks and cites chunk IDs. |
| **Optimized RAG** | Metadata filters, an optional query rewrite, BM25+-style keyword search and vector search fused with Reciprocal Rank Fusion (RRF), optional local cross-encoder reranking, citation validation and abstention. Each technique can be switched on or off. |
| **Agentic RAG** | A bounded tool-calling agent (OpenAI Responses API, with the tool loop run by the app). It decides what to search, refines queries, reads chunks and stops when it has enough evidence. Maximum of 3 tool rounds. |

Every number in the UI is one of the following, and each is labelled:

- **measured**: taken from real execution (latency, API-reported tokens, citation resolution) or computed from reviewed relevance judgments (Recall@K, MRR, nDCG).
- **estimated**: cost calculated from measured tokens and the pricing you configure.
- **LLM-judged**: scored by an evaluator model, which is named next to the score. These scores are not ground truth.
- **human**: scored by a reviewer in the UI.

Nothing is hardcoded or simulated in the live path.

---

## Quick start

Prerequisites: **Node.js ≥ 22.5** (developed on Node 26; uses the built-in `node:sqlite`) and an **OpenAI API key**.

```bash
npm install
cp .env.example .env          # then set OPENAI_API_KEY=...
npm run corpus:download       # downloads the 3 NIST PDFs into data/corpus/ (or place them manually, see below)
npm run ingest                # extract → chunk → embed → index  (about 1,300 chunks, a few cents of embeddings)
npm run dev                   # API on http://127.0.0.1:8787, UI on http://localhost:5173
```

Open **http://localhost:5173**. Ingestion can also be run from **Corpus & Ingestion** in the UI.

| Command | Purpose |
|---|---|
| `npm run dev` | API (tsx watch) and Vite dev server together |
| `npm run dev:server` / `npm run dev:web` | Start either one on its own |
| `npm run build` | Type-check all workspaces and build the UI to `web/dist` |
| `npm start -w server` | Serve the API plus the built UI on :8787 (after `npm run build`) |
| `npm run ingest` | Ingest every available PDF and rebuild the index |
| `npm run corpus:download` | Download the official PDFs from nvlpubs.nist.gov |

The first run with reranking enabled downloads a ~23 MB ONNX model (`Xenova/ms-marco-MiniLM-L-6-v2`) from Hugging Face into `data/model-cache/`. The server preloads it at startup so the live demo isn't delayed. Once cached, it runs offline.

### Pricing

Cost is **not** preconfigured, because prices change and should not be assumed. Before presenting, open **Settings → Pricing**, enter USD-per-1M-token prices for the answer and embedding models from https://openai.com/api/pricing, and record the source and date. Until you do, cost shows "pricing not configured" and the cost chart falls back to total tokens.

---

## Corpus

| ID | Publication | Version used | Source |
|---|---|---|---|
| `csf-2.0` | NIST Cybersecurity Framework 2.0 (CSWP 29) | 2024-02-26 | https://www.nist.gov/cyberframework, PDF: https://nvlpubs.nist.gov/nistpubs/CSWP/NIST.CSWP.29.pdf |
| `sp800-207` | SP 800-207 Zero Trust Architecture | Final, 2020-08 | https://csrc.nist.gov/pubs/sp/800/207/final, PDF: https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-207.pdf |
| `sp800-53r5` | SP 800-53 Rev. 5 Security and Privacy Controls | Rev. 5, including updates as of 2020-12-10 (upd1) | https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final, PDF: https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-53r5.pdf |

These versions were checked on 2026-10-26 against the publication pages and the downloaded PDFs. **Note:** NIST published SP 800-53 **Release 5.2.0** (2025-08-27) only in its online control catalog. The PDF is still the upd1 text, so controls added in 5.2.0 (for example SA-24) are not in this corpus. The UI shows this note on the document.

**Placing PDFs manually:** save the files with the exact names above (`NIST.CSWP.29.pdf`, `NIST.SP.800-207.pdf`, `NIST.SP.800-53r5.pdf`) in `data/corpus/`, or use the **PDF** upload button on the Corpus page (PDF only, max 25 MB). If a PDF is missing, the other documents still ingest and the missing one is flagged in the UI.

**Ingestion pipeline** (`server/src/corpus/`):

1. **PDF.js text extraction**, page by page.
2. **Cleanup.** Removes repeated running headers and footers, bare page numbers and table-of-contents dot leaders. Identifiers, headings and control text are kept.
3. **Section detection** (`3.1 Variations of…`, `2.1 REQUIREMENTS AND CONTROLS`) and **800-53 control detection** (`AC-2 ACCOUNT MANAGEMENT` followed by `Control:`).
4. **Chunking.** Line-granular windows (default 220 words with 40-word overlap) that never cross a section or control boundary.
5. **Stable chunk IDs.** The format is `<documentId>-<ordinal>-<sha1(text)[0:6]>`, for example `sp800-207-0031-53b17a`.
6. **Embedding.** A metadata header plus the original text is embedded with `text-embedding-3-small`, in batches.
7. **Storage.** Text, metadata and embeddings go into SQLite (`data/rag-lab.db`). An in-memory MiniSearch and vector index is built at startup. The original text is kept intact for citations.

Page numbers are **PDF page indexes** (1-based), not printed page labels. For example, SP 800-207's printed page 9 is PDF page 18.

When chunk size, overlap or embedding model change, the index is marked **stale** until you re-index (from the Optimization Lab or the Corpus page).

---

## Using the demo

- **Live Demo**: pick one of the two primary questions (or type your own), choose a mode, and **Run**. **Compare all four modes** runs them one after another. Click a citation chip to open the source chunk with its document, section, control ID, page and URL.
- **RAG Optimization Lab**: toggle keyword search, vector search, query rewriting, reranking, citation validation and abstention, and set the metadata filters, top-K, candidate count and RRF `k`. The pipeline trace shows the *actual* candidate lists at each stage: BM25+ list, cosine list, fused RRF list, reranked list and final context. **Use as default** applies the configuration to the Live Demo and evaluations.
- **Evaluation Results**: start a benchmark (choose questions, modes, repeats, and whether to LLM-judge). You get a per-mode comparison table, quality vs. latency and quality vs. cost charts, a question-level matrix (repeats are shown individually), run detail with the judge's rationale, a **human review** form, run history, and **CSV/JSON export**. The **Golden dataset** tab lets you review and edit each golden record.
- **Agent Trace**: a timeline of real model calls and tool executions. For each tool call it shows the tool, sanitized arguments, the model's short stated reason, result count and IDs, duration, and tokens per model call. Hidden reasoning is never shown.

---

## Evaluation methodology

### Golden dataset (`server/golden/questions.json`)

There are eight questions: the two primary demo questions (word-for-word as specified) and six additional ones, including a deliberate **insufficient-evidence** question (`Q6`) where abstention is expected.

Each record has: ID, text, category, expected answer points, expected source documents, section/page references, **relevance judgments**, optional manually annotated chunk IDs, abstention expectation, reviewer notes, and validation status.

Relevance judgments are stored as **evidence phrases**: `{documentId, page?, mustContain, grade 1–3}`. Every phrase was copied verbatim from the extracted PDF text and confirmed to match at least one chunk. A chunk counts as relevant if it contains the phrase. Because of this, retrieval metrics stay valid after re-chunking, whereas raw chunk IDs change.

The expected answer points are the implementer's reading of the evidence. **A human reviewer should sign them off before the presentation.**

### Metrics

| Metric | How it is produced | Label |
|---|---|---|
| Recall@K | Fraction of evidence items matched by at least one top-K chunk | measured |
| Precision@K | Fraction of the top-K chunks that match any evidence item | measured |
| MRR | Mean of 1 / rank of the first relevant chunk | measured |
| nDCG@K | Chunk-level graded gain 2^g − 1, normalised by the ideal ordering of all relevant chunks in the corpus | measured |
| Citations resolve | Fraction of cited IDs that are real chunks actually supplied to (or retrieved by) the model | measured |
| Sentences cited | Heuristic: fraction of substantive sentences that carry a citation marker | measured |
| Groundedness, faithfulness, correctness, completeness, relevance, citation support | Evaluator model with a fixed rubric (`judge-rubric-v1`), scored 1–5 | LLM-judged |
| Citation coverage, unsupported-claim rate | Counts of claims from the evaluator | LLM-judged |
| Abstention quality | Whether abstaining (or not) matched the golden expectation | LLM-judged |
| Input / output / embedding tokens | `usage` fields returned by the OpenAI API, per call | measured |
| Latency | Wall-clock time, end to end and per stage | measured |
| Cost | API-reported tokens × configured pricing (excludes judge calls) | estimated |
| Agent tool calls, rounds, duplicate searches, tool errors | Counted in the tool loop | measured |

Rules enforced in the code and the UI:

- **No RAG** shows **N/A** for retrieval metrics, groundedness, faithfulness and citations. A correct No-RAG answer is never counted as grounded.
- Custom (non-golden) questions show **Not evaluated** for retrieval metrics.
- **Agent retrieval metrics** use all unique chunks the tools returned, in the order they were first seen, with K = the number retrieved. The UI states this.
- Each run records the answer model, prompt version, retrieval settings, reranker model, corpus version and timestamp.
- Query-rewrite and agent-planning tokens are tracked separately from final-answer tokens but included in the totals. Local reranker inference is never counted as API tokens; only its latency is recorded.
- LLM judging runs only when you ask for it (benchmark toggle or "LLM-judge this run"), and results are cached per run.
- Repeats are stored and shown as individual runs. Averages are shown alongside them, and a single run is not presented as conclusive.

---

## Architecture

```
shared/src/index.ts        Zod schemas + TypeScript types for every API contract
server/src/
  app.ts                   Express routes (/api/v1/*, aliased at /api/*)
  config.ts                Paths, corpus manifest (versions/URLs), default settings
  context.ts               App state: store, in-memory index, providers, lazy reranker
  store.ts                 node:sqlite persistence (documents, chunks, runs, judgments, reviews)
  usage.ts                 Per-call token/latency recording and cost estimation
  corpus/                  pdf.ts (PDF.js) · chunker.ts · ingest.ts (download/upload/ingest)
  retrieval/               search.ts (MiniSearch, cosine, filters, RRF) · pipeline.ts (basic/optimized)
  providers/               types.ts (interfaces) · openai.ts · reranker.ts (flashrank-js)
  modes/                   answer.ts (prompts, citations) · agent.ts (tool loop) · run.ts (all modes)
  eval/                    golden.ts · metrics.ts · judge.ts · runner.ts (batches, CSV)
  golden/questions.json    Reviewed golden dataset
web/src/                   React + Tailwind + Recharts UI (one file per page)
data/                      PDFs, SQLite DB, settings.json, model cache (all git-ignored)
```

**Library choices, checked against the installed versions:**

- `openai` 7.x: the Responses API with strict JSON-schema outputs and function tools.
- `minisearch` 7.2: its scorer is **BM25+** (k = 1.2, b = 0.7, d = 0.5, read from the source code), so it is labelled "BM25+-style" rather than standard BM25. A custom tokenizer keeps `AC-2`, `AC-2(1)` and `PR.AA-01` as single tokens.
- `flashrank-js` 0.1.0: a thin wrapper over `@huggingface/transformers` v3 (ONNX). It is young, with a single release and maintainer, so it sits behind the `Reranker` interface. If it can't load, runs fail with a clear message rather than skipping reranking without telling you.
- `pdfjs-dist` 6 (legacy Node build).

### API

`GET /api/v1/health` · `GET /corpus/documents` · `GET /corpus/documents/:id/chunks` · `GET /corpus/chunks/:chunkId` · `POST /corpus/ingest` · `POST /corpus/reindex` · `POST /corpus/download` · `POST /corpus/documents/:id/upload` · `GET /questions` · `PATCH /questions/:id` · `GET /questions/:id/relevant` · `POST /demo/run` · `GET /runs` · `GET /runs/:runId` · `GET /runs/:runId/trace` · `POST /runs/:runId/judge` · `POST /runs/:runId/review` · `POST /evaluation/run` · `GET /evaluation/batches` · `GET /evaluation/results` · `GET /evaluation/export?format=csv|json` · `GET|PATCH /settings`

All inputs are validated with Zod, and validation failures return `400` with details. Setup problems return actionable messages: `409` when the corpus isn't ingested, `503` when the API key is missing. Stack traces are never sent to the client.

### Agent design

- Three read-only tools: `search_documents` (query, strategy, document filter, control filter, top-K), `get_chunk_details` and `get_document_sections`. All use strict JSON schemas, and every argument is validated with Zod again before execution.
- **The application controls the loop.** The model decides whether to call tools and which ones. The app executes them and enforces these limits:
  - at most `agentMaxRounds` tool rounds (default 3);
  - at most 4 calls per round;
  - identical repeat searches are blocked;
  - tool outputs are bounded (700-character snippets, 3,000-character chunk text).
  
  After the last round, the model is called with `tool_choice: "none"` and must answer.
- The final answer is structured JSON with citations. Citations are checked against the chunks the tools *actually returned*, so the agent can't cite a source it never retrieved.
- A timeout for the whole run (`runTimeoutMs`) cancels in-flight API calls through an `AbortSignal`.

### Security

- `OPENAI_API_KEY` is read only from the server environment and never sent to the browser. `.env`, the database, the PDFs, settings and the model cache are all git-ignored.
- Document text is treated as untrusted data. Evidence is wrapped in `<evidence>` tags, and the instructions tell the model never to follow instructions found inside evidence. The tools are read-only and can't execute code or reach external systems.
- Uploads accept PDFs only (magic bytes are checked) up to 25 MB, and only for the three known document slots. Downloads fetch only the URLs in the manifest.
- The server binds to `127.0.0.1`. The corpus is public; no customer or confidential data is used.

---

## Limitations

- **Section detection is heuristic.** Front matter and some CSF chunks have no section, and CSF chunks take the *first* CSF identifier they mention as `controlId`. The control-ID filter therefore also matches on chunk text.
- **Vector search is brute-force** over about 1,300 chunks. That is fine at this scale but not suitable for a large corpus.
- **LLM-judge scores** depend on the evaluator model and rubric. They are useful for comparison under identical conditions, not as absolute truth. Use the human review form for the primary questions.
- **The agent's tool-call "reason"** is a short justification the model writes as a tool argument. It is not its internal reasoning.
- **The reranker model** (MS MARCO MiniLM) is English-only and gives near-binary scores, so the abstention threshold should be calibrated before use.
- **No automated test suite**, deliberately, because this is a proof of concept. `npm run build` type-checks every workspace.
- **Single-user local app.** There is no authentication.

---

## Future: Azure (out of scope for now)

This version is local-only and has no Azure dependency. The retrieval modes, evaluation engine and UI depend only on the interfaces in `server/src/providers/types.ts` (`EmbeddingProvider`, `ResponsesClient`, `Reranker` and `RetrievalBackend`). An Azure OpenAI or Azure AI Search implementation could be added later through `defaultProviders()` in `context.ts` without changing the UI.
