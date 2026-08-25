import { expect, test } from "@playwright/test";

type BoardSnapshot = {
  id: string;
  itemIds: string[];
};

function getBoardSnapshot(): BoardSnapshot[] {
  return Array.from(document.querySelectorAll(".kanban-board[data-id]")).map((board) => {
    const element = board as HTMLElement;
    return {
      id: element.dataset.id ?? "",
      itemIds: Array.from(element.querySelectorAll(".kanban-item[data-eid]")).map(
        (item) => (item as HTMLElement).dataset.eid ?? ""
      ),
    };
  });
}

test("diagnostic: shift drag planner card", async ({ page }) => {
  const debugLogs: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (
      text.includes("WeeklyOrganiser") ||
      text.includes("drag:") ||
      text.includes("refresh:")
    ) {
      debugLogs.push(text);
    }
  });

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(page.locator(".mep-planner-resident.is-active")).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __MEP_KANBAN_DEBUG__?: boolean }).__MEP_KANBAN_DEBUG__ = true;
  });

  await expect
    .poll(async () => {
      return page.evaluate(() =>
        document.querySelectorAll(".kanban-item[data-eid]").length
      );
    })
    .toBeGreaterThan(0);

  const before = await page.evaluate(getBoardSnapshot);

  const placement = await page.evaluate(() => {
    const boards = Array.from(
      document.querySelectorAll(".kanban-board[data-id]")
    ) as HTMLElement[];

    const dayBoards = boards
      .map((board) => ({
        id: board.dataset.id ?? "",
        board,
        count: board.querySelectorAll(".kanban-item[data-eid]").length,
      }))
      .filter((entry) => entry.id && entry.id !== "marked");

    const source = dayBoards.find((entry) => entry.count > 0);
    const target = dayBoards.find((entry) => source && entry.id !== source.id);
    if (!source || !target) {
      return null;
    }

    const sourceCard = source.board.querySelector(".kanban-item[data-eid]") as HTMLElement | null;
    const targetContainer =
      (target.board.querySelector(".kanban-drag") as HTMLElement | null) ?? target.board;
    if (!sourceCard || !targetContainer) {
      return null;
    }

    const sourceRect = sourceCard.getBoundingClientRect();
    const targetRect = targetContainer.getBoundingClientRect();

    return {
      sourceId: source.id,
      targetId: target.id,
      itemId: sourceCard.dataset.eid ?? "",
      start: {
        x: sourceRect.left + sourceRect.width / 2,
        y: sourceRect.top + sourceRect.height / 2,
      },
      end: {
        x: targetRect.left + Math.min(36, Math.max(10, targetRect.width / 5)),
        y: targetRect.top + Math.min(110, Math.max(24, targetRect.height / 3)),
      },
    };
  });

  expect(placement).toBeTruthy();

  await page.keyboard.down("Shift");
  await page.mouse.move(placement!.start.x, placement!.start.y);
  await page.mouse.down();
  await page.mouse.move(placement!.end.x, placement!.end.y, { steps: 16 });
  await page.mouse.up();
  await page.keyboard.up("Shift");

  const immediateAfter = await page.evaluate(getBoardSnapshot);
  const movedPrefix = placement!.itemId.split("::")[0];
  await expect
    .poll(() =>
      page.evaluate(({ sourceId, targetId, movedPrefix }) => {
        const snapshot = Array.from(document.querySelectorAll(".kanban-board[data-id]")).map((board) => {
          const element = board as HTMLElement;
          return {
            id: element.dataset.id ?? "",
            itemIds: Array.from(element.querySelectorAll(".kanban-item[data-eid]")).map(
              (item) => (item as HTMLElement).dataset.eid ?? ""
            )
          };
        });
        const source = snapshot.find((board) => board.id === sourceId);
        const target = snapshot.find((board) => board.id === targetId);
        return Boolean(
          source?.itemIds.some((id) => id.startsWith(`${movedPrefix}::`)) &&
            target?.itemIds.some((id) => id.startsWith(`${movedPrefix}::`))
        );
      }, { sourceId: placement!.sourceId, targetId: placement!.targetId, movedPrefix })
    )
    .toBeTruthy();

  const after = await page.evaluate(getBoardSnapshot);

  const sourceImmediate = immediateAfter.find((board) => board.id === placement!.sourceId);
  const targetImmediate = immediateAfter.find((board) => board.id === placement!.targetId);

  const report = {
    before,
    immediateAfter,
    after,
    logs: debugLogs.slice(-60),
  };

  console.log("[SHIFT_DRAG_DIAG]", JSON.stringify(report));
  expect(sourceImmediate?.itemIds.some((id) => id.startsWith(`${movedPrefix}::`))).toBeTruthy();
  expect(targetImmediate?.itemIds.some((id) => id.startsWith(`${movedPrefix}::`))).toBeTruthy();
});
