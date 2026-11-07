// Same shape as OpenRig's root config: a bare `npx vitest run` from the repo root resolves each
// package's own config instead of running unconfigured.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts"],
  },
});
