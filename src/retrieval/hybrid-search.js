export const HYBRID_WEIGHTS = {
  lexicalWeight: 0.7,
  semanticWeight: 0.3,
};

function normalizeLexicalScore(score, maxScore) {
  if (!maxScore || maxScore <= 0) {
    return 0;
  }

  return Math.max(0, Number(score || 0) / maxScore);
}

function normalizeSemanticScore(score) {
  return Math.max(0, Math.min(1, (Number(score || 0) + 1) / 2));
}

export function combineHybridScore({ lexicalScore, semanticScore, maxLexicalScore, useSemantic }) {
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
