import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"]
    }
  },
  resolve: {
    alias: {
      "@/platform": path.resolve(__dirname, "test/platform-mock.ts"),
      "@": path.resolve(__dirname, "src"),
      obsidian: path.resolve(__dirname, "test/platform-mock.ts")
    }
  }
});
