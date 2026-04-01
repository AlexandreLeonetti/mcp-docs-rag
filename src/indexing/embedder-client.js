import { createEmbeddingProviderFromEnv, getLocalEmbeddingConfig } from "../llm/embeddings.js";

export async function maybeAttachEmbeddings(chunks) {
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
      chunks.map((chunk) =>
        [chunk.title, chunk.section_heading, chunk.content, chunk.tags?.join(" ")]
          .filter(Boolean)
          .join("\n")
      )
    );

    return {
      providerInfo: {
        enabled: true,
        provider: provider.name,
        model: provider.model,
        dimensions: vectors[0]?.length || null,
        reason: null,
      },
      chunks: chunks.map((chunk, index) => ({
        ...chunk,
        embedding: vectors[index] || null,
      })),
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
