import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Brain } from "lucide-react";
import { THINKING_LEVELS } from "@fusion/core";

/*
FNXC:Chat-ThinkingLevel 2026-07-12-19:30:
FN-7775 only let a user pick a direct chat session's thinking (reasoning-effort) level once, at
session creation, via the New Chat dialog's model-mode picker (CustomModelDropdown's inline
selector). FN-7898 closes that gap with a small `Brain`-icon trigger next to the composer's
attach button that opens a popup listing the six THINKING_LEVELS plus a "Default" (clear/inherit)
option; selecting one persists immediately via PATCH /api/chat/sessions/:id and takes effect on
the session's next send. This mirrors ThemeDropdown.tsx's small-popover interaction pattern
(rootRef + pointerdown outside-close, Escape, aria-haspopup listbox) and reuses
CustomModelDropdown's exact i18n keys for level labels and the default entry, rather than
introducing a parallel thinking-level list.
*/

export interface ChatThinkingLevelControlProps {
  /** Session's current thinkingLevel; null/undefined/empty means "inherit default". */
  level: string | null | undefined;
  /** Called with the newly selected level ("" for the Default/clear option). */
  onChange: (level: string) => void | Promise<void>;
  disabled?: boolean;
}

const THINKING_LEVEL_OPTIONS = ["", ...THINKING_LEVELS] as const;

export function ChatThinkingLevelControl({ level, onChange, disabled = false }: ChatThinkingLevelControlProps) {
  const { t } = useTranslation("app");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const normalizedLevel = level ?? "";
  const isActive = normalizedLevel !== "";
  const listboxId = "chat-thinking-level-listbox";

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  // Close the popup whenever the underlying level changes out from under us
  // (e.g. the active session switched) so it never leaks open across a
  // session switch showing the previous session's options.
  useEffect(() => {
    setOpen(false);
  }, [normalizedLevel]);

  const optionLabel = (value: string): string => {
    if (value === "") {
      return t("modelSelection.thinkingDefault", "Default ({{level}})", { level: "off" });
    }
    return t(`models.options.${value}`, value === "xhigh" ? "Very High" : value.charAt(0).toUpperCase() + value.slice(1));
  };

  const chooseLevel = (value: string) => {
    setOpen(false);
    void onChange(value);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      setOpen(false);
    }
  };

  const handleOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, value: string) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseLevel(value);
    }
  };

  return (
    <div className="chat-thinking-level-root" ref={rootRef}>
      <button
        type="button"
        className={`btn-icon chat-thinking-btn${isActive ? " chat-thinking-btn--active" : ""}`}
        data-testid="chat-thinking-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={t("chat.thinkingLevelButton", "Thinking level")}
        title={t("chat.thinkingLevelButton", "Thinking level")}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={handleTriggerKeyDown}
      >
        <Brain size={16} />
      </button>

      {open ? (
        <div className="chat-thinking-popover" role="presentation">
          <div
            id={listboxId}
            className="chat-thinking-popover-list"
            role="listbox"
            aria-label={t("chat.thinkingLevelButton", "Thinking level")}
          >
            {THINKING_LEVEL_OPTIONS.map((value) => {
              const selected = normalizedLevel === value;
              return (
                <button
                  key={value || "default"}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`chat-thinking-popover-option${selected ? " active" : ""}`}
                  data-testid={`chat-thinking-option-${value || "default"}`}
                  onClick={() => chooseLevel(value)}
                  onKeyDown={(event) => handleOptionKeyDown(event, value)}
                >
                  {optionLabel(value)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
