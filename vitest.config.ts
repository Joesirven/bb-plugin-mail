import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// @bb/plugin-sdk is linked from the local bb monorepo checkout without a
// built dist/ — resolve its "source" export condition, same as the
// monorepo's own package tests do.
export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL(".", import.meta.url)) },
      { find: /^@testing-library\/react$/, replacement: fileURLToPath(new URL("./node_modules/@testing-library/react/dist/index.js", import.meta.url)) },
      { find: /^react\/jsx-dev-runtime$/, replacement: fileURLToPath(new URL("./node_modules/react/jsx-dev-runtime.js", import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL("./node_modules/react/jsx-runtime.js", import.meta.url)) },
      { find: /^react-dom\/client$/, replacement: fileURLToPath(new URL("./node_modules/react-dom/client.js", import.meta.url)) },
      { find: /^react-dom$/, replacement: fileURLToPath(new URL("./node_modules/react-dom/index.js", import.meta.url)) },
      { find: /^react$/, replacement: fileURLToPath(new URL("./node_modules/react/index.js", import.meta.url)) },
    ],
    dedupe: ["react", "react-dom"],
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
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**"],
  },
});
