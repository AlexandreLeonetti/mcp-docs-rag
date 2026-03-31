import { env, pipeline } from "@huggingface/transformers";

const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_BATCH_SIZE = 16;

let cachedExtractorPromise = null;
let cachedModelKey = null;

function toBatches(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

function isEnabled(value) {
  return /^(1|true|yes|on)$/i.test(String(value || "").trim());
}

function getBatchSize() {
  const parsed = Number(process.env.LOCAL_EMBEDDING_BATCH_SIZE || DEFAULT_BATCH_SIZE);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BATCH_SIZE;
}

export function getLocalEmbeddingConfig() {
  return {
    enabled: isEnabled(process.env.ENABLE_LOCAL_EMBEDDINGS),
    model: process.env.LOCAL_EMBEDDING_MODEL || DEFAULT_LOCAL_EMBEDDING_MODEL,
    batchSize: getBatchSize(),
  };
}

async function getExtractor(model) {
  if (!cachedExtractorPromise || cachedModelKey !== model) {
    cachedModelKey = model;

    // The model can be downloaded once and then reused from the local cache.
    env.allowLocalModels = true;
    cachedExtractorPromise = pipeline("feature-extraction", model);
  }

  return cachedExtractorPromise;
}

async function embedTextsWithLocalModel(model, texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const extractor = await getExtractor(model);
  const output = [];

  for (const batch of toBatches(texts, getBatchSize())) {
    const tensor = await extractor(batch, {
      pooling: "mean",
      normalize: true,
    });
    output.push(...tensor.tolist());
  }

  return output;
}

export function createEmbeddingProviderFromEnv() {
  const config = getLocalEmbeddingConfig();
  if (!config.enabled) {
    return null;
  }

  return {
    name: "local_transformers",
    model: config.model,
    batchSize: config.batchSize,
    async embedTexts(texts) {
      return embedTextsWithLocalModel(config.model, texts);
    },
    async embedQuery(text) {
      const [embedding] = await embedTextsWithLocalModel(config.model, [text]);
      return embedding || null;
    },
  };
}
