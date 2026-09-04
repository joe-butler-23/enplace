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

export type OrganiserToolbarCalendar = {
  isOpen: boolean;
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

export type OrganiserToolbarProps = {
  topbarRef: React.RefObject<HTMLDivElement | null>;
  calendar: OrganiserToolbarCalendar;
  weekNav: OrganiserToolbarWeekNav;
  onSendShoppingList?: () => void;
};

/** One row: which week the board is showing, and the one action that acts on that week. */
export function OrganiserToolbar({
  topbarRef,
  calendar,
  weekNav,
  onSendShoppingList,
}: OrganiserToolbarProps): React.JSX.Element {
  const {
    isOpen: isCalendarOpen,
    startDateValue,
    inputRef: calendarInputRef,
    popoverRef: calendarPopoverRef,
    toggleRef: calendarToggleRef,
    onToggle: onToggleCalendar,
    onGotoToday,
    onClearDate,
  } = calendar;
  const { onPrevWeek, onNextWeek, onResetWeek, weekRangeDisplay } = weekNav;
  return (
    <div className="organiser-topbar" ref={topbarRef}>
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
        <span className="week-range">{weekRangeDisplay}</span>
      </div>

      {onSendShoppingList && (
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
      )}
    </div>
  );
}

type WeeklyToolbarState = {
  weekOffset: number;
  startDateValue: string;
  endDateValue: string;
  toolbarProps: Omit<OrganiserToolbarProps, "onSendShoppingList">;
};

/** Owns the weekly toolbar's week navigation and its date picker's lifecycle. */
export function useWeeklyToolbarState(): WeeklyToolbarState {
  const [weekOffset, setWeekOffset] = React.useState(0);
  const [isCalendarOpen, setIsCalendarOpen] = React.useState(false);
  const topbarRef = React.useRef<HTMLDivElement>(null);
  const calendarInputRef = React.useRef<HTMLInputElement>(null);
  const calendarPopoverRef = React.useRef<HTMLDivElement>(null);
  const calendarToggleRef = React.useRef<HTMLButtonElement>(null);

  const startDate = addCalendarDays(startOfIsoWeek(), weekOffset * 7);
  const endDate = addCalendarDays(startDate, 6);
  const startDateValue = formatIsoDate(startDate);
  const endDateValue = formatIsoDate(endDate);
  const weekRangeDisplay = `${formatPlannerDate(startDate, false, false)} - ${formatPlannerDate(endDate, false, true)}`;

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

  const handleCalendarToggle = React.useCallback(() => setIsCalendarOpen((open) => !open), []);
  const previousWeek = React.useCallback(() => setWeekOffset((offset) => offset - 1), []);
  const nextWeek = React.useCallback(() => setWeekOffset((offset) => offset + 1), []);
  const resetWeek = React.useCallback(() => setWeekOffset(0), []);

  const calendar: OrganiserToolbarCalendar = {
    isOpen: isCalendarOpen,
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

  return {
    weekOffset,
    startDateValue,
    endDateValue,
    toolbarProps: { topbarRef, calendar, weekNav },
  };
}
