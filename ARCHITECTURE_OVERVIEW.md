# Architecture Overview

This project is a small local RAG-style assistant for files in `docs/`. It first reads local documents, splits them into smaller chunks, and writes those chunks plus metadata into `data/index.json`. At runtime, an MCP server exposes a search tool over that JSON index, a CLI chat client calls that tool for each user question, and the retrieved chunks are then sent to DeepSeek so the model can answer using grounded evidence and citations.

## Quick mental model

1. Files in `docs/` are read during indexing.
2. Each document is split into chunks.
3. The chunks and metadata are stored in `data/index.json`.
4. `src/mcp/server.js` starts an MCP server that exposes a search tool.
5. `src/cli/chat.js` acts as the MCP client and calls that tool.
6. Retrieved chunks are turned into prompt context for DeepSeek.
7. The final answer is printed in the CLI, usually with citations from the retrieved chunks.

## Project structure

- `docs/`
  Local source documents. This is the knowledge base the project searches over.

- `data/index.json`
  Generated index file. It stores chunked document content plus metadata such as file path, title, tags, date fields, and keyword frequencies.

- `src/indexing/build-index.js`
  Small entry script for index building. It reads env config, calls the indexing code, and writes the final JSON index file.

- `src/mcp/server.js`
  The MCP server. It exposes the retrieval tool that searches the indexed documents.

- `src/cli/chat.js`
  The CLI chat app and MCP client. It sends the user question to the MCP server, then sends retrieved context to DeepSeek to generate the final answer.

- `logs/`
  Runtime chat logs. `src/cli/chat.js` creates JSON session logs here so each session records user inputs, MCP calls, DeepSeek requests, responses, and errors.

- `package.json`
  Defines the project scripts such as `npm run build-index`, `npm run server`, and `npm run chat`.

## Where the key RAG pieces are implemented

- Where documents are read from
  Documents are read from `docs/` by default. `src/indexing/build-index.js` sets `DOCS_DIR` to `./docs`, and `src/indexing/indexing.js` recursively reads files from that directory.

- Where chunking is done
  Chunking happens in [`src/indexing/indexing.js`](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/indexing/indexing.js). The main functions are `splitNormalDocument()` and `splitDailyNote()`.

- What chunking strategy is currently used
  It is rule-based chunking, not embedding-based chunking. Normal documents are split around headings and paragraphs with character limits; daily-note-style documents use a smaller block-based strategy.

- Where the index JSON is created
  The JSON structure is assembled in `buildIndex()` inside [`src/indexing/indexing.js`](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/indexing/indexing.js), and then written to `data/index.json` with `fs.writeFileSync()`.

- Where retrieval/search logic is implemented
  Retrieval is implemented in [`src/retrieval/retrieval.js`](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/retrieval/retrieval.js), mainly through `retrieveCandidates()` and `searchInternalDocs()`.

- Where MCP is implemented
  The MCP server lives in [`src/mcp/server.js`](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/mcp/server.js). The MCP client lives in [`src/cli/chat.js`](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/cli/chat.js).

- Where the final LLM call is made
  The final DeepSeek API call is made in [`src/cli/chat.js`](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/cli/chat.js) with `openai.chat.completions.create(...)` using the `deepseek-chat` model and DeepSeek base URL.

- Where logs are written
  Logs are written by [`src/cli/chat.js`](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/cli/chat.js) into `./logs` by default. Each run creates a timestamped `session-...json` file.

## Current chunking system

Chunking happens when the index is built, not during retrieval.

For normal documents, the code:

- normalizes whitespace
- walks through Markdown line by line
- tracks heading hierarchy like `Heading > Subheading`
- turns paragraph blocks into chunk candidates
- merges nearby blocks when they still fit inside the chunk size rules

The default rules for normal documents are:

- target maximum size is about `1100` characters
- smaller blocks may be merged when a chunk is still under that limit
- `minChars` is about `320`, which encourages merging short adjacent blocks
- if one block is too large, it is split again by newline, then by sentence boundary, then by a hard character cutoff if needed

For daily-note-style documents, the logic is different:

- text is split by blank-line blocks
- bullet-heavy blocks may be merged together
- the chunk size cap is smaller, about `750` characters
- short blocks under roughly `220` characters are more likely to be merged

This means the current chunking is mostly paragraph-based and heading-aware, with character limits. It does not use overlap windows in the usual sliding-window sense. Instead, it stores a small `local_context` field with short previous and next chunk previews.

## Current retrieval system

The current retriever is primarily lexical, using the JSON index in `data/index.json`.

In practical terms:

- it is not using a vector database
- it is not using pgvector or any external search engine
- it scores chunks from token matches and occurrences in chunk text and metadata
- metadata such as filename, source path, title, section heading, tags, doc type, and department also affect scoring

