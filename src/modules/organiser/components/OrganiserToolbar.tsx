import * as React from "react";
import { OrganiserPreset, OrganiserPresetId } from "../presets/organiserPresets";
import { WeeklyVisibleType, WeeklyVisibleTypeState } from "./weekly-organiser-types";

type PopoverId = "filter" | "group" | "sort" | null;

type ToolbarOption = {
  id: string;
  label: string;
};

export type OrganiserToolbarCalendar = {
  isOpen: boolean;
  isTimeRowVisible: boolean;
  isTimeBasedPreset: boolean;
  startDateValue: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  toggleRef: React.RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  onGotoToday: () => void;
  onClearDate: () => void;
};

export type OrganiserToolbarWeekNav = {
  onPrevWeek: () => void;
  onNextWeek: () => void;
  onResetWeek: () => void;
  weekRangeDisplay: string;
};

export type OrganiserToolbarPopovers = {
  filterButtonRef: React.RefObject<HTMLButtonElement | null>;
  filterPopoverRef: React.RefObject<HTMLDivElement | null>;
  groupButtonRef: React.RefObject<HTMLButtonElement | null>;
  groupPopoverRef: React.RefObject<HTMLDivElement | null>;
  sortButtonRef: React.RefObject<HTMLButtonElement | null>;
  sortPopoverRef: React.RefObject<HTMLDivElement | null>;
  activePopover: PopoverId;
  onToggle: (next: Exclude<PopoverId, null>) => void;
  showTimeControls: boolean;
  onToggleShowTimeControls: (next: boolean) => void;
  isWeeklyPreset: boolean;
  weeklyVisibleTypes: WeeklyVisibleTypeState;
  onToggleWeeklyType: (type: WeeklyVisibleType) => void;
  groupOptions: ToolbarOption[];
  groupBy: string;
  onGroupChange: (next: string) => void;
  sortOptions: ToolbarOption[];
  sortBy: string;
  onSortChange: (next: string) => void;
  isFilterActive: boolean;
  isGroupActive: boolean;
  isSortActive: boolean;
};

type OrganiserToolbarProps = {
  topbarRef: React.RefObject<HTMLDivElement | null>;
  presets: OrganiserPreset[];
  activePresetId: OrganiserPresetId;
  onPresetChange: (next: OrganiserPresetId) => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  calendar: OrganiserToolbarCalendar;
  weekNav: OrganiserToolbarWeekNav;
  onSendShoppingList?: () => void;
  isRecipePreset: boolean;
  isReviewOpen: boolean;
  onToggleReview: () => void;
  popovers: OrganiserToolbarPopovers;
};

