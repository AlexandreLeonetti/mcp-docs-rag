import fs from "node:fs";
import path from "node:path";
import {
  buildKeywordMap,
  compactText,
  extractInterestingTerms,
  inferTitleFromText,
  normalizeWhitespace,
  parseDateFromFilename,
} from "./text-utils.js";
import { createEmbeddingProviderFromEnv } from "./embeddings.js";

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

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

function inferDocType(relPath, filename, rawText) {
  const lowerPath = relPath.toLowerCase();
  const lowerName = filename.toLowerCase();
  const lowerText = rawText.toLowerCase();

  if (lowerPath.includes("/daily/") || parseDateFromFilename(filename)) {
    return "daily note";
  }

  if (
    /company|billing|auth|support|policy|onboarding|northstar|finance|leadership/.test(
      `${lowerPath} ${lowerName}`
    )
  ) {
    return "company doc";
  }

  if (
    /interview|prep|hello work|homeworks?|freelance offer|cv|nda|scrum/.test(
      `${lowerPath} ${lowerName} ${lowerText}`
    )
  ) {
    return "prep/interview note";
  }

  if (
    /app|product|landing page|design|repo|xcode|video|course|feature|mvp/.test(
      `${lowerPath} ${lowerName} ${lowerText}`
    )
  ) {
    return "app/product note";
  }

  return "miscellaneous";
}

