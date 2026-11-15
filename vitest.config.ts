import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // removeTree (fixtures/sandbox.ts) collects garbage so Windows can delete a closed ledger.
    execArgv: ["--expose-gc"],
  },
});
