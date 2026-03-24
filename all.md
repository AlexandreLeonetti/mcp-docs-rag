Perfect. We’ll build a **full local Node.js RAG-ish MCP project** with:

* a **docs folder**
* an **indexer** that chunks files into `index.json`
* an **MCP server** exposing `search_internal_docs`
* a **CLI chat client** using DeepSeek
* **citations** in answers
* **low token usage** by only sending top chunks

This is a real next-step MVP.

---

# What this project does

You’ll be able to ask:

* `how do we handle auth in onboarding?`
* `what do the docs say about password reset?`
* `find mentions of support SLA`
* `summarize billing policy`

Flow:

1. you type a question
2. DeepSeek sees a tool called `search_internal_docs`
3. it asks for the tool
4. your MCP server searches local indexed chunks
5. top matching chunks come back
6. DeepSeek answers using only those chunks
7. answer includes citations like `[auth.md#chunk-2]`

---

# Folder structure

Create this:

```text
mcp-docs-rag/
├── .env
├── package.json
├── build-index.js
├── server.js
├── chat.js
├── docs/
│   ├── auth.md
│   ├── onboarding.md
│   ├── support.txt
│   └── billing.md
├── data/
│   └── index.json
└── logs/
```

---

# 1) Create project

```bash
mkdir mcp-docs-rag
cd mcp-docs-rag
npm init -y
npm install @modelcontextprotocol/sdk openai dotenv zod
```

---

# 2) Create `.env`

```env
DEEPSEEK_API_KEY=your_real_key_here
DOCS_DIR=./docs
INDEX_FILE=./data/index.json
LOG_DIR=./logs
```

---

# 3) Update `package.json`

Replace it with:

```json
{
  "name": "mcp-docs-rag",
  "version": "1.0.0",
  "type": "module",
  "main": "chat.js",
  "scripts": {
    "build-index": "node build-index.js",
    "server": "node server.js",
    "chat": "node chat.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.11.0",
    "dotenv": "^16.5.0",
    "openai": "^4.103.0",
    "zod": "^3.24.2"
  }
}
```

If npm wrote slightly different versions, that’s fine too.

---

# 4) Add sample docs

## `docs/auth.md`

```md
# Authentication

We use JWT-based authentication for the web app.

## Login
Users log in with email and password. On success, the backend returns an access token and a refresh token.

## Password reset
Password reset is handled through a signed reset link sent by email. Reset links expire after 30 minutes.

## API auth
Internal APIs between services should use service tokens, not user JWTs.
```

## `docs/onboarding.md`

```md
# Onboarding Flow

The onboarding flow begins after account creation.

## Steps
1. User verifies email
2. User completes profile
3. User accepts terms
4. User lands on onboarding checklist

## Auth in onboarding
Protected onboarding endpoints require a valid JWT access token. If the token is expired, the frontend should attempt refresh before redirecting to login.
```

## `docs/support.txt`

```text
Support Playbook

SLA:
- Critical issues: respond within 1 hour
- Normal issues: respond within 24 hours

Escalation:
- Billing issues go to finance support
- Login/auth issues go to technical support
- Security issues should be escalated immediately

Password reset:
If the reset email is not received, instruct the user to check spam, then retry after 5 minutes.
```

## `docs/billing.md`

```md
# Billing Policy

Customers are billed monthly.

## Refunds
Refund requests must be submitted within 14 days of the billing date.

## Failed payments
If a payment fails, the account remains active for a 3-day grace period before restriction.
```

---

# 5) Create `build-index.js`

This script:

* scans `docs/`
* reads `.txt`, `.md`, `.json`
* splits them into chunks
* writes `data/index.json`

