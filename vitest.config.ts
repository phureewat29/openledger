import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Serial only when the live OCR suites are on: they all queue at one local
    // model server, and in parallel they eat each other's timeouts.
    fileParallelism: !process.env.TEST_OCR_BASE_URL,
    // removeTree (fixtures/sandbox.ts) collects garbage so Windows can delete a closed ledger.
    execArgv: ["--expose-gc"],
  },
});
