import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: [
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
    ],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      "./oxlint-plugin-plakk/index.ts",
      "oxlint-tailwindcss",
    ],
    settings: {
      tailwindcss: {
        entryPoint: "packages/ui/src/styles/globals.css",
      },
    },
    rules: {
      "tailwindcss/enforce-canonical": "warn",
      "vite-plus/prefer-vite-plus-imports": "error",
      "plakk/no-relative-js-imports": "error",
    },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    environment: "node",
    exclude: [
      "**/.repos/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/dist-electron/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    hookTimeout: 60_000,
    passWithNoTests: true,
    testTimeout: 60_000,
  },
  run: {
    cache: true,
    tasks: {
      dev: {
        command: "vp run --parallel --filter './apps/*' dev",
        cache: false,
      },
    },
  },
});
