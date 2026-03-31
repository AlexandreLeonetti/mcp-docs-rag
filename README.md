# MCP Docs RAG

Small local Node.js RAG demo for an enterprise documentation corpus, exposed through a simple MCP tool and a CLI chat loop.

The project stays intentionally incremental:

- JSON index on disk
- metadata-aware chunking and retrieval
- optional embedding support
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
2. optional embedding similarity
3. metadata-aware reranking

Comparison queries explicitly try to cover both sides instead of collapsing into one doc family.

Citation format is stable and readable:

```text
[filename | chunk_id | date-or-updated_at]
```

## Setup

Requirements:

- Node.js 18+
- optional `DEEPSEEK_API_KEY` for model-generated chat answers
- optional `OPENAI_API_KEY` if you enable embeddings

Install:

```bash
npm install
```

Example `.env`:

```env
INDEX_FILE=./data/index.json
LOG_DIR=./logs

# DeepSeek answer generation is optional.
# Without it, chat falls back to local grounded answers.
# DEEPSEEK_API_KEY=your_deepseek_api_key

# Optional hybrid retrieval
EMBEDDING_PROVIDER=none
# EMBEDDING_PROVIDER=openai
# OPENAI_API_KEY=your_openai_key
# EMBEDDING_MODEL=text-embedding-3-small

# Optional debug output
# RETRIEVAL_DEBUG=1
```

## Rebuild The Index

After changing corpus files:

```bash
npm run build-index
```

## Run Chat

```bash
npm run chat
```

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
