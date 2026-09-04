import * as React from "react";

type WeeklyBoardLayout = {
  plannerRootRef: React.RefObject<HTMLDivElement | null>;
  kanbanRef: React.RefObject<HTMLDivElement | null>;
};

export function clampHorizontalScroll(element: HTMLElement | null): void {
  if (!element) return;
  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  if (maxScrollLeft <= 0) {
    if (element.scrollLeft !== 0) element.scrollLeft = 0;
    return;
  }
  if (element.scrollLeft < 0) {
    element.scrollLeft = 0;
    return;
  }
  if (element.scrollLeft > maxScrollLeft) element.scrollLeft = maxScrollLeft;
}

/** Overflow correction for the weekly grid. The columns themselves are sized in CSS. */
export function useWeeklyBoardLayout(): WeeklyBoardLayout {
  const plannerRootRef = React.useRef<HTMLDivElement>(null);
  const kanbanRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const plannerRoot = plannerRootRef.current;
    const mainPane = plannerRoot?.closest(".mep-main--planner") as HTMLElement | null;
    const targets = [mainPane, plannerRoot, kanbanRef.current].filter(
      (value): value is HTMLElement => Boolean(value)
    );
    if (targets.length === 0) return;
    const clampAll = () => targets.forEach(clampHorizontalScroll);
    const observer = new ResizeObserver(clampAll);
    targets.forEach((target) => observer.observe(target));
    window.addEventListener("resize", clampAll);
    clampAll();
    return () => {
      window.removeEventListener("resize", clampAll);
      observer.disconnect();
    };
  }, []);

  return { plannerRootRef, kanbanRef };
}
