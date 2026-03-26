import fs from "node:fs";
import { analyzeQuery, findRelevantDateRange } from "./query-analysis.js";
import { createEmbeddingProviderFromEnv } from "./embeddings.js";
import {
  compactText,
  cosineSimilarity,
  extractInterestingTerms,
  makeCitation,
  normalizeText,
  tokenize,
} from "./text-utils.js";

const INDEX_FILE = process.env.INDEX_FILE || "./data/index.json";
const THEME_STOPWORDS = new Set([
  "add",
  "again",
  "appear",
  "check",
  "create",
  "daily",
  "december",
  "do",
  "finish",
  "make",
  "need",
  "notes",
  "ok",
  "priorities",
  "priority",
  "put",
  "quickly",
  "recurring",
  "review",
  "start",
  "test",
  "today",
  "tomorrow",
  "try",
  "work"
]);

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
  const chunkId = normalizeText(chunk.chunk_id || chunk.chunkId || "");
  const filenameFreq = tokenFrequency(filename);
  const sourcePathFreq = tokenFrequency(sourcePath);
  const titleFreq = tokenFrequency(title);
  const sectionFreq = tokenFrequency(section);
  const tagFreq = tokenFrequency(tags);
  const chunkIdFreq = tokenFrequency(chunkId);

  let score = 0;
  let matchedTokens = 0;

  for (const token of queryTokens) {
    const keywordFreq = Number(chunk.keyword_freq?.[token] || chunk.keywordFreq?.[token] || 0);
    const contentOccurrences = keywordFreq;
    const fileOccurrences = Number(filenameFreq[token] || 0) + Number(sourcePathFreq[token] || 0);
    const titleOccurrences = Number(titleFreq[token] || 0) + Number(sectionFreq[token] || 0);
    const tagOccurrences = Number(tagFreq[token] || 0);
    const chunkIdOccurrences = Number(chunkIdFreq[token] || 0);

    if (keywordFreq || contentOccurrences || fileOccurrences || titleOccurrences || tagOccurrences) {
      matchedTokens += 1;
    }

    score += keywordFreq * 7;
    score += contentOccurrences * 2;
    score += fileOccurrences * 7;
    score += titleOccurrences * 6;
    score += tagOccurrences * 4;
    score += chunkIdOccurrences * 2;
  }

  const normalizedQuery = normalizeText(query);
  if (normalizedQuery.length >= 5 && content.includes(normalizedQuery)) {
    score += 18;
  }
  if (normalizedQuery.length >= 5 && (filename.includes(normalizedQuery) || sourcePath.includes(normalizedQuery))) {
    score += 14;
  }

  if (queryTokens.length > 0) {
    score += Math.round((matchedTokens / queryTokens.length) * 18);
  }

  return {
    lexicalScore: score,
    matchedTokens,
  };
}

function chunkPassesFilter(chunk, analysis) {
  const { filters } = analysis;

  if (filters.doc_type && chunk.doc_type !== filters.doc_type) {
    if (analysis.broadQuery) {
      return false;
    }
  }

  if (filters.explicitDate && chunk.date !== filters.explicitDate) {
    return false;
  }

  if (filters.month && chunk.month !== filters.month && analysis.broadQuery) {
    return false;
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
      (chunk.tags || []).join(" "),
    ]
      .filter(Boolean)
      .join(" ")
  );

  if (analysis.filters.month && chunk.month === analysis.filters.month) {
    boost += 20;
    boosts.push(`month match (${analysis.filters.month})`);
  }

  if (analysis.filters.explicitDate && chunk.date === analysis.filters.explicitDate) {
    boost += 24;
    boosts.push(`date match (${analysis.filters.explicitDate})`);
  }

  if (analysis.filters.doc_type && chunk.doc_type === analysis.filters.doc_type) {
    boost += 12;
    boosts.push(`doc_type match (${chunk.doc_type})`);
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

async function getSemanticScores(index, query, candidates) {
  if (!index.embedding?.enabled) {
    return new Map();
  }

  const provider = createEmbeddingProviderFromEnv();
  if (!provider) {
    return new Map();
  }

  try {
    const queryEmbedding = await provider.embedQuery(query);
    const scores = new Map();

    for (const chunk of candidates) {
      const semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding || []);
      scores.set(chunk.chunk_id || chunk.chunkId, semanticScore);
    }

    return scores;
  } catch (error) {
    console.warn(
      `Semantic retrieval failed (${error?.message || "unknown error"}). Falling back to lexical-only retrieval.`
    );
    return new Map();
  }
}

