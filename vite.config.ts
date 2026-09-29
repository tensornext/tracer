import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: { format: "es" },
  optimizeDeps: {
    // Both ship large WASM payloads and self-locate them; let Vite serve them as-is.
    exclude: ["@huggingface/transformers", "replicad-opencascadejs"],
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 4000,
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
  },
} as never);
