import "dotenv/config";

import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "electron-vite";

const plakkApiRpcUrl = process.env.VITE_PLAKK_API_RPC_URL ?? process.env.PLAKK_API_RPC_URL ?? "";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      rollupOptions: {
        external: ["electron"],
        output: {
          format: "cjs",
        },
      },
    },
  },
  renderer: {
    define: {
      "import.meta.env.VITE_PLAKK_API_RPC_URL": JSON.stringify(plakkApiRpcUrl),
    },
    plugins: [tailwindcss()],
    root: resolve("src/renderer"),
  },
});
