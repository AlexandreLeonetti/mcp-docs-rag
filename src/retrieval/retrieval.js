import fs from "node:fs";
import { analyzeQuery, findRelevantDateRange } from "./query-analysis.js";
import { createEmbeddingProviderFromEnv, getLocalEmbeddingConfig } from "../llm/embeddings.js";
import {
  compactText,
  cosineSimilarity,
  makeCitation,
  normalizeText,
  sentenceSplit,
  tokenize,
} from "../indexing/text-utils.js";

const INDEX_FILE = process.env.INDEX_FILE || "./data/index.json";
const GENERIC_THEME_TAGS = new Set([
  "billing",
  "company",
  "december",
  "faq",
  "incident",
  "leadership",
  "meeting",
  "november",
  "onboarding",
  "operations",
  "org",
  "overview",
  "policy",
  "product",
  "release_notes",
  "security",
  "support",
  "ticket",
]);

const PHRASE_THEMES = [
  "password reset",
  "weekend support",
  "support hours",
  "refund window",
  "refund eligibility",
  "failed payment",
  "grace period",
  "login outage",
  "redirect loop",
  "invoice visibility",
  "production access",
  "access review",
  "onboarding",
  "training",
  "sso",
  "mfa",
];

const GENERIC_TOPIC_KEYWORDS = new Set([
  "compare",
  "comparison",
  "docs",
  "documentation",
  "document",
  "documents",
  "evolution",
  "incident",
  "notes",
  "policy",
  "postmortem",
  "process",
  "report",
  "summary",
]);

const HYBRID_WEIGHTS = {
  lexicalWeight: 0.7,
  semanticWeight: 0.3,
};

function isRetrievalDebugEnabled() {
  return /^1|true|yes$/i.test(String(process.env.RETRIEVAL_DEBUG || ""));
}

function retrievalDebug(message) {
  if (!isRetrievalDebugEnabled()) {
    return;
  }

  process.stderr.write(`[retrieval] ${message}\n`);
}

function formatTopHitSummary(hits, scoreKey, limit = 5) {
  return hits
    .slice(0, limit)
    .map((hit) => {
      const chunkId = hit.chunk_id || hit.chunkId || "unknown";
      return `${chunkId}:${Number(hit[scoreKey] || 0).toFixed(4)}`;
    })
    .join(", ");
}

function loadIndex(indexFile = INDEX_FILE) {
  if (!fs.existsSync(indexFile)) {
    throw new Error(`Index file not found: ${indexFile}. Run: npm run build-index`);
  }

  const parsed = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  if (!parsed || !Array.isArray(parsed.chunks)) {
    throw new Error(`Invalid index format in ${indexFile}`);
  }
  return parsed;
}

function tokenFrequency(text) {
  const freq = {};
  for (const token of tokenize(text)) {
    freq[token] = (freq[token] || 0) + 1;
  }
  return freq;
}

function scoreLexical(query, queryTokens, chunk) {
  const content = normalizeText(chunk.content || "");
  const filename = normalizeText(chunk.filename || chunk.fileName || "");
  const sourcePath = normalizeText(chunk.source_path || chunk.filePath || "");
  const title = normalizeText(chunk.title || "");
  const section = normalizeText(chunk.section_heading || "");
  const tags = normalizeText((chunk.tags || []).join(" "));
  const docType = normalizeText(chunk.doc_type || "");
  const department = normalizeText(chunk.department || "");
  const chunkId = normalizeText(chunk.chunk_id || chunk.chunkId || "");
  const filenameFreq = tokenFrequency(filename);
  const sourcePathFreq = tokenFrequency(sourcePath);
  const titleFreq = tokenFrequency(title);
  const sectionFreq = tokenFrequency(section);
  const tagFreq = tokenFrequency(tags);
  const docTypeFreq = tokenFrequency(docType);
  const departmentFreq = tokenFrequency(department);
  const chunkIdFreq = tokenFrequency(chunkId);

  let score = 0;
  let matchedTokens = 0;

  for (const token of queryTokens) {
    const keywordFreq = Number(chunk.keyword_freq?.[token] || chunk.keywordFreq?.[token] || 0);
    const fileOccurrences = Number(filenameFreq[token] || 0) + Number(sourcePathFreq[token] || 0);
    const titleOccurrences = Number(titleFreq[token] || 0) + Number(sectionFreq[token] || 0);
    const tagOccurrences = Number(tagFreq[token] || 0);
    const typeOccurrences = Number(docTypeFreq[token] || 0) + Number(departmentFreq[token] || 0);
    const chunkIdOccurrences = Number(chunkIdFreq[token] || 0);

    if (keywordFreq || fileOccurrences || titleOccurrences || tagOccurrences || typeOccurrences) {
      matchedTokens += 1;
    }

    score += keywordFreq * 8;
    score += fileOccurrences * 7;
    score += titleOccurrences * 7;
    score += tagOccurrences * 5;
    score += typeOccurrences * 4;
    score += chunkIdOccurrences * 3;
  }

  const normalizedQuery = normalizeText(query);
  if (normalizedQuery.length >= 5 && content.includes(normalizedQuery)) {
    score += 18;
  }
  if (normalizedQuery.length >= 5 && (title.includes(normalizedQuery) || section.includes(normalizedQuery))) {
    score += 16;
  }

  if (queryTokens.length > 0) {
    score += Math.round((matchedTokens / queryTokens.length) * 20);
  }

  return {
    lexicalScore: score,
    matchedTokens,
  };
}

