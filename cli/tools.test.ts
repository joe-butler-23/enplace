import { afterEach, describe, expect, it, vi } from "vitest";
import { COOKING_OPERATIONS } from "../src/agent/operations";
import { openCookingSession } from "../src/agent/session";
import { associationPath, readAssociation } from "./association";
import { executeLiveCli } from "./live";

vi.mock("../src/agent/session", () => ({ openCookingSession: vi.fn() }));
vi.mock("./association");
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("cooking schema discovery", () => {
  it("prints the complete canonical catalog on one line without accessing a cookbook", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(executeLiveCli(["tools"])).resolves.toBe(true);
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(JSON.parse(text)).toEqual(COOKING_OPERATIONS);
    expect(text.split("\n")).toHaveLength(2);
    expect(associationPath).not.toHaveBeenCalled();
    expect(readAssociation).not.toHaveBeenCalled();
    expect(openCookingSession).not.toHaveBeenCalled();
  });

  it("selects exact schemas in catalog order and deduplicates requests", async () => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await executeLiveCli(["tools", "plan.add", "recipe.search", "plan.read", "plan.add"]);
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join("");
    const schemas = JSON.parse(text);
    expect(schemas.map((schema: { name: string }) => schema.name)).toEqual(["recipe.search", "plan.read", "plan.add"]);
    expect(schemas).toEqual(COOKING_OPERATIONS.filter(schema => ["recipe.search", "plan.read", "plan.add"].includes(schema.name)));
    expect(text.split("\n")).toHaveLength(2);
  });

  it.each(["plan", "plan.*", "PLAN.READ", "unknown.operation"])("rejects unknown name %s before printing anything", async name => {
    const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    await expect(executeLiveCli(["tools", "plan.read", name])).rejects.toThrow(`Unknown cooking operation: ${name}`);
    expect(output).not.toHaveBeenCalled();
    expect(readAssociation).not.toHaveBeenCalled();
    expect(openCookingSession).not.toHaveBeenCalled();
  });
});
