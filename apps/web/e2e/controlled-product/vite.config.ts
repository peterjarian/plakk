import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite-controlled-product", import.meta.url)),
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: { tsconfigPaths: true },
  plugins: [tailwindcss(), viteReact()],
});
