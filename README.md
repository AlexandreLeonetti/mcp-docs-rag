# MCP Docs RAG

Local Node.js RAG prototype for internal docs, now backed by PostgreSQL + pgvector instead of `data/index.json`.

The migration stays intentionally incremental:

- docs still live under `docs/`
- `npm run build-index` still reads, chunks, enriches, and indexes docs
- CLI chat and the MCP tool still use the same retrieval entrypoints
- a separate `web/` Next.js app now provides a simple browser chat UI
- retrieval still follows the same mental model: lexical first, optional semantic rerank, then metadata-aware reranking

## Postgres MVP Architecture

```text
src/
├── db/
│   ├── client.js
│   ├── init.js
│   ├── migrations/
│   └── schema.sql
├── indexing/
│   ├── build-index.js
│   ├── chunker.js
│   ├── embedder-client.js
│   ├── indexing.js
│   └── postgres-writer.js
├── retrieval/
│   ├── lexical-search.js
│   ├── semantic-search.js
│   ├── hybrid-search.js
│   ├── query-analysis.js
│   └── retrieval.js
├── cli/
│   └── chat.js
├── chat/
│   └── run-chat-turn.js
└── mcp/
    └── server.js

web/
├── app/
│   ├── api/chat/route.ts
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
└── components/
    ├── ChatShell.tsx
    ├── Composer.tsx
    └── MessageBubble.tsx
```

Postgres now stores:

- documents
- chunks
- chunk metadata as `jsonb`
- full-text search data via `tsvector`
- optional chunk embeddings via `pgvector`

## Schema Overview

`documents` stores one row per source file:

- `source_path`
- `filename`
- `title`
- `doc_type`
- `content_hash`
- `metadata_json`

`chunks` stores retrieval units:

- `document_id`
- `chunk_index`
- `chunk_id`
- `content`
- `token_count`
- `section_heading`
- `date`
- `month`
- `metadata_json`
- `content_tsv`
- `embedding`

Current indexes include:

- GIN index on `chunks.content_tsv`
- btree indexes on document/chunk lookup fields
- unique `chunk_id`

Vector ANN indexing is intentionally deferred for this MVP.

## Retrieval Flow

High level flow:

1. analyze the query and keep the existing mode/filter logic
2. fetch lexical candidates from Postgres using full-text search on `chunks.content_tsv`
3. rescore candidates in application code with the existing metadata-aware lexical logic
4. optionally embed the query and compare it against stored chunk embeddings
5. combine lexical + semantic scores
6. apply the existing rerank and broad-summary logic

When local embeddings are disabled or unavailable, retrieval falls back to lexical-only mode.

## Setup

Requirements:

- Node.js 18+
- Docker for local Postgres
- optional `DEEPSEEK_API_KEY` for model-generated chat answers

Install dependencies:

```bash
npm install
```

Example `.env`:

```env
DATABASE_URL=postgresql://mcp:mcp@localhost:5432/mcp_docs_rag
PGHOST=localhost
PGPORT=5432
PGDATABASE=mcp_docs_rag
PGUSER=mcp
PGPASSWORD=mcp

LOG_DIR=./logs

# Optional local embeddings for indexing + hybrid retrieval
ENABLE_LOCAL_EMBEDDINGS=false
LOCAL_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
# LOCAL_EMBEDDING_BATCH_SIZE=16

# Optional retrieval debug lines in CLI output
# RETRIEVAL_DEBUG=1

# Optional DeepSeek answer generation
# DEEPSEEK_API_KEY=your_deepseek_api_key
```

## Start Postgres

Start PostgreSQL with pgvector:

```bash
docker compose up -d
```

Initialize the schema:

```bash
npm run db:init
```

The migration runner applies SQL files from [src/db/migrations](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/db/migrations).

## Build The Index

Reindex docs into Postgres:

```bash
npm run build-index
```

With local embeddings enabled:

```bash
ENABLE_LOCAL_EMBEDDINGS=true npm run build-index
```

Indexing now does this:

1. reads source files from `docs/`
2. extracts frontmatter and inferred metadata
3. chunks content with the existing chunking rules
4. computes embeddings when enabled
5. upserts the document row
6. deletes and recreates that document’s chunk rows so reruns do not duplicate data

## Run Chat

```bash
npm run chat
```

With retrieval debug:

```bash
RETRIEVAL_DEBUG=1 npm run chat
```

With local embeddings enabled:

```bash
ENABLE_LOCAL_EMBEDDINGS=true RETRIEVAL_DEBUG=1 npm run chat
```

The MCP tool name remains:

```text
search_internal_docs
```

## Run Web Chat

The browser UI lives in a separate `web/` app and reuses the same backend chat-turn helper as the CLI.

Install the web app dependencies:

```bash
cd web
npm install
```

Start the web app:

```bash
cd web
npm run dev
```

Or from the repo root:

```bash
npm run web
```

Then open `http://localhost:3000`.

The web app adds:

- one chat page
- one API route at `web/app/api/chat/route.ts`
- a thin bridge into `src/chat/run-chat-turn.js`

The existing CLI workflow is unchanged and still works with `npm run chat`.

## Run Eval

```bash
npm run eval
```

## Local Setup Example

```bash
docker compose up -d
npm install
npm run db:init
npm run build-index
npm run chat

# optional web UI
cd web && npm install && npm run dev
```

## Notes And MVP Limits

- Postgres is now the primary storage layer. The old JSON index is no longer the main runtime source of truth.
- Full-text search currently indexes chunk content, while metadata-aware lexical boosts still happen in application code.
- Embedding storage assumes the current local model dimension of 384.
- The schema is migration-based but intentionally lightweight.
- Approximate vector indexing, advanced metadata filters, and zero-downtime reindexing are out of scope for this MVP.
- The web UI is intentionally isolated from the backend under `web/` and calls the existing retrieval/answer flow through a small shared helper.
```txt
docs/
  ↓
src/indexing/chunker.js
  ↓
src/indexing/embedder-client.js
  ↓
src/indexing/postgres-writer.js
  ↓
Postgres
  ├─ documents
  └─ chunks (+ tsvector + pgvector)

user question
  ↓
src/retrieval/lexical-search.js
  ↓
src/retrieval/semantic-search.js
  ↓
src/retrieval/hybrid-search.js
  ↓
src/retrieval/retrieval.js
  ↓
src/chat/run-chat-turn.js
  ↓
MCP / CLI chat / Next.js web API
```
