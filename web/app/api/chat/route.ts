import "dotenv/config";
import { NextResponse } from "next/server";
import { runChatTurn } from "../../../../src/chat/run-chat-turn.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    });

    return NextResponse.json({
      answer: turn.answer,
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
