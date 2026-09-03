import { afterEach, describe, expect, it, vi } from "vitest";
import { openKitchen, type KitchenConnection } from "../host-client/kitchen-storage";
import { writeKitchenText } from "./doc";
import { setCurrentKitchenConnection } from "./current";
import { getKitchenSnapshot, subscribeKitchen } from "./store";

let connection: KitchenConnection | null = null;
afterEach(async () => {
  setCurrentKitchenConnection(null);
  await connection?.close(); connection = null;
});

describe("kitchen app store", () => {
  it("publishes parsed recipes, plan, shopping, paths, and live text changes", async () => {
    connection = await openKitchen({ id: "abcdefghijklmnopqrstuvwxyz", relayUrl: null, persist: false });
    const changed = vi.fn(); subscribeKitchen(changed);
    setCurrentKitchenConnection(connection);
    writeKitchenText(connection.doc, "soup.md", "# Soup\n\n## Ingredients\n- onion\n");
    writeKitchenText(connection.doc, "Plan.md", "## Marked\n- [[soup]]\n");
    writeKitchenText(connection.doc, "Shopping.md", "## Soup\n- [ ] onion\n");
    const snapshot = getKitchenSnapshot();
    expect(snapshot.recipes.map((recipe) => recipe.title)).toEqual(["Soup"]);
    expect(snapshot.plan.marked).toEqual(["soup"]);
    expect(snapshot.shopping.items[0]).toMatchObject({ content: "onion", checked: false });
    expect(snapshot.files.map((file) => file.path)).toEqual(["Plan.md", "Shopping.md", "soup.md"]);
    expect(snapshot.texts.get("soup.md")).toContain("## Ingredients");
    expect(changed).toHaveBeenCalled();
  });
});