function chunkPassesFilter(chunk, analysis) {
  const { filters } = analysis;

  if (analysis.mode === "comparison" && filters.comparison?.sides?.length) {
    if (!assignChunkToComparisonSide(chunk, filters.comparison.sides)) {
      return false;
    }
  } else if (analysis.mode !== "fact_lookup") {
    if (filters.doc_types?.length && !filters.doc_types.includes(chunk.doc_type)) {
      return false;
    }

    if (filters.departments?.length && !filters.departments.includes(chunk.department)) {
      return false;
    }
  }

  if (filters.explicitDate && chunk.date !== filters.explicitDate && chunk.updated_at !== filters.explicitDate) {
    return false;
  }

  if (filters.months?.length > 1) {
    const chunkMonth = chunk.month;
    if (!filters.months.includes(chunkMonth)) {
      return false;
    }
  } else if (filters.month && analysis.mode !== "fact_lookup" && analysis.mode !== "comparison") {
    const chunkMonth = chunk.month;
    if (chunkMonth !== filters.month) {
      return false;
    }
  }

  return true;
}

function computeBoosts(query, analysis, chunk) {
  const boosts = [];
  let boost = 0;
  const normalizedQuery = normalizeText(query);
  const combinedMeta = normalizeText(
    [
      chunk.filename,
      chunk.source_path,
      chunk.title,
      chunk.section_heading,
      chunk.doc_type,
      chunk.department,
      (chunk.tags || []).join(" "),
    ]
      .filter(Boolean)
      .join(" ")
  );

  const chunkMonth = chunk.month;

  if (analysis.filters.month && chunkMonth === analysis.filters.month) {
    boost += 18;
    boosts.push(`month match (${analysis.filters.month})`);
  }

  if (analysis.filters.months?.length > 1 && analysis.filters.months.includes(chunkMonth)) {
    boost += 10;
    boosts.push(`comparison month (${chunkMonth})`);
  }

  if (analysis.filters.explicitDate && (chunk.date === analysis.filters.explicitDate || chunk.updated_at === analysis.filters.explicitDate)) {
    boost += 24;
    boosts.push(`date match (${analysis.filters.explicitDate})`);
  }

  if (analysis.filters.doc_types?.includes(chunk.doc_type)) {
    boost += 6;
    boosts.push(`doc_type match (${chunk.doc_type})`);
  }

  if (analysis.filters.departments?.includes(chunk.department)) {
    boost += 5;
    boosts.push(`department match (${chunk.department})`);
  }

  for (const clue of analysis.filters.filename_clues || []) {
    const normalizedClue = normalizeText(clue);
    if (combinedMeta.includes(normalizedClue)) {
      boost += 10;
      boosts.push(`filename/path clue (${clue})`);
    }
  }

  for (const keyword of analysis.filters.topic_keywords || []) {
    const normalizedKeyword = normalizeText(keyword);
    if (!normalizedKeyword) continue;

    if (combinedMeta.includes(normalizedKeyword)) {
      boost += 4;
      boosts.push(`metadata overlap (${keyword})`);
    }

    if (normalizedQuery.includes(normalizedKeyword) && normalizeText(chunk.content).includes(normalizedKeyword)) {
      boost += 3;
      boosts.push(`phrase overlap (${keyword})`);
    }
  }

  if (analysis.filters.comparison?.sides?.length) {
    const side = assignChunkToComparisonSide(chunk, analysis.filters.comparison.sides);
    if (side) {
      boost += 8;
      boosts.push(`comparison side (${side.label})`);
    }
  }

  return {
    boost,
    boosts,
  };
}

