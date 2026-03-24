Absolutely — here is a compact `README.md` you can paste into the project.

````md
# MCP Docs RAG MVP

A small local **RAG-style internal docs assistant** built with:

- **Node.js**
- **MCP (Model Context Protocol)**
- **DeepSeek API**
- a simple local document index stored in JSON

This project lets you ask natural-language questions about local documentation files, retrieve relevant chunks, and generate grounded answers with citations.

---

## What this project is

This is a **basic local docs RAG assistant**.

Flow:

1. local docs are indexed into `data/index.json`
2. the MCP server exposes a `search_internal_docs` tool
3. the CLI retrieves relevant chunks through MCP
4. DeepSeek answers using only the retrieved context

This is **not a full autonomous agent**.
It is better described as:

- **RAG assistant**
- **local knowledge assistant**
- **MCP-powered retrieval demo**

---

## Project structure

```text
.
├── README.md
├── build-index.js
├── chat.js
├── data
│   └── index.json
├── docs
│   ├── auth.md
│   ├── billing.md
│   ├── support.txt
│   └── company.md
├── logs
│   └── session-*.json
├── package.json
└── server.js
````

### Main files

* `docs/`
  Your source documentation files

* `build-index.js`
  Reads files from `docs/` and creates the searchable index

* `data/index.json`
  Generated document index used for retrieval

* `server.js`
  MCP server exposing `search_internal_docs`

* `chat.js`
  CLI chat app that:

  * calls the MCP retrieval tool
  * sends retrieved context to DeepSeek
  * prints the final grounded answer

* `logs/`
  JSON session logs for debugging

---

## Requirements

* Node.js 18+ recommended
* a DeepSeek API key

---

## Installation

Clone or copy the project locally, then install dependencies:

```bash
npm install
```

Create a `.env` file in the project root:

```env
DEEPSEEK_API_KEY=your_deepseek_api_key_here
INDEX_FILE=./data/index.json
LOG_DIR=./logs
```

Only `DEEPSEEK_API_KEY` is required in most cases.

---

## Add your documents

Put your local documentation files inside the `docs/` folder.

Example:

* `docs/auth.md`
* `docs/billing.md`
* `docs/company.md`
* `docs/support.txt`

You can use `.md` and `.txt` files for a simple MVP.

Example `billing.md`:

```md
# Billing Policy

Customers are billed monthly.

## Refunds
Refund requests must be submitted within 14 days of the billing date.

## Failed payments
If a payment fails, the account remains active for a 3-day grace period before restriction.
```

---

## Build the search index

After adding or editing documents, rebuild the index:

```bash
npm run build-index
```

This generates:

```text
data/index.json
```

If you change the docs and do not rebuild the index, the assistant will keep using old content.

---

## Start the chat CLI

Run:

```bash
npm run chat
```

You should see something like:

```text
Internal Docs MCP CLI started.
Ask things like: "how do we handle auth in onboarding?"
Type "exit" to quit.
```

Example questions:

```text
who is the ceo?
are customers billed weekly?
what is the refund policy?
who leads onboarding?
where is the headquarters?
```

Exit with:

```text
exit
```

---

## How it works

### 1. Retrieval

`chat.js` sends your question to the MCP server tool:

* tool name: `search_internal_docs`

The server searches the local JSON index and returns the best matching chunks.

### 2. Grounded answer generation

The retrieved chunks are inserted into a single DeepSeek prompt.

The model is instructed to:

* answer only from retrieved documentation
* avoid inventing missing facts
* cite the returned sources

### 3. Logging

Each session creates a JSON file in `logs/` so you can inspect:

* user questions
* retrieval results
* model requests
* model responses
* errors

---

## Typical workflow

### First time setup

```bash
npm install
npm run build-index
npm run chat
```

### After editing docs

```bash
npm run build-index
npm run chat
```

---

## Example usage

Question:

```text
are customers billed weekly?
```

Possible answer:

```text
Based on the retrieved documentation, customers are not billed weekly. Customers are billed monthly (SOURCE: billing.md#chunk-1).
```

---

## Troubleshooting

### 1. `Index file not found`

Error like:

```text
Index file not found: ./data/index.json
```

Fix:

```bash
npm run build-index
```

---

### 2. DeepSeek API errors

Check that your `.env` contains a valid API key:

```env
DEEPSEEK_API_KEY=...
```

Also make sure your account and credits are working.

---

### 3. The assistant does not find new content

You probably forgot to rebuild the index.

Run:

```bash
npm run build-index
```

---

### 4. Retrieval quality feels weak

This MVP uses simple indexing and scoring.
It works for small demos, but larger corpora will need:

* better chunking
* richer metadata
* embeddings or hybrid search
* reranking

---

## Current limitations

This is intentionally a simple MVP.

Current limitations include:

* local files only
* simple token-based retrieval
* no embeddings yet
* no reranker
* no permissions model
* no web UI
* no source connectors like Confluence, Notion, Slack, or Google Drive

---

## Good next improvements

If you want to evolve this into a more serious enterprise-style project, the best next steps are:

1. better chunking by headings and sections
2. metadata enrichment
3. Postgres + pgvector
4. real connectors:

   * Confluence
   * Notion
   * Google Drive
   * Slack
5. web UI
6. evaluation scripts
7. observability and cost tracking
8. permission-aware retrieval

---

## Summary

This project is a small but useful demo of:

* local document ingestion
* MCP-based retrieval
* one-shot grounded answering
* simple RAG architecture

It is a good starting point for building a more serious internal knowledge assistant.

---



