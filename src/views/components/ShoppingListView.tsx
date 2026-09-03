import * as React from "react";
export type ShoppingListItem = {
  id: string;
  content: string;
  labels: string[];
  sources?: string[];
  checked: boolean;
};

export type ShoppingList = { items: ShoppingListItem[] };
export type ShoppingListPlan = { weekLabel: string; items: ShoppingListItem[] };

type ShoppingListViewProps = {
  list: ShoppingList | null;
  plan: ShoppingListPlan | null;
  busy: boolean;
  error: string | null;
  onApply: () => void;
  onCheck: (itemId: string, checked: boolean) => void;
  onRefresh: () => void;
  onAdd?: (content: string) => void | Promise<void>;
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
  const entries = [...groups.entries()];
  if (grouping === "section") entries.sort(([left], [right]) => {
    if (left === OTHER_GROUP) return 1;
    if (right === OTHER_GROUP) return -1;
    return left.localeCompare(right);
  });
  return entries.map(([label, groupItems]) => ({ label, items: groupItems }));
}


/** Hiding done items drops emptied groups, so the list collapses as the shop progresses. */
export function visibleGroups(groups: ShoppingGroup[], hideDone: boolean): ShoppingGroup[] {
  if (!hideDone) return groups;
  return groups
    .map((group) => ({ ...group, items: group.items.filter((item) => !item.checked) }))
    .filter((group) => group.items.length > 0);
}

/** Keep only the user-facing line when an error carries diagnostic detail. */
export function shoppingErrorText(error: string): string {
  return error.split("\n")[0];
}

/** First-item identifier for the first-load latency harness (see `mep:shopping:semantic-ready`). */
export function shoppingItemTimingIdentifier(itemId: string): string {
  return `mep:shopping-item:${itemId}`;
}

export function shoppingCheckTimingIdentifier(itemId: string, checked: boolean): string {
  return `mep:shopping-check:${itemId}:${checked ? 'checked' : 'unchecked'}`;
}

function ShoppingItemRow({
  item,
  busy,
  onCheck,
  onRemove,
  elementTimingId
}: {
  item: ShoppingList["items"][number];
  busy: boolean;
  onCheck: (itemId: string, checked: boolean) => void;
  onRemove?: (itemId: string) => void;
  /** Set only for the first rendered item, so the harness has one stable exact target. */
  elementTimingId?: string;
}): React.JSX.Element {
  return (
    <li className={`shopping-item ${item.checked ? "is-checked" : ""}`}>
      <label className="shopping-item__label">
        <input
          className="shopping-item__input"
          type="checkbox"
          checked={item.checked}
          data-item-id={item.id}
          disabled={busy}
          onChange={(event) => onCheck(item.id, event.currentTarget.checked)}
        />
        <span className="shopping-item__box" aria-hidden="true">
          <svg viewBox="0 0 16 16" focusable="false">
            <path d="M3.5 8.5l3 3 6-7" />
          </svg>
        </span>
        <span key={`${item.id}:${item.checked}`}
          {...({
            className: "shopping-item__name",
            ...(elementTimingId ? { elementtiming: elementTimingId } : {})
          } as React.HTMLAttributes<HTMLSpanElement>)}
        >
          {item.content}
        </span>
      </label>
      {onRemove ? <button type="button" className="shopping-item__remove" aria-label={`Remove ${item.content}`} disabled={busy} onClick={() => onRemove(item.id)}>×</button> : null}
    </li>
  );
}



