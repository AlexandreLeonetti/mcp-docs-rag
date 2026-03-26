import OpenAI from "openai";

function toBatches(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

export function createEmbeddingProviderFromEnv() {
  const provider = String(process.env.EMBEDDING_PROVIDER || "").trim().toLowerCase();

  if (!provider || provider === "none" || provider === "off") {
    return null;
  }

  if (provider !== "openai") {
    throw new Error(
      `Unsupported EMBEDDING_PROVIDER "${provider}". Supported values: openai, none.`
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  });

  const model = process.env.EMBEDDING_MODEL || "text-embedding-3-small";
  const batchSize = Number(process.env.EMBEDDING_BATCH_SIZE || 32);

  return {
    name: "openai",
    model,
    async embedTexts(texts) {
      const vectors = [];
      for (const batch of toBatches(texts, batchSize)) {
        const response = await client.embeddings.create({
          model,
          input: batch,
        });
        for (const item of response.data) {
          vectors.push(item.embedding);
        }
      }
      return vectors;
    },
    async embedQuery(text) {
      const response = await client.embeddings.create({
        model,
        input: text,
      });
      return response.data[0]?.embedding || null;
    },
  };
}
