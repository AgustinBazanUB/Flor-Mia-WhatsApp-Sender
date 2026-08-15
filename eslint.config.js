import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "graphify-out/**", "node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
    languageOptions: {
      globals: { ...globals.browser, ...globals.webextensions, ...globals.node },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
);
