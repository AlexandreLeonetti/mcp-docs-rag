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