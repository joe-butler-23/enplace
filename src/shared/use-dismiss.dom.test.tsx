// @vitest-environment happy-dom
import * as React from "react";
import { act } from "preact/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDismiss } from "./use-dismiss";

function Menu(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  useDismiss(open, (target) => Boolean(target.closest(".menu")), () => setOpen(false));
  return <div>
    <div className="menu"><button type="button" onClick={() => setOpen((value) => !value)}>Toggle</button>{open ? <ul role="menu" /> : null}</div>
    <p className="outside">Elsewhere</p>
  </div>;
}

describe("useDismiss", () => {
  let container: HTMLDivElement;
  let root: Root;
  const menu = () => container.querySelector('[role="menu"]');
  const open = () => act(() => { container.querySelector("button")!.click(); });
  const press = (target: Element) => act(() => { target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    act(() => { root.render(<Menu />); });
  });
  afterEach(() => { act(() => { root.unmount(); }); container.remove(); });

  it("closes on Escape in the same commit that opened it", () => {
    open();
    expect(menu()).not.toBeNull();
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(menu()).toBeNull();
  });

  it("closes on a press outside and stays open for a press inside", () => {
    open();
    press(menu()!);
    expect(menu()).not.toBeNull();
    press(container.querySelector(".outside")!);
    expect(menu()).toBeNull();
  });

  it("stops listening once closed", () => {
    open();
    press(container.querySelector(".outside")!);
    open();
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(menu()).not.toBeNull();
  });
});
