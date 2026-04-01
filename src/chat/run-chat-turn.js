import "dotenv/config";
import OpenAI from "openai";
import { searchInternalDocs } from "../retrieval/retrieval.js";
import { generateGroundedAnswer } from "../llm/answering.js";

function createEmptyResult() {
  return {
    analysis: { mode: "fact_lookup", broadQuery: false, filters: {} },
    finalHits: [],
    broadSummary: null,
    debug: null,
  };
}

function createDeepSeekClient() {
  if (!process.env.DEEPSEEK_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: "https://api.deepseek.com",
  });
}

function buildDeepSeekPayload(query, retrievedContext) {
  return {
    model: "deepseek-chat",
    stream: false,
    messages: [
      {
        role: "system",
        content: [
          "You are a helpful internal knowledge assistant.",
          "Answer only from the retrieved documentation.",
          "If the retrieved documentation is insufficient, say so clearly.",
          "For broad questions such as recurring themes, first mention, or evolution over time, only answer if the evidence spans multiple chunks or dates.",
          "Do not ask to search again.",
          "Do not mention tools.",
          "Use the provided CITATION values exactly when citing sources.",
        ].join(" "),
      },
      {
        role: "user",
        content: [`Question: ${query}`, "", "Retrieved documentation:", retrievedContext].join("\n"),
      },
    ],
  };
}

function buildLocalAnswer(query, retrievalResult) {
  const grounded = generateGroundedAnswer(query, retrievalResult || createEmptyResult());

  return {
    answer: grounded.answer,
    citations: grounded.citations || [],
    answerSource: "grounded_local",
  };
}

export async function runChatTurn({
  query,
  retrievalResult = null,
  retrievedContext = null,
  limit = 5,
  debug = false,
  onDeepSeekRequest = null,
  onDeepSeekResponse = null,
  onDeepSeekError = null,
} = {}) {
  const trimmedQuery = String(query || "").trim();

  if (!trimmedQuery) {
    return {
      answer: "Please enter a question.",
      citations: [],
      answerSource: "empty_query",
      retrievalResult: createEmptyResult(),
      retrievedContext: "No relevant results found.",
    };
  }

  let resolvedRetrievalResult = retrievalResult;
  let resolvedRetrievedContext = retrievedContext;

  if (!resolvedRetrievalResult || !resolvedRetrievedContext) {
    const searchResult = await searchInternalDocs(trimmedQuery, { limit, debug });
    resolvedRetrievalResult = searchResult.result;
    resolvedRetrievedContext = searchResult.text;
  }

  const deepSeekClient = createDeepSeekClient();
  if (!deepSeekClient) {
    return {
      ...buildLocalAnswer(trimmedQuery, resolvedRetrievalResult),
      retrievalResult: resolvedRetrievalResult,
      retrievedContext: resolvedRetrievedContext,
    };
  }

  const payload = buildDeepSeekPayload(trimmedQuery, resolvedRetrievedContext);

  if (typeof onDeepSeekRequest === "function") {
    onDeepSeekRequest(payload);
  }

  try {
    const response = await deepSeekClient.chat.completions.create(payload);

    if (typeof onDeepSeekResponse === "function") {
      onDeepSeekResponse(response);
    }

    return {
      answer: response.choices?.[0]?.message?.content || "",
      citations: [],
      answerSource: "deepseek",
      retrievalResult: resolvedRetrievalResult,
      retrievedContext: resolvedRetrievedContext,
    };
  } catch (error) {
    if (typeof onDeepSeekError === "function") {
      onDeepSeekError(error);
    }

    return {
      ...buildLocalAnswer(trimmedQuery, resolvedRetrievalResult),
      retrievalResult: resolvedRetrievalResult,
      retrievedContext: resolvedRetrievedContext,
    };
  }
}
