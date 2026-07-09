import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite-plus";

const root = fileURLToPath(new URL(".", import.meta.url));

const config = defineConfig({
  root,
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    viteReact(),
    nitro({
      routeRules: {
        "/api/**": {
          cors: true,
          headers: {
            "access-control-allow-origin": "plakk-app://renderer",
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "authorization, content-type",
            "access-control-max-age": "86400",
          },
        },
      },
    }),
  ],
});

export default config;
