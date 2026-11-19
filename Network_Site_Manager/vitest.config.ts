import os from "node:os"
import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // "server-only" throws outside a React Server Component build; tests import those modules directly.
      "server-only": path.resolve(__dirname, "tests/server-only-stub.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Imported configs are written under DATA_DIR; keep test runs away from the real ./data.
    env: { DATA_DIR: path.join(os.tmpdir(), `nsm-test-${process.pid}`) },
  },
})
