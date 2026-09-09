import "./ProjectSelector.css";
import { useState, useCallback, useRef, useEffect, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Check,
  Folder,
  Grid3X3,
  Search,
  Clock,
  Star,
  X,
} from "lucide-react";
import type { ProjectInfo } from "../api";
import type { ProjectStatus } from "@fusion/core";
import { getTrailingPath } from "../utils/pathDisplay";
import { getProjectStatusConfig, isInitializingStatus } from "../utils/projectStatusConfig";
import { useProjectBookmarks } from "../hooks/useProjectBookmarks";

export interface ProjectSelectorProps {
  projects: ProjectInfo[];
  currentProject: ProjectInfo | null;
  onSelect?: (project: ProjectInfo) => void;
  /** Optional in picker hosts (transfer modal) that have no project overview to navigate to. */
  onViewAll?: () => void;
  recentProjectIds?: string[];
  allowSingleProject?: boolean;
  viewAllLabel?: string;
  /*
  FNXC:CrossProjectHandoff 2026-09-09-05:03 (RUFU-203):
  Transfer-modal picker options. All optional so the existing header switcher is byte-for-byte
  unchanged: `triggerLabel` replaces the current-project trigger text with a picker prompt, and
  `getDisabledReason` marks entries the host cannot accept (cross-node remote projects for a
  transfer) — they render disabled with the reason visible, never silently hidden, so the operator
  sees the target exists but learns WHY it cannot receive a copy. Omitting `onViewAll` drops the
  "View All Projects" footer row from a picker that has no overview to navigate to.
  */
  triggerLabel?: string;
  getDisabledReason?: (project: ProjectInfo) => string | undefined;
}

/**
 * HighlightMatch — Renders text with matching substring highlighted (bold + accent underline).
 * Used to show which part of a project name/path matches the autocomplete query.
 */
function HighlightMatch({
  text,
  query,
}: {
  text: string;
  query: string;
}): ReactNode {
  if (!query.trim()) return <>{text}</>;

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);

  if (matchIndex === -1) return <>{text}</>;

  const before = text.slice(0, matchIndex);
  const match = text.slice(matchIndex, matchIndex + query.length);
  const after = text.slice(matchIndex + query.length);

  return (
    <>
      {before}
      <mark className="project-selector__highlight">{match}</mark>
      {after}
    </>
  );
}

/**
 * ProjectSelector - Project switcher dropdown with autocomplete/type-ahead
 * 
 * Features:
 * - Dropdown trigger showing current project name + chevron
 * - Always-visible search input with type-ahead filtering
 * - Text highlighting showing matched portions of project names/paths
 * - Dropdown menu with project list, status icons, "View All Projects" option
 * - Keyboard navigation: arrow keys, enter to select, escape to close
 * - Recent projects section (last 3 accessed)
 * - Bookmarked projects section (star toggle, persisted in localStorage)
 * - Exact match detection: auto-highlights and Enter-selects the exact match
 * - No matches state with clear messaging
 */
