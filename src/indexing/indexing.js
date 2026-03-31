import fs from "node:fs";
import path from "node:path";
import {
  buildKeywordMap,
  compactText,
  extractInterestingTerms,
  inferTitleFromText,
  normalizeWhitespace,
  parseDateSignals,
  parseDateFromFilename,
  parseFrontmatter,
} from "./text-utils.js";
import { createEmbeddingProviderFromEnv, getLocalEmbeddingConfig } from "../llm/embeddings.js";

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
  return match
    ? {
        level: match[1].length,
        text: match[2].trim(),
      }
    : null;
}

function splitLargeBlock(blockText, maxChars = 1100) {
  if (blockText.length <= maxChars) return [blockText];

  const pieces = [];
  let remaining = blockText.trim();

  while (remaining.length > maxChars) {
    let splitAt = remaining.lastIndexOf("\n", maxChars);
    if (splitAt < Math.floor(maxChars * 0.5)) {
      splitAt = remaining.lastIndexOf(". ", maxChars);
    }
    if (splitAt < Math.floor(maxChars * 0.4)) {
      splitAt = maxChars;
    }

    pieces.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) pieces.push(remaining);
  return pieces.filter(Boolean);
}

function splitNormalDocument(rawText, maxChars = 1100, minChars = 320) {
  const clean = normalizeWhitespace(rawText);
  if (!clean) return [];

  const lines = clean.split("\n");
  const blocks = [];
  const headingTrail = [];
  let paragraphBuffer = [];

  const flushParagraph = () => {
    const text = paragraphBuffer.join("\n").trim();
    if (text) {
      blocks.push({
        text,
        heading: headingTrail.filter(Boolean).join(" > ") || null,
      });
    }
    paragraphBuffer = [];
  };

  for (const line of lines) {
    const heading = extractMarkdownHeading(line.trim());
    if (heading) {
      flushParagraph();
      headingTrail[heading.level - 1] = heading.text;
      headingTrail.length = heading.level;
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
    const shouldMerge =
      candidate.length <= maxChars &&
      (current.text.length < minChars ||
        blockText.length < minChars ||
        current.heading === block.heading);

    if (shouldMerge) {
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

    const pieces = splitLargeBlock(blockText, maxChars);
    const [firstPiece, ...rest] = pieces;
    if (firstPiece) {
      chunks.push({
        text: firstPiece,
        heading: block.heading,
      });
    }
    for (const piece of rest.slice(0, -1)) {
      chunks.push({
        text: piece,
        heading: block.heading,
      });
    }
    current = rest.length
      ? {
          text: rest[rest.length - 1],
          heading: block.heading,
        }
      : null;
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
  const tags = new Set(Array.isArray(metadata.tags) ? metadata.tags : []);
  for (const term of extractInterestingTerms(`${metadata.title}\n${text}`, 6)) {
    tags.add(term);
  }
  if (metadata.month) tags.add(metadata.month);
  if (metadata.department) tags.add(metadata.department);
  return [...tags].slice(0, 8);
}

function buildDocumentMetadata(rootDir, filePath, rawText) {
  const relPath = path.relative(process.cwd(), filePath);
  const filename = path.basename(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const { data: frontmatter, content } = parseFrontmatter(rawText);
  const parsedDate =
    parseDateFromFilename(filename) ||
    parseDateSignals(relPath) ||
    parseDateSignals(filename) ||
    parseDateSignals(frontmatter.title);
  const title = frontmatter.title || inferTitleFromText(content, filename);
  const doc_type = frontmatter.doc_type || inferDocType(relPath, filename, content);
  const department =
    frontmatter.department ||
    relPath.split(path.sep)[1] ||
    path.basename(path.dirname(filePath)) ||
    null;
  const updated_at =
    typeof frontmatter.updated_at === "string" && /^\d{4}-\d{2}-\d{2}$/.test(frontmatter.updated_at)
      ? frontmatter.updated_at
      : null;
  const month = parsedDate?.month || null;

  return {
    raw_content: content,
    source_path: relPath,
    filename,
    extension,
    title,
    doc_type,
    department,
    updated_at,
    date: parsedDate?.date || null,
    month,
    tags: inferTags(content, {
      title,
      doc_type,
      department,
      tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
      month,
    }),
    root_dir: rootDir,
  };
}

async function maybeAttachEmbeddings(chunks) {
  const provider = createEmbeddingProviderFromEnv();
  if (!provider) {
    const config = getLocalEmbeddingConfig();
    return {
      providerInfo: {
        enabled: false,
        provider: null,
        model: config.model,
        dimensions: null,
        reason: "disabled_by_env",
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
        reason: null,
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
        provider: provider.name,
        model: provider.model,
        dimensions: null,
        reason: "load_failed",
        error: error?.message || "unknown error",
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
        ? splitDailyNote(metadata.raw_content)
        : splitNormalDocument(metadata.raw_content);

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
        department: metadata.department,
        updated_at: metadata.updated_at,
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