```javascript
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const DOCS_DIR = process.env.DOCS_DIR || "./docs";
const INDEX_FILE = process.env.INDEX_FILE || "./data/index.json";

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readAllFilesRecursive(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readAllFilesRecursive(fullPath));
    } else {
      out.push(fullPath);
    }
  }

  return out;
}

function isSupportedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return [".md", ".txt", ".json"].includes(ext);
}

function normalizeWhitespace(text) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function splitIntoChunks(text, maxChars = 700, overlap = 120) {
  const clean = normalizeWhitespace(text);
  if (!clean) return [];

  const paragraphs = clean.split(/\n\s*\n/);
  const chunks = [];

  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (para.length <= maxChars) {
      current = para;
      continue;
    }

    let start = 0;
    while (start < para.length) {
      const end = Math.min(start + maxChars, para.length);
      const piece = para.slice(start, end).trim();
      if (piece) chunks.push(piece);
      if (end >= para.length) break;
      start = Math.max(end - overlap, start + 1);
    }

    current = "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/gi, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function buildKeywordMap(text) {
  const tokens = tokenize(text);
  const freq = {};
  for (const token of tokens) {
    freq[token] = (freq[token] || 0) + 1;
  }
  return freq;
}

function buildIndex() {
  if (!fs.existsSync(DOCS_DIR)) {
    throw new Error(`Docs directory not found: ${DOCS_DIR}`);
  }

  const files = readAllFilesRecursive(DOCS_DIR).filter(isSupportedFile);
  const chunks = [];

  for (const filePath of files) {
    const relPath = path.relative(process.cwd(), filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    const docChunks = splitIntoChunks(raw);

    docChunks.forEach((chunkText, idx) => {
      const chunkId = `${path.basename(filePath)}#chunk-${idx + 1}`;
      chunks.push({
        chunkId,
        filePath: relPath,
        fileName: path.basename(filePath),
        chunkIndex: idx + 1,
        content: chunkText,
        keywordFreq: buildKeywordMap(chunkText),
      });
    });
  }

  const index = {
    builtAt: new Date().toISOString(),
    docsDir: DOCS_DIR,
    chunkCount: chunks.length,
    chunks,
  };

  ensureDirForFile(INDEX_FILE);
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf8");

  console.log(`Index built: ${INDEX_FILE}`);
  console.log(`Files indexed: ${files.length}`);
  console.log(`Chunks indexed: ${chunks.length}`);
}

buildIndex();
```

---

# 6) Create `server.js`

This MCP server exposes:

* `search_internal_docs(query, limit)`

It loads the local index and does simple keyword scoring.

```javascript
import "dotenv/config";
import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const INDEX_FILE = process.env.INDEX_FILE || "./data/index.json";

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error(`Index file not found: ${INDEX_FILE}. Run: npm run build-index`);
  }
  return JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/gi, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function scoreChunk(queryTokens, chunk) {
  let score = 0;

  for (const token of queryTokens) {
    const count = chunk.keywordFreq?.[token] || 0;
    score += count * 3;

    if (chunk.fileName.toLowerCase().includes(token)) {
      score += 5;
    }

    if (chunk.content.toLowerCase().includes(token)) {
      score += 1;
    }
  }

  return score;
}

