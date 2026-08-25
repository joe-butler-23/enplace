import * as React from "react";
import type { ShoppingList, ShoppingListPlan } from "@/host-client/commands";

type ShoppingListViewProps = {
  list: ShoppingList | null;
  plan: ShoppingListPlan | null;
  busy: boolean;
  error: string | null;
  onApply: () => void;
  onCheck: (itemId: string, checked: boolean) => void;
  onRollback: () => void;
  onRefresh: () => void;
  /** Resolves once the item is on the list; rejects so a failed add can be corrected. */
  onAdd?: (content: string, labels: string[]) => void | Promise<void>;
  onRemove?: (itemId: string) => void;
  onCopyLink?: () => void;
};

export type ShoppingListGrouping = "none" | "section" | "recipe";

const OTHER_GROUP = "Other";

export type ShoppingGroup = { label: string; items: ShoppingList["items"] };

export function groupShoppingItems(
  items: ShoppingList["items"],
  grouping: ShoppingListGrouping
): ShoppingGroup[] {
  if (grouping === "none") {
    return items.length > 0 ? [{ label: "", items: [...items] }] : [];
  }
  const groups = new Map<string, ShoppingList["items"]>();
  for (const item of items) {
    const sources = [...new Set((item.sources ?? []).map((source) => source.trim()).filter(Boolean))];
    const label = grouping === "section"
      ? item.labels[0]?.trim() || OTHER_GROUP
      : sources.length > 1
        ? "Shared ingredients"
        : sources[0] || OTHER_GROUP;
    const group = groups.get(label) ?? [];
    group.push(item);
    groups.set(label, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => {
      if (left === OTHER_GROUP) return 1;
      if (right === OTHER_GROUP) return -1;
      return left.localeCompare(right);
    })
    .map(([label, groupItems]) => ({ label, items: groupItems }));
}

function remaining(items: ShoppingList["items"]): number {
  return items.filter((item) => !item.checked).length;
}

/** Hiding done items drops emptied groups, so the list collapses as the shop progresses. */
export function visibleGroups(groups: ShoppingGroup[], hideDone: boolean): ShoppingGroup[] {
  if (!hideDone) return groups;
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.checked) }))
    .filter((group) => group.items.length > 0);
}

/** Aisle-at-a-time advance. Wraps, and tolerates an active label that no longer exists. */
export function nextGroupLabel(groups: ShoppingGroup[], activeLabel: string | null): string | null {
  if (groups.length === 0) return null;
  const index = groups.findIndex((group) => group.label === activeLabel);
  return groups[(index + 1) % groups.length].label;
}

