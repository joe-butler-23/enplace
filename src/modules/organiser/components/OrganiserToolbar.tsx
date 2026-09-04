import * as React from "react";
import { usePikadayDatePicker } from "../hooks/usePikadayDatePicker";
import {
  addCalendarDays,
  calendarWeekOffset,
  dateFromIso,
  formatIsoDate,
  formatPlannerDate,
  startOfIsoWeek,
} from "../utils/scheduled-dates";

type PopoverId = "filter" | "sort" | null;

type ToolbarOption = {
  id: string;
  label: string;
};

export type OrganiserToolbarCalendar = {
	isOpen: boolean;
	isTimeRowVisible: boolean;
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
  sortButtonRef: React.RefObject<HTMLButtonElement | null>;
  sortPopoverRef: React.RefObject<HTMLDivElement | null>;
  activePopover: PopoverId;
  onToggle: (next: Exclude<PopoverId, null>) => void;
  showTimeControls: boolean;
  onToggleShowTimeControls: (next: boolean) => void;
	sortOptions: ToolbarOption[];
  sortBy: string;
  onSortChange: (next: string) => void;
  isFilterActive: boolean;
	isSortActive: boolean;
};

export type OrganiserToolbarProps = {
  topbarRef: React.RefObject<HTMLDivElement | null>;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  calendar: OrganiserToolbarCalendar;
  weekNav: OrganiserToolbarWeekNav;
  onSendShoppingList?: () => void;
	isReviewOpen: boolean;
  onToggleReview: () => void;
  popovers: OrganiserToolbarPopovers;
};

