import { defineConfig } from "evalite/config";
import { createSqliteStorage } from "evalite/sqlite-storage";
import tsconfigPaths from "vite-tsconfig-paths";
export default defineConfig({
  storage: () => createSqliteStorage("./evals/db/evalite.db"),
  setupFiles: ["./evals/setup.ts"],
  /**
   * Vitest's 30s default kills a gate-calibration fixture mid-flight: each one
   * makes two SEQUENTIAL judge calls over a full persona + phase brief +
   * transcript, and the slowest transcripts exceed 15s per call. A timeout
   * there is recorded as a failed eval, which reads as a calibration failure
   * when it is only a clock. evalite requires this at the root, not in
   * viteConfig.test.
   */
  testTimeout: 180_000,
  viteConfig: {
    // @ts-expect-error this is actually the correct way to pass vitest config
    plugins: [tsconfigPaths()],
  },
});
