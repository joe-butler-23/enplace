import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCookingCapabilities } from "./platform";
import { mepCookingBuildDesiredItems } from "./host-client/commands";

vi.mock("./host-client/commands", () => ({
  mepCookingBuildDesiredItems: vi.fn()
}));

const buildDesiredItemsMock = vi.mocked(mepCookingBuildDesiredItems);

describe("createCookingCapabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (globalThis as { __MEP_REMOTE_HOST__?: unknown }).__MEP_REMOTE_HOST__;
  });

  it("routes remote cooking through the typed command wrapper", async () => {
    (globalThis as { __MEP_REMOTE_HOST__?: unknown }).__MEP_REMOTE_HOST__ = {
      mode: "remote-host",
      apiBase: "/api",
      token: "test-token"
    };
    const recipes = [
      {
        path: "recipes/soup.md",
        title: "Soup",
        markdown: "# Soup\n\n## Ingredients\n- 1 | onion | produce\n\n## Method\n1. Cook"
      }
    ];
    const desired = [{ content: "onion - 1 (Soup)", labels: ["produce"] }];
    buildDesiredItemsMock.mockResolvedValue(desired);

    await expect(createCookingCapabilities().buildDesiredItems(recipes)).resolves.toEqual(desired);
    expect(buildDesiredItemsMock).toHaveBeenCalledWith({ recipes });
  });
});
