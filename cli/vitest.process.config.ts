import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["cli/mirror-process.worker.ts"], pool: "threads", maxWorkers: 1,
} });
