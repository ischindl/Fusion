import "./WorkflowSwitcher.css";

import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { BoardWorkflowDefinition } from "../api";
import type { WorkflowStatusCounts } from "./workflowStatusCounts";

export interface WorkflowSwitcherProps {
  workflows: BoardWorkflowDefinition[];
  value: string;
  onChange: (id: string) => void;
  counts: Map<string, WorkflowStatusCounts>;
  label?: string;
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

const ZERO_COUNTS: WorkflowStatusCounts = { todo: 0, inProgress: 0, done: 0 };

function getCounts(counts: Map<string, WorkflowStatusCounts>, workflowId: string): WorkflowStatusCounts {
  return counts.get(workflowId) ?? ZERO_COUNTS;
}

/**
 * FNXC:WorkflowSwitcher 2026-06-20-00:09:
 * The board/list workflow switcher must be a fully rendered themed dropdown rather than a native select so each workflow option can include compact inline Todo, In Progress, and Done counts.
 * The component owns only presentation and accessible dropdown behavior; all status-bucket semantics stay in computeWorkflowStatusCounts so Board and ListView cannot drift.
 *
 * FNXC:WorkflowSwitcher 2026-06-20-00:31:
 * Counts are contextual detail, so the collapsed trigger must stay visually and accessibly scoped to the active workflow name plus chevron.
 * Render Todo, In Progress, and Done counts only while the dropdown is expanded; option rows keep their count text because the listbox is the comparison surface.
 */
export function WorkflowSwitcher({ workflows, value, onChange, counts, label: labelProp }: WorkflowSwitcherProps) {
  const { t } = useTranslation("app");
  const label = labelProp ?? t("workflowSwitcher.label", "Workflow");
  const todoLabel = t("workflowSwitcher.todo", "Todo");
  const inProgressLabel = t("workflowSwitcher.inProgress", "In Progress");
  const doneLabel = t("workflowSwitcher.done", "Done");
  const listboxId = useId();

  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedIndex = useMemo(() => Math.max(0, workflows.findIndex((workflow) => workflow.id === value)), [value, workflows]);
  const selectedWorkflow = workflows[selectedIndex] ?? workflows[0] ?? null;
  const selectedCounts = selectedWorkflow ? getCounts(counts, selectedWorkflow.id) : ZERO_COUNTS;

  const updateDropdownPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const offsetTop = window.visualViewport?.offsetTop ?? 0;
    const offsetLeft = window.visualViewport?.offsetLeft ?? 0;
    const horizontalPadding = 16;
    const verticalPadding = 16;
    const gap = 4;
    const preferredHeight = Math.min(viewportHeight * 0.6, 320);
    const triggerTop = rect.top - offsetTop;
    const triggerBottom = rect.bottom - offsetTop;
    const triggerLeft = rect.left - offsetLeft;
    const spaceBelow = viewportHeight - triggerBottom;
    const spaceAbove = triggerTop;
    const openUpward = spaceBelow < preferredHeight && spaceAbove > spaceBelow;
    const availableHeight = Math.max((openUpward ? spaceAbove : spaceBelow) - verticalPadding - gap, 160);
    const maxHeight = Math.max(Math.min(availableHeight, preferredHeight), 160);
    const width = Math.min(Math.max(rect.width, 240), viewportWidth - horizontalPadding * 2);
    const left = Math.min(Math.max(triggerLeft, horizontalPadding), viewportWidth - horizontalPadding - width) + offsetLeft;
    const top = openUpward
      ? Math.max(verticalPadding + offsetTop, triggerTop - maxHeight - gap + offsetTop)
      : Math.min(triggerBottom + gap + offsetTop, viewportHeight + offsetTop - verticalPadding - maxHeight);

    setDropdownPosition({ top, left, width, maxHeight });
  }, []);

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    setHighlightedIndex(selectedIndex);
    updateDropdownPosition();
  }, [isOpen, selectedIndex, updateDropdownPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handleReposition = () => updateDropdownPosition();
    window.addEventListener("resize", handleReposition);
    window.addEventListener("scroll", handleReposition, true);
    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", handleReposition);
    visualViewport?.addEventListener("scroll", handleReposition);
    return () => {
      window.removeEventListener("resize", handleReposition);
      window.removeEventListener("scroll", handleReposition, true);
      visualViewport?.removeEventListener("resize", handleReposition);
      visualViewport?.removeEventListener("scroll", handleReposition);
    };
  }, [isOpen, updateDropdownPosition]);

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setIsOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !listRef.current) return;
    const highlightedElement = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`);
    if (highlightedElement && typeof highlightedElement.scrollIntoView === "function") {
      highlightedElement.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex, isOpen]);

  const selectWorkflow = useCallback((workflowId: string) => {
    onChange(workflowId);
    setIsOpen(false);
    triggerRef.current?.focus();
  }, [onChange]);

  const handleKeyDown = useCallback((event: KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          setHighlightedIndex((current) => (workflows.length ? (current + 1) % workflows.length : 0));
        }
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          setHighlightedIndex((current) => (workflows.length ? (current - 1 + workflows.length) % workflows.length : 0));
        }
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        if (isOpen) {
          const workflow = workflows[highlightedIndex];
          if (workflow) selectWorkflow(workflow.id);
        } else {
          setIsOpen(true);
        }
        break;
      case "Escape":
        event.preventDefault();
        setIsOpen(false);
        break;
      case "Tab":
        setIsOpen(false);
        break;
    }
  }, [highlightedIndex, isOpen, selectWorkflow, workflows]);

  if (!selectedWorkflow) return null;

  const renderCountBadges = (workflowCounts: WorkflowStatusCounts, variant: "trigger" | "option") => (
    <span className={`workflow-switcher-counts workflow-switcher-counts--${variant}`} aria-hidden="true">
      <span className="workflow-switcher-count workflow-switcher-count--todo" title={`${todoLabel}: ${workflowCounts.todo}`}>{workflowCounts.todo}</span>
      <span className="workflow-switcher-count-separator">·</span>
      <span className="workflow-switcher-count workflow-switcher-count--in-progress" title={`${inProgressLabel}: ${workflowCounts.inProgress}`}>{workflowCounts.inProgress}</span>
      <span className="workflow-switcher-count-separator">·</span>
      <span className="workflow-switcher-count workflow-switcher-count--done" title={`${doneLabel}: ${workflowCounts.done}`}>{workflowCounts.done}</span>
    </span>
  );

  const renderAccessibleCounts = (workflowCounts: WorkflowStatusCounts) => (
    <span className="visually-hidden">
      {t("workflowSwitcher.countsAria", "{{todoLabel}}: {{todo}}, {{inProgressLabel}}: {{inProgress}}, {{doneLabel}}: {{done}}", {
        todoLabel,
        todo: workflowCounts.todo,
        inProgressLabel,
        inProgress: workflowCounts.inProgress,
        doneLabel,
        done: workflowCounts.done,
      })}
    </span>
  );

  const dropdown = isOpen && portalRoot && dropdownPosition
    ? createPortal(
      <div
        ref={dropdownRef}
        id={listboxId}
        className="workflow-switcher-menu"
        role="listbox"
        aria-label={label}
        style={{
          top: dropdownPosition.top,
          left: dropdownPosition.left,
          width: dropdownPosition.width,
          maxHeight: dropdownPosition.maxHeight,
        }}
      >
        <div ref={listRef} className="workflow-switcher-options">
          {workflows.map((workflow, index) => {
            const workflowCounts = getCounts(counts, workflow.id);
            const isSelected = workflow.id === selectedWorkflow.id;
            const isHighlighted = index === highlightedIndex;
            return (
              <button
                key={workflow.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                data-index={index}
                data-testid={`workflow-switcher-option-${workflow.id}`}
                className={`workflow-switcher-option${isSelected ? " workflow-switcher-option--selected" : ""}${isHighlighted ? " workflow-switcher-option--highlighted" : ""}`}
                onMouseEnter={() => setHighlightedIndex(index)}
                onClick={() => selectWorkflow(workflow.id)}
              >
                <span className="workflow-switcher-option-name">{workflow.name}</span>
                {renderCountBadges(workflowCounts, "option")}
                {renderAccessibleCounts(workflowCounts)}
              </button>
            );
          })}
        </div>
      </div>,
      portalRoot,
    )
    : null;

  return (
    <div ref={containerRef} className="workflow-switcher">
      <span className="workflow-switcher-label">{label}</span>
      <button
        ref={triggerRef}
        type="button"
        className="btn workflow-switcher-trigger"
        data-testid="workflow-switcher"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        aria-label={t("workflowSwitcher.triggerAria", "Select workflow. Current workflow: {{name}}", { name: selectedWorkflow.name })}
        onClick={() => setIsOpen((open) => !open)}
        onKeyDown={handleKeyDown}
      >
        <span className="workflow-switcher-trigger-main">
          <span className="workflow-switcher-current-name">{selectedWorkflow.name}</span>
          {isOpen ? renderCountBadges(selectedCounts, "trigger") : null}
          {isOpen ? renderAccessibleCounts(selectedCounts) : null}
        </span>
        <ChevronDown className="workflow-switcher-chevron" aria-hidden="true" />
      </button>
      {dropdown}
    </div>
  );
}
