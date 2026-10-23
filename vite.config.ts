import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { port: 1420, strictPort: true },
  clearScreen: false,
  test: {
    environment: "jsdom",
    setupFiles: "./src/test-setup.ts",
    // Several suites wait on IPC promises with short default timeouts; running
    // the jsdom files in parallel makes those waits flaky on slower CI runners.
    fileParallelism: false,
    exclude: ["node_modules/**", "src-tauri/**", "crates/**"],
  },
});
