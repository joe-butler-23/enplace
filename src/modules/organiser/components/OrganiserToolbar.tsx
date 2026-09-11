import * as React from "react";
import { useDismiss } from "@/shared/use-dismiss";
import { usePikadayDatePicker } from "../hooks/usePikadayDatePicker";
import { addCalendarDays, calendarWeekOffset, formatPlannerDate, startOfIsoWeek } from "../utils/scheduled-dates";

type OrganiserToolbarProps = {
  weekOffset: number;
  onWeekOffset: (offset: number) => void;
  onSendShoppingList: () => void;
};

const Icon = ({ size = 14, children }: { size?: number; children: React.ReactNode }): React.JSX.Element => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

/** One row: which week the board is showing, and the one action that acts on that week. */
export function OrganiserToolbar({ weekOffset, onWeekOffset, onSendShoppingList }: OrganiserToolbarProps): React.JSX.Element {
  const [calendarOpen, setCalendarOpen] = React.useState(false);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const startDate = addCalendarDays(startOfIsoWeek(), weekOffset * 7);
  const endDate = addCalendarDays(startDate, 6);
  const closeCalendar = React.useCallback(() => setCalendarOpen(false), []);
  usePikadayDatePicker({
    isOpen: calendarOpen,
    containerRef: popoverRef,
    selectedDate: startDate,
    onSelect: (date) => { onWeekOffset(calendarWeekOffset(date)); closeCalendar(); },
    onClose: closeCalendar,
  });
  // Pikaday redraws its month on mousedown; the pointerdown that precedes it still sees the old,
  // attached nodes, so containment inside the toggle-and-popover wrapper is enough.
  useDismiss(calendarOpen, (target) => Boolean(target.closest(".week-nav-calendar")), closeCalendar);

  return (
    <div className="organiser-topbar">
      <div className="week-nav">
        <button type="button" className="mep-icon-button" onClick={() => onWeekOffset(weekOffset - 1)} aria-label="Previous week">
          <Icon><polyline points="15 18 9 12 15 6" /></Icon>
        </button>
        <button type="button" className="week-nav-btn" onClick={() => onWeekOffset(0)}>Today</button>
        <div className="week-nav-calendar">
          <button type="button" className="mep-icon-button" aria-label="Choose week" aria-expanded={calendarOpen} onClick={() => setCalendarOpen((open) => !open)}>
            <Icon><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></Icon>
          </button>
          {calendarOpen ? <div className="calendar-popover" ref={popoverRef} /> : null}
        </div>
        <button type="button" className="mep-icon-button" onClick={() => onWeekOffset(weekOffset + 1)} aria-label="Next week">
          <Icon><polyline points="9 18 15 12 9 6" /></Icon>
        </button>
        <span className="week-range">{`${formatPlannerDate(startDate, false, false)} – ${formatPlannerDate(endDate, false, true)}`}</span>
      </div>
      <button type="button" className="mep-icon-button" title="Build shopping list" aria-label="Build shopping list" onClick={onSendShoppingList}>
        <Icon size={16}><circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" /><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" /></Icon>
      </button>
    </div>
  );
}