The main lexical scoring is in `scoreLexical()` in [`src/retrieval/retrieval.js`](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/retrieval/retrieval.js). It counts overlaps between query tokens and:

- `keyword_freq` from chunk content
- filename and source path tokens
- title and section tokens
- tags
- doc type and department

After that, the code applies extra heuristic boosts in `computeBoosts()` for things like:

- month/date matches
- department or doc-type matches
- filename clues
- topic keyword overlap
- comparison-side matching for comparison queries

There is optional embedding support in the codebase, but the checked-in index currently shows:

- `"embedding": { "enabled": false, "provider": null, "model": null }`

So in the current project state, retrieval is effectively lexical-only. The code can compute semantic scores only if embeddings were enabled during indexing and are available again at query time.

## MCP in this project

MCP is the interface layer between the chat client and the retrieval server.

In beginner terms, that means:

- `src/mcp/server.js` starts a small tool server over stdio
- `src/cli/chat.js` connects to it as a client
- the client asks the server to run a named tool instead of doing retrieval directly in the chat file

In this project:

- the MCP server file is [`src/mcp/server.js`](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/mcp/server.js)
- the exposed tool is `search_internal_docs`
- the MCP client file is [`src/cli/chat.js`](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/cli/chat.js)

So MCP is not doing the ranking itself. It is mainly the transport and tool boundary that lets the chat client call the retrieval logic in a structured way.

## Step-by-step request lifecycle

When a user asks one question in the CLI, the flow is:

1. The user types a question into `src/cli/chat.js`.
2. `src/cli/chat.js` logs the input and sends an MCP tool call to `search_internal_docs`.
3. `src/mcp/server.js` receives that tool call and forwards the query to `searchInternalDocs()` in [`src/retrieval/retrieval.js`](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/retrieval/retrieval.js).
4. Retrieval loads `data/index.json`, analyzes the query, filters candidate chunks, scores them lexically, optionally adds semantic scores if embeddings exist, and applies heuristic reranking boosts.
5. The best chunks are formatted into readable retrieved context, including `CITATION` lines and metadata.
6. That retrieved context is returned through MCP back to `src/cli/chat.js`.
7. `src/cli/chat.js` builds a DeepSeek prompt containing:
   - the user question
   - the retrieved documentation text
   - system rules telling the model to answer only from retrieved docs and use the provided citation values
8. `src/cli/chat.js` sends that prompt to DeepSeek with `deepseek-chat`.
9. The model response is logged and printed to the terminal.
10. If DeepSeek is unavailable, `src/cli/chat.js` falls back to a local grounded answer generator in [`src/llm/answering.js`](/Users/alexandreleonetti/Documents/Code_CV/mcp/mcp-docs-rag/src/llm/answering.js).

## Current limitations

- The index is a single JSON file on disk, not a database. That is simple, but it will not scale well to larger corpora or concurrent workloads.

- The current checked-in setup is lexical-first and effectively lexical-only, because embeddings are disabled in the current index. Semantic search will therefore be limited.

- There is no vector database. Even though embedding hooks exist, vectors are stored inside the JSON index when enabled, not in a dedicated vector store.

- Retrieval quality depends heavily on token overlap, metadata clues, and heuristic boosts. Queries that use different wording from the docs may be weaker.

- Chunking is simple rule-based chunking. It is heading-aware and practical, but not adaptive or learned.

- There is no classic chunk overlap window. The project only keeps short previous/next context snippets.

- Reranking is heuristic, not model-based. The boosts are hand-written rules, not a learned reranker.

- The final answer quality depends on the retrieved chunks. If retrieval misses the right chunk, DeepSeek has intentionally been instructed not to answer beyond the retrieved evidence.

## Interview cheat sheet

- This prototype indexes local docs into a JSON file.
- Chunking happens during index build, not at query time.
- The current chunking is heading-aware and paragraph/block-based with character limits.
- The MCP server is `src/mcp/server.js` and it exposes the `search_internal_docs` tool.
- The CLI app in `src/cli/chat.js` is the MCP client.
- Retrieval is currently lexical-first and, in the current checked-in index, effectively lexical-only.
- The chat client sends retrieved chunks to DeepSeek for the final answer.
- Logs are written as JSON session files under `logs/`.
- A realistic next step would be enabling embeddings, moving vectors into proper storage, and improving retrieval quality.

## Next upgrades

1. Improve metadata consistency and document typing so filtering and ranking become more reliable.
2. Refine chunking with better boundaries and optional overlap for long sections.
3. Enable embeddings by default and store vectors in a more suitable system.
4. Add hybrid retrieval that combines lexical search with vector search more deliberately.
5. Add a stronger reranking step after retrieval.
6. Add a small eval set so retrieval and answer quality can be measured after each change.