/** Sections offered by the composer, taken from the labels already on the list. */
export function shoppingSections(items: ShoppingList["items"]): string[] {
  return [...new Set(items.flatMap((item) => item.labels).map((label) => label.trim()))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Walking one aisle at a time only means anything grouped by aisle: the tabs would
 * otherwise label recipes, or collapse to a single unnamed group.
 */
export function effectiveGrouping(
  aisleAtATime: boolean,
  grouping: ShoppingListGrouping
): ShoppingListGrouping {
  return aisleAtATime ? "section" : grouping;
}

/**
 * Backend errors carry an appended stack line, and a revision conflict is phrased for
 * engineers. The conflict is already self-healing: the caller refetches the real list.
 */
export function shoppingErrorText(error: string): string {
  const first = error.split("\n")[0];
  if (first.startsWith("Stale shopping list revision")) {
    return "The list changed somewhere else, so it has been reloaded. Try that again.";
  }
  return first;
}

function ShoppingItemRow({
  item,
  busy,
  onCheck,
  onRemove
}: {
  item: ShoppingList["items"][number];
  busy: boolean;
  onCheck: (itemId: string, checked: boolean) => void;
  onRemove?: (itemId: string) => void;
}): React.JSX.Element {
  return (
    <li className={`shopping-item ${item.checked ? "is-checked" : ""}`}>
      <label className="shopping-item__label">
        <input
          className="shopping-item__input"
          type="checkbox"
          checked={item.checked}
          disabled={busy}
          onChange={(event) => onCheck(item.id, event.currentTarget.checked)}
        />
        <span className="shopping-item__box" aria-hidden="true">
          <svg viewBox="0 0 16 16" focusable="false">
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
        </span>
        <span className="shopping-item__name">{item.content}</span>
      </label>
      {onRemove && (
        <button
          type="button"
          className="shopping-item__remove"
          aria-label={`Remove ${item.content}`}
          disabled={busy}
          onClick={() => onRemove(item.id)}
        >
          ×
        </button>
      )}
    </li>
  );
}

const GROUPINGS: Array<{ value: ShoppingListGrouping; label: string }> = [
  { value: "none", label: "None" },
  { value: "section", label: "Aisle" },
  { value: "recipe", label: "Recipe" }
];

export function ShoppingListView({
  list,
  plan,
  busy,
  error,
  onApply,
  onCheck,
  onRollback,
  onRefresh,
  onAdd,
  onRemove,
  onCopyLink
}: ShoppingListViewProps): React.JSX.Element {
  const [grouping, setGrouping] = React.useState<ShoppingListGrouping>("section");
  const [aisleAtATime, setAisleAtATime] = React.useState(false);
  const [hideDone, setHideDone] = React.useState(false);
  const [activeLabel, setActiveLabel] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [draftSection, setDraftSection] = React.useState("");
  const [composerOpen, setComposerOpen] = React.useState(false);
  const draftRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (composerOpen) draftRef.current?.focus();
  }, [composerOpen]);

  const items = list?.items ?? [];
  // The stored preference is kept so leaving aisle mode restores it, but the control
  // must show what is actually in effect.
  const shownGrouping = effectiveGrouping(aisleAtATime, grouping);
  const groups = groupShoppingItems(items, shownGrouping);
  const total = items.length;

  const activeGroup = groups.find((group) => group.label === activeLabel) ?? groups[0] ?? null;
  const sections = shoppingSections(items);

  // Walking one aisle at a time, the viewed aisle IS the destination for a new item.
  const composerSection = aisleAtATime
    ? (activeGroup && activeGroup.label !== OTHER_GROUP ? activeGroup.label : "")
    : draftSection;

  const shownGroups = visibleGroups(groups, hideDone);
  const activeItems = activeGroup
    ? hideDone
      ? activeGroup.items.filter((item) => !item.checked)
      : activeGroup.items
    : [];

  const closeComposer = () => {
    setComposerOpen(false);
    setDraft("");
  };

  const submitDraft = () => {
    const content = draft.trim();
    if (!content || !onAdd) return;
    const result = onAdd(content, composerSection ? [composerSection] : []);
    if (result instanceof Promise) {
      // Keep the typed text until the add lands, so a rejected one can be corrected.
      result.then(closeComposer, () => undefined);
      return;
    }
    closeComposer();
  };

  // A null list means "not loaded yet" — say nothing rather than claim it is empty.
  const loaded = list !== null;
  const showBoard = !plan;
  const showList = showBoard && total > 0;
  const aisleMode = showList && aisleAtATime && activeGroup !== null;

  return (
    <section className="shopping-list-view">
      <header className="shopping-list-view__header">
        <h2>{list?.weekLabel?.trim() || "Shopping list"}</h2>
        {showList && (
          <div className="shopping-seg" role="group" aria-label="Group by">
            {GROUPINGS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`shopping-seg__option ${shownGrouping === option.value ? "is-active" : ""}`}
                aria-pressed={shownGrouping === option.value}
                disabled={aisleAtATime && option.value !== "section"}
                onClick={() => {
                  setGrouping(option.value);
                  setActiveLabel(null);
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        )}
        {showList && (
          <button
            type="button"
            className={`shopping-icon-toggle ${hideDone ? "is-active" : ""}`}
            aria-pressed={hideDone}
            title={hideDone ? "Show done items" : "Hide done items"}
            aria-label={hideDone ? "Show done items" : "Hide done items"}
            onClick={() => setHideDone((value) => !value)}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          </button>
        )}
        <details className="shopping-menu">
          <summary className="shopping-menu__trigger" aria-label="More actions" />
          <div className="shopping-menu__panel">
            {showList && (
              <button type="button" onClick={() => { setAisleAtATime((value) => !value); setActiveLabel(null); }}>
                {aisleAtATime ? "Show every aisle" : "One aisle at a time"}
              </button>
            )}
            <button type="button" onClick={onRefresh} disabled={busy}>
              Refresh
            </button>
            {onCopyLink && (
              <button type="button" onClick={onCopyLink}>
                Copy link
              </button>
            )}
            {showBoard && list?.rollback && (
              <button type="button" onClick={onRollback} disabled={busy}>
                Roll back previous list
              </button>
            )}
          </div>
        </details>
      </header>

      {error && (
        <div className="shopping-list-view__error">
          <span>{shoppingErrorText(error)}</span>
          <button type="button" onClick={onRefresh} disabled={busy}>
            Retry
          </button>
        </div>
      )}

      {plan && (
        <section className="shopping-list-view__preview" aria-label="Shopping list preview">
          <h3>Preview: {plan.weekLabel}</h3>
          <p className="shopping-list-view__preview-summary">
            {plan.summary.desiredCount} items · {plan.summary.createCount} new
            {plan.summary.deleteCount > 0 && ` · ${plan.summary.deleteCount} removed`}
            {plan.summary.manualCount > 0 && ` · ${plan.summary.manualCount} of yours kept`}
          </p>
          <div className="shopping-list-view__preview-groups">
            {groupShoppingItems(plan.items, "section").map((group) => (
              <section key={group.label} className="shopping-group">
                <div className="shopping-group__label">{group.label}</div>
                <ul className="shopping-list-view__preview-items">
                  {group.items.map((item) => (
                    <li key={item.id}>{item.content}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <button type="button" className="shopping-button" onClick={onApply} disabled={busy}>
            Apply list
          </button>
        </section>
      )}

      {aisleMode && activeGroup && (
        <>
          <nav className="shopping-tabs" aria-label="Aisles">
            {groups.map((group) => (
              <button
                key={group.label}
                type="button"
                className={`shopping-tabs__tab ${group.label === activeGroup.label ? "is-active" : ""}`}
                aria-pressed={group.label === activeGroup.label}
                onClick={() => setActiveLabel(group.label)}
              >
                {group.label}
              </button>
            ))}
          </nav>
          {/* The tab already names the aisle; this line carries only what it does not. */}
          <div className="shopping-aisle__status">
            {remaining(activeGroup.items) === 0 ? (
              groups.length > 1 && (
                <button
                  type="button"
                  className="shopping-button shopping-button--next"
                  onClick={() => setActiveLabel(nextGroupLabel(groups, activeGroup.label))}
                >
                  Next aisle →
                </button>
              )
            ) : (
              <span className="shopping-aisle__count">{remaining(activeGroup.items)} left</span>
            )}
          </div>
        </>
      )}

      {showList && (
        <div className="shopping-list-view__scroll">
          {(aisleMode && activeGroup
            ? [{ label: "", items: activeItems }]
            : shownGroups
          ).map((group) => (
            <section key={group.label || "all"} className="shopping-group">
              {group.label && <div className="shopping-group__label">{group.label}</div>}
              <ul className="shopping-items">
                {group.items.map((item) => (
                  <ShoppingItemRow
                    key={item.id}
                    item={item}
                    busy={busy}
                    onCheck={onCheck}
                    onRemove={onRemove}
                  />
                ))}
              </ul>
            </section>
          ))}
          {aisleMode && activeItems.length === 0 && activeGroup && (
            <p className="shopping-list-view__cleared">Nothing left in {activeGroup.label}.</p>
          )}
          {!aisleMode && shownGroups.length === 0 && (
            <p className="shopping-list-view__cleared">Everything is picked up.</p>
          )}
        </div>
      )}

      {showBoard && loaded && total === 0 && (
        <p className="shopping-list-view__empty">Your list is empty — add an item below.</p>
      )}

      {/* Not offered until the list has loaded: adding against an unknown revision fails. */}
      {showBoard && loaded && onAdd && (
        composerOpen ? (
          <form
            className="shopping-composer"
            onSubmit={(event) => {
              event.preventDefault();
              submitDraft();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeComposer();
            }}
          >
            <input
              ref={draftRef}
              type="text"
              className="shopping-composer__input"
              value={draft}
              disabled={busy}
              placeholder={
                aisleAtATime && activeGroup ? `Add to ${activeGroup.label}` : "Add an item"
              }
              aria-label="Add a shopping item"
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
            {!aisleAtATime && (
              <select
                className="shopping-composer__section"
                aria-label="Section"
                value={composerSection}
                disabled={busy}
                onChange={(event) => setDraftSection(event.currentTarget.value)}
              >
                <option value="">{OTHER_GROUP}</option>
                {sections.map((section) => (
                  <option key={section} value={section}>
                    {section}
                  </option>
                ))}
              </select>
            )}
            <button type="submit" className="shopping-button" disabled={busy || !draft.trim()}>
              Add
            </button>
          </form>
        ) : (
          <button
            type="button"
            className="shopping-fab"
            aria-label="Add an item"
            aria-expanded={false}
            onClick={() => setComposerOpen(true)}
          >
            +
          </button>
        )
      )}
    </section>
  );
}
