"use client";

import type { KeyboardEvent } from "react";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
};

export function Composer({ value, onChange, onSubmit, disabled = false }: ComposerProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  }

  return (
    <div className="composer-shell">
      <textarea
        className="composer-input"
        placeholder="Ask about internal docs..."
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        rows={1}
      />
      <button className="composer-button" onClick={onSubmit} disabled={disabled || !value.trim()}>
        Send
      </button>
    </div>
  );
}
