import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { runChatTurn } from "../chat/run-chat-turn.js";

const LOG_DIR = process.env.LOG_DIR || "./logs";
const RETRIEVAL_DEBUG = /^1|true|yes$/i.test(String(process.env.RETRIEVAL_DEBUG || ""));

function yesNo(value) {
  return value ? "yes" : "no";
}

function formatSkipReason(reason) {
  const labels = {
    no_lexical_candidates: "no lexical candidates",
    embeddings_disabled: "embeddings disabled",
    index_has_no_chunk_embeddings: "index has no chunk embeddings",
    no_embedding_provider: "no embedding provider",
    query_embedding_unavailable: "query embedding unavailable",
    candidate_embeddings_missing: "candidate embeddings missing",
    query_embedding_failed: "query embedding failed",
  };

  return labels[reason] || reason || null;
}

function renderRetrievalDebug(result) {
  const debug = result?.debug;
  if (!RETRIEVAL_DEBUG || !debug) {
    return;
  }

  const analysisMode = debug.analysis?.mode || result?.analysis?.mode || "unknown";
  const broadQuery = debug.broadQuery ?? result?.analysis?.broadQuery ?? false;
  const embeddingDebug = debug.embeddingDebug || {};
  const lexicalCandidateCount = Number(debug.lexicalCandidateCount || 0);
  const totalChunks = Number(debug.totalChunks || 0);
  const candidatesWithEmbeddings = Number(embeddingDebug.candidatesWithEmbeddings || 0);
  const queryEmbeddingAttempted = Boolean(embeddingDebug.queryEmbeddingAttempted);
  const queryEmbeddingSucceeded = Boolean(embeddingDebug.queryEmbeddingSucceeded);
  const queryEmbeddingDimension = embeddingDebug.queryEmbeddingDimension || null;
  const semanticSkipReason = formatSkipReason(embeddingDebug.semanticSkipReason || embeddingDebug.reason);
  const topFinalHits = debug.summaries?.topFinalHits || debug.finalHits?.map((hit) => hit.chunk_id) || [];

  process.stderr.write(
    `[retrieval] analysis mode=${analysisMode}, broadQuery=${broadQuery ? "yes" : "no"}\n`
  );
  process.stderr.write(
    `[retrieval] local embeddings enabled in env: ${yesNo(embeddingDebug.configured)}\n`
  );
  process.stderr.write(
    `[retrieval] loaded index has chunk embeddings: ${yesNo(embeddingDebug.indexHasEmbeddings)}\n`
  );
  process.stderr.write(`[retrieval] total chunks in index: ${totalChunks}\n`);
  process.stderr.write(
    `[retrieval] lexical candidates selected before semantic scoring: ${lexicalCandidateCount}\n`
  );

  if (queryEmbeddingAttempted) {
    process.stderr.write("[retrieval] converting query to embedding...\n");
    if (queryEmbeddingSucceeded && queryEmbeddingDimension) {
      process.stderr.write(`[retrieval] query embedding created (dim=${queryEmbeddingDimension})\n`);
    }
  }

  if (!queryEmbeddingAttempted || !queryEmbeddingSucceeded) {
    if (semanticSkipReason) {
      process.stderr.write(`[retrieval] semantic scoring skipped: ${semanticSkipReason}\n`);
    }
  }

  process.stderr.write(
    `[retrieval] candidates with embeddings: ${candidatesWithEmbeddings}/${lexicalCandidateCount}\n`
  );
  process.stderr.write(`[retrieval] retrieval mode: ${debug.retrievalMode || "unknown"}\n`);
  process.stderr.write(
    `[retrieval] top final hits: ${topFinalHits.length ? topFinalHits.join(", ") : "none"}\n`
  );
}

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

const useDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY);

const transport = new StdioClientTransport({
  command: "node",
  args: ["src/mcp/server.js"],
});

const mcpClient = new Client({
  name: "docs-cli-client",
  version: "1.0.0",
});

await mcpClient.connect(transport);

addEvent("chat_client", "mcp_connected", {
  command: "node",
  args: ["src/mcp/server.js"],
});

const rl = readline.createInterface({ input, output });

console.log("Internal Docs MCP CLI started.");
console.log('Ask things like: "how do we handle auth in onboarding?"');
console.log('Type "exit" to quit.\n');
console.log(`JSON session log: ${sessionFile}\n`);
if (!useDeepSeek) {
  console.log("DeepSeek API key not set. Falling back to local grounded summaries.\n");
}

while (true) {
  const userInput = await rl.question("You: ");
  addEvent("user", "user_input", { text: userInput });

  if (userInput.trim().toLowerCase() === "exit") {
    addEvent("chat_client", "session_end", { reason: "user_exit" });
    break;
  }

  let toolResult;
  try {
    if (RETRIEVAL_DEBUG) {
      process.stderr.write("[chat] sending query to MCP search tool\n");
    }
    toolResult = await mcpClient.callTool({
      name: "search_internal_docs",
      arguments: {
        query: userInput,
        limit: 5,
        debug: RETRIEVAL_DEBUG,
      },
    });
    addEvent("mcp_server", "mcp_tool_result", toolResult);
  } catch (error) {
    addEvent("mcp_server", "mcp_tool_error", {
      message: error?.message,
      stack: error?.stack,
    });
    console.log("\nAssistant: Error while searching internal docs.\n");
    continue;
  }

  const retrievedContext =
    toolResult.content?.map((item) => item.text || "").join("\n") ||
    "No relevant results found.";

  const structured = toolResult.structuredContent || toolResult.structured || null;
  renderRetrievalDebug(structured?.result || null);

  try {
    const turn = await runChatTurn({
      query: userInput,
      retrievalResult: structured?.result || null,
      retrievedContext,
      limit: 5,
      debug: RETRIEVAL_DEBUG,
      onDeepSeekRequest(payload) {
        addEvent("chat_client", "deepseek_request", payload);
      },
      onDeepSeekResponse(response) {
        addEvent("deepseek", "deepseek_response", response);
      },
      onDeepSeekError(error) {
        addEvent("deepseek", "deepseek_error", {
          message: error?.message,
          stack: error?.stack,
        });
      },
    });

    addEvent(
      "assistant",
      turn.answerSource === "deepseek" ? "assistant_final" : "assistant_final_local",
      {
        text: turn.answer,
        source: turn.answerSource,
        citations: turn.citations,
      }
    );
    console.log(`\nAssistant: ${turn.answer}\n`);
  } catch (error) {
    addEvent("assistant", "assistant_turn_error", {
      message: error?.message,
      stack: error?.stack,
    });
    console.log("\nAssistant: Error while generating an answer.\n");
  }
}

rl.close();
await mcpClient.close();

addEvent("chat_client", "mcp_closed", {
  message: "MCP client closed",
});

sessionLog.endedAt = new Date().toISOString();
persistSessionLog();
