"use client";

import { useState } from "react";

type MessageBubbleProps = {
  role: "user" | "assistant";
  content: string;
  sources?: Array<{
    id: string;
    label: string;
  }>;
};

export function MessageBubble({ role, content, sources = [] }: MessageBubbleProps) {
  const [showSources, setShowSources] = useState(false);
  const hasSources = role === "assistant" && sources.length > 0;

  return (
    <div className={`message-row ${role === "user" ? "message-row-user" : "message-row-assistant"}`}>
      <div className={`message-bubble ${role === "user" ? "message-user" : "message-assistant"}`}>
        <p>{content}</p>

        {hasSources ? (
          <div className="message-sources">
            <button
              type="button"
              className="sources-toggle"
              onClick={() => setShowSources((current) => !current)}
              aria-expanded={showSources}
            >
              {showSources ? "Hide sources" : "Show sources"}
            </button>

            {showSources ? (
              <div className="sources-panel">
                <ul className="sources-list">
                  {sources.map((source) => (
                    <li key={source.id}>{source.label}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
