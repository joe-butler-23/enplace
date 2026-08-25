import { describe, expect, it, vi, afterEach } from "vitest";
import { createModifierKeyHandlers } from "./modifier-keys";

type FakeWindow = {
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
	listeners: Map<string, EventListener>;
};

function makeFakeWindow(): FakeWindow {
	const listeners = new Map<string, EventListener>();
	return {
		listeners,
		addEventListener: vi.fn((type: string, listener: EventListener) => listeners.set(type, listener)),
		removeEventListener: vi.fn((type: string) => listeners.delete(type)),
	};
}

describe("createModifierKeyHandlers", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("attach registers exactly keydown, keyup, and blur listeners", () => {
		const fakeWindow = makeFakeWindow();
		vi.stubGlobal("window", fakeWindow);
		const handlers = createModifierKeyHandlers(vi.fn(), ["Shift"]);

		handlers.attach();

		expect(fakeWindow.addEventListener).toHaveBeenCalledTimes(3);
		expect(fakeWindow.listeners.has("keydown")).toBe(true);
		expect(fakeWindow.listeners.has("keyup")).toBe(true);
		expect(fakeWindow.listeners.has("blur")).toBe(true);
	});

	it("calls update(true) on a matching keydown and update(false) on a matching keyup", () => {
		const fakeWindow = makeFakeWindow();
		vi.stubGlobal("window", fakeWindow);
		const update = vi.fn();
		createModifierKeyHandlers(update, ["Shift"]).attach();

		fakeWindow.listeners.get("keydown")!({ key: "Shift" } as KeyboardEvent);
		expect(update).toHaveBeenLastCalledWith(true);

		fakeWindow.listeners.get("keyup")!({ key: "Shift" } as KeyboardEvent);
		expect(update).toHaveBeenLastCalledWith(false);
	});

	it("ignores keys outside the watched set", () => {
		const fakeWindow = makeFakeWindow();
		vi.stubGlobal("window", fakeWindow);
		const update = vi.fn();
		createModifierKeyHandlers(update, ["Shift"]).attach();

		fakeWindow.listeners.get("keydown")!({ key: "Control" } as KeyboardEvent);

		expect(update).not.toHaveBeenCalled();
	});

	it("resets on window blur regardless of watched keys", () => {
		const fakeWindow = makeFakeWindow();
		vi.stubGlobal("window", fakeWindow);
		const update = vi.fn();
		createModifierKeyHandlers(update, ["Shift"]).attach();

		fakeWindow.listeners.get("blur")!(new Event("blur"));

		expect(update).toHaveBeenCalledWith(false);
	});

	it("detach removes every listener it attached", () => {
		const fakeWindow = makeFakeWindow();
		vi.stubGlobal("window", fakeWindow);
		const handlers = createModifierKeyHandlers(vi.fn(), ["Shift"]);
		handlers.attach();

		handlers.detach();

		expect(fakeWindow.removeEventListener).toHaveBeenCalledTimes(3);
		expect(fakeWindow.listeners.size).toBe(0);
	});
});
