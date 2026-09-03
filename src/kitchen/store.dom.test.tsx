// @vitest-environment happy-dom
import * as React from "react";
import { act } from "preact/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKitchen, type KitchenConnection } from "../host-client/kitchen-storage";
import { writeKitchenText } from "./doc";
import { setCurrentKitchenConnection } from "./current";
import { useKitchenSlice, useKitchenText } from "./store";

let connection: KitchenConnection | null = null;
let root: Root | null = null;
afterEach(async () => {
  if (root) act(() => root!.unmount()); root = null;
  setCurrentKitchenConnection(null);
  await connection?.close(); connection = null;
});

describe("kitchen slice subscriptions", () => {
  it("does not rerender recipe or exact-path readers for an unrelated shopping edit", async () => {
    connection = await openKitchen({ id: "abcdefghijklmnopqrstuvwxyz", relayUrl: null, persist: false });
    connection.doc.transact(() => {
      writeKitchenText(connection!.doc, "a.md", "# A\n\n## Ingredients\n- onion\n");
      writeKitchenText(connection!.doc, "Shopping.md", "- [ ] milk\n");
    });
    setCurrentKitchenConnection(connection);
    const recipeRender = vi.fn(); const textRender = vi.fn();
    function RecipeReader(): React.JSX.Element { recipeRender(); return <span>{useKitchenSlice("recipes").length}</span>; }
    function TextReader(): React.JSX.Element { textRender(); return <span>{useKitchenText("a.md")}</span>; }
    const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    act(() => root!.render(<><RecipeReader /><TextReader /></>));
    recipeRender.mockClear(); textRender.mockClear();

    act(() => writeKitchenText(connection!.doc, "Shopping.md", "- [x] milk\n"));
    expect(recipeRender).not.toHaveBeenCalled();
    expect(textRender).not.toHaveBeenCalled();

    act(() => writeKitchenText(connection!.doc, "a.md", "# A2\n\n## Ingredients\n- onion\n"));
    expect(recipeRender).toHaveBeenCalledOnce();
    expect(textRender).toHaveBeenCalledOnce();
    container.remove();
  });
});