function extractMarkdownHeading(line) {
  const match = String(line || "").match(/^(#{1,6})\s+(.+?)\s*$/);
  return match ? match[2].trim() : null;
}

function splitNormalDocument(rawText, maxChars = 900, overlap = 120) {
  const clean = normalizeWhitespace(rawText);
  if (!clean) return [];

  const lines = clean.split("\n");
  const blocks = [];
  let currentHeading = null;
  let paragraphBuffer = [];

  const flushParagraph = () => {
    const text = paragraphBuffer.join("\n").trim();
    if (text) {
      blocks.push({
        text,
        heading: currentHeading,
      });
    }
    paragraphBuffer = [];
  };

  for (const line of lines) {
    const heading = extractMarkdownHeading(line.trim());
    if (heading) {
      flushParagraph();
      currentHeading = heading;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    paragraphBuffer.push(line);
  }

  flushParagraph();

  const chunks = [];
  let current = null;

  for (const block of blocks) {
    const blockText = block.heading ? `${block.heading}\n${block.text}` : block.text;

    if (!current) {
      current = {
        text: blockText,
        heading: block.heading,
      };
      continue;
    }

    const candidate = `${current.text}\n\n${blockText}`;
    if (candidate.length <= maxChars) {
      current.text = candidate;
      current.heading = current.heading || block.heading;
      continue;
    }

    chunks.push(current);

    if (blockText.length <= maxChars) {
      current = {
        text: blockText,
        heading: block.heading,
      };
      continue;
    }

    let start = 0;
    while (start < blockText.length) {
      const end = Math.min(start + maxChars, blockText.length);
      const piece = blockText.slice(start, end).trim();
      if (piece) {
        chunks.push({
          text: piece,
          heading: block.heading,
        });
      }
      if (end >= blockText.length) break;
      start = Math.max(end - overlap, start + 1);
    }

    current = null;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function isBulletLike(line) {
  return /^(\s*[-*>]|\s*\d+\.)\s+/.test(line);
}

function splitDailyNote(rawText) {
  const clean = normalizeWhitespace(rawText);
  if (!clean) return [];

  const rawBlocks = clean
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);

  const blocks = rawBlocks.map((block) => {
    const lines = block.split("\n").map((line) => line.trim());
    const heading = extractMarkdownHeading(lines[0]) || null;
    const bulletCount = lines.filter(isBulletLike).length;
    return {
      text: block,
      heading,
      isBulletGroup: bulletCount >= Math.max(2, Math.ceil(lines.length / 2)),
    };
  });

  const chunks = [];
  let current = null;

  for (const block of blocks) {
    if (!current) {
      current = {
        text: block.text,
        heading: block.heading,
      };
      continue;
    }

    const candidate = `${current.text}\n\n${block.text}`;
    const shouldMerge =
      candidate.length <= 750 &&
      (current.text.length < 220 || block.text.length < 220 || block.isBulletGroup);

    if (shouldMerge) {
      current.text = candidate;
      current.heading = current.heading || block.heading;
      continue;
    }

    chunks.push(current);
    current = {
      text: block.text,
      heading: block.heading,
    };
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.map((chunk, index) => ({
    ...chunk,
    localContext: {
      previous: compactText(chunks[index - 1]?.text || "", 140),
      next: compactText(chunks[index + 1]?.text || "", 140),
    },
  }));
}

function inferTags(text, metadata) {
  const tags = new Set(extractInterestingTerms(`${metadata.title}\n${text}`, 6));
  if (metadata.doc_type === "daily note") tags.add("daily");
  if (metadata.month) tags.add(metadata.month);
  if (metadata.doc_type === "company doc") tags.add("company");
  return [...tags].slice(0, 8);
}

function buildDocumentMetadata(rootDir, filePath, rawText) {
  const relPath = path.relative(process.cwd(), filePath);
  const filename = path.basename(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const parsedDate = parseDateFromFilename(filename);
  const title = inferTitleFromText(rawText, filename);
  const doc_type = inferDocType(relPath, filename, rawText);

  return {
    source_path: relPath,
    filename,
    extension,
    title,
    doc_type,
    date: parsedDate?.date || null,
    month: parsedDate?.month || null,
    tags: inferTags(rawText, {
      title,
      doc_type,
      month: parsedDate?.month || null,
    }),
    root_dir: rootDir,
  };
}

async function maybeAttachEmbeddings(chunks) {
  const provider = createEmbeddingProviderFromEnv();
  if (!provider) {
    return {
      providerInfo: {
        enabled: false,
        provider: null,
        model: null,
      },
      chunks,
    };
  }

  try {
    const vectors = await provider.embedTexts(
      chunks.map((chunk) => {
        return [
          chunk.title,
          chunk.section_heading,
          chunk.content,
          chunk.tags?.join(" "),
        ]
          .filter(Boolean)
          .join("\n");
      })
    );

    const enrichedChunks = chunks.map((chunk, index) => ({
      ...chunk,
      embedding: vectors[index] || null,
    }));

    return {
      providerInfo: {
        enabled: true,
        provider: provider.name,
        model: provider.model,
        dimensions: vectors[0]?.length || null,
      },
      chunks: enrichedChunks,
    };
  } catch (error) {
    console.warn(
      `Embedding generation failed (${error?.message || "unknown error"}). Falling back to lexical-only indexing.`
    );

    return {
      providerInfo: {
        enabled: false,
        provider: null,
        model: null,
      },
      chunks,
    };
  }
}

export async function buildIndex({ docsDir, indexFile }) {
  if (!fs.existsSync(docsDir)) {
    throw new Error(`Docs directory not found: ${docsDir}`);
  }

  const files = readAllFilesRecursive(docsDir).filter(isSupportedFile);
  const chunks = [];

  for (const filePath of files) {
    const rawText = fs.readFileSync(filePath, "utf8");
    const metadata = buildDocumentMetadata(docsDir, filePath, rawText);
    const parts =
      metadata.doc_type === "daily note"
        ? splitDailyNote(rawText)
        : splitNormalDocument(rawText);

    parts.forEach((part, index) => {
      const chunk_id = `${metadata.filename}#chunk-${index + 1}`;
      const content = normalizeWhitespace(part.text);

      chunks.push({
        chunk_id,
        chunkId: chunk_id,
        chunk_index: index + 1,
        chunkIndex: index + 1,
        content,
        keyword_freq: buildKeywordMap(content),
        keywordFreq: buildKeywordMap(content),
        source_path: metadata.source_path,
        filePath: metadata.source_path,
        filename: metadata.filename,
        fileName: metadata.filename,
        extension: metadata.extension,
        title: metadata.title,
        doc_type: metadata.doc_type,
        date: metadata.date,
        month: metadata.month,
        tags: metadata.tags,
        section_heading: part.heading || null,
        local_context: part.localContext || null,
      });
    });
  }

  const withEmbeddings = await maybeAttachEmbeddings(chunks);
  const index = {
    builtAt: new Date().toISOString(),
    docsDir,
    chunkCount: withEmbeddings.chunks.length,
    embedding: withEmbeddings.providerInfo,
    chunks: withEmbeddings.chunks,
  };

  ensureDirForFile(indexFile);
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2), "utf8");

  return {
    index,
    fileCount: files.length,
  };
}
