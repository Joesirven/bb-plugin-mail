import { defineConfig } from "vitest/config";

// @bb/plugin-sdk is linked from the local bb monorepo checkout without a
// built dist/ — resolve its "source" export condition, same as the
// monorepo's own package tests do.
export default defineConfig({
  resolve: {
    conditions: ["source"],
  },
  ssr: {
    resolve: {
      conditions: ["source"],
      externalConditions: ["source"],
    },
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**"],
  },
});
