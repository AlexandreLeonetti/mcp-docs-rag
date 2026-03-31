import { compactText, makeCitation, sentenceSplit, tokenize } from "../indexing/text-utils.js";

function citationsFromChunks(chunks, limit = 4) {
  return [...new Set(chunks.slice(0, limit).map((chunk) => makeCitation(chunk)))];
}

function bestSentenceForQuery(query, content) {
  const queryTokens = new Set(tokenize(query).filter((token) => !["who", "what", "when", "where", "which", "is", "are", "the", "of"].includes(token)));
  const sentences = sentenceSplit(content);

  if (sentences.length === 0) return compactText(content, 220);

  const ranked = sentences
    .map((sentence) => {
      const sentenceTokens = new Set(tokenize(sentence));
      let overlap = 0;
      for (const token of queryTokens) {
        if (sentenceTokens.has(token)) overlap += 1;
      }
      return {
        sentence,
        overlap,
      };
    })
    .sort((a, b) => b.overlap - a.overlap || b.sentence.length - a.sentence.length);

  return ranked[0]?.sentence || compactText(content, 220);
}

function answerFromFact(query, result) {
  const top = result.finalHits[0];
  if (!top) {
    return {
      answer: "Evidence was not found in the indexed documents.",
      citations: [],
    };
  }

  const sentence = bestSentenceForQuery(query, top.content);
  return {
    answer: `${sentence} ${makeCitation(top)}`.trim(),
    citations: [makeCitation(top)],
  };
}

function answerFromBroadSummary(result) {
  if (!result.broadSummary?.summary) {
    return {
      answer: "Evidence is insufficient to produce a grounded broad summary.",
      citations: [],
    };
  }

  return {
    answer: result.broadSummary.summary,
    citations: result.broadSummary.citations || citationsFromChunks(result.finalHits),
  };
}

export function generateGroundedAnswer(query, retrievalResult) {
  if (
    [
      "recurring_themes",
      "temporal_summary",
      "first_mention",
      "evolution_over_time",
      "comparison",
    ].includes(retrievalResult.analysis.mode)
  ) {
    return answerFromBroadSummary(retrievalResult);
  }

  return answerFromFact(query, retrievalResult);
}
