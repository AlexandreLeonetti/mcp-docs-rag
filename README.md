# MCP Docs RAG

Small local Node.js RAG demo for an enterprise documentation corpus, exposed through a simple MCP tool and a CLI chat loop.

The project stays intentionally incremental:

- JSON index on disk
- metadata-aware chunking and retrieval
- optional local embedding support
- MCP server interface unchanged
- local grounded fallback when DeepSeek is unavailable

## Enterprise Demo Corpus

The demo corpus now centers on clean markdown documents under `docs/`, grouped by domain:

- `company/`
- `product/`
- `support/`
- `billing/`
- `security/`
- `onboarding/`
- `incidents/`
- `meetings/`
- `tickets/`

Typical document families:

- company and org docs
- policies and process docs
- release notes and roadmap docs
- incident reports and postmortems
- meeting notes
- support tickets

## Frontmatter Parsing

Markdown files can include YAML frontmatter like:

```yaml
---
title: Refunds Policy
doc_type: policy
department: billing
updated_at: 2025-12-02
tags: [billing, refunds]
---
```

During indexing, frontmatter values take precedence over inferred metadata when present:

- `title`
- `doc_type`
- `department`
- `updated_at`
- `tags`

The index also keeps:

- `filename`
- `source_path`
- `section_heading`
- `chunk_id`
- `date`
- `month`

Dates and months are derived from filenames, paths, titles, or `updated_at` when possible.

## Chunking

Chunking is tuned for enterprise markdown:

- splits by heading hierarchy and paragraph groups
- preserves heading paths in `section_heading`
- avoids over-splitting short sections
- keeps bullets and short note sections together when practical
- works reasonably across policies, release notes, incidents, tickets, and meeting notes

## Query Modes

The query analyzer routes queries into:

- `fact_lookup`
- `temporal_summary`
- `recurring_themes`
- `first_mention`
- `evolution_over_time`
- `comparison`

Broad queries widen retrieval and build aggregated evidence before answer generation.

Examples:

- fact lookup: CEO, refund window, grace period, onboarding owner
- temporal summary: December meeting notes, incident timeline
- recurring themes: repeated support issues across tickets or meetings
- first mention: earliest document mentioning a feature or issue
- evolution over time: incident report to postmortem, multi-doc progression
- comparison: policy vs tickets, November vs December release notes

## Retrieval Notes

Retrieval uses:

1. lexical scoring over content and metadata
2. optional local embedding similarity from `@huggingface/transformers`
3. metadata-aware reranking

When local embeddings are available, retrieval is hybrid:

- lexical score stays in place
- semantic score is cosine similarity between the query embedding and stored chunk embeddings
- a small weighted hybrid score combines both signals before reranking

When local embeddings are disabled, missing from the JSON index, or fail to load, retrieval falls back to lexical-only mode without crashing.

Comparison queries explicitly try to cover both sides instead of collapsing into one doc family.

Citation format is stable and readable:

```text
[filename | chunk_id | date-or-updated_at]
```

## Setup

Requirements:

- Node.js 18+
- optional `DEEPSEEK_API_KEY` for model-generated chat answers
- no embedding API key is required

Install:

```bash
npm install
# or install the new dependency explicitly if you are updating an existing clone:
# npm install @huggingface/transformers
```

Example `.env`:

```env
INDEX_FILE=./data/index.json
LOG_DIR=./logs

# DeepSeek answer generation is optional.
# Without it, chat falls back to local grounded answers.
# DEEPSEEK_API_KEY=your_deepseek_api_key

# Optional local embeddings for indexing + hybrid retrieval
ENABLE_LOCAL_EMBEDDINGS=false
LOCAL_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
# Optional batching knob if you want to reduce memory usage
# LOCAL_EMBEDDING_BATCH_SIZE=16

# Optional debug output
# RETRIEVAL_DEBUG=1
```

Notes:

- local embeddings use `@huggingface/transformers`
- the default model is `Xenova/all-MiniLM-L6-v2`
- the model may be downloaded once on first use and cached locally
- if the model cannot be loaded, indexing and retrieval still work in lexical-only mode

## Rebuild The Index

After changing corpus files:

```bash
npm run build-index
```

To rebuild with local embeddings stored directly inside `data/index.json`:

```bash
ENABLE_LOCAL_EMBEDDINGS=true npm run build-index
```

You can verify that embeddings were written by checking:

```bash
node -e "const index=require('./data/index.json'); console.log(index.embedding); console.log(index.chunks.find(chunk => Array.isArray(chunk.embedding))?.embedding?.length || 0)"
```

## Run Chat

```bash
npm run chat
```

With retrieval debug enabled:

```bash
RETRIEVAL_DEBUG=1 npm run chat
```

This shows retrieval debug lines directly in the CLI chat, including query analysis, lexical candidate selection, retrieval mode, and top final hits.

With local embeddings and retrieval debug enabled:

```bash
ENABLE_LOCAL_EMBEDDINGS=true RETRIEVAL_DEBUG=1 npm run chat
```

This also shows whether the query was converted to an embedding and whether hybrid retrieval is active for that query.

In debug mode you will see:

- whether local embeddings were configured and used
- whether the query embedding step ran
- whether retrieval ran in lexical-only or hybrid mode
- a compact retrieval summary in the visible chat terminal

The MCP tool name remains:

```text
search_internal_docs
```

## Run Eval

```bash
npm run eval
```

Eval outputs are written under `eval/results/`.

## Eval Coverage

The benchmark is grounded in the enterprise corpus and includes:

- 8 easy questions
- 8 medium questions
- 8 hard questions

Coverage includes:

- fact lookup
- policy lookup
- release note comparison
- incident timeline
- ticket vs policy comparison
- recurring support issue themes
- access and security rules
- onboarding ownership and process

Each eval item stores:

- `id`
- `query`
- `expected_mode`

## Project Structure

```text
.
├── docs/
├── src/
│   ├── cli/
│   │   └── chat.js
│   ├── indexing/
│   │   ├── build-index.js
│   │   ├── indexing.js
│   │   └── text-utils.js
│   ├── llm/
│   │   ├── answering.js
│   │   └── embeddings.js
│   ├── mcp/
│   │   └── server.js
│   └── retrieval/
│       ├── query-analysis.js
│       └── retrieval.js
├── data/
│   └── index.json
├── eval/
│   ├── questions.json
│   └── results/
├── logs/
└── scripts/
    └── run-eval.js
```

## Limitations

- frontmatter parsing is intentionally lightweight and expects simple scalar or inline array values
- broad summaries are heuristic and grounded, not full document synthesis
- comparison answers are stronger for two-sided questions than for three-way comparisons
- embedding retrieval is optional; lexical fallback still needs clean wording in queries for best results
- there is still no vector database; embeddings are stored inline in `data/index.json`
