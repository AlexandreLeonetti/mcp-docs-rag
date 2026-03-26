import path from "node:path";

const STOPWORDS = new Set([
  "a",
  "about",
  "all",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "me",
  "more",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "over",
  "s",
  "say",
  "so",
  "some",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "would",
  "you",
  "your",
]);

export function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[`"'’]/g, "")
    .replace(/[^a-z0-9\s/_-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text, { unique = false, minLength = 2 } = {}) {
  const tokens = normalizeText(text)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= minLength);

  return unique ? [...new Set(tokens)] : tokens;
}

export function buildKeywordMap(text) {
  const freq = {};
  for (const token of tokenize(text)) {
    freq[token] = (freq[token] || 0) + 1;
  }
  return freq;
}

export function countOccurrences(haystack, needle) {
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

export function compactText(text, maxLength = 220) {
  const clean = normalizeWhitespace(text);
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 3).trim()}...`;
}

export function extractInterestingTerms(text, limit = 8) {
  const freq = new Map();

  for (const token of tokenize(text)) {
    if (STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    freq.set(token, (freq.get(token) || 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([term]) => term);
}

export function inferTitleFromText(text, filename) {
  const lines = String(text || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith("#")) {
      return line.replace(/^#+\s*/, "").trim();
    }
  }

  for (const line of lines) {
    if (!/^\d{6,8}$/.test(line) && line.length >= 4 && line.length <= 120) {
      return line;
    }
  }

  return path.basename(filename, path.extname(filename));
}

export function parseDateFromFilename(filename) {
  const base = path.basename(filename, path.extname(filename));
  const match = base.match(/^(\d{4})[-_]?(\d{2})[-_]?(\d{2})$/);

  if (!match) return null;

  const [, year, month, day] = match;
  const isoDate = `${year}-${month}-${day}`;
  const asDate = new Date(`${isoDate}T00:00:00Z`);

  if (Number.isNaN(asDate.getTime())) return null;

  return {
    date: isoDate,
    month: `${year}-${month}`,
    year,
  };
}

function cleanScalar(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function parseYamlValue(rawValue) {
  const value = cleanScalar(rawValue);
  if (!value) return "";

  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => cleanScalar(item))
      .filter(Boolean);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  return value;
}

export function parseFrontmatter(rawText) {
  const text = String(rawText || "").replace(/\r/g, "");
  if (!text.startsWith("---\n")) {
    return {
      data: {},
      content: text,
    };
  }

  const endMarker = "\n---\n";
  const endIndex = text.indexOf(endMarker, 4);
  if (endIndex === -1) {
    return {
      data: {},
      content: text,
    };
  }

  const frontmatter = text.slice(4, endIndex);
  const content = text.slice(endIndex + endMarker.length);
  const data = {};

  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.+)\s*$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    data[key] = parseYamlValue(rawValue);
  }

  return {
    data,
    content,
  };
}

export function parseDateSignals(text) {
  const normalized = String(text || "");
  const fullDateMatch = normalized.match(/(\d{4})[-_/](\d{2})[-_/](\d{2})/);
  if (fullDateMatch) {
    const [, year, month, day] = fullDateMatch;
    return {
      date: `${year}-${month}-${day}`,
      month: `${year}-${month}`,
      year,
    };
  }

  const monthMatch = normalized.match(/(\d{4})[-_/](\d{2})(?![-_/]\d{2})/);
  if (monthMatch) {
    const [, year, month] = monthMatch;
    return {
      date: null,
      month: `${year}-${month}`,
      year,
    };
  }

  return null;
}

export function makeCitation(chunk) {
  const filename = chunk.filename || chunk.fileName || "unknown";
  const chunkId = chunk.chunk_id || chunk.chunkId || "unknown";
  const stamp = chunk.date || chunk.updated_at || "n/a";
  return `[${filename} | ${chunkId} | ${stamp}]`;
}

export function cosineSimilarity(a = [], b = []) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) {
    return 0;
  }

  const length = Math.min(a.length, b.length);
  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < length; i += 1) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }

  if (!magA || !magB) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function sentenceSplit(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}
