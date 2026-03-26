import "dotenv/config";
import OpenAI from "openai";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { generateGroundedAnswer } from "./lib/answering.js";

const LOG_DIR = process.env.LOG_DIR || "./logs";
const RETRIEVAL_DEBUG = /^1|true|yes$/i.test(String(process.env.RETRIEVAL_DEBUG || ""));

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
const openai = useDeepSeek
  ? new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
    })
  : null;

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

  if (!useDeepSeek) {
    const fallback = generateGroundedAnswer(userInput, structured?.result || {
      analysis: { mode: "fact_lookup" },
      finalHits: [],
      broadSummary: null,
    });
    addEvent("assistant", "assistant_final_local", fallback);
    console.log(`\nAssistant: ${fallback.answer}\n`);
    continue;
  }

  const payload = {
    model: "deepseek-chat",
    stream: false,
    messages: [
      {
        role: "system",
        content: [
          "You are a helpful internal knowledge assistant.",
          "Answer only from the retrieved documentation.",
          "If the retrieved documentation is insufficient, say so clearly.",
          "For broad questions such as recurring themes, first mention, or evolution over time, only answer if the evidence spans multiple chunks or dates.",
          "Do not ask to search again.",
          "Do not mention tools.",
          "Use the provided CITATION values exactly when citing sources.",
        ].join(" "),
      },
      {
        role: "user",
        content: [
          `Question: ${userInput}`,
          "",
          "Retrieved documentation:",
          retrievedContext,
        ].join("\n"),
      },
    ],
  };

  addEvent("chat_client", "deepseek_request", payload);

  try {
    const response = await openai.chat.completions.create(payload);
    addEvent("deepseek", "deepseek_response", response);

    const finalText = response.choices[0].message.content || "";
    addEvent("assistant", "assistant_final", { text: finalText });

    console.log(`\nAssistant: ${finalText}\n`);
  } catch (error) {
    addEvent("deepseek", "deepseek_error", {
      message: error?.message,
      stack: error?.stack,
    });
    const fallback = generateGroundedAnswer(userInput, structured?.result || {
      analysis: { mode: "fact_lookup" },
      finalHits: [],
      broadSummary: null,
    });
    addEvent("assistant", "assistant_final_fallback", fallback);
    console.log(`\nAssistant: ${fallback.answer}\n`);
  }
}

rl.close();
await mcpClient.close();

addEvent("chat_client", "mcp_closed", {
  message: "MCP client closed",
});

sessionLog.endedAt = new Date().toISOString();
persistSessionLog();
