import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchInternalDocs } from "./lib/retrieval.js";

const server = new McpServer({
  name: "internal-docs-server",
  version: "1.1.0",
});

server.tool(
  "search_internal_docs",
  "Searches internal docs with metadata-aware retrieval, reranking, and readable citations",
  {
    query: z.string().min(1).describe("The search query"),
    limit: z.number().int().min(1).max(10).optional().default(5),
    debug: z.boolean().optional().default(false),
  },
  async ({ query, limit, debug }) => {
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

    const { text, result } = await searchInternalDocs(trimmedQuery, {
      limit,
      debug,
    });

    if (!result.finalHits.length) {
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
      structuredContent: {
        result,
      },
      content: [
        {
          type: "text",
          text,
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
