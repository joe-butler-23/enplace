import type { ShoppingList } from "@/host-client/commands";

type PersistShoppingCheck = (args: {
  expectedRevision: number;
  itemId: string;
  checked: boolean;
}) => Promise<ShoppingList>;

export async function checkShoppingItem({
  list,
  itemId,
  checked,
  publish,
  persist
}: {
  list: ShoppingList;
  itemId: string;
  checked: boolean;
  publish: (list: ShoppingList) => void;
  persist: PersistShoppingCheck;
}): Promise<void> {
  const optimistic = {
    ...list,
    items: list.items.map((item) => (item.id === itemId ? { ...item, checked } : item))
  };
  publish(optimistic);
  try {
    publish(await persist({ expectedRevision: list.revision, itemId, checked }));
  } catch (error) {
    publish(list);
    throw error;
  }
}
