import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { retrieveCandidates } from "../src/retrieval/retrieval.js";
import { generateGroundedAnswer } from "../src/llm/answering.js";
import { makeCitation } from "../src/indexing/text-utils.js";

const EVAL_FILE = "./eval/questions.json";
const OUTPUT_DIR = "./eval/results";

const REQUEST_DELAY_MS = Number(process.env.DEEPSEEK_REQUEST_DELAY_MS || 1200);
const MAX_RETRIES = Number(process.env.DEEPSEEK_MAX_RETRIES || 4);
const BACKOFF_BASE_MS = Number(process.env.DEEPSEEK_BACKOFF_BASE_MS || 1500);

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeFileTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms, ratio = 0.25) {
  const spread = Math.floor(ms * ratio);
  const delta = Math.floor(Math.random() * (spread * 2 + 1)) - spread;
  return Math.max(0, ms + delta);
}

function isRetryableError(error) {
  const status = error?.status || error?.response?.status || error?.cause?.status;
  return status === 429 || status === 500 || status === 503;
}

async function callDeepSeekWithRetry(openai, payload) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await openai.chat.completions.create(payload);
    } catch (error) {
      lastError = error;

      if (!isRetryableError(error) || attempt === MAX_RETRIES) {
        throw error;
      }

      const backoff = jitter(BACKOFF_BASE_MS * Math.pow(2, attempt));
      console.warn(
        `DeepSeek temporary failure (status=${error?.status || "unknown"}). Retry ${attempt + 1}/${MAX_RETRIES} in ${backoff}ms.`
      );
      await sleep(backoff);
    }
  }

  throw lastError;
}

async function maybeGenerateModelAnswer(query, retrievalResult, openai) {
  if (!process.env.DEEPSEEK_API_KEY || !openai) {
    return generateGroundedAnswer(query, retrievalResult);
  }

  const prompt = [
    `Question: ${query}`,
    "",
    "Retrieved context:",
    retrievalResult.finalHits
      .map(
        (chunk) =>
          `${chunk.content}\nCITATION: ${makeCitation(chunk)}`
      )
      .join("\n\n---\n\n"),
    "",
    retrievalResult.broadSummary?.summary
      ? `Aggregated evidence:\n${retrievalResult.broadSummary.summary}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await callDeepSeekWithRetry(openai, {
      model: "deepseek-chat",
      stream: false,
      messages: [
        {
          role: "system",
          content:
            "Answer only from the provided retrieved context. If evidence is insufficient, say so clearly. Use citations exactly as provided.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    return {
      answer: response.choices[0]?.message?.content || "",
      citations:
        retrievalResult.broadSummary?.citations ||
        retrievalResult.finalHits
          .slice(0, 4)
          .map((chunk) => makeCitation(chunk)),
    };
  } catch (error) {
    console.warn(
      `DeepSeek answer generation failed (${error?.message || "unknown error"}). Falling back to local grounded answers.`
    );
    return generateGroundedAnswer(query, retrievalResult);
  }
}

ensureDir(OUTPUT_DIR);

const questions = JSON.parse(fs.readFileSync(EVAL_FILE, "utf8"));
const results = [];

const openai = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
    })
  : null;

for (const [difficulty, items] of Object.entries(questions)) {
  for (const item of items) {
    const retrievalResult = await retrieveCandidates(item.query, {
      limit: 6,
    });

    const answer = await maybeGenerateModelAnswer(item.query, retrievalResult, openai);

    results.push({
      difficulty,
      id: item.id,
      query: item.query,
      expected_mode: item.expected_mode,
      analysis: retrievalResult.analysis,
      retrieval_mode: retrievalResult.retrievalMode,
      broad_summary: retrievalResult.broadSummary,
      retrieved_chunks: retrievalResult.finalHits.map((chunk) => ({
        citation: makeCitation(chunk),
        source_path: chunk.source_path,
        title: chunk.title,
        doc_type: chunk.doc_type,
        department: chunk.department,
        date: chunk.date,
        updated_at: chunk.updated_at,
        score: chunk.finalScore,
        boost_reasons: chunk.rerankBoostReasons,
        content_preview: chunk.content.slice(0, 240),
      })),
      final_answer: answer.answer,
      citations: answer.citations,
    });

    await sleep(jitter(REQUEST_DELAY_MS));
  }
}

const outputFile = path.join(OUTPUT_DIR, `eval-${safeFileTimestamp()}.json`);
fs.writeFileSync(outputFile, JSON.stringify(results, null, 2), "utf8");

console.log(`Evaluation results written to ${outputFile}`);
