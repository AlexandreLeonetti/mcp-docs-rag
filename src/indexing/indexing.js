import fs from "node:fs";
import path from "node:path";
import { buildChunksForDocument, buildDocumentMetadata } from "./chunker.js";
import { maybeAttachEmbeddings } from "./embedder-client.js";
import { writeDocumentsToPostgres } from "./postgres-writer.js";

function readAllFilesRecursive(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".DS_Store")) continue;
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

export async function buildIndex({ docsDir }) {
  if (!fs.existsSync(docsDir)) {
    throw new Error(`Docs directory not found: ${docsDir}`);
  }

  const files = readAllFilesRecursive(docsDir).filter(isSupportedFile);
  const documents = [];
  const allChunks = [];

  for (const filePath of files) {
    const rawText = fs.readFileSync(filePath, "utf8");
    const metadata = buildDocumentMetadata(docsDir, filePath, rawText);
    const chunks = buildChunksForDocument(metadata);

    documents.push({
      metadata,
      chunks,
    });
    allChunks.push(...chunks);
  }

  const withEmbeddings = await maybeAttachEmbeddings(allChunks);
  let offset = 0;
  const documentsWithEmbeddings = documents.map((document) => {
    const count = document.chunks.length;
    const chunkSlice = withEmbeddings.chunks.slice(offset, offset + count);
    offset += count;
    return {
      metadata: document.metadata,
      chunks: chunkSlice,
    };
  });

  const persisted = await writeDocumentsToPostgres(documentsWithEmbeddings);
  const index = {
    builtAt: new Date().toISOString(),
    docsDir,
    chunkCount: persisted.chunkCount,
    documentCount: persisted.documentCount,
    embedding: withEmbeddings.providerInfo,
  };

  return {
    index,
    fileCount: files.length,
  };
}