export function ProjectSelector({
  projects,
  currentProject,
  onSelect,
  onViewAll,
  recentProjectIds = [],
  allowSingleProject = false,
  viewAllLabel,
  triggerLabel,
  getDisabledReason,
}: ProjectSelectorProps) {
  const { t } = useTranslation("app");
  /*
   * FNXC:ProjectSelector 2026-06-20-20:51:
   * The trigger fallback must remain readable when translation fixtures omit the optional project-selector key; provide the English default at the component seam instead of leaking the i18n key into the header.
   */
  const projectsLabel = t("projectSelector.projects", "Projects");
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const itemRefs = useRef<Map<number, HTMLButtonElement>>(new Map());
  const { bookmarkedIds, toggleBookmark, isBookmarked } = useProjectBookmarks();

  // Close dropdown on outside click
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
        setSearchQuery("");
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  // Close on escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        setSearchQuery("");
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  // Focus search input when dropdown opens (always visible for autocomplete)
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [isOpen]);

  // Get recent projects
  const recentProjects = useMemo(() => {
    return recentProjectIds
      .map((id) => projects.find((p) => p.id === id))
      .filter((p): p is ProjectInfo => p !== undefined && p.id !== currentProject?.id && !getDisabledReason?.(p))
      .slice(0, 3);
  }, [recentProjectIds, projects, currentProject, getDisabledReason]);

  // Filter projects based on search
  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const query = searchQuery.toLowerCase();
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.path.toLowerCase().includes(query)
    );
  }, [projects, searchQuery]);

  // Detect exact match (case-insensitive name match)
  const exactMatch = useMemo((): ProjectInfo | null => {
    if (!searchQuery.trim()) return null;
    const query = searchQuery.toLowerCase();
    // Exclude current project — it's not shown in the dropdown
    const candidates = filteredProjects.filter(
      (p) => p.id !== currentProject?.id && !getDisabledReason?.(p)
    );
    const nameMatches = candidates.filter(
      (p) => p.name.toLowerCase() === query
    );
    if (nameMatches.length === 1) return nameMatches[0];
    return null;
  }, [filteredProjects, searchQuery, currentProject]);

  // Organize projects for display: bookmarked first, then recent, then others
  const displayProjects = useMemo(() => {
    const recentIds = new Set(recentProjects.map((p) => p.id));
    const currentId = currentProject?.id;
    const hasSearch = Boolean(searchQuery.trim());

    // Bookmarked projects (excluding current). Disabled-by-host entries are legacy/local
    // affordances, so a host-marked-disabled project never belongs in these sections.
    const bookmarked = hasSearch
      ? []
      : filteredProjects.filter(
          (p) =>
            p.id !== currentId &&
            bookmarkedIds.has(p.id) &&
            !recentIds.has(p.id) &&
            !getDisabledReason?.(p)
        );

    // Exclude current, bookmarked, and recent from "others" only when those
    // sections are visible. Search mode surfaces every matching project here.
    const bookmarkedAndRecentIds = new Set([
      ...bookmarked.map((p) => p.id),
      ...(hasSearch ? [] : recentIds),
    ]);
    const others = filteredProjects.filter(
      (p) => p.id !== currentId && !bookmarkedAndRecentIds.has(p.id)
    );

    return {
      bookmarked,
      recent: hasSearch ? [] : recentProjects,
      others,
    };
  }, [filteredProjects, recentProjects, currentProject, searchQuery, bookmarkedIds]);

  // Calculate total items for keyboard navigation
  const totalItems = useMemo(() => {
    const bookmarkedCount = displayProjects.bookmarked.length;
    const recentCount = displayProjects.recent.length;
    const othersCount = displayProjects.others.length;
    /* A picker host without onViewAll has no footer row, so no fourth keyboard slot. */
    const viewAllCount = onViewAll ? 1 : 0;
    return bookmarkedCount + recentCount + othersCount + viewAllCount;
  }, [displayProjects, onViewAll]);

  // Handle keyboard navigation within dropdown
  const handleDropdownKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev < totalItems - 1 ? prev + 1 : 0
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setHighlightedIndex((prev) =>
            prev > 0 ? prev - 1 : totalItems - 1
          );
          break;
        case "Enter":
          e.preventDefault();
          if (highlightedIndex >= 0) {
            const bookmarkedCount = displayProjects.bookmarked.length;
            const recentCount = displayProjects.recent.length;
            const othersCount = displayProjects.others.length;
            const highlightedProject: ProjectInfo | null =
              highlightedIndex < bookmarkedCount
                ? displayProjects.bookmarked[highlightedIndex]
                : highlightedIndex < bookmarkedCount + recentCount
                  ? displayProjects.recent[highlightedIndex - bookmarkedCount]
                  : highlightedIndex < bookmarkedCount + recentCount + othersCount
                    ? displayProjects.others[highlightedIndex - bookmarkedCount - recentCount]
                    : null;
            if (highlightedProject) {
              /* A disabled entry (cross-node transfer target) is a no-op that keeps the dropdown open. */
              if (getDisabledReason?.(highlightedProject)) break;
              onSelect?.(highlightedProject);
            } else if (onViewAll) {
              onViewAll();
            }
            setIsOpen(false);
            setSearchQuery("");
          } else if (exactMatch) {
            // Auto-select exact match on Enter when nothing is highlighted
            onSelect?.(exactMatch);
            setIsOpen(false);
            setSearchQuery("");
          }
          break;
        case "Home":
          e.preventDefault();
          setHighlightedIndex(0);
          break;
        case "End":
          e.preventDefault();
          setHighlightedIndex(totalItems - 1);
          break;
      }
    },
    [highlightedIndex, totalItems, displayProjects, onSelect, onViewAll, exactMatch, getDisabledReason]
  );

  // Auto-highlight first result when filtering (type-ahead behavior)
  useEffect(() => {
    if (isOpen && searchQuery.trim()) {
      if (exactMatch) {
        // Auto-highlight the exact match item
        const bookmarkedCount = displayProjects.bookmarked.length;
        const recentCount = displayProjects.recent.length;
        const matchIdx = displayProjects.others.findIndex(
          (p) => p.id === exactMatch.id
        );
        if (matchIdx >= 0) {
          setHighlightedIndex(bookmarkedCount + recentCount + matchIdx);
        }
      } else if (displayProjects.others.length > 0) {
        // Highlight first item in others section
        setHighlightedIndex(displayProjects.bookmarked.length + displayProjects.recent.length);
      } else {
        setHighlightedIndex(-1);
      }
    } else if (isOpen && !searchQuery.trim()) {
      setHighlightedIndex(-1);
    }
  }, [isOpen, searchQuery, exactMatch, displayProjects]);

  // Scroll highlighted item into view for keyboard navigation
  useEffect(() => {
    if (highlightedIndex < 0) return;
    const el = itemRefs.current.get(highlightedIndex);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [highlightedIndex]);

  // Handle project selection
  const handleSelectProject = useCallback(
    (project: ProjectInfo) => {
      /* Disabled entries (e.g. cross-node transfer targets) never fire a selection. */
      if (getDisabledReason?.(project)) return;
      onSelect?.(project);
      setIsOpen(false);
      setSearchQuery("");
    },
    [onSelect, getDisabledReason]
  );

  // Handle view all
  const handleViewAll = useCallback(() => {
    onViewAll?.();
    setIsOpen(false);
    setSearchQuery("");
  }, [onViewAll]);

  // Toggle dropdown
  const toggleDropdown = useCallback(() => {
    setIsOpen((prev) => {
      if (!prev) {
        // Opening — always clear search for a fresh type-ahead
        setSearchQuery("");
      }
      return !prev;
    });
  }, []);

  // Render status icon
  const renderStatusIcon = (status: ProjectStatus) => {
    const config = getProjectStatusConfig(status);
    const Icon = config.icon;
    return (
      <Icon
        size={14}
        style={{ color: config.color }}
        className={isInitializingStatus(status) ? "animate-spin" : ""}
      />
    );
  };

  // Render bookmark star toggle (span to avoid nested <button> inside listbox items)
  const renderBookmarkToggle = (projectId: string) => {
    const bookmarked = isBookmarked(projectId);
    return (
      <span
        role="button"
        tabIndex={0}
        className={`project-selector__bookmark ${bookmarked ? "bookmarked" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          toggleBookmark(projectId);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.stopPropagation();
            e.preventDefault();
            toggleBookmark(projectId);
          }
        }}
        aria-label={bookmarked ? t("projectSelector.removeBookmark", "Remove bookmark") : t("projectSelector.addBookmark", "Bookmark project")}
        data-testid={`bookmark-toggle-${projectId}`}
      >
        <Star
          size={14}
          fill={bookmarked ? "currentColor" : "none"}
        />
      </span>
    );
  };

  // Standalone project switching stays hidden in single/no-project contexts unless
  // a host uses the trigger as an explicit Manage Projects affordance.
  if (!allowSingleProject && projects.length <= 1) {
    return null;
  }

  return (
    <div className="project-selector" ref={dropdownRef}>
      {/* Trigger button */}
      <button
        ref={triggerRef}
        className={`project-selector__trigger ${isOpen ? "open" : ""}`}
        onClick={toggleDropdown}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={t("projectSelector.ariaLabel", "Select project")}
        title={currentProject?.name ? t("projectSelector.switchProjectTitle", "Switch project (current: {{name}})", { name: currentProject.name }) : t("projectSelector.projectsTitle", "Projects")}
        data-testid="project-selector-trigger"
      >
        <Folder size={16} className="project-selector__trigger-icon" />
        <span className="project-selector__trigger-text">
          {triggerLabel ?? (currentProject?.name || projectsLabel)}
        </span>
        <ChevronDown
          size={14}
          className={`project-selector__trigger-chevron ${isOpen ? "rotate" : ""}`}
        />
      </button>

      {/* Dropdown menu */}
      {isOpen && (
        <div
          className="project-selector__dropdown"
          role="listbox"
          aria-label={projectsLabel}
          onKeyDown={handleDropdownKeyDown}
          data-testid="project-selector-dropdown"
        >
          {/* Search input — always visible for autocomplete/type-ahead */}
          <div className="project-selector__search">
            <Search size={14} className="project-selector__search-icon" />
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t("projectSelector.searchPlaceholder", "Search projects...")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="project-selector__search-input"
              data-testid="project-selector-search-input"
              aria-label={t("projectSelector.searchAriaLabel", "Type to search projects")}
            />
            {searchQuery && (
              <button
                className="project-selector__search-clear"
                onClick={() => setSearchQuery("")}
                aria-label={t("projectSelector.clearSearch", "Clear search")}
              >
                <X size={12} />
              </button>
            )}
          </div>

          {/* Exact match indicator */}
          {exactMatch && (
            <div className="project-selector__exact-match" data-testid="project-selector-exact-match">
              {t("projectSelector.exactMatch", "Exact match — press Enter to select")}
            </div>
          )}

          {/* Bookmarked projects section */}
          {displayProjects.bookmarked.length > 0 && (
            <div className="project-selector__section">
              <div className="project-selector__section-header">
                <Star size={12} fill="currentColor" />
                <span>{t("projectSelector.bookmarked", "Bookmarked")}</span>
              </div>
              {displayProjects.bookmarked.map((project, index) => (
                <button
                  key={project.id}
                  ref={(el) => {
                    if (el) itemRefs.current.set(index, el);
                    else itemRefs.current.delete(index);
                  }}
                  className={`project-selector__item ${
                    highlightedIndex === index ? "highlighted" : ""
                  }`}
                  onClick={() => handleSelectProject(project)}
                  role="option"
                  aria-selected={currentProject?.id === project.id}
                >
                  {renderStatusIcon(project.status)}
                  <span className="project-selector__item-name">
                    {project.name}
                  </span>
                  {renderBookmarkToggle(project.id)}
                  {currentProject?.id === project.id && (
                    <Check size={14} className="project-selector__item-check" />
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Recent projects section */}
          {displayProjects.recent.length > 0 && (
            <div className="project-selector__section">
              <div className="project-selector__section-header">
                <Clock size={12} />
                <span>{t("projectSelector.recent", "Recent")}</span>
              </div>
              {displayProjects.recent.map((project, index) => {
                const actualIndex = displayProjects.bookmarked.length + index;
                return (
                  <button
                    key={project.id}
                    ref={(el) => {
                      if (el) itemRefs.current.set(actualIndex, el);
                      else itemRefs.current.delete(actualIndex);
                    }}
                    className={`project-selector__item ${
                      highlightedIndex === actualIndex ? "highlighted" : ""
                    }`}
                    onClick={() => handleSelectProject(project)}
                    role="option"
                    aria-selected={currentProject?.id === project.id}
                  >
                    {renderStatusIcon(project.status)}
                    <span className="project-selector__item-name">
                      {project.name}
                    </span>
                    {renderBookmarkToggle(project.id)}
                    {currentProject?.id === project.id && (
                      <Check size={14} className="project-selector__item-check" />
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* All projects section */}
          <div className="project-selector__section">
            {(displayProjects.bookmarked.length > 0 || displayProjects.recent.length > 0) && (
              <div className="project-selector__section-header">
                <Folder size={12} />
                <span>{t("projectSelector.allProjects", "All Projects")}</span>
              </div>
            )}

            {displayProjects.others.length === 0 && searchQuery ? (
              <div className="project-selector__no-results" data-testid="project-selector-no-results">
                <Search size={14} className="project-selector__no-results-icon" />
                <span>
                  {t("projectSelector.noResults", "No projects match \"{{query}}\"", { query: searchQuery })}
                </span>
              </div>
            ) : (
              displayProjects.others.map((project, index) => {
                const actualIndex = displayProjects.bookmarked.length + displayProjects.recent.length + index;
                const isExactMatch = exactMatch?.id === project.id;
                /* Host-marked entries (cross-node transfer targets) render disabled WITH the reason
                   so the operator learns why the visible target cannot receive the copy. */
                const disabledReason = getDisabledReason?.(project);
                return (
                  <button
                    key={project.id}
                    ref={(el) => {
                      if (el) itemRefs.current.set(actualIndex, el);
                      else itemRefs.current.delete(actualIndex);
                    }}
                    className={`project-selector__item ${
                      highlightedIndex === actualIndex ? "highlighted" : ""
                    } ${isExactMatch ? "exact-match" : ""} ${disabledReason ? "project-selector__item--disabled" : ""}`}
                    onClick={() => handleSelectProject(project)}
                    role="option"
                    disabled={Boolean(disabledReason)}
                    aria-disabled={Boolean(disabledReason)}
                    aria-selected={currentProject?.id === project.id}
                    data-testid={`project-selector-item-${project.id}`}
                  >
                    {renderStatusIcon(project.status)}
                    <div className="project-selector__item-info">
                      <span className="project-selector__item-name">
                        <HighlightMatch text={project.name} query={searchQuery} />
                      </span>
                      {project.path && (
                        <span className="project-selector__item-path">
                          <HighlightMatch
                            text={getTrailingPath(project.path, 2)}
                            query={searchQuery}
                          />
                        </span>
                      )}
                    </div>
                    {isExactMatch && (
                      <span className="project-selector__exact-badge">
                        {t("projectSelector.exact", "Exact")}
                      </span>
                    )}
                    {disabledReason && (
                      <span className="project-selector__item-disabled-reason" title={disabledReason}>
                        {disabledReason}
                      </span>
                    )}
                    {renderBookmarkToggle(project.id)}
                    {currentProject?.id === project.id && (
                      <Check size={14} className="project-selector__item-check" />
                    )}
                  </button>
                );
              })
            )}
          </div>

          {/* View All option — omitted in picker hosts that pass no onViewAll. */}
          {onViewAll && (
          <div className="project-selector__footer">
            <button
              ref={(el) => {
                const viewAllIndex = totalItems - 1;
                if (el) itemRefs.current.set(viewAllIndex, el);
                else itemRefs.current.delete(viewAllIndex);
              }}
              className={`project-selector__view-all ${
                highlightedIndex === totalItems - 1 ? "highlighted" : ""
              }`}
              onClick={handleViewAll}
              data-testid="manage-projects-action"
            >
              <Grid3X3 size={14} />
              <span>{viewAllLabel ?? t("projectSelector.viewAll", "View All Projects")}</span>
            </button>
          </div>
          )}
        </div>
      )}
    </div>
  );
}
