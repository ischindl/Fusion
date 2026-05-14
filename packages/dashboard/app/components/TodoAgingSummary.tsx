import type { Task } from "@fusion/core";
import type { TodoAgeBucket } from "../utils/todoAging";
import { summarizeTodoAging } from "../utils/todoAging";
import "./TodoAgingSummary.css";

interface TodoAgingSummaryProps {
  tasks: Task[];
  activeBucket: TodoAgeBucket | null;
  onSelectBucket: (bucket: TodoAgeBucket | null) => void;
  dataAsOfMs?: number;
}

const BUCKETS: Array<{ bucket: TodoAgeBucket; label: string; title: string }> = [
  { bucket: "fresh", label: "0–7d", title: "Todo tasks 0–7 days old" },
  { bucket: "aging", label: "8–30d", title: "Todo tasks 8–30 days old" },
  { bucket: "stale", label: "31+d", title: "Todo tasks 31+ days old" },
];

export function TodoAgingSummary({ tasks, activeBucket, onSelectBucket, dataAsOfMs }: TodoAgingSummaryProps) {
  const counts = summarizeTodoAging(tasks, dataAsOfMs);
  if (counts.total === 0) {
    return null;
  }

  return (
    <div className="todo-aging-summary" data-testid="todo-aging-summary">
      {BUCKETS.map(({ bucket, label, title }) => {
        const isActive = activeBucket === bucket;
        return (
          <button
            key={bucket}
            type="button"
            className={`btn btn-sm todo-aging-chip todo-aging-chip--${bucket}${isActive ? " todo-aging-chip--active" : ""}`}
            aria-pressed={isActive}
            title={title}
            onClick={() => onSelectBucket(isActive ? null : bucket)}
            data-testid={`todo-aging-chip-${bucket}`}
          >
            <span>{label}</span>
            <span className="todo-aging-chip-count">{counts[bucket]}</span>
          </button>
        );
      })}
    </div>
  );
}
