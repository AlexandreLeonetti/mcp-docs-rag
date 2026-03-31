import "dotenv/config";
import { buildIndex } from "./indexing.js";

const DOCS_DIR = process.env.DOCS_DIR || "./docs";
const INDEX_FILE = process.env.INDEX_FILE || "./data/index.json";

const { index, fileCount } = await buildIndex({
  docsDir: DOCS_DIR,
  indexFile: INDEX_FILE,
});

console.log(`Index built: ${INDEX_FILE}`);
console.log(`Files indexed: ${fileCount}`);
console.log(`Chunks indexed: ${index.chunkCount}`);
console.log(
  `Embeddings: ${
    index.embedding?.enabled
      ? `${index.embedding.provider}:${index.embedding.model}`
      : "disabled (lexical fallback only)"
  }`
);