function groupChunksByDateOrFile(chunks) {
  const groups = new Map();

  for (const chunk of chunks) {
    const key = chunk.date || chunk.filename || chunk.source_path;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(chunk);
  }

  return [...groups.entries()]
    .map(([key, items]) => ({
      key,
      items: items.sort((a, b) => (a.chunk_index || 0) - (b.chunk_index || 0)),
    }))
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

function matchesTopicKeywords(chunk, analysis) {
  const keywords = (analysis.filters.topic_keywords || []).map((keyword) => normalizeText(keyword));
  if (keywords.length === 0) return false;
  const haystack = normalizeText(
    [
      chunk.content,
      chunk.title,
      chunk.section_heading,
      chunk.filename,
      chunk.source_path,
      (chunk.tags || []).join(" "),
    ]
      .filter(Boolean)
      .join(" ")
  );

  return keywords.some((keyword) => haystack.includes(keyword));
}

function extractRecurringThemes(groupedChunks) {
  const themeMap = new Map();

  for (const group of groupedChunks) {
    const tokens = new Set();
    for (const chunk of group.items) {
      for (const term of extractInterestingTerms(chunk.content, 10)) {
        if (THEME_STOPWORDS.has(term)) continue;
        tokens.add(term);
      }
    }

    for (const token of tokens) {
      if (!themeMap.has(token)) {
        themeMap.set(token, {
          theme: token,
          supportCount: 0,
          chunks: [],
        });
      }
      const entry = themeMap.get(token);
      entry.supportCount += 1;
      entry.chunks.push(group.items[0]);
    }
  }

  return [...themeMap.values()]
    .filter((entry) => entry.supportCount >= 2)
    .sort((a, b) => {
      if (b.supportCount !== a.supportCount) return b.supportCount - a.supportCount;
      return a.theme.localeCompare(b.theme);
    })
    .slice(0, 5);
}

function findFirstMention(chunks, analysis) {
  const keywords = (analysis.filters.topic_keywords || []).map((keyword) => normalizeText(keyword));
  if (keywords.length === 0) return null;

  const matches = chunks.filter((chunk) => {
    const content = normalizeText(chunk.content);
    const overlap = keywords.filter((keyword) => content.includes(keyword)).length;
    return overlap >= Math.max(1, Math.min(2, keywords.length));
  });

  if (matches.length === 0) return null;

  return [...matches].sort((a, b) => {
    const aKey = a.date || a.filename;
    const bKey = b.date || b.filename;
    return String(aKey).localeCompare(String(bKey));
  })[0];
}

function summarizeEvolution(groupedChunks, analysis) {
  const keywords = analysis.filters.topic_keywords || [];
  const steps = groupedChunks
    .map((group) => {
      const merged = group.items.map((item) => item.content).join("\n");
      return {
        label: group.key,
        snippet: compactText(merged, 180),
        chunk: group.items[0],
      };
    })
    .slice(0, 6);

  if (steps.length < 2) return null;

  const lines = [`Observed progression for ${keywords.join(", ") || "the topic"}:`];
  const citations = [];

  for (const step of steps) {
    lines.push(`- ${step.label}: ${step.snippet} ${makeCitation(step.chunk)}`);
    citations.push(makeCitation(step.chunk));
  }

  return {
    summary: lines.join("\n"),
    citations: [...new Set(citations)],
  };
}

function buildBroadSummary(analysis, sourceHits) {
  const grouped = groupChunksByDateOrFile(sourceHits);

  if (analysis.mode === "recurring_themes") {
    const themes = extractRecurringThemes(grouped);
    if (themes.length < 2) {
      return {
        summary: "Evidence is insufficient across multiple chunks to identify recurring themes confidently.",
        citations: [],
      };
    }

    const lines = ["Recurring themes observed across the retrieved notes:"];
    const citations = [];

    for (const theme of themes) {
      const supports = theme.chunks.slice(0, 2);
      const supportText = supports.map((chunk) => makeCitation(chunk)).join(", ");
      lines.push(`- ${theme.theme}: appears across ${theme.supportCount} files (${supportText})`);
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
        first.date || first.filename
      }: ${compactText(first.content, 220)} ${makeCitation(first)}`,
      citations: [makeCitation(first)],
    };
  }

  if (analysis.mode === "evolution_over_time" || analysis.mode === "temporal_summary") {
    return (
      summarizeEvolution(grouped, analysis) || {
        summary: "Evidence is insufficient across time to summarize evolution confidently.",
        citations: [],
      }
    );
  }

  if (analysis.mode === "comparison") {
    const groupedItems = grouped.slice(0, 4);
    if (groupedItems.length < 2) {
      return {
        summary: "Evidence is insufficient to produce a grounded comparison.",
        citations: [],
      };
    }

    const lines = ["Comparison evidence from the retrieved documents:"];
    const citations = [];

    for (const group of groupedItems) {
      const chunk = group.items[0];
      lines.push(`- ${group.key}: ${compactText(chunk.content, 180)} ${makeCitation(chunk)}`);
      citations.push(makeCitation(chunk));
    }

    return {
      summary: lines.join("\n"),
      citations: [...new Set(citations)],
    };
  }

  return null;
}

function selectFinalHitsByMode(rerankedHits, analysis, limit) {
  const deduped = dedupeByChunkId(rerankedHits);

  if (analysis.mode === "first_mention") {
    return deduped
      .filter((chunk) => matchesTopicKeywords(chunk, analysis))
      .sort((a, b) => {
        const aKey = a.date || a.filename;
        const bKey = b.date || b.filename;
        if (String(aKey) !== String(bKey)) {
          return String(aKey).localeCompare(String(bKey));
        }
        return b.finalScore - a.finalScore;
      })
      .slice(0, Math.max(limit, 6));
  }

  if (analysis.mode === "evolution_over_time" || analysis.mode === "temporal_summary") {
    return deduped
      .sort((a, b) => {
        const aKey = a.date || a.filename;
        const bKey = b.date || b.filename;
        if (String(aKey) !== String(bKey)) {
          return String(aKey).localeCompare(String(bKey));
        }
        return b.finalScore - a.finalScore;
      })
      .slice(0, Math.max(limit, 8));
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
    `MONTH: ${hit.month || "n/a"}`,
    `DOC_TYPE: ${hit.doc_type || "n/a"}`,
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
    `RETRIEVAL_MODE: ${debug.retrievalMode}`,
    `TOP_LEXICAL_HITS: ${debug.topLexicalHits.map((hit) => hit.chunk_id).join(", ") || "none"}`,
    `TOP_SEMANTIC_HITS: ${debug.topSemanticHits.map((hit) => hit.chunk_id).join(", ") || "none"}`,
    `FINAL_RERANKED_HITS: ${debug.finalHits.map((hit) => hit.chunk_id).join(", ") || "none"}`,
    ...debug.finalHits.map((hit) => {
      return `WHY_BOOSTED ${hit.chunk_id}: ${hit.rerankBoostReasons?.join("; ") || "none"}`;
    }),
  ].join("\n");
}

export async function retrieveCandidates(query, options = {}) {
  const limit = Number(options.limit || 5);
  const index = loadIndex(options.indexFile || INDEX_FILE);
  const analysis = analyzeQuery(query);
  const analyzedTokens = [
    ...(analysis.filters.topic_keywords || []).flatMap((keyword) => tokenize(keyword)),
    ...(analysis.filters.filename_clues || []).flatMap((keyword) => tokenize(keyword)),
    ...(analysis.filters.doc_type ? tokenize(analysis.filters.doc_type) : []),
  ];
  const queryTokens = [...new Set(analyzedTokens)].filter(Boolean);

  if (queryTokens.length === 0) {
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

  const wideLimit = analysis.broadQuery ? Math.max(limit * 6, 24) : Math.max(limit * 3, 12);
  const lexicalCandidates = lexicalRanked.slice(0, wideLimit);
  const semanticScoreMap = await getSemanticScores(index, query, lexicalCandidates);

  const hybridRanked = lexicalCandidates
    .map((chunk) => {
      const semanticScore = semanticScoreMap.get(chunk.chunk_id || chunk.chunkId) || 0;
      const combinedScore = chunk.lexicalScore + semanticScore * 35;
      return {
        ...chunk,
        semanticScore,
        combinedScore,
      };
    })
    .sort((a, b) => b.combinedScore - a.combinedScore);

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

  const broadSourceHits = dedupeByChunkId(reranked).slice(0, Math.max(wideLimit, 30));
  const finalHits = selectFinalHitsByMode(reranked, analysis, limit);
  const broadSummary = analysis.broadQuery ? buildBroadSummary(analysis, broadSourceHits) : null;

  const debug = {
    analysis,
    retrievalMode: semanticScoreMap.size > 0 ? "hybrid" : "lexical_only",
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
  };

  return {
    analysis,
    retrievalMode: debug.retrievalMode,
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
  sections.push(`RETRIEVAL_MODE: ${result.retrievalMode}`);

  if (result.broadSummary?.summary) {
    sections.push("");
    sections.push("AGGREGATED_EVIDENCE:");
    sections.push(result.broadSummary.summary);
  }

  sections.push("");
  sections.push("RETRIEVED_CHUNKS:");
  sections.push(result.finalHits.map((hit, index) => formatHit(hit, index)).join("\n\n---\n\n"));

  if (debugEnabled) {
    sections.push("");
    sections.push(formatDebug(result.debug));
  }

  return {
    text: sections.join("\n"),
    result,
  };
}

export { groupChunksByDateOrFile, extractRecurringThemes, findFirstMention, summarizeEvolution, loadIndex };
