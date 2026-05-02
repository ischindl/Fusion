import type { ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { usePluginUiSlots } from "../hooks/usePluginUiSlots";

interface PluginSlotProps {
  /** The slot identifier to render (e.g., "task-detail-tab", "header-action") */
  slotId: string;
  /** Optional project ID for multi-project slot scoping */
  projectId?: string;
  /** Optional plugin IDs to restrict rendering to a subset of matching entries */
  pluginIds?: string[];
}

/**
 * Renders plugin slot registrations for a host surface.
 *
 * Dynamic plugin component loading is not yet available, so this renders a
 * meaningful fallback shell with plugin metadata instead of empty placeholders.
 * Each rendered slot is wrapped in an ErrorBoundary to isolate failures from
 * the parent dashboard UI.
 */
export function PluginSlot({ slotId, projectId, pluginIds }: PluginSlotProps): ReactNode {
  const { getSlotsForId, loading, error } = usePluginUiSlots(projectId);

  // Non-critical failure — no visible UI when loading, errored, or no matching slots
  if (loading || error || !slotId) {
    return null;
  }

  const matchingEntries = getSlotsForId(slotId).filter((entry) =>
    pluginIds && pluginIds.length > 0 ? pluginIds.includes(entry.pluginId) : true,
  );

  if (matchingEntries.length === 0) {
    return null;
  }

  return (
    <ErrorBoundary level="page">
      <>
        {matchingEntries.map((entry, index) => (
          <section
            key={`${entry.pluginId}-${entry.slot.slotId}-${index}`}
            className="card"
            data-plugin-slot
            data-slot-id={entry.slot.slotId}
            data-plugin-id={entry.pluginId}
            data-component-path={entry.slot.componentPath}
            aria-label={entry.slot.label}
          >
            <div className="card-header">
              <span className="card-title">{entry.slot.label}</span>
              <span className="card-id">{entry.pluginId}</span>
            </div>
            <div className="card-meta">
              <span className="detail-metadata-label">Surface</span>
              <code className="detail-source-number">{entry.slot.slotId}</code>
            </div>
            <div className="detail-source-summary">
              <span className="detail-source-label">Component</span>
              <code className="detail-source-number">{entry.slot.componentPath}</code>
            </div>
          </section>
        ))}
      </>
    </ErrorBoundary>
  );
}
