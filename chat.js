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