function searchChunks(query, limit = 5) {
  const index = loadIndex();
  const queryTokens = tokenize(query);

  const ranked = index.chunks
    .map((chunk) => ({
      ...chunk,
      score: scoreChunk(queryTokens, chunk),
    }))
    .filter((chunk) => chunk.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return ranked;
}

const server = new McpServer({
  name: "internal-docs-server",
  version: "1.0.0",
});

server.tool(
  "search_internal_docs",
  "Searches internal company or local documentation and returns relevant chunks with citations",
  {
    query: z.string().describe("The search query"),
    limit: z.number().optional().default(5),
  },
  async ({ query, limit }) => {
    const results = searchChunks(query, limit);

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No relevant results found.",
          },
        ],
      };
    }

    const formatted = results
      .map((r) => {
        return [
          `SOURCE: ${r.chunkId}`,
          `FILE: ${r.filePath}`,
          `SCORE: ${r.score}`,
          `CONTENT:`,
          r.content,
        ].join("\n");
      })
      .join("\n\n---\n\n");

    return {
      content: [{ type: "text", text: formatted }],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

---

# 7) Create `chat.js`

This is your CLI chat app with:

* session log JSON
* tool calling
* retrieval flow
* citation-friendly instructions

```javascript
import "dotenv/config";
import OpenAI from "openai";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";

const LOG_DIR = process.env.LOG_DIR || "./logs";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeFileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

ensureDir(LOG_DIR);

const sessionStartedAt = new Date();
const sessionFile = path.join(
  LOG_DIR,
  `session-${safeFileTimestamp(sessionStartedAt)}.json`
);

const sessionLog = {
  sessionId: safeFileTimestamp(sessionStartedAt),
  startedAt: sessionStartedAt.toISOString(),
  pid: process.pid,
  logFile: sessionFile,
  events: [],
};

let seq = 0;
const sessionStartHr = process.hrtime.bigint();

function persistSessionLog() {
  fs.writeFileSync(sessionFile, JSON.stringify(sessionLog, null, 2), "utf8");
}

function addEvent(actor, type, data = {}) {
  seq += 1;
  const now = new Date();
  const hrNow = process.hrtime.bigint();
  const elapsedMs = Number(hrNow - sessionStartHr) / 1_000_000;

  sessionLog.events.push({
    seq,
    ts: now.toISOString(),
    elapsedMs: Number(elapsedMs.toFixed(3)),
    actor,
    type,
    data,
  });

  persistSessionLog();
}

persistSessionLog();

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

const transport = new StdioClientTransport({
  command: "node",
  args: ["server.js"],
});

const mcpClient = new Client({
  name: "docs-cli-client",
  version: "1.0.0",
});

await mcpClient.connect(transport);

addEvent("chat_client", "mcp_connected", {
  command: "node",
  args: ["server.js"],
});

const tools = [
  {
    type: "function",
    function: {
      name: "search_internal_docs",
      description:
        "Searches internal docs and returns relevant chunks with citations",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query",
          },
          limit: {
            type: "number",
            description: "Max number of chunks to return",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
];

const rl = readline.createInterface({ input, output });

console.log("Internal Docs MCP CLI started.");
console.log('Ask things like: "how do we handle auth in onboarding?"');
console.log('Type "exit" to quit.\n');
console.log(`JSON session log: ${sessionFile}\n`);

while (true) {
  const userInput = await rl.question("You: ");

  addEvent("user", "user_input", { text: userInput });

  if (userInput.trim().toLowerCase() === "exit") {
    addEvent("chat_client", "session_end", { reason: "user_exit" });
    break;
  }

  const messages = [
    {
      role: "system",
      content:
        [
          "You are a helpful internal knowledge assistant.",
          "For questions about company knowledge, documentation, policy, onboarding, billing, auth, or support, use the search_internal_docs tool first.",
          "Answer only from retrieved documents when using the tool.",
          "If the retrieved results are insufficient, say so clearly.",
          "When you answer from retrieved docs, cite sources using the SOURCE identifiers exactly as provided, for example [auth.md#chunk-1].",
          "Do not invent documentation that was not retrieved.",
        ].join(" "),
    },
    {
      role: "user",
      content: userInput,
    },
  ];

  const firstPayload = {
    model: "deepseek-chat",
    messages,
    tools,
    tool_choice: "auto",
    stream: false,
  };

  addEvent("chat_client", "deepseek_request_1", firstPayload);

  let firstResponse;
  try {
    firstResponse = await openai.chat.completions.create(firstPayload);
    addEvent("deepseek", "deepseek_response_1", firstResponse);
  } catch (error) {
    addEvent("deepseek", "deepseek_error_1", {
      message: error?.message,
      stack: error?.stack,
    });
    console.log("\nAssistant: Error while calling DeepSeek.\n");
    continue;
  }

  const assistantMessage = firstResponse.choices[0].message;
  addEvent("deepseek", "assistant_message_1", assistantMessage);

  if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
    messages.push(assistantMessage);

    for (const toolCall of assistantMessage.tool_calls) {
      const toolName = toolCall.function.name;

      let args = {};
      try {
        args = JSON.parse(toolCall.function.arguments || "{}");
      } catch (error) {
        addEvent("chat_client", "tool_args_parse_error", {
          rawArguments: toolCall.function.arguments,
          message: error?.message,
        });
      }

      addEvent("deepseek", "tool_call_requested", {
        toolName,
        args,
        rawToolCall: toolCall,
      });

      if (toolName === "search_internal_docs") {
        addEvent("chat_client", "mcp_tool_call_started", {
          toolName,
          args,
        });

        try {
          const result = await mcpClient.callTool({
            name: "search_internal_docs",
            arguments: args,
          });

          addEvent("mcp_server", "mcp_tool_result", result);

          const toolText =
            result.content?.map((item) => item.text || "").join("\n") ||
            "No tool output";

          addEvent("chat_client", "tool_text_for_model", {
            tool_call_id: toolCall.id,
            toolName,
            toolText,
          });

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolText,
          });
        } catch (error) {
          addEvent("mcp_server", "mcp_tool_error", {
            toolName,
            args,
            message: error?.message,
            stack: error?.stack,
          });

          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: "Tool execution failed.",
          });
        }
      } else {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Unknown tool: ${toolName}`,
        });
      }
    }

    const secondPayload = {
      model: "deepseek-chat",
      messages,
      stream: false,
    };

    addEvent("chat_client", "deepseek_request_2", secondPayload);

    try {
      const finalResponse = await openai.chat.completions.create(secondPayload);
      addEvent("deepseek", "deepseek_response_2", finalResponse);

      const finalText = finalResponse.choices[0].message.content || "";
      addEvent("assistant", "assistant_final", { text: finalText });

      console.log(`\nAssistant: ${finalText}\n`);
    } catch (error) {
      addEvent("deepseek", "deepseek_error_2", {
        message: error?.message,
        stack: error?.stack,
      });

      console.log("\nAssistant: Error while generating the final answer.\n");
    }
  } else {
    const directText = assistantMessage.content || "";
    addEvent("assistant", "assistant_direct", { text: directText });
    console.log(`\nAssistant: ${directText}\n`);
  }
}

