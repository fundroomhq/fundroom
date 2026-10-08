import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** Project `ui`: component tests in jsdom with Testing Library and axe (vitest-axe). */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    name: "ui",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
