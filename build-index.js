import "dotenv/config";
import fs from "node:fs";
import path from "node:path";

const DOCS_DIR = process.env.DOCS_DIR || "./docs";
const INDEX_FILE = process.env.INDEX_FILE || "./data/index.json";

function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readAllFilesRecursive(dir) {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
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

function normalizeWhitespace(text) {
  return text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function splitIntoChunks(text, maxChars = 700, overlap = 120) {
  const clean = normalizeWhitespace(text);
  if (!clean) return [];

  const paragraphs = clean.split(/\n\s*\n/);
  const chunks = [];

  let current = "";

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;

    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (para.length <= maxChars) {
      current = para;
      continue;
    }

    let start = 0;
    while (start < para.length) {
      const end = Math.min(start + maxChars, para.length);
      const piece = para.slice(start, end).trim();
      if (piece) chunks.push(piece);
      if (end >= para.length) break;
      start = Math.max(end - overlap, start + 1);
    }

    current = "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/gi, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

function buildKeywordMap(text) {
  const tokens = tokenize(text);
  const freq = {};
  for (const token of tokens) {
    freq[token] = (freq[token] || 0) + 1;
  }
  return freq;
}

function buildIndex() {
  if (!fs.existsSync(DOCS_DIR)) {
    throw new Error(`Docs directory not found: ${DOCS_DIR}`);
  }

  const files = readAllFilesRecursive(DOCS_DIR).filter(isSupportedFile);
  const chunks = [];

  for (const filePath of files) {
    const relPath = path.relative(process.cwd(), filePath);
    const raw = fs.readFileSync(filePath, "utf8");
    const docChunks = splitIntoChunks(raw);

    docChunks.forEach((chunkText, idx) => {
      const chunkId = `${path.basename(filePath)}#chunk-${idx + 1}`;
      chunks.push({
        chunkId,
        filePath: relPath,
        fileName: path.basename(filePath),
        chunkIndex: idx + 1,
        content: chunkText,
        keywordFreq: buildKeywordMap(chunkText),
      });
    });
  }

  const index = {
    builtAt: new Date().toISOString(),
    docsDir: DOCS_DIR,
    chunkCount: chunks.length,
    chunks,
  };

  ensureDirForFile(INDEX_FILE);
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), "utf8");

  console.log(`Index built: ${INDEX_FILE}`);
  console.log(`Files indexed: ${files.length}`);
  console.log(`Chunks indexed: ${chunks.length}`);
}

buildIndex();