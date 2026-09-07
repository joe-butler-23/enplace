import { COOKING_OPERATIONS } from "../src/agent/operations";

export const cookingToolName = (name: string): string => name.replaceAll(".", "_");
export const COOKING_MCP_TOOL_NAMES = COOKING_OPERATIONS.map(({ name }) => `mcp__enplace__${cookingToolName(name)}`);
