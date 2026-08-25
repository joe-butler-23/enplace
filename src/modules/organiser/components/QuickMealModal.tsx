import * as React from "react";

export type QuickMealDraft = {
  date: string;
  title: string;
  ingredients: string;
  notes: string;
};

type QuickMealModalProps = {
  draft: QuickMealDraft;
  onChange: (next: QuickMealDraft) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

export function QuickMealModal({
  draft,
  onChange,
  onCancel,
  onSubmit,
}: QuickMealModalProps): React.JSX.Element {
  return (
    <div className="quick-meal-modal-overlay" onClick={onCancel}>
      <div className="quick-meal-modal" onClick={(event) => event.stopPropagation()}>
        <div className="quick-meal-modal__title">Add Quick Meal</div>
        <label className="quick-meal-modal__field">
          <span>Title</span>
          <input
            type="text"
            value={draft.title}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
          />
        </label>
        <label className="quick-meal-modal__field">
          <span>Ingredients (optional)</span>
          <textarea
            rows={4}
            placeholder="Comma or newline separated"
            value={draft.ingredients}
            onChange={(event) => onChange({ ...draft, ingredients: event.target.value })}
          />
        </label>
        <label className="quick-meal-modal__field">
          <span>Notes (optional)</span>
          <textarea
            rows={3}
            value={draft.notes}
            onChange={(event) => onChange({ ...draft, notes: event.target.value })}
          />
        </label>
        <div className="quick-meal-modal__actions">
          <button
            type="button"
            className="topbar-option quick-meal-modal__cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="topbar-option is-active quick-meal-modal__submit"
            onClick={onSubmit}
          >
            Add meal
          </button>
        </div>
      </div>
    </div>
  );
}