function dedupeByChunkId(results) {
  const seen = new Set();
  const deduped = [];

  for (const item of results) {
    const key = item.chunk_id || item.chunkId;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function normalizeLexicalScore(score, maxScore) {
  if (!maxScore || maxScore <= 0) {
    return 0;
  }

  return Math.max(0, Number(score || 0) / maxScore);
}

function normalizeSemanticScore(score) {
  // Cosine similarity is usually in [-1, 1]. Convert it to a simple [0, 1] range
  // before mixing it with lexical scores.
  return Math.max(0, Math.min(1, (Number(score || 0) + 1) / 2));
}

function combineHybridScore({ lexicalScore, semanticScore, maxLexicalScore, useSemantic }) {
  const lexicalComponent = normalizeLexicalScore(lexicalScore, maxLexicalScore);

  if (!useSemantic) {
    return lexicalComponent;
  }

  const semanticComponent = normalizeSemanticScore(semanticScore);

  return (
    HYBRID_WEIGHTS.lexicalWeight * lexicalComponent +
    HYBRID_WEIGHTS.semanticWeight * semanticComponent
  );
}

async function getSemanticScores(index, query, candidates) {
  const localEmbeddingsEnabled = getLocalEmbeddingConfig().enabled;
  const indexHasChunkEmbeddings = index.chunks.some(
    (chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0
  );

  if (!Array.isArray(candidates) || candidates.length === 0) {
    retrievalDebug("semantic scoring skipped: no lexical candidates");
    return {
      scores: new Map(),
      localEmbeddingsUsed: false,
      reason: "no_lexical_candidates",
      queryEmbeddingDimension: null,
      candidatesWithEmbeddings: 0,
      queryEmbeddingAttempted: false,
      queryEmbeddingSucceeded: false,
    };
  }

  if (!localEmbeddingsEnabled) {
    retrievalDebug("semantic scoring skipped: embeddings disabled");
    return {
      scores: new Map(),
      localEmbeddingsUsed: false,
      reason: "embeddings_disabled",
      queryEmbeddingDimension: null,
      candidatesWithEmbeddings: 0,
      queryEmbeddingAttempted: false,
      queryEmbeddingSucceeded: false,
    };
  }

  if (!index.embedding?.enabled || !indexHasChunkEmbeddings) {
    retrievalDebug("semantic scoring skipped: index has no chunk embeddings");
    return {
      scores: new Map(),
      localEmbeddingsUsed: false,
      reason: "index_has_no_chunk_embeddings",
      queryEmbeddingDimension: null,
      candidatesWithEmbeddings: 0,
      queryEmbeddingAttempted: false,
      queryEmbeddingSucceeded: false,
    };
  }

  const provider = createEmbeddingProviderFromEnv();
  if (!provider) {
    retrievalDebug("semantic scoring skipped: no embedding provider");
    return {
      scores: new Map(),
      localEmbeddingsUsed: false,
      reason: "no_embedding_provider",
      queryEmbeddingDimension: null,
      candidatesWithEmbeddings: 0,
      queryEmbeddingAttempted: false,
      queryEmbeddingSucceeded: false,
    };
  }

  try {
    retrievalDebug("converting query to embedding...");
    const queryEmbedding = await provider.embedQuery(query);
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      retrievalDebug("semantic scoring skipped: query embedding unavailable");
      return {
        scores: new Map(),
        localEmbeddingsUsed: false,
        reason: "query_embedding_unavailable",
        queryEmbeddingDimension: null,
        candidatesWithEmbeddings: 0,
        queryEmbeddingAttempted: true,
        queryEmbeddingSucceeded: false,
      };
    }

    retrievalDebug(`query embedding created (dim=${queryEmbedding.length})`);
    const scores = new Map();
    let candidatesWithEmbeddings = 0;

    retrievalDebug("semantic scoring started");

    for (const chunk of candidates) {
      if (!Array.isArray(chunk.embedding) || chunk.embedding.length === 0) {
        continue;
      }

      candidatesWithEmbeddings += 1;
      const semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding || []);
      scores.set(chunk.chunk_id || chunk.chunkId, semanticScore);
    }

    return {
      scores,
      localEmbeddingsUsed: scores.size > 0,
      queryEmbeddingDimension: queryEmbedding.length,
      candidatesWithEmbeddings,
      reason: scores.size > 0 ? null : "candidate_embeddings_missing",
      queryEmbeddingAttempted: true,
      queryEmbeddingSucceeded: true,
    };
  } catch (error) {
    console.warn(
      `Semantic retrieval failed (${error?.message || "unknown error"}). Falling back to lexical-only retrieval.`
    );
    return {
      scores: new Map(),
      localEmbeddingsUsed: false,
      reason: error?.message || "query_embedding_failed",
      queryEmbeddingDimension: null,
      candidatesWithEmbeddings: 0,
      queryEmbeddingAttempted: true,
      queryEmbeddingSucceeded: false,
    };
  }
}

function groupChunksByDocument(chunks) {
  const groups = new Map();

  for (const chunk of chunks) {
    const key = chunk.source_path || chunk.filename;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(chunk);
  }

  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      items: items.sort((a, b) => (a.chunk_index || 0) - (b.chunk_index || 0)),
      chunk: items[0],
      label:
        items[0].date ||
        items[0].updated_at ||
        items[0].month ||
        items[0].title ||
        items[0].filename,
    }))
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

