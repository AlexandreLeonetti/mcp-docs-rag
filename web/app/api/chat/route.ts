import "dotenv/config";
import { NextResponse } from "next/server";
import { runChatTurn } from "../../../../src/chat/run-chat-turn.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const INLINE_CITATION_PATTERN = /\[[^\[\]\n]+?\|[^\[\]\n]+?\|[^\[\]\n]+?\]/g;

type SourceItem = {
  id: string;
  label: string;
};

function normalizeText(text: string) {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
}

function extractInlineCitations(answer: string) {
  return (answer.match(INLINE_CITATION_PATTERN) || []).map((citation) => citation.trim());
}

function normalizeSources(citations: unknown, answer: string): SourceItem[] {
  const rawItems = Array.isArray(citations) && citations.length > 0 ? citations : extractInlineCitations(answer);
  const seen = new Set<string>();
  const sources: SourceItem[] = [];

  for (const item of rawItems) {
    const label = String(item || "").trim();
    if (!label || seen.has(label)) {
      continue;
    }

    seen.add(label);
    sources.push({
      id: label,
      label,
    });
  }

  return sources;
}

function stripInlineCitations(answer: string) {
  if (!answer) {
    return "";
  }

  const cleaned = answer.replace(/\s*\[[^\[\]\n]+?\|[^\[\]\n]+?\|[^\[\]\n]+?\]\s*/g, " ");
  return normalizeText(cleaned) || answer.trim();
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const message = String(body?.message || "").trim();

    if (!message) {
      return NextResponse.json({ error: "Message is required." }, { status: 400 });
    }

    const turn = await runChatTurn({
      query: message,
      limit: 5,
    } as any);

    const answer = String(turn.answer || "");
    const sources = normalizeSources(turn.citations, answer);
    const content = stripInlineCitations(answer);

    return NextResponse.json({
      answer,
      content,
      sources,
      citations: turn.citations,
      answerSource: turn.answerSource,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Something went wrong while generating the answer.",
      },
      { status: 500 }
    );
  }
}
