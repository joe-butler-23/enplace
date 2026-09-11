/** Definition for one rendered Kanban column. */
export interface ColumnDefinition {
  id: string;
  /** Plain text: the lane renders it, so it is never parsed as markup. */
  title: string;
  /** Day lanes only: the household's note for that date, "" when there is none. */
  note?: string;
  isDefault?: boolean;
  className?: string;
}

export interface BaseKanbanItem {
  id: string;
  title: string;
  path: string;
  coverImage?: string;
}

export interface BoardConfig {
  id: string;
  columns: ColumnDefinition[];
}