function renderOrganiserToolbar({
  topbarRef,
  presets,
  activePresetId,
  onPresetChange,
  searchQuery,
  onSearchChange,
  calendar,
  weekNav,
  onSendShoppingList,
  isRecipePreset,
  isReviewOpen,
  onToggleReview,
  popovers,
}: OrganiserToolbarProps): React.JSX.Element {
  const {
    isOpen: isCalendarOpen,
    isTimeRowVisible,
    isTimeBasedPreset,
    startDateValue,
    inputRef: calendarInputRef,
    popoverRef: calendarPopoverRef,
    toggleRef: calendarToggleRef,
    onToggle: onToggleCalendar,
    onGotoToday,
    onClearDate,
  } = calendar;
  const { onPrevWeek, onNextWeek, onResetWeek, weekRangeDisplay } = weekNav;
  const {
    filterButtonRef,
    filterPopoverRef,
    groupButtonRef,
    groupPopoverRef,
    sortButtonRef,
    sortPopoverRef,
    activePopover,
    onToggle: onTogglePopover,
    showTimeControls,
    onToggleShowTimeControls,
    isWeeklyPreset,
    weeklyVisibleTypes,
    onToggleWeeklyType,
    groupOptions,
    groupBy,
    onGroupChange,
    sortOptions,
    sortBy,
    onSortChange,
    isFilterActive,
    isGroupActive,
    isSortActive,
  } = popovers;
  return (
    <div className="organiser-topbar" ref={topbarRef}>
		<select
			id="preset-select"
			className="topbar-select"
			aria-label="Organiser preset"
        value={activePresetId}
        onChange={(event) => onPresetChange(event.target.value as OrganiserPresetId)}
      >
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
      </select>

      <input
        id="board-search"
        className="topbar-input"
        type="search"
        placeholder="Search..."
        value={searchQuery}
        onChange={(event) => onSearchChange(event.target.value)}
      />

      {isTimeRowVisible && (
        <div className="week-nav">
          <button
            type="button"
            className="week-nav-btn"
            onClick={onPrevWeek}
            aria-label="Previous week"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button
            type="button"
            className="week-nav-btn"
            onClick={onResetWeek}
          >
            Today
          </button>
          <div className="week-nav-calendar">
            <button
              ref={calendarToggleRef}
              className="week-nav-btn"
              aria-label="Choose week"
              onClick={onToggleCalendar}
              type="button"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
              </svg>
            </button>
            {isCalendarOpen && (
              <div className="calendar-popover" ref={calendarPopoverRef}>
                <input
                  ref={calendarInputRef}
                  className="calendar-input"
                  type="text"
                  aria-label="Choose week"
                  value={startDateValue}
                  readOnly
                />
                <div className="pika-footer">
                  <button type="button" className="pika-footer-btn" onClick={onGotoToday}>
                    Today
                  </button>
                  <button type="button" className="pika-footer-btn" onClick={onClearDate}>
                    Clear
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            type="button"
            className="week-nav-btn"
            onClick={onNextWeek}
            aria-label="Next week"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
          <span
            className="week-range"
            // @ts-expect-error elementtiming is a valid Element Timing API attribute.
            elementtiming="mep:planner-week-range"
          >
            {weekRangeDisplay}
          </span>
        </div>
      )}

      <div className="topbar-actions">
        {onSendShoppingList && (
          <div className="topbar-action">
            <button
              className="topbar-icon-btn"
              type="button"
              title="Build shopping list"
              aria-label="Build shopping list"
              onClick={onSendShoppingList}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="9" cy="21" r="1" />
                <circle cx="20" cy="21" r="1" />
                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
              </svg>
            </button>
          </div>
        )}
        {isRecipePreset && (
          <div className="topbar-action">
            <button
              className={`topbar-icon-btn${isReviewOpen ? " is-active" : ""}`}
              type="button"
              title="Review week"
              aria-label="Review week"
              aria-expanded={isReviewOpen}
              onClick={onToggleReview}
            >
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                <path d="m9 14 2 2 4-4" />
              </svg>
            </button>
          </div>
        )}
        <div className="topbar-action">
          <button
            ref={filterButtonRef}
            className={`topbar-icon-btn${isFilterActive ? " is-active" : ""}`}
            type="button"
            title="Filter"
            aria-label="Filter"
            aria-expanded={activePopover === "filter"}
            onClick={() => onTogglePopover("filter")}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="21" x2="14" y1="4" y2="4" />
              <line x1="10" x2="3" y1="4" y2="4" />
              <line x1="21" x2="12" y1="12" y2="12" />
              <line x1="8" x2="3" y1="12" y2="12" />
              <line x1="21" x2="16" y1="20" y2="20" />
              <line x1="12" x2="3" y1="20" y2="20" />
              <circle cx="12" cy="4" r="2" />
              <circle cx="10" cy="12" r="2" />
              <circle cx="14" cy="20" r="2" />
            </svg>
          </button>
          {activePopover === "filter" && (
            <div ref={filterPopoverRef} className="topbar-popover">
              {isTimeBasedPreset && (
                <label className="topbar-toggle">
                  <input
                    type="checkbox"
                    checked={showTimeControls}
                    onChange={(event) => onToggleShowTimeControls(event.target.checked)}
                  />
                  <span>Show date row</span>
                </label>
              )}
              {isWeeklyPreset && (
                <>
                  <div className="topbar-popover__section-label">Show types</div>
                  <label className="topbar-toggle">
                    <input
                      type="checkbox"
                      checked={weeklyVisibleTypes.recipe}
                      onChange={() => onToggleWeeklyType("recipe")}
                    />
                    <span>Meals</span>
                  </label>
                  <label className="topbar-toggle">
                    <input
                      type="checkbox"
                      checked={weeklyVisibleTypes.exercise}
                      onChange={() => onToggleWeeklyType("exercise")}
                    />
                    <span>Exercise</span>
                  </label>
                  <label className="topbar-toggle">
                    <input
                      type="checkbox"
                      checked={weeklyVisibleTypes.task}
                      onChange={() => onToggleWeeklyType("task")}
                    />
                    <span>Tasks</span>
                  </label>
                  <label className="topbar-toggle">
                    <input
                      type="checkbox"
                      checked={weeklyVisibleTypes.reminder}
                      onChange={() => onToggleWeeklyType("reminder")}
                    />
                    <span>Reminders</span>
                  </label>
                </>
              )}
            </div>
          )}
        </div>
        <div className="topbar-action">
          <button
            ref={groupButtonRef}
            className={`topbar-icon-btn${isGroupActive ? " is-active" : ""}`}
            type="button"
            title="Group"
            aria-label="Group"
            aria-expanded={activePopover === "group"}
            onClick={() => onTogglePopover("group")}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="12 2 2 7 12 12 22 7 12 2" />
              <polyline points="2 17 12 22 22 17" />
              <polyline points="2 12 12 17 22 12" />
            </svg>
          </button>
          {activePopover === "group" && (
            <div ref={groupPopoverRef} className="topbar-popover">
              {groupOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`topbar-option${groupBy === option.id ? " is-active" : ""}`}
                  onClick={() => onGroupChange(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="topbar-action">
          <button
            ref={sortButtonRef}
            className={`topbar-icon-btn${isSortActive ? " is-active" : ""}`}
            type="button"
            title="Sort"
            aria-label="Sort"
            aria-expanded={activePopover === "sort"}
            onClick={() => onTogglePopover("sort")}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m21 16-4 4-4-4" />
              <path d="M17 20V4" />
              <path d="m3 8 4-4 4 4" />
              <path d="M7 4v16" />
            </svg>
          </button>
          {activePopover === "sort" && (
            <div ref={sortPopoverRef} className="topbar-popover">
              {sortOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`topbar-option${sortBy === option.id ? " is-active" : ""}`}
                  onClick={() => onSortChange(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function OrganiserToolbar(props: OrganiserToolbarProps): React.JSX.Element {
	return renderOrganiserToolbar(props);
}