export function ShoppingListView({
  list, plan, busy, error, onApply, onCheck, onRefresh, onAdd, onRemove, onCopyLink
}: ShoppingListViewProps): React.JSX.Element {
  const [hideDone, setHideDone] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [composerOpen, setComposerOpen] = React.useState(false);
  const draftRef = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => { if (composerOpen) draftRef.current?.focus(); }, [composerOpen]);

  const closeComposer = () => { setComposerOpen(false); setDraft(""); };
  const submitDraft = () => {
    const content = draft.trim();
    if (!content || !onAdd) return;
    const result = onAdd(content);
    if (result instanceof Promise) result.then(closeComposer, () => undefined);
    else closeComposer();
  };
  const items = list?.items ?? [];
  const groups = visibleGroups(groupShoppingItems(items, "recipe"), hideDone);
  const firstItemId = groups.flatMap((group) => group.items)[0]?.id ?? null;

  React.useEffect(() => {
    if (list === null || typeof performance === "undefined" || typeof performance.mark !== "function") return;
    performance.mark("mep:shopping:semantic-ready", { detail: {
      total: items.length, empty: items.length === 0,
      presentationIdentifier: firstItemId ? shoppingItemTimingIdentifier(firstItemId) : "mep:shopping:empty-state"
    }});
  }, [firstItemId, items.length, list]);

  return <section className="shopping-list-view">
    <header className="shopping-list-view__header">
      <h2>Shopping list</h2>
      {items.length > 0 ? <button type="button" className={`shopping-icon-toggle ${hideDone ? "is-active" : ""}`} aria-pressed={hideDone} title={hideDone ? "Show done items" : "Hide done items"} aria-label={hideDone ? "Show done items" : "Hide done items"} onClick={() => setHideDone((value) => !value)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
      </button> : null}
      <details className="shopping-menu"><summary className="shopping-menu__trigger" aria-label="More actions"/><div className="shopping-menu__panel">
        <button type="button" onClick={onRefresh} disabled={busy}>Refresh</button>
        {onCopyLink ? <button type="button" onClick={onCopyLink}>Copy list</button> : null}
      </div></details>
    </header>
    {error ? <div className="shopping-list-view__error" role="alert" aria-live="assertive"><span>{shoppingErrorText(error)}</span><button type="button" onClick={onRefresh} disabled={busy}>Retry</button></div> : null}
    {plan ? <section className="shopping-list-view__preview" aria-label="Shopping list preview"><h3>Build list for {plan.weekLabel}</h3><p>{plan.items.length} items</p><button type="button" className="shopping-button" onClick={onApply} disabled={busy}>Build list</button></section> : null}
    {list !== null && items.length === 0 && !plan ? <p {...({ className: "shopping-list-view__empty", elementtiming: "mep:shopping:empty-state" } as React.HTMLAttributes<HTMLParagraphElement>)}>Your list is empty — add an item below.</p> : null}
    {items.length > 0 ? <div className="shopping-list-view__scroll">
      {groups.map((group) => <section key={group.label || "ungrouped"} className="shopping-group">{group.label ? <div className="shopping-group__label">{group.label}</div> : null}<ul className="shopping-items">{group.items.map((item) => <ShoppingItemRow key={item.id} item={item} busy={busy} onCheck={onCheck} onRemove={onRemove} elementTimingId={shoppingCheckTimingIdentifier(item.id, item.checked)}/>)}</ul></section>)}
      {groups.length === 0 ? <p className="shopping-list-view__cleared">Everything is picked up.</p> : null}
    </div> : null}
    {list !== null && !plan && onAdd ? composerOpen ? (
      <form className="shopping-composer" onSubmit={(event) => { event.preventDefault(); submitDraft(); }} onKeyDown={(event) => { if (event.key === "Escape") closeComposer(); }}>
        <input ref={draftRef} type="text" className="shopping-composer__input" value={draft} disabled={busy} placeholder="Add an item" aria-label="Add a shopping item" onChange={(event) => setDraft(event.currentTarget.value)} />
        <button type="submit" className="shopping-button" disabled={busy || !draft.trim()}>Add</button>
      </form>
    ) : (
      <button type="button" className="shopping-fab" aria-label="Add an item" aria-expanded={false} onClick={() => setComposerOpen(true)}>+</button>
    ) : null}
  </section>;
}