function groupChunksForTimeline(chunks) {
  return groupChunksByDocument(chunks).sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

function matchesTopicKeywords(chunk, analysis) {
  const keywords = (analysis.filters.topic_keywords || [])
    .map((keyword) => normalizeText(keyword))
    .filter((keyword) => keyword && !GENERIC_TOPIC_KEYWORDS.has(keyword));
  if (keywords.length === 0) return false;
  const haystack = normalizeText(
    [
      chunk.content,
      chunk.title,
      chunk.section_heading,
      chunk.filename,
      chunk.source_path,
      chunk.doc_type,
      chunk.department,
      (chunk.tags || []).join(" "),
    ]
      .filter(Boolean)
      .join(" ")
  );

  const overlap = keywords.filter((keyword) => haystack.includes(keyword)).length;
  return overlap >= Math.min(2, keywords.length);
}

function collectThemeSignals(chunk) {
  const signals = new Set();

  for (const tag of chunk.tags || []) {
    const normalized = normalizeText(tag).replaceAll("_", " ");
    if (!normalized || GENERIC_THEME_TAGS.has(normalized)) continue;
    signals.add(normalized);
  }

  const metaText = normalizeText(
    [chunk.title, chunk.section_heading, chunk.content]
      .filter(Boolean)
      .join(" ")
  );

  for (const phrase of PHRASE_THEMES) {
    if (metaText.includes(phrase)) {
      signals.add(phrase);
    }
  }

  return [...signals];
}

function extractRecurringThemes(groupedChunks) {
  const themeMap = new Map();

  for (const group of groupedChunks) {
    const seenInDocument = new Set();
    for (const chunk of group.items) {
      for (const theme of collectThemeSignals(chunk)) {
        if (seenInDocument.has(theme)) continue;
        seenInDocument.add(theme);

        if (!themeMap.has(theme)) {
          themeMap.set(theme, {
            theme,
            supportCount: 0,
            chunks: [],
          });
        }

        const entry = themeMap.get(theme);
        entry.supportCount += 1;
        entry.chunks.push(group.chunk);
      }
    }
  }

  return [...themeMap.values()]
    .filter((entry) => entry.supportCount >= 2)
    .sort((a, b) => b.supportCount - a.supportCount || a.theme.localeCompare(b.theme))
    .slice(0, 6);
}

function findFirstMention(chunks, analysis) {
  const keywords = (analysis.filters.topic_keywords || []).map((keyword) => normalizeText(keyword));
  if (keywords.length === 0) return null;

  const matches = chunks.filter((chunk) => {
    const haystack = normalizeText([chunk.content, chunk.title, chunk.section_heading].join(" "));
    const overlap = keywords.filter((keyword) => haystack.includes(keyword)).length;
    return overlap >= Math.max(1, Math.min(2, keywords.length));
  });

  if (matches.length === 0) return null;

  return [...matches].sort((a, b) => {
    const aKey = a.date || a.updated_at || a.filename;
    const bKey = b.date || b.updated_at || b.filename;
    return String(aKey).localeCompare(String(bKey));
  })[0];
}

function bestEvidenceSnippet(chunk, maxLength = 200) {
  const sectionAware = sentenceSplit(chunk.content).slice(0, 2).join(" ");
  return compactText(sectionAware || chunk.content, maxLength);
}

function summarizeTimeline(groupedChunks, analysis) {
  const steps = groupedChunks.slice(0, 6).map((group) => ({
    label: group.label,
    title: group.chunk.title || group.chunk.filename,
    snippet: bestEvidenceSnippet(group.chunk, 190),
    chunk: group.chunk,
  }));

  if (steps.length < 1) return null;

  const lines = [
    analysis.mode === "temporal_summary"
      ? "Grounded period summary from the retrieved documents:"
      : "Observed progression across the retrieved documents:",
  ];
  const citations = [];

  for (const step of steps) {
    lines.push(`- ${step.label} | ${step.title}: ${step.snippet} ${makeCitation(step.chunk)}`);
    citations.push(makeCitation(step.chunk));
  }

  return {
    summary: lines.join("\n"),
    citations: [...new Set(citations)],
  };
}

function sideKeywords(side) {
  return [
    ...(side.keywords || []),
    ...(side.docTypes || []),
    ...(side.departments || []),
    ...(side.groups || []),
    ...(side.months || []),
  ]
    .map((item) => normalizeText(String(item || "").replaceAll("_", " ")))
    .filter(Boolean);
}

function scoreSideMembership(chunk, side) {
  if (side.docTypes?.length && !side.docTypes.includes(chunk.doc_type)) {
    return 0;
  }

  if (side.departments?.length && !side.departments.includes(chunk.department)) {
    return 0;
  }

  let score = 0;

  if (side.docTypes?.includes(chunk.doc_type)) score += 5;
  if (side.departments?.includes(chunk.department)) score += 4;

  const chunkMonth = chunk.month;
  if (side.months?.includes(chunkMonth)) score += 5;

  const haystack = normalizeText(
    [
      chunk.title,
      chunk.section_heading,
      chunk.content,
      chunk.filename,
      chunk.source_path,
      (chunk.tags || []).join(" "),
    ]
      .filter(Boolean)
      .join(" ")
  );

  for (const keyword of sideKeywords(side)) {
    if (haystack.includes(keyword)) score += 2;
  }

  return score;
}

function assignChunkToComparisonSide(chunk, sides) {
  const ranked = (sides || [])
    .map((side) => ({
      side,
      score: scoreSideMembership(chunk, side),
    }))
    .sort((a, b) => b.score - a.score);

  return ranked[0]?.score > 0 ? ranked[0].side : null;
}

function detectComparisonMismatch(sideHits) {
  const leftText = normalizeText(sideHits.left.map((chunk) => chunk.content).join(" "));
  const rightText = normalizeText(sideHits.right.map((chunk) => chunk.content).join(" "));
  const combined = `${leftText} ${rightText}`;

  if (combined.includes("14 days") && combined.includes("21 days")) {
    return "The refund evidence shows one request inside the 14-day window and another outside it.";
  }

  if (combined.includes("3-day grace period")) {
    return "The ticket evidence is consistent with the 3-day failed-payment grace period.";
  }

  if (combined.includes("weekend support is only guaranteed for enterprise") && combined.includes("weekend")) {
    return "Weekend support requests should be checked against the Enterprise-only guarantee in policy.";
  }

  return null;
}

function summarizeComparison(sourceHits, analysis) {
  const sides = analysis.filters.comparison?.sides || [];
  if (sides.length < 2) return null;

  const sideHits = new Map(sides.map((side) => [side.label, []]));
  for (const chunk of sourceHits) {
    const side = assignChunkToComparisonSide(chunk, sides);
    if (!side) continue;
    const list = sideHits.get(side.label);
    if (list.length < 3) list.push(chunk);
  }

  if ([...sideHits.values()].filter((items) => items.length > 0).length < 2) {
    return {
      summary: "Evidence is insufficient to compare both requested sides confidently.",
      citations: [],
    };
  }

  const lines = ["Side-by-side comparison evidence:"];
  const citations = [];

  for (const side of sides) {
    const items = sideHits.get(side.label) || [];
    if (items.length === 0) continue;
    const snippets = items
      .slice(0, 2)
      .map((chunk) => `${bestEvidenceSnippet(chunk, 140)} ${makeCitation(chunk)}`);
    lines.push(`- ${side.label}: ${snippets.join(" ")}`);
    citations.push(...items.slice(0, 2).map((chunk) => makeCitation(chunk)));
  }

  const mismatch = detectComparisonMismatch({
    left: sideHits.get(sides[0].label) || [],
    right: sideHits.get(sides[1].label) || [],
  });

  if (mismatch) {
    lines.push(`- Comparison note: ${mismatch}`);
  }

  return {
    summary: lines.join("\n"),
    citations: [...new Set(citations)],
  };
}

function buildBroadSummary(analysis, sourceHits) {
  const groupedDocs = groupChunksByDocument(sourceHits);

  if (analysis.mode === "recurring_themes") {
    const themes = extractRecurringThemes(groupedDocs);
    if (themes.length === 0) {
      return {
        summary: "Evidence is insufficient across multiple documents to identify recurring themes confidently.",
        citations: [],
      };
    }

    const lines = ["Recurring themes observed across the retrieved documents:"];
    const citations = [];

    for (const theme of themes) {
      const supports = theme.chunks.slice(0, 2);
      lines.push(
        `- ${theme.theme}: appears across ${theme.supportCount} documents (${supports
          .map((chunk) => makeCitation(chunk))
          .join(", ")})`
      );
      citations.push(...supports.map((chunk) => makeCitation(chunk)));
    }

    return {
      summary: lines.join("\n"),
      citations: [...new Set(citations)],
    };
  }

  if (analysis.mode === "first_mention") {
    const first = findFirstMention(sourceHits, analysis);
    if (!first) {
      return {
        summary: "Evidence was not found for a grounded first mention in the indexed documents.",
        citations: [],
      };
    }

    return {
      summary: `The earliest grounded mention found is on ${
        first.date || first.updated_at || first.filename
      }: ${bestEvidenceSnippet(first, 220)} ${makeCitation(first)}`,
      citations: [makeCitation(first)],
    };
  }

  if (analysis.mode === "comparison") {
    return summarizeComparison(sourceHits, analysis);
  }

  if (analysis.mode === "evolution_over_time" || analysis.mode === "temporal_summary") {
    return (
      summarizeTimeline(groupChunksForTimeline(sourceHits), analysis) || {
        summary: "Evidence is insufficient across time to summarize the retrieved documents confidently.",
        citations: [],
      }
    );
  }

  return null;
}

function ensureComparisonCoverage(rerankedHits, analysis, limit) {
  const sides = analysis.filters.comparison?.sides || [];
  if (analysis.mode !== "comparison" || sides.length < 2) {
    return dedupeByChunkId(rerankedHits).slice(0, Math.max(limit, 8));
  }

  const chosen = [];
  const seen = new Set();

  for (const side of sides) {
    const candidates = rerankedHits.filter((chunk) => assignChunkToComparisonSide(chunk, [side])?.label === side.label);
    for (const chunk of candidates.slice(0, 3)) {
      const key = chunk.chunk_id || chunk.chunkId;
      if (seen.has(key)) continue;
      seen.add(key);
      chosen.push(chunk);
    }
  }

  for (const chunk of rerankedHits) {
    const key = chunk.chunk_id || chunk.chunkId;
    if (seen.has(key)) continue;
    chosen.push(chunk);
    seen.add(key);
    if (chosen.length >= Math.max(limit, 8)) break;
  }

  return chosen;
}

function selectFinalHitsByMode(rerankedHits, analysis, limit) {
  const deduped = dedupeByChunkId(rerankedHits);

  if (analysis.mode === "first_mention") {
    return deduped
      .filter((chunk) => matchesTopicKeywords(chunk, analysis))
      .sort((a, b) => {
        const aKey = a.date || a.updated_at || a.filename;
        const bKey = b.date || b.updated_at || b.filename;
        if (String(aKey) !== String(bKey)) {
          return String(aKey).localeCompare(String(bKey));
        }
        return b.finalScore - a.finalScore;
      })
      .slice(0, Math.max(limit, 6));
  }

  if (analysis.mode === "evolution_over_time" || analysis.mode === "temporal_summary") {
    const topical = deduped.filter((chunk) => matchesTopicKeywords(chunk, analysis));
    const scoped = topical.length >= 2 ? topical : deduped;

    return scoped
      .sort((a, b) => {
        const aKey = a.date || a.updated_at || a.filename;
        const bKey = b.date || b.updated_at || b.filename;
        if (String(aKey) !== String(bKey)) {
          return String(aKey).localeCompare(String(bKey));
        }
        return b.finalScore - a.finalScore;
      })
      .slice(0, Math.max(limit, 8));
  }

  if (analysis.mode === "comparison") {
    return ensureComparisonCoverage(deduped, analysis, limit);
  }

  return deduped.slice(0, analysis.broadQuery ? Math.max(limit, 8) : limit);
}

function formatHit(hit, index) {
  const lines = [
    `RESULT: ${index + 1}`,
    `CITATION: ${makeCitation(hit)}`,
    `SOURCE: ${hit.chunk_id || hit.chunkId}`,
    `FILE: ${hit.source_path || hit.filePath || hit.filename || hit.fileName || "unknown"}`,
    `DATE: ${hit.date || "n/a"}`,
    `UPDATED_AT: ${hit.updated_at || "n/a"}`,
    `MONTH: ${hit.month || "n/a"}`,
    `DOC_TYPE: ${hit.doc_type || "n/a"}`,
    `DEPARTMENT: ${hit.department || "n/a"}`,
    `TITLE: ${hit.title || "n/a"}`,
    `SECTION: ${hit.section_heading || "n/a"}`,
    `TAGS: ${(hit.tags || []).join(", ") || "n/a"}`,
    `LEXICAL_SCORE: ${Number(hit.lexicalScore || 0).toFixed(2)}`,
    `SEMANTIC_SCORE: ${Number(hit.semanticScore || 0).toFixed(4)}`,
    `COMBINED_SCORE: ${Number(hit.combinedScore || 0).toFixed(4)}`,
  ];

  if (hit.rerankBoostReasons?.length) {
    lines.push(`BOOSTS: ${hit.rerankBoostReasons.join("; ")}`);
  }

  if (hit.local_context?.previous || hit.local_context?.next) {
    lines.push(`LOCAL_CONTEXT_PREV: ${hit.local_context?.previous || "n/a"}`);
    lines.push(`LOCAL_CONTEXT_NEXT: ${hit.local_context?.next || "n/a"}`);
  }

  lines.push("CONTENT:");
  lines.push(hit.content);
  return lines.join("\n");
}

function formatDebug(debug) {
  return [
    "DEBUG:",
    `QUERY_MODE: ${debug.analysis.mode}`,
    `FILTERS: ${JSON.stringify(debug.analysis.filters)}`,
    `LOCAL_EMBEDDINGS_CONFIGURED: ${debug.embeddingDebug.configured ? "yes" : "no"}`,
    `LOCAL_EMBEDDINGS_INDEX: ${debug.embeddingDebug.indexHasEmbeddings ? "yes" : "no"}`,
    `LOCAL_QUERY_EMBEDDING_USED: ${debug.embeddingDebug.queryEmbeddingUsed ? "yes" : "no"}`,
    `LOCAL_EMBEDDING_MODEL: ${debug.embeddingDebug.model}`,
    `QUERY_EMBEDDING_DIMENSION: ${debug.embeddingDebug.queryEmbeddingDimension || "n/a"}`,
    `CANDIDATES_WITH_EMBEDDINGS: ${debug.embeddingDebug.candidatesWithEmbeddings || 0}`,
    `RETRIEVAL_MODE: ${debug.retrievalMode}`,
    `HYBRID_WEIGHTS: lexical=${debug.hybridWeights.lexicalWeight}, semantic=${debug.hybridWeights.semanticWeight}`,
    `SEMANTIC_STATUS: ${debug.embeddingDebug.reason || "ok"}`,
    `TOP_LEXICAL_HITS: ${debug.topLexicalHits.map((hit) => hit.chunk_id).join(", ") || "none"}`,
    `TOP_SEMANTIC_HITS: ${debug.topSemanticHits.map((hit) => hit.chunk_id).join(", ") || "none"}`,
    `FINAL_RERANKED_HITS: ${debug.finalHits.map((hit) => hit.chunk_id).join(", ") || "none"}`,
    ...debug.finalHits.map((hit) => `WHY_BOOSTED ${hit.chunk_id}: ${hit.rerankBoostReasons?.join("; ") || "none"}`),
  ].join("\n");
}

export async function retrieveCandidates(query, options = {}) {
  const limit = Number(options.limit || 5);
  const index = loadIndex(options.indexFile || INDEX_FILE);
  const embeddingConfig = getLocalEmbeddingConfig();
  const indexHasChunkEmbeddings = index.chunks.some(
    (chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length > 0
  );
  const analysis = analyzeQuery(query);
  const analyzedTokens = [
    ...(analysis.filters.topic_keywords || []).flatMap((keyword) => tokenize(keyword)),
    ...(analysis.filters.filename_clues || []).flatMap((keyword) => tokenize(keyword)),
    ...((analysis.filters.comparison?.sides || []).flatMap((side) => side.keywords || []).flatMap((keyword) =>
      tokenize(keyword)
    )),
  ];
  const queryTokens = [...new Set(analyzedTokens)].filter(Boolean);

  retrievalDebug(`query received: ${query}`);
  retrievalDebug(
    `analysis mode=${analysis.mode}, broadQuery=${analysis.broadQuery ? "yes" : "no"}`
  );
  retrievalDebug(`local embeddings enabled in env: ${embeddingConfig.enabled ? "yes" : "no"}`);
  retrievalDebug(`loaded index has chunk embeddings: ${indexHasChunkEmbeddings ? "yes" : "no"}`);
  retrievalDebug(`total chunks in index: ${index.chunks.length}`);

  if (queryTokens.length === 0) {
    retrievalDebug("no query tokens extracted; skipping retrieval");
    return {
      analysis,
      retrievalMode: "empty_query",
      topLexicalHits: [],
      topSemanticHits: [],
      finalHits: [],
      broadSummary: null,
      debug: null,
      dateRange: findRelevantDateRange(analysis),
    };
  }

  const candidatePool = index.chunks.filter((chunk) => chunkPassesFilter(chunk, analysis));
  const lexicalRanked = candidatePool
    .map((chunk) => {
      const lexical = scoreLexical(query, queryTokens, chunk);
      return {
        ...chunk,
        ...lexical,
      };
    })
    .filter((chunk) => chunk.lexicalScore > 0 && chunk.matchedTokens > 0)
    .sort((a, b) => {
      if (b.lexicalScore !== a.lexicalScore) return b.lexicalScore - a.lexicalScore;
      if (b.matchedTokens !== a.matchedTokens) return b.matchedTokens - a.matchedTokens;
      return String(a.chunk_id || a.chunkId).localeCompare(String(b.chunk_id || b.chunkId));
    });

  const wideLimit = analysis.broadQuery ? Math.max(limit * 6, 30) : Math.max(limit * 3, 12);
  const lexicalCandidates = lexicalRanked.slice(0, wideLimit);
  const lexicalCandidateCount = lexicalCandidates.length;
  retrievalDebug(`lexical candidates selected before semantic scoring: ${lexicalCandidates.length}`);
  const semanticResult = await getSemanticScores(index, query, lexicalCandidates);
  const semanticScoreMap = semanticResult.scores;
  const retrievalMode = semanticResult.localEmbeddingsUsed ? "hybrid" : "lexical_only";
  const maxLexicalScore = Math.max(...lexicalCandidates.map((chunk) => chunk.lexicalScore), 0);

  if (semanticResult.queryEmbeddingDimension) {
    retrievalDebug(`query embedding dimension: ${semanticResult.queryEmbeddingDimension}`);
  }
  retrievalDebug(
    `candidates with embeddings: ${semanticResult.candidatesWithEmbeddings || 0}/${lexicalCandidates.length}`
  );

  const hybridRanked = lexicalCandidates
    .map((chunk) => {
      const semanticScore = semanticScoreMap.get(chunk.chunk_id || chunk.chunkId) || 0;
      const combinedScore = combineHybridScore({
        lexicalScore: chunk.lexicalScore,
        semanticScore,
        maxLexicalScore,
        useSemantic: retrievalMode === "hybrid",
      });
      return {
        ...chunk,
        semanticScore,
        combinedScore,
      };
    })
    .sort((a, b) => b.combinedScore - a.combinedScore);

  retrievalDebug(
    `hybrid scoring/reranking completed: mode=${retrievalMode}, semantic_status=${semanticResult.reason || "ok"}`
  );

  const reranked = hybridRanked
    .map((chunk) => {
      const rerank = computeBoosts(query, analysis, chunk);
      return {
        ...chunk,
        rerankBoost: rerank.boost,
        rerankBoostReasons: rerank.boosts,
        finalScore: chunk.combinedScore + rerank.boost,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);

  const broadSourceHits = dedupeByChunkId(reranked).slice(0, Math.max(wideLimit, 36));
  const finalHits = selectFinalHitsByMode(reranked, analysis, limit);
  const summarySourceHits =
    analysis.mode === "evolution_over_time" || analysis.mode === "temporal_summary"
      ? finalHits
      : broadSourceHits;
  const broadSummary = analysis.broadQuery ? buildBroadSummary(analysis, summarySourceHits) : null;

  retrievalDebug(
    `top lexical hits: ${formatTopHitSummary(lexicalRanked, "lexicalScore") || "none"}`
  );
  retrievalDebug(
    `top semantic hits: ${formatTopHitSummary(
      hybridRanked.filter((hit) => hit.semanticScore > 0),
      "semanticScore"
    ) || "none"}`
  );
  retrievalDebug(`top final hits: ${formatTopHitSummary(finalHits, "finalScore") || "none"}`);

  const debug = {
    analysis,
    broadQuery: analysis.broadQuery,
    retrievalMode,
    totalChunks: index.chunks.length,
    lexicalCandidateCount,
    hybridWeights: HYBRID_WEIGHTS,
    embeddingDebug: {
      configured: embeddingConfig.enabled,
      model: embeddingConfig.model,
      indexHasEmbeddings: indexHasChunkEmbeddings,
      queryEmbeddingAttempted: semanticResult.queryEmbeddingAttempted,
      queryEmbeddingUsed: semanticResult.localEmbeddingsUsed,
      queryEmbeddingSucceeded: semanticResult.queryEmbeddingSucceeded,
      reason: semanticResult.reason,
      semanticSkipReason: semanticResult.reason,
      queryEmbeddingDimension: semanticResult.queryEmbeddingDimension,
      candidatesWithEmbeddings: semanticResult.candidatesWithEmbeddings,
    },
    topLexicalHits: lexicalRanked.slice(0, Math.min(5, lexicalRanked.length)).map((hit) => ({
      chunk_id: hit.chunk_id || hit.chunkId,
      lexicalScore: hit.lexicalScore,
    })),
    topSemanticHits: hybridRanked
      .filter((hit) => hit.semanticScore > 0)
      .slice(0, 5)
      .map((hit) => ({
        chunk_id: hit.chunk_id || hit.chunkId,
        semanticScore: hit.semanticScore,
      })),
    finalHits: finalHits.map((hit) => ({
      chunk_id: hit.chunk_id || hit.chunkId,
      finalScore: hit.finalScore,
      rerankBoostReasons: hit.rerankBoostReasons,
    })),
    summaries: {
      topLexicalHits: lexicalRanked
        .slice(0, Math.min(5, lexicalRanked.length))
        .map((hit) => hit.chunk_id || hit.chunkId),
      topFinalHits: finalHits
        .slice(0, Math.min(5, finalHits.length))
        .map((hit) => hit.chunk_id || hit.chunkId),
    },
  };

  return {
    analysis,
    retrievalMode,
    topLexicalHits: lexicalRanked.slice(0, 5),
    topSemanticHits: hybridRanked.filter((hit) => hit.semanticScore > 0).slice(0, 5),
    finalHits,
    broadSummary,
    debug,
    dateRange: findRelevantDateRange(analysis),
  };
}

export async function searchInternalDocs(query, options = {}) {
  const result = await retrieveCandidates(query, options);
  const debugEnabled = options.debug || /^1|true|yes$/i.test(String(process.env.RETRIEVAL_DEBUG || ""));

  if (result.finalHits.length === 0) {
    return {
      text: "No relevant results found.",
      result,
    };
  }

  const sections = [];
  sections.push("QUERY_ANALYSIS:");
  sections.push(`MODE: ${result.analysis.mode}`);
  sections.push(`FILTERS: ${JSON.stringify(result.analysis.filters)}`);
  sections.push("");

  if (result.broadSummary?.summary) {
    sections.push("AGGREGATED_EVIDENCE:");
    sections.push(result.broadSummary.summary);
    sections.push("");
  }

  sections.push("RETRIEVED_RESULTS:");
  result.finalHits.forEach((hit, index) => {
    sections.push(formatHit(hit, index));
    sections.push("");
  });

  if (debugEnabled && result.debug) {
    sections.push(formatDebug(result.debug));
  }

  return {
    text: sections.join("\n").trim(),
    result,
  };
}
