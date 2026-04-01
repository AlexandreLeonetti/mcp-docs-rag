import "dotenv/config";
import { closePool, getDatabaseUrl } from "../db/client.js";
import { buildIndex } from "./indexing.js";

const DOCS_DIR = process.env.DOCS_DIR || "./docs";

const { index, fileCount } = await buildIndex({ docsDir: DOCS_DIR });

console.log(`Index built in Postgres: ${getDatabaseUrl()}`);
console.log(`Files indexed: ${fileCount}`);
console.log(`Chunks indexed: ${index.chunkCount}`);
console.log(
  `Embeddings: ${
    index.embedding?.enabled
      ? `${index.embedding.provider}:${index.embedding.model}`
      : "disabled (lexical fallback only)"
  }`
);
await closePool();
