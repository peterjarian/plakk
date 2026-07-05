import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "drizzle",
  schema: "src/main/db/schema.ts",
});
