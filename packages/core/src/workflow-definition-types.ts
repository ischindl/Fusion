import type { WorkflowIr } from "./workflow-ir-types.js";

/** Editor layout position for a single workflow IR node. Persisted separately
 *  from the IR because the v1 IR contract deliberately excludes node geometry. */
export interface WorkflowNodeLayout {
  x: number;
  y: number;
}

/** A named, persisted workflow authored as a WorkflowIr graph plus editor layout. */
export interface WorkflowDefinition {
  /** Unique identifier (e.g., "WF-001"). */
  id: string;
  /** Display name. */
  name: string;
  /** Short description for UI display. */
  description: string;
  /** The validated workflow graph (v1 IR contract). */
  ir: WorkflowIr;
  /** Editor node positions keyed by IR node id. May be empty (auto-layout). */
  layout: Record<string, WorkflowNodeLayout>;
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** ISO-8601 timestamp of last update. */
  updatedAt: string;
}

/** Input for creating a workflow definition. */
export interface WorkflowDefinitionInput {
  name: string;
  description?: string;
  /** Workflow graph; validated via parseWorkflowIr on write. */
  ir: WorkflowIr;
  layout?: Record<string, WorkflowNodeLayout>;
}

/** Partial update for an existing workflow definition. */
export interface WorkflowDefinitionUpdate {
  name?: string;
  description?: string;
  ir?: WorkflowIr;
  layout?: Record<string, WorkflowNodeLayout>;
}
