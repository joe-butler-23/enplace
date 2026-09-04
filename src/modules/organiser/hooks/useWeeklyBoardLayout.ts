import * as React from "react";
import { useEffectEvent } from "@/shared/use-effect-event";
import {
  computeWeeklyTrackWidth,
  normalizeWeeklyColumnMinWidth,
} from "../utils/weekly-layout";

type ResizeSession = {
  startX: number;
  startMinWidth: number;
  startWidth: number;
};

type WeeklyBoardLayout = {
  plannerRootRef: React.RefObject<HTMLDivElement | null>;
  kanbanRef: React.RefObject<HTMLDivElement | null>;
  currentMarkedWidth: number;
  isResizingMarked: boolean;
  startResize: (event: React.MouseEvent) => void;
  resizeWithKeyboard: (event: React.KeyboardEvent<HTMLDivElement>) => void;
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

/** Owns marked-column resizing and overflow correction for the weekly grid. */
export function useWeeklyBoardLayout(
  markedWidth: number,
  onSaveMarkedWidth?: (width: number) => void,
): WeeklyBoardLayout {
  const [currentMarkedWidth, setCurrentMarkedWidth] = React.useState(() =>
    normalizeWeeklyColumnMinWidth(markedWidth)
  );
  const [resizeSession, setResizeSession] = React.useState<ResizeSession | null>(null);
  const plannerRootRef = React.useRef<HTMLDivElement>(null);
  const kanbanRef = React.useRef<HTMLDivElement>(null);
  const saveMarkedWidth = useEffectEvent((width: number) => onSaveMarkedWidth?.(width));

  React.useEffect(() => {
    setCurrentMarkedWidth(normalizeWeeklyColumnMinWidth(markedWidth));
  }, [markedWidth]);

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

  const startResize = (event: React.MouseEvent) => {
    event.preventDefault();
    const startHostWidth = kanbanRef.current?.clientWidth ?? 0;
    setResizeSession({
      startX: event.clientX,
      startMinWidth: currentMarkedWidth,
      startWidth: computeWeeklyTrackWidth(startHostWidth, currentMarkedWidth),
    });
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
    if (!delta) return;
    event.preventDefault();
    const nextWidth = normalizeWeeklyColumnMinWidth(currentMarkedWidth + delta);
    if (nextWidth === currentMarkedWidth) return;
    setCurrentMarkedWidth(nextWidth);
    saveMarkedWidth(nextWidth);
  };

  React.useEffect(() => {
    if (!resizeSession) return;
    const handleMouseMove = (event: MouseEvent) => {
      const diff = event.clientX - resizeSession.startX;
      setCurrentMarkedWidth(normalizeWeeklyColumnMinWidth(resizeSession.startWidth + diff));
    };
    const handleMouseUp = (event: MouseEvent) => {
      const diff = event.clientX - resizeSession.startX;
      setResizeSession(null);
      if (Math.abs(diff) < 1) return;
      const finalWidth = normalizeWeeklyColumnMinWidth(resizeSession.startWidth + diff);
      setCurrentMarkedWidth(finalWidth);
      if (finalWidth !== resizeSession.startMinWidth) saveMarkedWidth(finalWidth);
    };
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [resizeSession]);

  return {
    plannerRootRef,
    kanbanRef,
    currentMarkedWidth,
    isResizingMarked: resizeSession !== null,
    startResize,
    resizeWithKeyboard,
  };
}
