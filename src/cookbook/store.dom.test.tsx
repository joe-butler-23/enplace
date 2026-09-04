// @vitest-environment happy-dom
import * as React from "react";
import { act } from "preact/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openCookbook, type CookbookConnection } from "../host-client/cookbook-storage";
import { writeCookbookText } from "./doc";
import { setCurrentCookbookConnection } from "./current";
import { useCookbookSlice, useCookbookText } from "./store";

let connection: CookbookConnection | null = null;
let root: Root | null = null;
afterEach(async () => {
  if (root) act(() => root!.unmount()); root = null;
  setCurrentCookbookConnection(null);
  await connection?.close(); connection = null;
});

describe("cookbook slice subscriptions", () => {
  it("does not rerender recipe or exact-path readers for an unrelated shopping edit", async () => {
    connection = await openCookbook({ id: "abcdefghijklmnopqrstuvwxyz", relayUrl: null, persist: false });
    connection.doc.transact(() => {
      writeCookbookText(connection!.doc, "a.md", "# A\n\n## Ingredients\n- onion\n");
      writeCookbookText(connection!.doc, "Shopping.md", "- [ ] milk\n");
    });
    setCurrentCookbookConnection(connection);
    const recipeRender = vi.fn(); const textRender = vi.fn();
    function RecipeReader(): React.JSX.Element { recipeRender(); return <span>{useCookbookSlice("recipes").length}</span>; }
    function TextReader(): React.JSX.Element { textRender(); return <span>{useCookbookText("a.md")}</span>; }
    const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    act(() => root!.render(<><RecipeReader /><TextReader /></>));
    recipeRender.mockClear(); textRender.mockClear();

    act(() => writeCookbookText(connection!.doc, "Shopping.md", "- [x] milk\n"));
    expect(recipeRender).not.toHaveBeenCalled();
    expect(textRender).not.toHaveBeenCalled();

    act(() => writeCookbookText(connection!.doc, "a.md", "# A2\n\n## Ingredients\n- onion\n"));
    expect(recipeRender).toHaveBeenCalledOnce();
    expect(textRender).toHaveBeenCalledOnce();
    container.remove();
  });
});
