import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "drizzle-kit";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
for (const filename of [".env.local", ".env"]) {
  const path = resolve(repoRoot, filename);
  if (!existsSync(path)) continue;

  for (const [key, value] of Object.entries(parseEnv(readFileSync(path, "utf8")))) {
    process.env[key] ??= value;
  }
}

export default defineConfig({
  dialect: "postgresql",
  out: "drizzle",
  schema: "src/schema.ts",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
