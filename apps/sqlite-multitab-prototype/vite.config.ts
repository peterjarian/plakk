import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      e2e: {
        cache: false,
        command: "node scripts/e2e.mjs",
      },
    },
  },
  server: {
    headers: {
      "Cache-Control": "no-store",
    },
  },
});
