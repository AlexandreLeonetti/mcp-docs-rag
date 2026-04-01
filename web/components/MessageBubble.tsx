type MessageBubbleProps = {
  role: "user" | "assistant";
  content: string;
};

export function MessageBubble({ role, content }: MessageBubbleProps) {
  return (
    <div className={`message-row ${role === "user" ? "message-row-user" : "message-row-assistant"}`}>
      <div className={`message-bubble ${role === "user" ? "message-user" : "message-assistant"}`}>
        <p>{content}</p>
      </div>
    </div>
  );
}
