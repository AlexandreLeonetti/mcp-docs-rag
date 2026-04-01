"use client";

import { useEffect, useRef, useState } from "react";
import { Composer } from "./Composer";
import { MessageBubble } from "./MessageBubble";

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Array<{
    id: string;
    label: string;
  }>;
};

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content: "Ask a question about the indexed internal docs. Answers stay grounded in the existing RAG backend.",
  },
];

export function ChatShell() {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = listRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [messages, isLoading]);

  async function handleSubmit() {
    const message = input.trim();
    if (!message || isLoading) {
      return;
    }

    const userMessage: ChatMessage = {
      id: `${Date.now()}-user`,
      role: "user",
      content: message,
    };

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload?.error || "Unable to generate an answer right now.");
      }

      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}-assistant`,
          role: "assistant",
          content: payload.content || payload.answer || "No answer returned.",
          sources: Array.isArray(payload.sources) ? payload.sources : [],
        },
      ]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        {
          id: `${Date.now()}-assistant-error`,
          role: "assistant",
          content:
            error instanceof Error
              ? `Sorry, something went wrong: ${error.message}`
              : "Sorry, something went wrong while contacting the chat API.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="chat-card">
        <header className="chat-header">
          <div>
            <p className="chat-eyebrow">Internal knowledge assistant</p>
            <h1>Internal Docs Chat</h1>
            <p className="chat-subtitle">Simple web chat on top of the existing Postgres-backed RAG flow.</p>
          </div>
        </header>

        <div ref={listRef} className="message-list">
          {messages.map((message) => (
            <MessageBubble
              key={message.id}
              role={message.role}
              content={message.content}
              sources={message.sources}
            />
          ))}

          {isLoading ? (
            <div className="message-row message-row-assistant">
              <div className="message-bubble message-assistant message-loading">
                <p>Thinking...</p>
              </div>
            </div>
          ) : null}
        </div>

        <div className="composer-wrap">
          <Composer value={input} onChange={setInput} onSubmit={handleSubmit} disabled={isLoading} />
        </div>
      </section>
    </main>
  );
}