export function OrganiserToolbar({
  topbarRef,
  searchQuery,
  onSearchChange,
  calendar,
  weekNav,
  onSendShoppingList,
  isReviewOpen,
  onToggleReview,
  popovers,
}: OrganiserToolbarProps): React.JSX.Element {
  const {
    isOpen: isCalendarOpen,
    isTimeRowVisible,
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
    sortButtonRef,
    sortPopoverRef,
    activePopover,
    onToggle: onTogglePopover,
    showTimeControls,
    onToggleShowTimeControls,
    sortOptions,
    sortBy,
    onSortChange,
    isFilterActive,
    isSortActive,
  } = popovers;
  return (
    <div className="organiser-topbar" ref={topbarRef}>
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
				<label className="topbar-toggle">
                  <input
                    type="checkbox"
                    checked={showTimeControls}
                    onChange={(event) => onToggleShowTimeControls(event.target.checked)}
                  />
                  <span>Show date row</span>
				</label>
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


const SORT_OPTIONS = [
  { id: "default", label: "Default" },
  { id: "title-asc", label: "Title A-Z" },
  { id: "title-desc", label: "Title Z-A" },
  { id: "added-desc", label: "Added (newest)" },
  { id: "added-asc", label: "Added (oldest)" },
];

type WeeklyToolbarState = {
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  sortBy: string;
  weekOffset: number;
  startDateValue: string;
  endDateValue: string;
  weekRangeDisplay: string;
  advanceWeek: () => void;
  toolbarProps: Omit<OrganiserToolbarProps, "onSendShoppingList" | "isReviewOpen" | "onToggleReview">;
};

/** Owns the weekly toolbar's navigation, date picker, filter, and sort lifecycle. */
export function useWeeklyToolbarState(): WeeklyToolbarState {
  const [searchQuery, setSearchQuery] = React.useState("");
  const [activePopover, setActivePopover] = React.useState<PopoverId>(null);
  const [sortBy, setSortBy] = React.useState("default");
  const [showTimeControls, setShowTimeControls] = React.useState(true);
  const [weekOffset, setWeekOffset] = React.useState(0);
  const [isCalendarOpen, setIsCalendarOpen] = React.useState(false);
  const topbarRef = React.useRef<HTMLDivElement>(null);
  const calendarInputRef = React.useRef<HTMLInputElement>(null);
  const calendarPopoverRef = React.useRef<HTMLDivElement>(null);
  const calendarToggleRef = React.useRef<HTMLButtonElement>(null);
  const filterButtonRef = React.useRef<HTMLButtonElement>(null);
  const filterPopoverRef = React.useRef<HTMLDivElement>(null);
  const sortButtonRef = React.useRef<HTMLButtonElement>(null);
  const sortPopoverRef = React.useRef<HTMLDivElement>(null);

  const startDate = addCalendarDays(startOfIsoWeek(), weekOffset * 7);
  const endDate = addCalendarDays(startDate, 6);
  const startDateValue = formatIsoDate(startDate);
  const endDateValue = formatIsoDate(endDate);
  const weekRangeDisplay = `${formatPlannerDate(startDate, false, false)} - ${formatPlannerDate(endDate, false, true)}`;

  React.useEffect(() => {
    if (!showTimeControls && isCalendarOpen) setIsCalendarOpen(false);
  }, [isCalendarOpen, showTimeControls]);

  const handleCalendarSelect = React.useCallback((date: Date) => {
    if (!date || Number.isNaN(date.getTime())) return;
    setWeekOffset(calendarWeekOffset(date));
    setIsCalendarOpen(false);
  }, []);
  const handleCalendarClose = React.useCallback(() => setIsCalendarOpen(false), []);
  const calendarSelectedDate = React.useMemo(() => dateFromIso(startDateValue), [startDateValue]);
  const { gotoToday, clear: clearCalendarSelection } = usePikadayDatePicker({
    isOpen: isCalendarOpen,
    inputRef: calendarInputRef,
    containerRef: calendarPopoverRef,
    selectedDate: calendarSelectedDate,
    onSelect: handleCalendarSelect,
    onClose: handleCalendarClose,
  });
  const handleCalendarClear = React.useCallback(() => {
    clearCalendarSelection();
    setWeekOffset(0);
    setIsCalendarOpen(false);
  }, [clearCalendarSelection]);

  React.useEffect(() => {
    if (!isCalendarOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const isInsidePopover = calendarPopoverRef.current?.contains(target);
      const isInsideToggle = calendarToggleRef.current?.contains(target);
      let element: HTMLElement | null = target;
      let isInsidePikaday = false;
      while (element) {
        if (typeof element.className === "string" && element.className.includes("pika")) {
          isInsidePikaday = true;
          break;
        }
        element = element.parentElement;
      }
      if (!isInsidePopover && !isInsideToggle && !isInsidePikaday) setIsCalendarOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isCalendarOpen]);

  React.useEffect(() => {
    if (!activePopover) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      const refs = activePopover === "filter"
        ? [filterButtonRef, filterPopoverRef]
        : [sortButtonRef, sortPopoverRef];
      if (refs.some((ref) => ref.current?.contains(target))) return;
      setActivePopover(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [activePopover]);

  const togglePopover = React.useCallback((name: Exclude<PopoverId, null>) => {
    setActivePopover((previous) => previous === name ? null : name);
  }, []);
  const handleSortChange = React.useCallback((next: string) => {
    setSortBy(next);
    setActivePopover(null);
  }, []);
  const handleCalendarToggle = React.useCallback(() => setIsCalendarOpen((open) => !open), []);
  const previousWeek = React.useCallback(() => setWeekOffset((offset) => offset - 1), []);
  const nextWeek = React.useCallback(() => setWeekOffset((offset) => offset + 1), []);
  const resetWeek = React.useCallback(() => setWeekOffset(0), []);

  const calendar: OrganiserToolbarCalendar = {
    isOpen: isCalendarOpen,
    isTimeRowVisible: showTimeControls,
    startDateValue,
    inputRef: calendarInputRef,
    popoverRef: calendarPopoverRef,
    toggleRef: calendarToggleRef,
    onToggle: handleCalendarToggle,
    onGotoToday: gotoToday,
    onClearDate: handleCalendarClear,
  };
  const weekNav: OrganiserToolbarWeekNav = {
    onPrevWeek: previousWeek,
    onNextWeek: nextWeek,
    onResetWeek: resetWeek,
    weekRangeDisplay,
  };
  const popovers: OrganiserToolbarPopovers = {
    filterButtonRef,
    filterPopoverRef,
    sortButtonRef,
    sortPopoverRef,
    activePopover,
    onToggle: togglePopover,
    showTimeControls,
    onToggleShowTimeControls: setShowTimeControls,
    sortOptions: SORT_OPTIONS,
    sortBy,
    onSortChange: handleSortChange,
    isFilterActive: !showTimeControls,
    isSortActive: sortBy !== "default",
  };

  return {
    searchQuery,
    setSearchQuery,
    sortBy,
    weekOffset,
    startDateValue,
    endDateValue,
    weekRangeDisplay,
    advanceWeek: nextWeek,
    toolbarProps: { topbarRef, searchQuery, onSearchChange: setSearchQuery, calendar, weekNav, popovers },
  };
}
