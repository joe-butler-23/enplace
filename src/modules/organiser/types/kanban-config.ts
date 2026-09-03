/** Definition for one rendered Kanban column. */
export interface ColumnDefinition {
  id: string;
  title: string;
  fieldValue: string | boolean | number | undefined;
  isDefault?: boolean;
  className?: string;
  gridRow?: string;
  gridColumn?: string;
}

export interface BaseKanbanItem {
  id: string;
  title: string;
  path: string;
  coverImage?: string;
}

export interface BoardConfig {
  id: string;
  name: string;
  columns: ColumnDefinition[];
}
