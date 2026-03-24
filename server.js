import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const INDEX_FILE = process.env.INDEX_FILE || "./data/index.json";

function loadIndex() {
  if (!fs.existsSync(INDEX_FILE)) {
    throw new Error(`Index file not found: ${INDEX_FILE}. Run: npm run build-index`);
  }

  const raw = fs.readFileSync(INDEX_FILE, "utf8");
  const parsed = JSON.parse(raw);

  if (!parsed || !Array.isArray(parsed.chunks)) {
    throw new Error(`Invalid index format in ${INDEX_FILE}`);
  }

  return parsed;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[`"'’]/g, "")
    .replace(/[^a-z0-9\s/_-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  const tokens = normalizeText(text)
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);

  return [...new Set(tokens)];
}

function countOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;

  let count = 0;
  let start = 0;

  while (true) {
    const idx = haystack.indexOf(needle, start);
    if (idx === -1) break;
    count += 1;
    start = idx + needle.length;
  }

  return count;
}

function scoreChunk(query, queryTokens, chunk) {
  const content = normalizeText(chunk.content || "");
  const fileName = normalizeText(chunk.fileName || "");
  const filePath = normalizeText(chunk.filePath || "");
  const chunkId = normalizeText(chunk.chunkId || "");

  let score = 0;
  let matchedTokens = 0;

  for (const token of queryTokens) {
    const keywordFreq = Number(chunk.keywordFreq?.[token] || 0);
    const contentOccurrences = countOccurrences(content, token);
    const fileNameOccurrences = countOccurrences(fileName, token);
    const filePathOccurrences = countOccurrences(filePath, token);
    const chunkIdOccurrences = countOccurrences(chunkId, token);

    const tokenMatched =
      keywordFreq > 0 ||
      contentOccurrences > 0 ||
      fileNameOccurrences > 0 ||
      filePathOccurrences > 0 ||
      chunkIdOccurrences > 0;

    if (tokenMatched) {
      matchedTokens += 1;
    }

    score += keywordFreq * 6;
    score += contentOccurrences * 2;
    score += fileNameOccurrences * 8;
    score += filePathOccurrences * 5;
    score += chunkIdOccurrences * 3;
  }

  const normalizedQuery = normalizeText(query);

  if (normalizedQuery.length >= 6) {
    if (content.includes(normalizedQuery)) {
      score += 20;
    }

    if (fileName.includes(normalizedQuery) || filePath.includes(normalizedQuery)) {
      score += 12;
    }
  }

  if (queryTokens.length > 0) {
    const coverageRatio = matchedTokens / queryTokens.length;
    score += Math.round(coverageRatio * 20);
  }

  if (chunk.content && chunk.content.length < 1200) {
    score += 2;
  }

  return {
    score,
    matchedTokens,
  };
}

function dedupeByContent(results) {
  const seen = new Set();
  const deduped = [];

  for (const item of results) {
    const key = normalizeText(item.content || "").slice(0, 500);

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function searchChunks(query, limit = 5) {
  const index = loadIndex();
  const queryTokens = tokenize(query);

  if (queryTokens.length === 0) {
    return [];
  }

  const ranked = index.chunks
    .map((chunk) => {
      const { score, matchedTokens } = scoreChunk(query, queryTokens, chunk);
      return {
        ...chunk,
        score,
        matchedTokens,
      };
    })
    .filter((chunk) => chunk.score > 0 && chunk.matchedTokens > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.matchedTokens !== a.matchedTokens) return b.matchedTokens - a.matchedTokens;
      return String(a.chunkId).localeCompare(String(b.chunkId));
    });

  return dedupeByContent(ranked).slice(0, limit);
}

function formatResults(results) {
  return results
    .map((r, index) => {
      const prettyFile = r.filePath || r.fileName || "unknown";
      const shortName = path.basename(prettyFile);

      return [
        `RESULT: ${index + 1}`,
        `SOURCE: ${r.chunkId}`,
        `FILE: ${prettyFile}`,
        `FILE_NAME: ${shortName}`,
        `MATCHED_TOKENS: ${r.matchedTokens}`,
        `SCORE: ${r.score}`,
        `CONTENT:`,
        r.content,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

const server = new McpServer({
  name: "internal-docs-server",
  version: "1.0.0",
});

server.tool(
  "search_internal_docs",
  "Searches internal company or local documentation and returns relevant chunks with citations",
  {
    query: z.string().min(1).describe("The search query"),
    limit: z.number().int().min(1).max(10).optional().default(5),
  },
  async ({ query, limit }) => {
    const trimmedQuery = String(query || "").trim();

    if (!trimmedQuery) {
      return {
        content: [
          {
            type: "text",
            text: "No relevant results found.",
          },
        ],
      };
    }

    const results = searchChunks(trimmedQuery, limit);

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

    return {
      content: [
        {
          type: "text",
          text: formatResults(results),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);