# MCP Docs RAG Phase 1

Small local RAG-style knowledge search for Node.js with:

- metadata-aware indexing
- lexical retrieval with optional embeddings
- heuristic reranking
- temporal daily-note analysis
- MCP server access
- CLI chat

The project stays intentionally small. It still uses a JSON index on disk and a simple MCP tool, but the retrieval stack is stronger and easier to inspect.

## What Changed

The original version was a keyword-only chunk retriever. This phase adds:

- richer chunk metadata: `source_path`, `filename`, `extension`, `title`, `doc_type`, `date`, `month`, `tags`, `section_heading`, `chunk_id`
- daily-note aware chunking for date-based files
- optional hybrid retrieval with embeddings
- a reranking layer with metadata boosts
- query analysis and retrieval planning
- broader evidence gathering for recurring themes / first mention / over-time questions
- consistent citations
- retrieval debug output
- lightweight evaluation scaffolding

## Project Structure

```text
.
├── build-index.js
├── chat.js
├── server.js
├── docs/
├── data/
│   └── index.json
├── eval/
│   ├── questions.json
│   └── results/
├── lib/
│   ├── answering.js
│   ├── embeddings.js
│   ├── indexing.js
│   ├── query-analysis.js
│   ├── retrieval.js
│   └── text-utils.js
└── scripts/
    └── run-eval.js
```

## Requirements

- Node.js 18+
- `DEEPSEEK_API_KEY` for LLM answers in the CLI
- optional `OPENAI_API_KEY` if you want embedding-based retrieval

## Setup

Install dependencies:

```bash
npm install
```

Create `.env`:

```env
DEEPSEEK_API_KEY=your_deepseek_api_key
INDEX_FILE=./data/index.json
LOG_DIR=./logs

# Optional hybrid retrieval
EMBEDDING_PROVIDER=none
# EMBEDDING_PROVIDER=openai
# OPENAI_API_KEY=your_openai_key
# EMBEDDING_MODEL=text-embedding-3-small

# Optional retrieval debugging
# RETRIEVAL_DEBUG=1
```

## Metadata-Aware Retrieval

When you run `npm run build-index`, each chunk now stores:

- `source_path`
- `filename`
- `extension`
- `title`
- `doc_type`
- `date`
- `month`
- `tags`
- `section_heading`
- `chunk_id`

`doc_type` is inferred with simple heuristics:

- `daily note`
- `company doc`
- `prep/interview note`
- `app/product note`
- `miscellaneous`

Date-style filenames such as `20251204.txt` are parsed automatically into `date=2025-12-04` and `month=2025-12`.

## Chunking

Normal docs still use paragraph-oriented chunking with heading preservation.

Daily notes use a special mode:

- chunks are built from paragraph groups / bullet groups
- tiny blocks are merged to avoid useless micro-chunks
- heading linkage is preserved when detectable
- local neighboring context is attached to chunks for debugging and answer synthesis

## Hybrid Retrieval

Retrieval works in two layers:

1. lexical scoring over content, filename, path, title, heading, tags
2. optional semantic scoring from embeddings

If embeddings are enabled, the final retrieval score combines:

- lexical score
- semantic score
- reranker boosts

If embeddings are not configured, the system stays fully functional in lexical-only mode.

To enable embeddings:

```env
EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=your_openai_key
EMBEDDING_MODEL=text-embedding-3-small
```

Fallback mode without embeddings:

```env
EMBEDDING_PROVIDER=none
```

## Query Analysis And Temporal Search

Before retrieval, the query is classified into one of these modes:

- `fact_lookup`
- `scoped_lookup`
- `temporal_summary`
- `recurring_themes`
- `first_mention`
- `evolution_over_time`
- `comparison`
- `unsupported / unknown`

The pipeline also extracts filters where possible:

- date range
- month/year
- doc type preference
- filename clues
- topic keywords

Broad temporal questions do not stop at the top 5 chunks. The retriever widens the pool, filters by metadata, groups evidence by date or file, and produces aggregated evidence before the final answer step.

This is especially useful for:

- exact fact lookup
- month-scoped daily-note queries
- recurring themes across many notes
- first-mentioned questions
- evolution / over-time summaries

## MCP Server

The MCP tool name is still:

```text
search_internal_docs
```

It now returns:

- query analysis
- retrieval mode
- aggregated evidence for broad queries when available
- retrieved chunks with richer metadata
- consistent citations in this format:

```text
[filename | chunk_id | date]
```

## Build The Index

After changing docs:

```bash
npm run build-index
```

Example output:

```text
Index built: ./data/index.json
Files indexed: 66
Chunks indexed: 200
Embeddings: disabled (lexical fallback only)
```

## Run The Chat CLI

```bash
npm run chat
```

The CLI still uses the MCP server for retrieval. If `DEEPSEEK_API_KEY` is not set, it falls back to a local grounded summary so the project still runs locally.

## Debug Retrieval

Enable retrieval debugging:

```bash
RETRIEVAL_DEBUG=1 npm run chat
```

Debug mode exposes:

- query classification
- extracted filters
- retrieval mode used
- top lexical hits
- top semantic hits
- final reranked hits
- reranker boost reasons

## Evaluation Scaffolding

Sample queries live in:

- `eval/questions.json`

Run the evaluation script:

```bash
npm run eval
```

This writes a review-friendly JSON file under `eval/results/` containing:

- query
- expected mode
- query analysis
- retrieval mode
- broad summary
- retrieved chunks
- final answer
- citations

## Suggested Questions

- `Who is the CEO of Northstar Metrics?`
- `What recurring priorities appear in the December 2025 daily notes?`
- `On which date was Alipay first mentioned in the daily notes?`
- `How did the focus on Chinese tutoring evolve over time in the daily notes?`
- `Compare the company billing policy with what appears in the daily notes about billing or payments.`

## Notes And Limits

- broad summaries are heuristic and grounded, not model-perfect
- theme extraction is token-based, so labels can still be rough
- semantic retrieval only works if embeddings were built into the index
- the system does not yet do permission filtering, structured scoring benchmarks, or true learned reranking