rl.close();
await mcpClient.close();

addEvent("chat_client", "mcp_closed", {
  message: "MCP client closed",
});

sessionLog.endedAt = new Date().toISOString();
persistSessionLog();
```

---

# 8) Build the index

Run:

```bash
mkdir -p docs data logs
npm run build-index
```

You should see something like:

```bash
Index built: ./data/index.json
Files indexed: 4
Chunks indexed: 6
```

---

# 9) Run the chat

```bash
npm run chat
```

Try questions like:

```text
how do we handle auth in onboarding?
```

```text
what is the password reset process?
```

```text
what are the support SLA rules?
```

```text
what is the refund policy?
```

---

# What the flow will look like

For:

```text
how do we handle auth in onboarding?
```

expected behavior:

1. DeepSeek sees it is a docs question
2. calls `search_internal_docs`
3. MCP returns chunks from `auth.md` and `onboarding.md`
4. DeepSeek answers using those chunks
5. cites them like:

   * `[onboarding.md#chunk-2]`
   * `[auth.md#chunk-1]`

---

# Why this is already startup-like

This is basically a local version of:

* internal docs assistant
* onboarding knowledge bot
* support knowledge search
* engineering knowledge search

Later you can swap:

* local files → Notion export / Postgres / Confluence / S3
* simple keyword scoring → embeddings / pgvector
* CLI → web UI
* local machine → ECS / Docker / internal infra

Same product idea.

---

# Why this keeps token usage low

Because the model does **not** receive all files.

It only receives:

* your question
* tool definition
* top relevant chunks

So it is much cheaper than dumping the full folder into the prompt.

---

# Suggested next upgrades

## Upgrade 1: preserve conversation history

Right now each turn starts fresh again, like your previous MVP.

## Upgrade 2: better search ranking

You can add:

* BM25
* cosine similarity
* embeddings

## Upgrade 3: file previews

Add another tool:

* `read_document(filePath)`

## Upgrade 4: semantic retrieval

Precompute embeddings and search nearest chunks.

## Upgrade 5: FastAPI/NestJS backend

Move search logic behind an API and let MCP call that.

---

# Useful debug commands

Pretty-print your index:

```bash
cat data/index.json | jq
```

See only chunk ids:

```bash
cat data/index.json | jq '.chunks[] | {chunkId, filePath}'
```

Pretty-print logs:

```bash
cat logs/session-*.json | jq '.events[] | {seq, actor, type}'
```

---

# If something breaks

## `Index file not found`

Run:

```bash
npm run build-index
```

## `401 Unauthorized`

Check `.env` and your DeepSeek key.

## `Cannot use import statement outside a module`

Make sure `"type": "module"` is in `package.json`.

## MCP errors on stdio

Do not add `console.log()` in `server.js`.

---

# Best first test set

After starting chat, try these in order:

```text
hello
```

```text
how do we handle auth in onboarding?
```

```text
what do docs say about password reset?
```

```text
what is the refund window?
```

```text
what is our Kubernetes failover strategy?
```

That last one should ideally say it did not find enough evidence.

---

# Best next step after this

Once this runs, the next strong upgrade is:

* keep chat history across turns
* add `read_document(filePath)`
* maybe add embeddings

If you hit any error when running this, paste the terminal output and I’ll fix it directly.

