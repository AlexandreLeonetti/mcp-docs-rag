import { createEmbeddingProviderFromEnv, getLocalEmbeddingConfig } from "../llm/embeddings.js";
import { cosineSimilarity } from "../indexing/text-utils.js";

export async function getSemanticScores({ query, candidates, indexHasChunkEmbeddings, retrievalDebug }) {
  const localEmbeddingsEnabled = getLocalEmbeddingConfig().enabled;

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

  if (!indexHasChunkEmbeddings) {
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
    retrievalDebug("semantic scoring started");

    const scores = new Map();
    let candidatesWithEmbeddings = 0;

    for (const chunk of candidates) {
      if (!Array.isArray(chunk.embedding) || chunk.embedding.length === 0) {
        continue;
      }

      candidatesWithEmbeddings += 1;
      scores.set(chunk.chunk_id || chunk.chunkId, cosineSimilarity(queryEmbedding, chunk.embedding));
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
